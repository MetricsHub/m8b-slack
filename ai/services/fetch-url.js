/**
 * Application-side web page reader (fetch_url) for providers without a hosted
 * web search that reads pages itself.
 *
 * Content negotiation, Markdown first:
 * 1. GET the page with `Accept: text/markdown, text/plain, text/html`; a
 *    Markdown or plain-text response is used as-is
 * 2. A sibling Markdown resource (`/docs/page` → `/docs/page.md`,
 *    `/docs/` → `/docs/index.html.md`, the llms.txt convention)
 * 3. `/llms.txt` at the site root as an index of Markdown renditions
 * 4. The HTML page itself, reduced to Markdown-ish text
 *
 * GitHub issue / pull request URLs are read through the REST API (body +
 * comments + reviews) instead of scraping the React app; `blob` URLs map to
 * their raw counterpart.
 *
 * Safety: http/https only; every hop (redirects included) must resolve to a
 * public address — private, loopback, link-local, multicast and cloud
 * metadata ranges are refused, at resolution time AND at connect time (the
 * validating DNS lookup is wired into the connection, so a rebinding DNS
 * answer cannot slip through). Optional allow/block host lists, timeout and
 * response size cap. Only GITHUB_TOKEN ever leaves the bot, and only towards
 * api.github.com.
 */

import dns from "node:dns";
import net from "node:net";
import { parseBooleanFlag } from "../config/providers.js";
import { extractHtmlTitle, htmlToMarkdown } from "../utils/html-text.js";

/** Default per-request timeout */
const DEFAULT_TIMEOUT_MS = 20000;

/** Default response size cap (bytes) */
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

/** Redirect hops followed before giving up */
const MAX_REDIRECTS = 5;

/**
 * Cap on the text handed to the model in one call (characters). Keeps a
 * 2 MB plain-text response under the middleware's hard output limit; the
 * provider inline cap applies on top of it.
 */
export const MAX_CONTENT_CHARS = 200000;

/** GitHub API: comments/reviews fetched per issue or pull request */
const GITHUB_PAGE_SIZE = 100;

const USER_AGENT = "M8B-Slackbot/1.0 (+https://github.com/MetricsHub/m8b-slack)";

const PAGE_ACCEPT = "text/markdown, text/plain;q=0.9, text/html;q=0.8, */*;q=0.1";
const MARKDOWN_ACCEPT = "text/markdown, text/plain;q=0.9";

const MARKDOWN_TYPES = new Set(["text/markdown", "text/x-markdown"]);
const HTML_TYPES = new Set(["text/html", "application/xhtml+xml"]);

/**
 * Function tool definition for the application-side page reader.
 */
export const FETCH_URL_TOOL = {
	type: "function",
	name: "fetch_url",
	description:
		"Read a web page, documentation page, GitHub issue or pull request and return its text content as Markdown. Use it whenever a user pastes a URL or when a web_search result needs to be read in full. Only http(s) URLs to public hosts; no binary files.",
	parameters: {
		type: "object",
		properties: {
			url: {
				type: "string",
				description: "The absolute http:// or https:// URL to read.",
			},
		},
		required: ["url"],
		additionalProperties: false,
	},
};

/**
 * Whether the fetch_url tool is enabled (FETCH_URL_ENABLED, default true).
 *
 * @returns {boolean}
 */
export function isFetchUrlEnabled() {
	return parseBooleanFlag(process.env.FETCH_URL_ENABLED, true);
}

/**
 * Get the fetch_url function tool, or null when disabled.
 *
 * @returns {Object|null}
 */
export function getFetchUrlTool() {
	return isFetchUrlEnabled() ? FETCH_URL_TOOL : null;
}

function parsePositiveInt(value, fallback) {
	const parsed = Number.parseInt(String(value ?? "").trim(), 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseHostList(value) {
	return String(value || "")
		.split(",")
		.map((entry) =>
			entry
				.trim()
				.toLowerCase()
				.replace(/^\*?\.+/, "")
				.replace(/\.+$/, "")
		)
		.filter(Boolean);
}

/**
 * Read the fetch_url configuration from the environment.
 *
 * @returns {{timeoutMs: number, maxBytes: number, allowedHosts: string[], blockedHosts: string[], githubToken: string, githubTokenRepos: string[]}}
 */
export function getFetchUrlConfig() {
	return {
		timeoutMs: parsePositiveInt(process.env.FETCH_URL_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
		maxBytes: parsePositiveInt(process.env.FETCH_URL_MAX_BYTES, DEFAULT_MAX_BYTES),
		allowedHosts: parseHostList(process.env.FETCH_URL_ALLOWED_HOSTS),
		blockedHosts: parseHostList(process.env.FETCH_URL_BLOCKED_HOSTS),
		githubToken: (process.env.GITHUB_TOKEN || "").trim(),
		githubTokenRepos: String(process.env.GITHUB_TOKEN_REPOS || "")
			.split(",")
			.map((entry) =>
				entry
					.trim()
					.toLowerCase()
					.replace(/^\/+|\/+$/g, "")
			)
			.filter(Boolean),
	};
}

/**
 * Whether the shared GITHUB_TOKEN may be used for a repository. The token is
 * the bot's, not the requesting user's: GITHUB_TOKEN_REPOS ("owner/repo" or
 * "owner/*", comma-separated) limits which repositories it is spent on. An
 * empty scope means every repository (documented as the operator's decision).
 *
 * @param {string[]} scope - Parsed GITHUB_TOKEN_REPOS entries
 * @param {string} owner - Repository owner
 * @param {string} repo - Repository name
 * @returns {boolean}
 */
export function githubTokenAllowedFor(scope, owner, repo) {
	if (!Array.isArray(scope) || scope.length === 0) return true;
	const full = `${owner}/${repo}`.toLowerCase();
	const ownerKey = String(owner).toLowerCase();
	return scope.some((entry) => entry === full || entry === `${ownerKey}/*` || entry === ownerKey);
}

// ---------------------------------------------------------------------------
// Address policy (SSRF guard)
// ---------------------------------------------------------------------------

function ipv4ToInt(address) {
	const parts = address.split(".").map((part) => Number.parseInt(part, 10));
	if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
		return null;
	}
	return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

function inCidr4(address, cidr) {
	const [base, bits] = cidr.split("/");
	const baseInt = ipv4ToInt(base);
	const addressInt = ipv4ToInt(address);
	if (baseInt === null || addressInt === null) return false;
	const mask = bits === "0" ? 0 : (0xffffffff << (32 - Number(bits))) >>> 0;
	return (addressInt & mask) >>> 0 === (baseInt & mask) >>> 0;
}

/** IPv4 ranges the bot must never talk to */
const BLOCKED_IPV4 = [
	"0.0.0.0/8", // "this" network
	"10.0.0.0/8", // private
	"100.64.0.0/10", // carrier-grade NAT
	"127.0.0.0/8", // loopback
	"169.254.0.0/16", // link-local, cloud metadata (169.254.169.254)
	"172.16.0.0/12", // private
	"192.0.0.0/24", // IETF protocol assignments
	"192.0.2.0/24", // documentation
	"192.88.99.0/24", // 6to4 relay anycast (deprecated)
	"192.168.0.0/16", // private
	"198.18.0.0/15", // benchmarking
	"198.51.100.0/24", // documentation
	"203.0.113.0/24", // documentation
	"224.0.0.0/4", // multicast
	"240.0.0.0/4", // reserved + broadcast
];

/**
 * Expand an IPv6 address to its eight 16-bit groups (numbers), or null when
 * it is not a valid IPv6 address.
 */
function ipv6Groups(address) {
	let text = address.toLowerCase();
	const zone = text.indexOf("%");
	if (zone !== -1) text = text.slice(0, zone);

	// Embedded IPv4 tail (::ffff:1.2.3.4, 64:ff9b::1.2.3.4)
	const v4Tail = text.match(/:(\d+\.\d+\.\d+\.\d+)$/);
	if (v4Tail) {
		const v4 = ipv4ToInt(v4Tail[1]);
		if (v4 === null) return null;
		text = `${text.slice(0, v4Tail.index)}:${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`;
	}

	const halves = text.split("::");
	if (halves.length > 2) return null;
	const head = halves[0] ? halves[0].split(":") : [];
	const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
	const missing = 8 - head.length - tail.length;
	if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
	const groups = [...head, ...Array(missing).fill("0"), ...tail].map((group) =>
		/^[0-9a-f]{1,4}$/.test(group) ? Number.parseInt(group, 16) : NaN
	);
	return groups.some(Number.isNaN) ? null : groups;
}

/**
 * Whether an IPv6 address is off-limits (loopback, unspecified, unique-local,
 * link/site-local, multicast, documentation, discard, or a mapped/translated
 * IPv4 address that is itself blocked).
 */
function isBlockedIpv6(address) {
	const groups = ipv6Groups(address);
	if (!groups) return true;

	const allZero = groups.every((g) => g === 0);
	if (allZero) return true; // ::
	if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return true; // ::1

	const embeddedV4 = (offset) =>
		`${groups[offset] >> 8}.${groups[offset] & 0xff}.${groups[offset + 1] >> 8}.${groups[offset + 1] & 0xff}`;
	// ::ffff:a.b.c.d (IPv4-mapped) and ::a.b.c.d (IPv4-compatible, deprecated)
	if (groups.slice(0, 5).every((g) => g === 0) && (groups[5] === 0xffff || groups[5] === 0)) {
		return isBlockedIpv4(embeddedV4(6));
	}
	// ::ffff:0:a.b.c.d (IPv4-translatable, RFC 6145 / SIIT)
	if (groups.slice(0, 4).every((g) => g === 0) && groups[4] === 0xffff && groups[5] === 0) {
		return isBlockedIpv4(embeddedV4(6));
	}
	// 64:ff9b::/96 (NAT64) and 64:ff9b:1::/48 (local-use NAT64)
	if (groups[0] === 0x64 && groups[1] === 0xff9b) {
		return groups[2] === 1 || isBlockedIpv4(embeddedV4(6));
	}
	// 2002::/16 (6to4): the embedded IPv4 decides
	if (groups[0] === 0x2002) return isBlockedIpv4(embeddedV4(1));

	if ((groups[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
	if ((groups[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
	if ((groups[0] & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (deprecated)
	if ((groups[0] & 0xff00) === 0xff00) return true; // ff00::/8 multicast
	if (groups[0] === 0x2001 && groups[1] === 0x0db8) return true; // 2001:db8::/32 documentation
	if (groups[0] === 0x0100 && groups[1] === 0 && groups[2] === 0 && groups[3] === 0) return true; // 100::/64 discard
	return false;
}

function isBlockedIpv4(address) {
	return BLOCKED_IPV4.some((cidr) => inCidr4(address, cidr));
}

/**
 * Whether an IP address (v4 or v6, as returned by DNS or written in a URL)
 * must not be contacted.
 *
 * @param {string} address - IP address literal
 * @returns {boolean}
 */
export function isBlockedAddress(address) {
	const text = String(address || "")
		.trim()
		.replace(/^\[|\]$/g, "");
	const family = net.isIP(text);
	if (family === 4) return isBlockedIpv4(text);
	if (family === 6) return isBlockedIpv6(text);
	return true; // not an address at all: never trust it
}

function hostMatches(hostname, entries) {
	return entries.some((entry) => hostname === entry || hostname.endsWith(`.${entry}`));
}

class FetchUrlError extends Error {
	/**
	 * @param {string} message - Model-facing explanation
	 * @param {string} [hint] - Optional model-facing follow-up advice
	 */
	constructor(message, hint) {
		super(message);
		this.name = "FetchUrlError";
		this.hint = hint;
	}
}

/**
 * Validate a URL against the scheme and host policy (no network access).
 *
 * @param {string} rawUrl - URL to validate
 * @param {{allowedHosts: string[], blockedHosts: string[]}} policy - Host lists
 * @param {Object} [options]
 * @param {boolean} [options.derivedHost] - The host was derived by the tool itself
 *   from an already-checked URL (api.github.com, raw.githubusercontent.com): it
 *   need not be on the allow list, but an explicit block entry still wins
 * @returns {URL} Parsed URL
 * @throws {FetchUrlError} When the URL is refused
 */
export function validateUrlPolicy(rawUrl, policy, { derivedHost = false } = {}) {
	let url;
	try {
		url = new URL(String(rawUrl));
	} catch {
		throw new FetchUrlError(`Invalid URL: ${String(rawUrl).slice(0, 200)}`);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new FetchUrlError(`Refused: only http and https URLs can be read (got ${url.protocol})`);
	}
	if (url.username || url.password) {
		throw new FetchUrlError("Refused: URLs with embedded credentials are not read");
	}

	const hostname = url.hostname.toLowerCase().replace(/\.+$/, "");
	if (!hostname) throw new FetchUrlError("Invalid URL: missing host");

	const literal = hostname.replace(/^\[|\]$/g, "");
	if (net.isIP(literal)) {
		if (isBlockedAddress(literal)) {
			throw new FetchUrlError(
				`Refused: ${hostname} is a private, loopback, link-local or reserved address`
			);
		}
	} else if (hostname === "localhost" || hostname.endsWith(".localhost")) {
		throw new FetchUrlError(`Refused: ${hostname} is a loopback address`);
	}

	// Blocked always wins, derived hosts included
	if (hostMatches(hostname, policy.blockedHosts)) {
		throw new FetchUrlError(`Refused: ${hostname} is blocked by FETCH_URL_BLOCKED_HOSTS`);
	}
	if (
		!derivedHost &&
		policy.allowedHosts.length > 0 &&
		!hostMatches(hostname, policy.allowedHosts)
	) {
		throw new FetchUrlError(`Refused: ${hostname} is not in FETCH_URL_ALLOWED_HOSTS`);
	}
	return url;
}

/**
 * Resolve a hostname and refuse it when ANY of its addresses is off-limits.
 *
 * @param {string} hostname - Host to resolve
 * @param {Function} lookup - dns.promises.lookup-compatible resolver
 * @returns {Promise<string[]>} The public addresses
 * @throws {FetchUrlError}
 */
async function resolvePublicAddresses(hostname, lookup) {
	if (net.isIP(hostname)) {
		if (isBlockedAddress(hostname)) {
			throw new FetchUrlError(
				`Refused: ${hostname} is a private, loopback, link-local or reserved address`
			);
		}
		return [hostname];
	}

	let records;
	try {
		records = await lookup(hostname, { all: true });
	} catch (e) {
		throw new FetchUrlError(`Cannot resolve ${hostname}: ${e?.code || e?.message || e}`);
	}
	const addresses = (Array.isArray(records) ? records : [records])
		.map((record) => (typeof record === "string" ? record : record?.address))
		.filter(Boolean);
	if (addresses.length === 0) {
		throw new FetchUrlError(`Cannot resolve ${hostname}: no address`);
	}
	const blocked = addresses.find((address) => isBlockedAddress(address));
	if (blocked) {
		throw new FetchUrlError(
			`Refused: ${hostname} resolves to ${blocked}, a private, loopback, link-local or reserved address`
		);
	}
	return addresses;
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

let guardedDispatcherPromise = null;

/**
 * undici Agent whose DNS lookup refuses non-public addresses at connect time.
 * Closes the resolve-then-connect window: whatever the resolver answers when
 * the socket is actually opened is checked again.
 */
async function getGuardedDispatcher() {
	if (!guardedDispatcherPromise) {
		guardedDispatcherPromise = import("undici").then(
			({ Agent }) =>
				new Agent({
					connect: {
						lookup(hostname, options, callback) {
							dns.lookup(hostname, { ...options, all: true }, (err, records) => {
								if (err) return callback(err, undefined, undefined);
								const list = Array.isArray(records) ? records : [records];
								const blocked = list.find((record) => isBlockedAddress(record.address));
								if (blocked) {
									const refused = new Error(
										`Refused: ${hostname} resolves to ${blocked.address}, a private, loopback, link-local or reserved address`
									);
									// Node error convention: a code the fetch error handler recognizes
									Object.assign(refused, { code: "EPRIVATEADDRESS" });
									return callback(refused, undefined, undefined);
								}
								if (options?.all) return callback(null, list, undefined);
								callback(null, list[0].address, list[0].family);
							});
						},
					},
				})
		);
		// A failed initialization must not be cached: the next call retries
		guardedDispatcherPromise.catch(() => {
			guardedDispatcherPromise = null;
		});
	}
	return guardedDispatcherPromise;
}

function parseContentType(header) {
	const value = String(header || "").toLowerCase();
	const [type, ...params] = value.split(";").map((part) => part.trim());
	const charset = params.map((param) => param.match(/^charset=["']?([^"';]+)/)).find(Boolean)?.[1];
	return { type: type || "", charset: charset || null };
}

function isTextualType(type) {
	if (!type) return false;
	if (type.startsWith("text/")) return true;
	return /^application\/(?:json|xml|yaml|x-yaml|javascript|x-javascript|ecmascript|x-ndjson|x-sh|x-httpd-php|.*\+(?:json|xml))$/.test(
		type
	);
}

function decodeBody(bytes, charset, type) {
	let label = charset;
	if (!label && type && HTML_TYPES.has(type)) {
		// Sniff <meta charset> in the first bytes of the document
		const head = new TextDecoder("latin1").decode(bytes.subarray(0, 4096));
		label =
			head.match(/<meta[^>]+charset=["']?\s*([a-z0-9_-]+)/i)?.[1] ||
			head.match(/<\?xml[^>]+encoding=["']([a-z0-9_-]+)/i)?.[1] ||
			null;
	}
	try {
		return new TextDecoder(label || "utf-8", { fatal: false }).decode(bytes);
	} catch {
		return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
	}
}

/** Magic numbers of binary formats commonly served with a missing or wrong Content-Type */
const BINARY_SIGNATURES = [
	[0x25, 0x50, 0x44, 0x46], // %PDF
	[0x89, 0x50, 0x4e, 0x47], // PNG
	[0xff, 0xd8, 0xff], // JPEG
	[0x47, 0x49, 0x46, 0x38], // GIF8
	[0x50, 0x4b, 0x03, 0x04], // ZIP / OOXML / JAR
	[0x1f, 0x8b], // gzip
	[0x7f, 0x45, 0x4c, 0x46], // ELF
	[0x4d, 0x5a], // MZ (Windows executable)
	[0x52, 0x49, 0x46, 0x46], // RIFF (WebP, WAV, AVI)
	[0x00, 0x00, 0x00, 0x1c, 0x66, 0x74, 0x79, 0x70], // MP4 ftyp
	[0xd0, 0xcf, 0x11, 0xe0], // OLE (legacy Office)
	[0x42, 0x5a, 0x68], // bzip2
	[0xfd, 0x37, 0x7a, 0x58, 0x5a], // xz
	[0x37, 0x7a, 0xbc, 0xaf], // 7z
	[0x52, 0x61, 0x72, 0x21], // RAR
];

/**
 * Whether a body is binary rather than text: a known signature, a NUL byte,
 * or a high share of control characters in the first kilobytes. Guards
 * against servers that omit Content-Type (object stores, download endpoints).
 *
 * @param {Uint8Array} bytes - Response body
 * @returns {boolean}
 */
export function looksBinary(bytes) {
	if (!bytes || bytes.byteLength === 0) return false;
	// Skip a UTF-8 BOM
	const start = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
	if (
		BINARY_SIGNATURES.some((signature) =>
			signature.every((byte, index) => bytes[start + index] === byte)
		)
	) {
		return true;
	}
	const sample = bytes.subarray(start, start + 8192);
	let control = 0;
	for (const byte of sample) {
		if (byte === 0) return true;
		// Control characters other than tab, LF, VT, FF, CR and ESC
		if (
			byte < 0x20 &&
			byte !== 0x09 &&
			byte !== 0x0a &&
			byte !== 0x0b &&
			byte !== 0x0c &&
			byte !== 0x0d &&
			byte !== 0x1b
		) {
			control++;
		}
	}
	return control > sample.byteLength * 0.05;
}

/**
 * Read a response body up to maxBytes; abort past it.
 */
async function readBodyCapped(response, maxBytes) {
	const declared = Number(response.headers?.get?.("content-length"));
	if (Number.isFinite(declared) && declared > maxBytes) {
		// Release the connection: undici would otherwise keep draining the body
		await response.body?.cancel?.().catch(() => {});
		throw new FetchUrlError(
			`Refused: response is ${declared} bytes, above the FETCH_URL_MAX_BYTES cap of ${maxBytes}`
		);
	}

	if (response.body && typeof response.body.getReader === "function") {
		const reader = response.body.getReader();
		const chunks = [];
		let total = 0;
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > maxBytes) {
				await reader.cancel().catch(() => {});
				throw new FetchUrlError(
					`Refused: response exceeds the FETCH_URL_MAX_BYTES cap of ${maxBytes} bytes`
				);
			}
			chunks.push(value);
		}
		const bytes = new Uint8Array(total);
		let offset = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return bytes;
	}

	// Test doubles and exotic responses without a readable stream
	const bytes = new Uint8Array(await response.arrayBuffer());
	if (bytes.byteLength > maxBytes) {
		throw new FetchUrlError(
			`Refused: response exceeds the FETCH_URL_MAX_BYTES cap of ${maxBytes} bytes`
		);
	}
	return bytes;
}

/**
 * GET a URL, following redirects manually so that every hop goes through the
 * address policy. Returns the final response (not consumed) and its URL.
 */
async function guardedGet(rawUrl, headers, runtime, { derivedHost = false } = {}) {
	const { config, fetchImpl, lookup, dispatcher, logger } = runtime;
	let url = validateUrlPolicy(rawUrl, config, { derivedHost });
	let hops = 0;
	let requestHeaders = { ...headers };

	for (;;) {
		// The preliminary resolution runs before the request (and its timeout)
		// exists: bound it by the same deadline, or a stalled resolver would hold
		// the Slack run for the OS's much longer DNS timeout
		await withTimeout(
			resolvePublicAddresses(url.hostname.replace(/^\[|\]$/g, ""), lookup),
			config.timeoutMs,
			`DNS resolution of ${url.hostname}`
		);

		let response;
		try {
			response = await fetchImpl(url.toString(), {
				method: "GET",
				headers: { "User-Agent": USER_AGENT, ...requestHeaders },
				redirect: "manual",
				signal: AbortSignal.timeout(config.timeoutMs),
				...(dispatcher ? { dispatcher } : {}),
			});
		} catch (e) {
			throw new FetchUrlError(`Request to ${url.hostname} failed: ${describeFetchError(e)}`);
		}

		const status = Number(response.status);
		if ([301, 302, 303, 307, 308].includes(status)) {
			const location = response.headers?.get?.("location");
			await response.body?.cancel?.().catch(() => {});
			if (!location) {
				throw new FetchUrlError(`HTTP ${status} redirect without a Location header`);
			}
			if (++hops > MAX_REDIRECTS) {
				throw new FetchUrlError(`Refused: more than ${MAX_REDIRECTS} redirects`);
			}
			let next;
			try {
				next = new URL(location, url).toString();
			} catch {
				throw new FetchUrlError(`Invalid redirect target: ${location.slice(0, 200)}`);
			}
			logger?.info?.(`[FETCH_URL] ${url.hostname} redirected (${status}) to ${next}`);
			// Redirect targets are never trusted, whatever the origin of the hop
			const nextUrl = validateUrlPolicy(next, config);
			// Credentials never follow a redirect to another origin (the GitHub
			// token is for api.github.com only), as browsers and curl behave
			if (nextUrl.origin !== url.origin) {
				requestHeaders = Object.fromEntries(
					Object.entries(requestHeaders).filter(
						([key]) => !SENSITIVE_HEADERS.has(key.toLowerCase())
					)
				);
			}
			url = nextUrl;
			continue;
		}

		return { response, url };
	}
}

/** Request headers that must not follow a redirect to another origin */
const SENSITIVE_HEADERS = new Set(["authorization", "cookie", "proxy-authorization"]);

/**
 * Bound a promise by a deadline (the promise itself keeps running; its result
 * is dropped). dns.promises.lookup takes no AbortSignal, hence the race.
 */
function withTimeout(promise, ms, label) {
	let timer;
	const deadline = new Promise((_resolve, reject) => {
		timer = setTimeout(() => reject(new FetchUrlError(`${label} timed out after ${ms} ms`)), ms);
	});
	return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

function describeFetchError(e) {
	let current = e;
	const seen = new Set();
	while (current && !seen.has(current)) {
		seen.add(current);
		if (current.code === "EPRIVATEADDRESS") return current.message;
		if (current.name === "TimeoutError" || current.code === "UND_ERR_CONNECT_TIMEOUT") {
			return "timed out";
		}
		current = current.cause;
	}
	const inner = e?.cause?.message || e?.cause?.code;
	return inner ? `${e?.message || e} (${inner})` : String(e?.message || e);
}

// ---------------------------------------------------------------------------
// Markdown / llms.txt negotiation
// ---------------------------------------------------------------------------

/**
 * Sibling Markdown URL for a page (llms.txt convention), or null when the page
 * already is a Markdown/text resource.
 *
 * @param {URL} url - Page URL
 * @returns {string|null}
 */
export function markdownSiblingUrl(url) {
	const sibling = new URL(url.toString());
	sibling.hash = "";
	sibling.search = "";
	const pathname = sibling.pathname;
	if (/\.(?:md|markdown|txt)$/i.test(pathname)) return null;
	if (pathname === "" || pathname.endsWith("/")) {
		sibling.pathname = `${pathname || "/"}index.html.md`;
	} else if (/\.(?:html?|php|aspx?|jsp)$/i.test(pathname)) {
		sibling.pathname = pathname.replace(/\.[a-z]+$/i, ".md");
	} else {
		sibling.pathname = `${pathname}.md`;
	}
	return sibling.toString();
}

/**
 * Path of a page or of its Markdown rendition, reduced to a comparable key:
 * `/docs/a`, `/docs/a.html`, `/docs/a.md`, `/docs/a.html.md`, `/docs/a/`
 * and `/docs/a/index.html.md` all give `/docs/a`. Hosts are ignored on
 * purpose: an llms.txt index describes the site it is served from, and may
 * point at a separate Markdown host.
 */
function pagePathKey(rawUrl) {
	try {
		return new URL(rawUrl).pathname
			.replace(/\.(?:md|markdown|txt)$/i, "")
			.replace(/\/index(?:\.html?)?$/i, "/")
			.replace(/\.html?$/i, "")
			.replace(/\/+$/, "")
			.toLowerCase();
	} catch {
		return null;
	}
}

/**
 * Find, in an llms.txt index, the Markdown rendition of a page: the entry
 * whose path is the page's path (with an optional .md / .html.md suffix).
 *
 * @param {string} llmsText - Content of /llms.txt
 * @param {URL} pageUrl - Page being read
 * @returns {string|null} Absolute URL of the matching Markdown file
 */
export function findLlmsTxtEntry(llmsText, pageUrl) {
	const target = pagePathKey(pageUrl.toString());
	if (target === null) return null;
	const links = [
		...String(llmsText || "").matchAll(/\]\(([^)\s]+)\)|^\s*-?\s*(https?:\/\/\S+)\s*$/gm),
	];
	for (const match of links) {
		const href = match[1] || match[2];
		let absolute;
		try {
			absolute = new URL(href, pageUrl).toString();
		} catch {
			continue;
		}
		if (pagePathKey(absolute) === target) {
			return absolute;
		}
	}
	return null;
}

function finalizeContent(text) {
	const clean = String(text || "")
		.replace(/\r\n?/g, "\n")
		.trim();
	if (clean.length <= MAX_CONTENT_CHARS) {
		return { content: clean, truncated: false, totalChars: clean.length };
	}
	return { content: clean.slice(0, MAX_CONTENT_CHARS), truncated: true, totalChars: clean.length };
}

/**
 * Shape the model-facing success payload.
 *
 * @param {Object} parts
 * @param {string} parts.requestedUrl - URL as given by the model
 * @param {string} parts.finalUrl - URL the content actually came from
 * @param {"markdown"|"text"|"llms.txt"|"html"|"github"} parts.source - Rendition used
 * @param {string} parts.text - Content (capped to MAX_CONTENT_CHARS)
 * @param {string} [parts.title] - Document title when known
 * @param {string} [parts.contentType] - Media type of the rendition
 * @param {string} [parts.note] - Additional model-facing remark
 * @returns {Object}
 */
function buildResult({ requestedUrl, finalUrl, source, title, contentType, text, note }) {
	const { content, truncated, totalChars } = finalizeContent(text);
	const result = {
		ok: true,
		url: requestedUrl,
		finalUrl,
		source,
		title: title || undefined,
		contentType: contentType || undefined,
		chars: content.length,
		content,
	};
	if (truncated) {
		result.truncated = true;
		result.totalChars = totalChars;
		result.hint = `Only the first ${MAX_CONTENT_CHARS} of ${totalChars} characters are shown.`;
	}
	if (note) result.note = note;
	return result;
}

/**
 * Try a candidate Markdown URL; return its text or null when it is not a
 * usable Markdown/plain-text document (missing, HTML, binary, too large...).
 */
async function tryMarkdownResource(candidateUrl, runtime) {
	try {
		const { response, url } = await guardedGet(candidateUrl, { Accept: MARKDOWN_ACCEPT }, runtime);
		if (!response.ok) {
			await response.body?.cancel?.().catch(() => {});
			return null;
		}
		const { type, charset } = parseContentType(response.headers?.get?.("content-type"));
		const pathLooksMarkdown = /\.(?:md|markdown|txt)$/i.test(url.pathname);
		if (!(MARKDOWN_TYPES.has(type) || type === "text/plain" || (pathLooksMarkdown && !type))) {
			await response.body?.cancel?.().catch(() => {});
			return null;
		}
		const bytes = await readBodyCapped(response, runtime.config.maxBytes);
		if (looksBinary(bytes)) return null;
		const text = decodeBody(bytes, charset, type);
		// A "Markdown" file that is really an HTML error/SPA shell is useless
		if (/^\s*<(?:!doctype|html|head|body)\b/i.test(text) || !text.trim()) return null;
		return { text, url: url.toString(), contentType: type || "text/markdown" };
	} catch (e) {
		runtime.logger?.debug?.(
			`[FETCH_URL] Markdown candidate ${candidateUrl} unusable: ${e?.message}`
		);
		return null;
	}
}

async function readWebPage(pageUrl, runtime, { derivedHost = false } = {}) {
	const requestedUrl = pageUrl.toString();
	const { response, url: finalUrl } = await guardedGet(
		requestedUrl,
		{ Accept: PAGE_ACCEPT },
		runtime,
		{ derivedHost }
	);

	if (!response.ok) {
		await response.body?.cancel?.().catch(() => {});
		throw new FetchUrlError(
			`HTTP ${response.status} from ${finalUrl.hostname}`,
			response.status === 401 || response.status === 403
				? "The page requires authentication the bot does not have."
				: undefined
		);
	}

	const { type, charset } = parseContentType(response.headers?.get?.("content-type"));
	if (type && !isTextualType(type)) {
		await response.body?.cancel?.().catch(() => {});
		throw new FetchUrlError(
			`Refused: ${finalUrl.hostname} returned ${type}, which is not a text document (only Markdown, plain text and HTML pages can be read)`
		);
	}

	const bytes = await readBodyCapped(response, runtime.config.maxBytes);
	// Servers that omit or mislabel Content-Type: the bytes have the last word
	if (looksBinary(bytes)) {
		throw new FetchUrlError(
			`Refused: ${finalUrl.hostname} returned a binary document${type ? ` labelled ${type}` : " without a Content-Type"} (only Markdown, plain text and HTML pages can be read)`
		);
	}
	const body = decodeBody(bytes, charset, type);
	const contentType = type || "text/plain";

	// One HTML predicate for every branch: declared HTML, or an untyped /
	// text/plain body that is really markup (misconfigured servers)
	const looksHtml =
		HTML_TYPES.has(type) ||
		((!type || type === "text/plain") && /^\s*<(?:!doctype|html)\b|<html\b|<body\b/i.test(body));

	// 1. The server answered our Accept header with Markdown or plain text
	if (MARKDOWN_TYPES.has(type) || (type === "text/plain" && !looksHtml)) {
		return buildResult({
			requestedUrl,
			finalUrl: finalUrl.toString(),
			source: MARKDOWN_TYPES.has(type) ? "markdown" : "text",
			contentType,
			text: body,
		});
	}

	if (!looksHtml) {
		// JSON, XML, YAML, scripts: hand over verbatim
		return buildResult({
			requestedUrl,
			finalUrl: finalUrl.toString(),
			source: "text",
			contentType,
			text: body,
		});
	}

	// 2. Sibling Markdown resource
	const sibling = markdownSiblingUrl(finalUrl);
	if (sibling) {
		const markdown = await tryMarkdownResource(sibling, runtime);
		if (markdown) {
			runtime.logger?.info?.(`[FETCH_URL] Using sibling Markdown ${markdown.url}`);
			return buildResult({
				requestedUrl,
				finalUrl: markdown.url,
				source: "markdown",
				title: extractHtmlTitle(body),
				contentType: markdown.contentType,
				text: markdown.text,
			});
		}
	}

	// 3. /llms.txt index at the site root
	const llmsUrl = new URL("/llms.txt", finalUrl).toString();
	const llms = await tryMarkdownResource(llmsUrl, runtime);
	if (llms) {
		const entry = findLlmsTxtEntry(llms.text, finalUrl);
		if (entry && entry !== llmsUrl) {
			const markdown = await tryMarkdownResource(entry, runtime);
			if (markdown) {
				runtime.logger?.info?.(`[FETCH_URL] Using llms.txt entry ${markdown.url}`);
				return buildResult({
					requestedUrl,
					finalUrl: markdown.url,
					source: "llms.txt",
					title: extractHtmlTitle(body),
					contentType: markdown.contentType,
					text: markdown.text,
				});
			}
		}
	}

	// 4. The HTML page itself
	return buildResult({
		requestedUrl,
		finalUrl: finalUrl.toString(),
		source: "html",
		title: extractHtmlTitle(body),
		contentType,
		text: htmlToMarkdown(body, { baseUrl: finalUrl.toString() }),
	});
}

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

/**
 * Recognize GitHub URLs the tool handles specially.
 *
 * @param {URL} url - Parsed URL
 * @returns {{kind: "issue"|"pull", owner: string, repo: string, number: number}
 *   | {kind: "blob", rawUrl: string} | null}
 */
export function parseGitHubUrl(url) {
	const host = url.hostname.toLowerCase();
	if (host !== "github.com" && host !== "www.github.com") return null;
	const segments = url.pathname.split("/").filter(Boolean);
	if (segments.length < 4) return null;
	const [owner, repo, kind, ...rest] = segments;
	if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) return null;

	if ((kind === "issues" || kind === "pull") && /^\d+$/.test(rest[0] || "")) {
		return {
			kind: kind === "issues" ? "issue" : "pull",
			owner,
			repo: repo.replace(/\.git$/, ""),
			number: Number(rest[0]),
		};
	}
	if ((kind === "blob" || kind === "raw") && rest.length >= 2) {
		return {
			kind: "blob",
			rawUrl: `https://raw.githubusercontent.com/${owner}/${repo}/${rest.join("/")}`,
		};
	}
	return null;
}

async function githubApi(path, runtime) {
	const headers = {
		Accept: "application/vnd.github+json",
		"X-GitHub-Api-Version": "2022-11-28",
	};
	// The token is the bot's, shared by every Slack user who can talk to it:
	// only spend it on repositories the operator scoped it to
	const [, owner = "", repo = ""] = path.match(/^\/repos\/([^/]+)\/([^/]+)/) || [];
	const tokenInScope =
		Boolean(runtime.config.githubToken) &&
		githubTokenAllowedFor(runtime.config.githubTokenRepos, owner, repo);
	if (tokenInScope) {
		headers.Authorization = `Bearer ${runtime.config.githubToken}`;
	}
	const { response } = await guardedGet(`https://api.github.com${path}`, headers, runtime, {
		derivedHost: true,
	});
	if (!response.ok) {
		await response.body?.cancel?.().catch(() => {});
		const remaining = response.headers?.get?.("x-ratelimit-remaining");
		if (response.status === 404) {
			let hint = "Set GITHUB_TOKEN on the bot to read private repositories.";
			if (tokenInScope) hint = "The configured GITHUB_TOKEN cannot see this repository.";
			else if (runtime.config.githubToken)
				hint = `The bot's GITHUB_TOKEN is not scoped to ${owner}/${repo} (GITHUB_TOKEN_REPOS), so the request was anonymous.`;
			throw new FetchUrlError(
				`GitHub returned 404 for ${path}: the issue does not exist, or the repository is private`,
				hint
			);
		}
		if ((response.status === 403 || response.status === 429) && remaining === "0") {
			throw new FetchUrlError(
				"GitHub API rate limit exhausted",
				tokenInScope ? "Try again later." : "Set GITHUB_TOKEN for a higher rate limit."
			);
		}
		throw new FetchUrlError(`GitHub API returned HTTP ${response.status} for ${path}`);
	}
	const bytes = await readBodyCapped(response, runtime.config.maxBytes);
	try {
		return JSON.parse(new TextDecoder("utf-8").decode(bytes));
	} catch {
		throw new FetchUrlError("GitHub API returned malformed JSON");
	}
}

function formatDate(value) {
	return value ? String(value).slice(0, 10) : "";
}

function renderCommentList(heading, comments) {
	if (!Array.isArray(comments) || comments.length === 0) return "";
	const lines = [`## ${heading} (${comments.length})`, ""];
	for (const comment of comments) {
		lines.push(
			`### @${comment.user?.login || "unknown"} — ${formatDate(comment.created_at)}`,
			"",
			(comment.body || "").trim() || "_(empty)_",
			""
		);
	}
	return lines.join("\n");
}

/**
 * Render a GitHub issue or pull request (+ comments, + reviews) as Markdown.
 *
 * @param {{kind: string, number: number}} target - Parsed GitHub target
 * @param {Object} item - Issue or pull request API object
 * @param {Array} comments - Issue-thread comments
 * @param {Array} [reviews] - Pull request reviews (state + summary body)
 * @param {Array} [reviewComments] - Pull request inline (line-level) review comments
 * @returns {string}
 */
export function renderGitHubItem(target, item, comments, reviews = [], reviewComments = []) {
	const isPull = target.kind === "pull" || Boolean(item.pull_request);
	const lines = [`# ${item.title || "(untitled)"} (#${item.number ?? target.number})`, ""];
	const facts = [
		`${isPull ? "Pull request" : "Issue"} in ${item.base?.repo?.full_name || item.repository_url?.split("/repos/")[1] || ""}`.trim(),
		`State: ${item.state}${item.merged ? " (merged)" : item.draft ? " (draft)" : ""}`,
		`Author: @${item.user?.login || "unknown"}`,
		`Created: ${formatDate(item.created_at)}`,
		item.closed_at ? `Closed: ${formatDate(item.closed_at)}` : "",
		Array.isArray(item.labels) && item.labels.length > 0
			? `Labels: ${item.labels.map((label) => label.name || label).join(", ")}`
			: "",
		Array.isArray(item.assignees) && item.assignees.length > 0
			? `Assignees: ${item.assignees.map((user) => `@${user.login}`).join(", ")}`
			: "",
		item.milestone?.title ? `Milestone: ${item.milestone.title}` : "",
		isPull && item.head?.ref ? `Branch: ${item.head.ref} → ${item.base?.ref || "?"}` : "",
		isPull && Number.isFinite(item.changed_files)
			? `Changes: ${item.commits ?? "?"} commits, ${item.changed_files} files, +${item.additions ?? "?"}/-${item.deletions ?? "?"}`
			: "",
		`URL: ${item.html_url || ""}`,
	].filter(Boolean);
	lines.push(
		...facts.map((fact) => `- ${fact}`),
		"",
		(item.body || "").trim() || "_(no description)_",
		""
	);

	if (Array.isArray(reviews) && reviews.length > 0) {
		const meaningful = reviews.filter((review) => review.state && review.state !== "PENDING");
		if (meaningful.length > 0) {
			lines.push(`## Reviews (${meaningful.length})`, "");
			for (const review of meaningful) {
				lines.push(
					`- @${review.user?.login || "unknown"}: ${review.state.toLowerCase().replace(/_/g, " ")} (${formatDate(review.submitted_at)})${review.body?.trim() ? ` — ${review.body.trim()}` : ""}`
				);
			}
			lines.push("");
		}
	}

	// Inline review comments carry the substance of a review; the reviews
	// endpoint only has the verdict and the summary body
	if (Array.isArray(reviewComments) && reviewComments.length > 0) {
		lines.push(`## Review comments (${reviewComments.length})`, "");
		for (const comment of reviewComments) {
			const line = comment.line ?? comment.original_line;
			const location = `${comment.path || "?"}${line ? `:${line}` : ""}`;
			lines.push(
				`### @${comment.user?.login || "unknown"} on ${location} — ${formatDate(comment.created_at)}`,
				"",
				(comment.body || "").trim() || "_(empty)_",
				""
			);
		}
	}

	lines.push(renderCommentList("Comments", comments));
	return lines.join("\n").trim();
}

async function readGitHubItem(target, requestedUrl, runtime) {
	const base = `/repos/${target.owner}/${target.repo}`;
	const number = target.number;
	const item = await githubApi(
		target.kind === "pull" ? `${base}/pulls/${number}` : `${base}/issues/${number}`,
		runtime
	);
	const comments = await githubApi(
		`${base}/issues/${number}/comments?per_page=${GITHUB_PAGE_SIZE}`,
		runtime
	);
	const isPull = target.kind === "pull" || Boolean(item.pull_request);
	const reviews = isPull
		? await githubApi(`${base}/pulls/${number}/reviews?per_page=${GITHUB_PAGE_SIZE}`, runtime)
		: [];
	// Line-level review comments live on their own endpoint
	const reviewComments = isPull
		? await githubApi(`${base}/pulls/${number}/comments?per_page=${GITHUB_PAGE_SIZE}`, runtime)
		: [];

	const notes = [];
	if (Array.isArray(comments) && comments.length >= GITHUB_PAGE_SIZE) {
		notes.push(`Only the first ${GITHUB_PAGE_SIZE} comments are included.`);
	}
	if (Array.isArray(reviewComments) && reviewComments.length >= GITHUB_PAGE_SIZE) {
		notes.push(`Only the first ${GITHUB_PAGE_SIZE} review comments are included.`);
	}
	return buildResult({
		requestedUrl,
		finalUrl: item.html_url || requestedUrl,
		source: "github",
		title: item.title,
		contentType: "text/markdown",
		text: renderGitHubItem(target, item, comments, reviews, reviewComments),
		note: notes.length > 0 ? notes.join(" ") : undefined,
	});
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Execute a fetch_url function call.
 *
 * @param {Object} args - {url}
 * @param {Object} [logger] - Logger instance
 * @param {Object} [options] - Test hooks
 * @param {Function} [options.fetchImpl] - fetch replacement (default: global fetch with the guarded dispatcher)
 * @param {Function} [options.lookup] - dns.promises.lookup replacement
 * @param {Object} [options.config] - Configuration override (default: from the environment)
 * @returns {Promise<Object>} {ok: true, url, finalUrl, source, title?, contentType, chars, content, truncated?, note?}
 *   or {ok: false, error, hint?}
 */
export async function executeFetchUrl(args, logger, options = {}) {
	const rawUrl = String(args?.url || "").trim();
	if (!rawUrl) {
		return { ok: false, error: "Missing required parameter: url" };
	}
	if (!isFetchUrlEnabled() && !options.config) {
		return {
			ok: false,
			error: "fetch_url is disabled on this deployment (FETCH_URL_ENABLED=false).",
		};
	}

	const config = options.config || getFetchUrlConfig();

	// Fail closed: without the guarded dispatcher the connect-time address
	// check is gone, and an unguarded request would reopen the DNS-rebinding
	// window. A test double for fetch brings its own transport.
	let dispatcher = null;
	if (!options.fetchImpl) {
		try {
			dispatcher = await getGuardedDispatcher();
		} catch (e) {
			logger?.error?.("[FETCH_URL] Guarded HTTP client unavailable", { error: String(e) });
			return {
				ok: false,
				error: "fetch_url is unavailable: the guarded HTTP client could not be initialized.",
			};
		}
	}

	const runtime = {
		config,
		logger,
		fetchImpl: options.fetchImpl || globalThis.fetch,
		lookup: options.lookup || dns.promises.lookup,
		dispatcher,
	};

	try {
		// Slack wraps pasted links in <...|label>; models sometimes forward that form
		const cleaned = rawUrl.replace(/^<([^|>]+)(?:\|[^>]*)?>$/, "$1");
		const url = validateUrlPolicy(cleaned, config);

		const github = parseGitHubUrl(url);
		if (github && github.kind !== "blob") {
			logger?.info?.(
				`[FETCH_URL] GitHub ${github.kind} ${github.owner}/${github.repo}#${github.number}`
			);
			return await readGitHubItem(github, url.toString(), runtime);
		}
		if (github?.kind === "blob") {
			logger?.info?.(`[FETCH_URL] GitHub blob → ${github.rawUrl}`);
			// The raw host is derived from an already policy-checked github.com URL:
			// exempt from the allow list, still subject to the block list
			const result = await readWebPage(new URL(github.rawUrl), runtime, {
				derivedHost: true,
			});
			result.url = url.toString();
			return result;
		}

		const result = await readWebPage(url, runtime);
		logger?.info?.(`[FETCH_URL] ${url.hostname} read via ${result.source} (${result.chars} chars)`);
		return result;
	} catch (e) {
		if (e instanceof FetchUrlError) {
			logger?.warn?.(`[FETCH_URL] ${e.message}`);
			return { ok: false, error: e.message, ...(e.hint ? { hint: e.hint } : {}) };
		}
		logger?.error?.("[FETCH_URL] Unexpected failure", { error: String(e) });
		return { ok: false, error: `fetch_url failed: ${e?.message || e}` };
	}
}
