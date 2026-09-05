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
import { extractHtmlTitle, htmlToMarkdown, sniffMetaCharset } from "../utils/html-text.js";

/** Default per-request timeout */
const DEFAULT_TIMEOUT_MS = 20000;

/** Default response size cap (bytes) */
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

/** Redirect hops followed before giving up */
const MAX_REDIRECTS = 5;

/**
 * Cap on the text carried by one result (characters). High on purpose: the
 * tool middleware stages the COMPLETE result for run_python and the provider
 * inline cap trims what the model sees, so the staged copy must not be cut
 * beforehand. The cap only keeps the serialized result under the middleware's
 * 1 MB hard limit.
 */
export const MAX_CONTENT_CHARS = 900000;

/** Cap on the title reported alongside the content (characters) */
const MAX_TITLE_CHARS = 300;

/** GitHub API: comments/reviews fetched per issue or pull request */
const GITHUB_PAGE_SIZE = 100;

const USER_AGENT = "M8B-Slackbot/1.0 (+https://github.com/MetricsHub/m8b-slack)";

const PAGE_ACCEPT = "text/markdown, text/plain;q=0.9, text/html;q=0.8, */*;q=0.1";
const MARKDOWN_ACCEPT = "text/markdown, text/plain;q=0.9";

const MARKDOWN_TYPES = new Set(["text/markdown", "text/x-markdown"]);
// application/xhtml+xml is deliberately absent: XHTML is XML (CDATA sections,
// self-closing elements) and the HTML parser would misread it, so it is
// handed over verbatim like any other XML document
const HTML_TYPES = new Set(["text/html"]);

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
			canonicalHostname(
				entry
					.trim()
					.toLowerCase()
					.replace(/^\*?\.+/, "")
					.replace(/\.+$/, "")
			)
		)
		.filter(Boolean);
}

/**
 * Hostname as the URL parser would spell it (lowercase, IDN in Punycode), so
 * that a configured "évil.example" matches the "xn--vil-9la.example" a URL
 * carries. Entries the URL parser rejects are kept verbatim (they then match
 * nothing, which is the safe direction for an allow list).
 */
function canonicalHostname(host) {
	if (!host) return host;
	try {
		return new URL(`http://${host}/`).hostname.replace(/\.+$/, "");
	} catch {
		return host;
	}
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
	// Only the documented forms count: "owner/repo" and "owner/*". A bare owner
	// (or the "owner/" typo, normalized to "owner") is a malformed entry and
	// grants nothing — a nonempty scope must fail closed, never widen
	return scope.some((entry) => entry === full || entry === `${ownerKey}/*`);
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
	"168.63.129.16/32", // Azure platform address (WireServer), guest-only
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
	 * @param {number} [status] - HTTP status behind the error, when there is one
	 */
	constructor(message, hint, status) {
		super(message);
		this.name = "FetchUrlError";
		this.hint = hint;
		this.status = status;
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
	const charset = params
		.map((param) => param.match(/^charset\s*=\s*["']?\s*([^"';\s]+)/))
		.find(Boolean)?.[1];
	return { type: type || "", charset: charset || null };
}

function isTextualType(type) {
	if (!type) return false;
	if (type.startsWith("text/")) return true;
	return /^application\/(?:json|xml|yaml|x-yaml|javascript|x-javascript|ecmascript|x-ndjson|x-sh|x-httpd-php|.*\+(?:json|xml))$/.test(
		type
	);
}

/**
 * Whether a text body starts like an HTML document: optional BOM/whitespace,
 * any number of comments, then "<!doctype html", "<html", "<head" or "<body".
 * Only the first 4 KB are examined, one comment at a time (linear).
 *
 * @param {string} body - Decoded body
 * @returns {boolean}
 */
function startsLikeHtml(body) {
	const head = body.slice(0, 4096);
	let pos = 0;
	for (;;) {
		while (pos < head.length && /[\s\uFEFF]/.test(head[pos])) pos++;
		if (!head.startsWith("<!--", pos)) break;
		const end = head.indexOf("-->", pos + 4);
		if (end === -1) return false; // an unterminated comment: nothing can follow
		pos = end + 3;
	}
	return /^<(?:!doctype\s+html|html|head|body)\b/i.test(head.slice(pos));
}

function decodeBody(bytes, charset, type) {
	// A byte-order mark wins over everything, the HTTP charset included (WHATWG
	// Encoding "decode": BOM sniffing comes first) — a UTF-8 document served as
	// windows-1252 is still UTF-8. Then the declared charset (UTF-16 by name too)
	let label = bomLabel(bytes) || utf16Label(bytes, charset) || charset;
	// No HTTP charset: the document's own declaration decides. For HTML that is
	// <meta charset> (then an XML declaration, as browsers accept on XHTML served
	// as text/html); for XML media types (RSS/Atom feeds, sitemaps, ...) only the
	// leading XML declaration has any authority — a <meta charset> inside an
	// embedded XHTML fragment is content, not a declaration
	// (application/xhtml+xml is an XML media type: its <meta charset> has no
	// authority, only the XML declaration does)
	const isHtml = !type || HTML_TYPES.has(type);
	const isXml = type === "text/xml" || /xml$/.test(type);
	if (!label && (isHtml || isXml)) {
		const head = new TextDecoder("latin1").decode(bytes.subarray(0, 4096));
		label =
			(isHtml ? sniffMetaCharset(head) : null) ||
			// An XML declaration is only valid at the very start of the document (a
			// UTF-8 BOM, read as latin1, is the "ï»¿" prefix); one inside a comment
			// or CDATA is example text and must not decide the encoding
			head.match(/^[\sï»¿]*<\?xml\b[^>]*?\sencoding\s*=\s*["']([a-z0-9_-]+)/i)?.[1] ||
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
	// (No "MZ": two ASCII letters are too weak a signature — a text document may
	// well start with "MZ tools..."; executables are caught by the control-byte share)
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
 * @param {string|null} [charset] - Declared charset, when the server sent one
 * @returns {boolean}
 */
export function looksBinary(bytes, charset = null) {
	if (!bytes || bytes.byteLength === 0) return false;

	// Known binary signatures are refused whatever the server claims: a
	// charset label must not launder a PDF or an archive
	const start = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0; // UTF-8 BOM
	if (
		BINARY_SIGNATURES.some((signature) =>
			signature.every((byte, index) => bytes[start + index] === byte)
		)
	) {
		return true;
	}

	// UTF-16 text (declared, or announced by a byte-order mark) encodes most
	// ASCII with a NUL byte: judge the decoded code units, not the bytes
	const utf16 = utf16Label(bytes, charset);
	if (utf16) {
		let text;
		try {
			text = new TextDecoder(utf16, { fatal: false }).decode(bytes.subarray(0, 16384));
		} catch {
			return true;
		}
		return controlShare(Array.from(text.slice(0, 8192), (char) => char.charCodeAt(0))) > 0.05;
	}

	const sample = bytes.subarray(start, start + 8192);
	for (const byte of sample) if (byte === 0) return true;
	return controlShare(sample) > 0.05;
}

/**
 * "utf-16le" / "utf-16be" when the body is UTF-16 (declared charset or BOM), else null.
 */
/**
 * Encoding named by a leading byte-order mark: "utf-8", "utf-16le", "utf-16be",
 * or null when there is none.
 *
 * @param {Uint8Array} bytes - Response body
 * @returns {string|null}
 */
function bomLabel(bytes) {
	if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return "utf-8";
	if (bytes[0] === 0xff && bytes[1] === 0xfe) return "utf-16le";
	if (bytes[0] === 0xfe && bytes[1] === 0xff) return "utf-16be";
	return null;
}

function utf16Label(bytes, charset) {
	const declared = String(charset || "")
		.toLowerCase()
		.replace(/[^a-z0-9]/g, "");
	if (bytes[0] === 0xff && bytes[1] === 0xfe) return "utf-16le";
	if (bytes[0] === 0xfe && bytes[1] === 0xff) return "utf-16be";
	if (declared === "utf16be" || declared === "unicodefffe") return "utf-16be";
	if (declared === "utf16" || declared === "utf16le" || declared === "ucs2") return "utf-16le";
	return null;
}

/**
 * Share of control characters (other than tab, LF, VT, FF, CR and ESC) in a
 * sequence of byte values or code units. NUL counts as binary outright.
 */
function controlShare(values) {
	let control = 0;
	let total = 0;
	for (const value of values) {
		total++;
		if (value === 0) return 1;
		if (
			value < 0x20 &&
			value !== 0x09 &&
			value !== 0x0a &&
			value !== 0x0b &&
			value !== 0x0c &&
			value !== 0x0d &&
			value !== 0x1b
		) {
			control++;
		}
	}
	return total === 0 ? 0 : control / total;
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
async function guardedGet(
	rawUrl,
	headers,
	runtime,
	{ derivedHost = false, reviseHeaders = null } = {}
) {
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
			logger?.info?.(`[FETCH_URL] ${url.hostname} redirected (${status}) to ${redactUrl(next)}`);
			// Redirect targets are never trusted, whatever the origin of the hop. A
			// derived host (api.github.com) keeps its allow-list exemption while the
			// redirect stays on that same host (repository rename); any other host
			// goes through the full policy
			const nextUrl = validateUrlPolicy(next, config, {
				derivedHost: derivedHost && new URL(next).hostname === url.hostname,
			});
			// Credentials never follow a redirect to another origin (the GitHub
			// token is for api.github.com only), as browsers and curl behave
			if (nextUrl.origin !== url.origin) {
				requestHeaders = Object.fromEntries(
					Object.entries(requestHeaders).filter(
						([key]) => !SENSITIVE_HEADERS.has(key.toLowerCase())
					)
				);
			}
			// Same-origin hops may still change what the credentials apply to (a
			// renamed GitHub repository): the caller gets the last word
			if (reviseHeaders) requestHeaders = reviseHeaders(nextUrl, requestHeaders);
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
	// The query stays: "/guide?version=2" selects content the rendition must too
	const sibling = new URL(url.toString());
	sibling.hash = "";
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
		// Only the rendition suffixes are normalized: paths keep their case, since
		// /Guide and /guide are different resources on case-sensitive sites
		return new URL(rawUrl).pathname
			.replace(/\.(?:md|markdown|txt)$/i, "")
			.replace(/\/index(?:\.html?)?$/i, "/")
			.replace(/\.html?$/i, "")
			.replace(/\/+$/, "");
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
	for (const href of llmsTxtLinks(String(llmsText || ""))) {
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

/**
 * Link targets of an llms.txt index — Markdown "[label](url)" links and bare
 * "- https://..." lines — in one linear pass. The index is attacker-controlled:
 * a "](" is followed by a scan that stops at the first ")" or whitespace, and
 * the scan resumes AFTER that point (any "](" inside the scanned run was part
 * of a URL candidate, or of a run no URL can span), so nothing is rescanned.
 *
 * @param {string} text - llms.txt content
 * @returns {string[]} Raw link targets, in document order
 */
export function llmsTxtLinks(text) {
	const links = [];
	let pos = 0;
	for (;;) {
		const open = text.indexOf("](", pos);
		if (open === -1) break;
		let end = open + 2;
		while (end < text.length) {
			const code = text.charCodeAt(end);
			if (code === 41 /* ) */ || code === 32 || code === 9 || code === 10 || code === 13) break;
			end++;
		}
		if (end < text.length && text.charCodeAt(end) === 41 && end > open + 2) {
			links.push(text.slice(open + 2, end));
		}
		pos = end + 1;
	}
	// Bare URL lines (one per line; a line is bounded, so the anchored test is too)
	let lineStart = 0;
	while (lineStart < text.length) {
		let lineEnd = text.indexOf("\n", lineStart);
		if (lineEnd === -1) lineEnd = text.length;
		const line = text.slice(lineStart, lineEnd).trim();
		const bare = line.replace(/^-\s*/, "");
		if (/^https?:\/\/\S+$/.test(bare)) links.push(bare);
		lineStart = lineEnd + 1;
	}
	return links;
}

/**
 * URL for log lines: origin and path only. Query strings may carry signed
 * tokens or credentials and never belong in the application logs.
 */
function redactUrl(rawUrl) {
	try {
		const url = new URL(String(rawUrl));
		return `${url.origin}${url.pathname}${url.search ? "?…" : ""}`;
	} catch {
		return "<invalid url>";
	}
}

function finalizeContent(text) {
	const clean = String(text || "")
		.replace(/\r\n?/g, "\n")
		.trim();
	// The cap bounds the SERIALIZED size (what the middleware measures against
	// its hard limit): JSON escaping can double a text made of quotes or
	// backslashes. Cut proportionally until the serialized form fits.
	let content = clean;
	let serialized = JSON.stringify(content).length;
	while (serialized > MAX_CONTENT_CHARS && content.length > 0) {
		const keep = Math.floor((content.length * MAX_CONTENT_CHARS) / serialized) - 1;
		content = content.slice(0, Math.max(keep, 0));
		serialized = JSON.stringify(content).length;
	}
	return {
		content,
		truncated: content.length < clean.length,
		totalChars: clean.length,
		full: clean,
	};
}

/**
 * Complete text of results whose inline content had to be cut, kept aside
 * (never serialized) so the caller can stage it in full for the sandbox.
 */
const FULL_TEXT = new WeakMap();

/**
 * Complete text behind a truncated result, or null when nothing was cut.
 *
 * @param {Object} result - A result produced by buildResult
 * @returns {string|null}
 */
export function fullTextOf(result) {
	return FULL_TEXT.get(result) ?? null;
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
	const { content, truncated, totalChars, full } = finalizeContent(text);
	const result = {
		ok: true,
		url: requestedUrl,
		finalUrl,
		source,
		// Metadata, not content: a hostile <title> must not blow the output limit
		title: title ? String(title).slice(0, MAX_TITLE_CHARS) : undefined,
		contentType: contentType || undefined,
		chars: content.length,
		content,
	};
	if (truncated) {
		result.truncated = true;
		result.totalChars = totalChars;
		result.hint = `Only the first ${content.length} of ${totalChars} characters are shown.`;
		// The complete text stays out of the serialized result but is kept for
		// the caller to stage in full (see executeFetchUrl's stageText option)
		FULL_TEXT.set(result, full);
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
		if (looksBinary(bytes, charset)) return null;
		const text = decodeBody(bytes, charset, type);
		// A "Markdown" file that is really an HTML error/SPA shell is useless
		if (/^\s*<(?:!doctype|html|head|body)\b/i.test(text) || !text.trim()) return null;
		return { text, url: url.toString(), contentType: type || "text/markdown" };
	} catch (e) {
		runtime.logger?.debug?.(
			`[FETCH_URL] Markdown candidate ${redactUrl(candidateUrl)} unusable: ${e?.message}`
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
				: undefined,
			response.status
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
	if (looksBinary(bytes, charset)) {
		throw new FetchUrlError(
			`Refused: ${finalUrl.hostname} returned a binary document${type ? ` labelled ${type}` : " without a Content-Type"} (only Markdown, plain text and HTML pages can be read)`
		);
	}
	const body = decodeBody(bytes, charset, type);
	const contentType = type || "text/plain";

	// One HTML predicate for every branch: declared HTML, or an untyped /
	// text/plain body that STARTS like an HTML document (misconfigured servers).
	// Only the leading structure counts — any number of leading comments, then
	// the doctype or a document tag: a tutorial or source file that merely
	// contains "<html>" somewhere is the plain text it claims to be
	const looksHtml =
		HTML_TYPES.has(type) || ((!type || type === "text/plain") && startsLikeHtml(body));

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
			runtime.logger?.info?.(`[FETCH_URL] Using sibling Markdown ${redactUrl(markdown.url)}`);
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
	// A listed rendition cannot carry the page's query string: skip the index then
	const llms = finalUrl.search ? null : await tryMarkdownResource(llmsUrl, runtime);
	if (llms) {
		const entry = findLlmsTxtEntry(llms.text, finalUrl);
		if (entry && entry !== llmsUrl) {
			const markdown = await tryMarkdownResource(entry, runtime);
			if (markdown) {
				runtime.logger?.info?.(`[FETCH_URL] Using llms.txt entry ${redactUrl(markdown.url)}`);
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
 *   | {kind: "blob", owner: string, repo: string, ref: string, path: string, segments: string[], rawUrl: string}
 *   | null}
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
		// The first segment after blob/ is taken as the ref (branch names with
		// slashes are ambiguous in GitHub URLs too). URL.pathname is already
		// percent-encoded: decode so the API path is encoded exactly once
		const decode = (segment) => {
			try {
				return decodeURIComponent(segment);
			} catch {
				return segment;
			}
		};
		const [ref, ...pathSegments] = rest;
		return {
			kind: "blob",
			owner,
			repo: repo.replace(/\.git$/, ""),
			ref: decode(ref),
			path: pathSegments.map(decode).join("/"),
			segments: rest.map(decode),
			rawUrl: `https://raw.githubusercontent.com/${owner}/${repo}/${rest.join("/")}`,
		};
	}
	return null;
}

/** Pages followed per GitHub list (comments, reviews); 100 items each */
const GITHUB_MAX_PAGES = 5;

const GITHUB_API_ORIGIN = "https://api.github.com";

/**
 * Whether the bot's token applies to a repository (see githubTokenAllowedFor).
 */
function githubTokenInScope(runtime, owner, repo) {
	return (
		Boolean(runtime.config.githubToken) &&
		githubTokenAllowedFor(runtime.config.githubTokenRepos, owner, repo)
	);
}

/**
 * Owner and repository named by an API path (/repos/{owner}/{repo}/...), or
 * the fallback for paths that do not name them (/repositories/{id}/...).
 *
 * @param {string} path - API path
 * @param {{owner: string, repo: string}|null} fallback - Repository the request started from
 * @returns {{owner: string, repo: string}}
 */
function repoOfApiPath(path, fallback) {
	const match = path.match(/^\/repos\/([^/]+)\/([^/]+)/);
	if (match) return { owner: match[1], repo: match[2] };
	return { owner: fallback?.owner || "", repo: fallback?.repo || "" };
}

/**
 * One GitHub API request. Returns the body bytes and the response headers;
 * HTTP errors become model-facing FetchUrlErrors with actionable hints.
 *
 * @param {string} pathOrUrl - API path (/repos/...) or absolute api.github.com URL
 * @param {Object} runtime - Fetch runtime
 * @param {Object} [options]
 * @param {string} [options.accept] - Media type (default: JSON)
 * @param {string} [options.what] - Noun for the 404 message (default: "the issue")
 * @param {{owner: string, repo: string}|null} [options.scopeRepo] - Repository the request
 *   started from, for follow-up URLs that do not name one (/repositories/{id}/...)
 * @returns {Promise<{bytes: Uint8Array, headers: Headers}>}
 */
async function githubRequest(
	pathOrUrl,
	runtime,
	{ accept, what = "the issue", scopeRepo = null } = {}
) {
	const url = pathOrUrl.startsWith("/") ? `${GITHUB_API_ORIGIN}${pathOrUrl}` : pathOrUrl;
	if (!url.startsWith(`${GITHUB_API_ORIGIN}/`)) {
		throw new FetchUrlError(`Refused: GitHub pagination pointed outside ${GITHUB_API_ORIGIN}`);
	}
	const path = url.slice(GITHUB_API_ORIGIN.length);
	const headers = {
		Accept: accept || "application/vnd.github+json",
		"X-GitHub-Api-Version": "2022-11-28",
	};
	// The token is the bot's, shared by every Slack user who can talk to it:
	// only spend it on repositories the operator scoped it to. GitHub may spell
	// follow-up URLs (pagination, redirects) as /repositories/{id}/...: those
	// inherit the repository the request started from.
	const { owner, repo } = repoOfApiPath(path, scopeRepo);
	const tokenInScope = githubTokenInScope(runtime, owner, repo);
	if (tokenInScope) {
		headers.Authorization = `Bearer ${runtime.config.githubToken}`;
	}
	// A same-origin redirect can land on another repository (renamed or
	// transferred): the token follows only if that repository is in scope too
	const reviseHeaders = (nextUrl, current) => {
		if (!current.Authorization) return current;
		// A redirect target that does not name its repository (/repositories/{id})
		// cannot be checked against the scope: the token does not follow it.
		// (Pagination links, which come from an authorized response, keep their
		// scope through scopeRepo instead.)
		const next = repoOfApiPath(nextUrl.pathname, null);
		if (next.owner && githubTokenInScope(runtime, next.owner, next.repo)) return current;
		const { Authorization: _dropped, ...rest } = current;
		return rest;
	};
	const { response } = await guardedGet(url, headers, runtime, {
		derivedHost: true,
		reviseHeaders,
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
				`GitHub returned 404 for ${path}: ${what} does not exist, or the repository is private`,
				hint,
				404
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
	return { bytes, headers: response.headers };
}

/**
 * GET a JSON document from the GitHub API.
 */
async function githubApi(path, runtime, options = {}) {
	const { bytes } = await githubRequest(path, runtime, options);
	try {
		return JSON.parse(new TextDecoder("utf-8").decode(bytes));
	} catch {
		throw new FetchUrlError("GitHub API returned malformed JSON");
	}
}

/**
 * Next page URL from a GitHub `Link` header, or null.
 */
function nextPageLink(headers) {
	const link = headers?.get?.("link") || "";
	const match = link.match(/<([^>]+)>\s*;\s*rel="next"/);
	return match ? match[1] : null;
}

/**
 * GET a paginated GitHub list, following `Link: rel="next"` up to
 * GITHUB_MAX_PAGES pages (all on api.github.com). Reports truncation so the
 * model is never told a list is complete when it is not.
 *
 * @returns {Promise<{items: Array, truncated: boolean}>}
 */
async function githubList(path, runtime) {
	const items = [];
	// Later pages may be spelled /repositories/{id}/...: they keep this scope
	const scopeRepo = repoOfApiPath(path, null);
	let next = path;
	let pages = 0;
	while (next) {
		const { bytes, headers } = await githubRequest(next, runtime, { scopeRepo });
		let page;
		try {
			page = JSON.parse(new TextDecoder("utf-8").decode(bytes));
		} catch {
			throw new FetchUrlError("GitHub API returned malformed JSON");
		}
		if (Array.isArray(page)) items.push(...page);
		pages++;
		next = nextPageLink(headers);
		if (next && pages >= GITHUB_MAX_PAGES) return { items, truncated: true };
	}
	return { items, truncated: false };
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
	const isPull = target.kind === "pull" || Boolean(item.pull_request);
	const none = { items: [], truncated: false };
	// Every list is paginated (Link: rel="next") up to GITHUB_MAX_PAGES pages
	// The discussion lists are supplementary: when one cannot be loaded (rate
	// limit, transient error) the item is still returned, with a note saying
	// which list is missing, instead of failing the whole read
	const notes = [];
	const loadList = async (label, path) => {
		try {
			return await githubList(path, runtime);
		} catch (e) {
			const reason = e instanceof FetchUrlError ? e.message : "unexpected error";
			runtime.logger?.warn?.(`[FETCH_URL] GitHub ${label} could not be loaded: ${reason}`);
			notes.push(`The ${label} could not be loaded (${reason}).`);
			return { items: [], truncated: false };
		}
	};
	const comments = await loadList(
		"comments",
		`${base}/issues/${number}/comments?per_page=${GITHUB_PAGE_SIZE}`
	);
	const reviews = isPull
		? await loadList("reviews", `${base}/pulls/${number}/reviews?per_page=${GITHUB_PAGE_SIZE}`)
		: none;
	// Line-level review comments live on their own endpoint
	const reviewComments = isPull
		? await loadList(
				"review comments",
				`${base}/pulls/${number}/comments?per_page=${GITHUB_PAGE_SIZE}`
			)
		: none;

	const limit = GITHUB_PAGE_SIZE * GITHUB_MAX_PAGES;
	if (comments.truncated) notes.push(`Only the first ${limit} comments are included.`);
	if (reviews.truncated) notes.push(`Only the first ${limit} reviews are included.`);
	if (reviewComments.truncated) {
		notes.push(`Only the first ${limit} review comments are included.`);
	}
	return buildResult({
		requestedUrl,
		finalUrl: item.html_url || requestedUrl,
		source: "github",
		title: item.title,
		contentType: "text/markdown",
		text: renderGitHubItem(target, item, comments.items, reviews.items, reviewComments.items),
		note: notes.length > 0 ? notes.join(" ") : undefined,
	});
}

/**
 * Read a repository file from raw.githubusercontent.com VERBATIM: no content
 * negotiation, no HTML sniffing or conversion — a repository file is source,
 * whatever its extension, and the token-scoped path (the API) returns the
 * same bytes, so a public and a private read of the same blob give the same
 * text. The raw host is derived from an already policy-checked github.com
 * URL: exempt from the allow list, still subject to the block list.
 *
 * @param {string} rawUrl - raw.githubusercontent.com URL
 * @param {string} requestedUrl - The blob URL the user gave
 * @param {string} path - Repository path (the title)
 * @param {Object} runtime
 * @returns {Promise<Object>}
 */
async function readRawGitHubFile(rawUrl, requestedUrl, path, runtime) {
	const { response, url: finalUrl } = await guardedGet(
		rawUrl,
		{ Accept: "text/plain, */*;q=0.5" },
		runtime,
		{ derivedHost: true }
	);
	if (!response.ok) {
		await response.body?.cancel?.().catch(() => {});
		throw new FetchUrlError(
			`HTTP ${response.status} from ${finalUrl.hostname}`,
			response.status === 404
				? "The file does not exist at that path, or the repository is private (set GITHUB_TOKEN on the bot to read private repositories)."
				: undefined,
			response.status
		);
	}
	const { charset } = parseContentType(response.headers?.get?.("content-type"));
	const bytes = await readBodyCapped(response, runtime.config.maxBytes);
	if (looksBinary(bytes, charset)) {
		throw new FetchUrlError(`Refused: ${path} is a binary file (only text files can be read)`);
	}
	return buildResult({
		requestedUrl,
		finalUrl: finalUrl.toString(),
		source: "text",
		title: path,
		contentType: "text/plain",
		text: decodeBody(bytes, charset, "text/plain"),
	});
}

/**
 * Read a GitHub blob URL as the repository file it names: from the raw host
 * for public repositories (or a token scoped elsewhere), through the API
 * with the token for repositories in its scope.
 *
 * @param {Object} target - Parsed blob URL (owner, repo, ref, path, segments, rawUrl)
 * @param {string} requestedUrl - The blob URL the user gave
 * @param {Object} runtime
 * @returns {Promise<Object>}
 */
async function readGitHubBlob(target, requestedUrl, runtime) {
	// A blob URL does not say where the ref ends and the path starts
	// ("/blob/feature/foo/docs/guide.md" may be branch "feature/foo"). The refs
	// API lists the branches and tags starting with the first segment and the
	// longest one matching the URL wins; any number of slashes in a ref.
	const segments = target.segments || [target.ref, ...target.path.split("/")];
	const base = `/repos/${target.owner}/${target.repo}`;

	if (!githubTokenInScope(runtime, target.owner, target.repo)) {
		try {
			return await readRawGitHubFile(target.rawUrl, requestedUrl, target.path, runtime);
		} catch (e) {
			// The single-segment split (the common case) does not exist: the branch
			// or tag may contain a slash. The refs API is asked anonymously — only
			// now, since the anonymous budget is 60 requests an hour per address —
			// and the file re-read under the explicit refs/heads|tags form that
			// raw.githubusercontent.com accepts. When the API cannot answer (rate
			// limit, outage), the original 404 stands.
			if (!(e instanceof FetchUrlError && e.status === 404) || segments.length < 3) throw e;
			const resolved = await resolveGitHubRefSegments(base, segments, runtime).catch((error) => {
				const reason = error instanceof FetchUrlError ? error.message : "unexpected error";
				runtime.logger?.warn?.(`[FETCH_URL] GitHub refs could not be listed: ${reason}`);
				return null;
			});
			if (!resolved) throw e;
			const ref = segments.slice(0, resolved.refSegments).join("/");
			const path = segments.slice(resolved.refSegments).join("/");
			runtime.logger?.info?.(`[FETCH_URL] GitHub blob ref resolved to ${resolved.kind} ${ref}`);
			return await readRawGitHubFile(
				`https://raw.githubusercontent.com/${target.owner}/${target.repo}/refs/${resolved.kind}/${ref}/${path}`,
				requestedUrl,
				path,
				runtime
			);
		}
	}

	// With the token: the single-segment split (branch, tag or SHA) is the
	// fallback; the refs API is consulted first when the URL could name a
	// multi-segment ref. At most four requests.
	const encode = (parts) => parts.map((segment) => encodeURIComponent(segment)).join("/");
	const readAt = async (refSegments) => {
		const ref = segments.slice(0, refSegments).join("/");
		const path = segments.slice(refSegments).join("/");
		const { bytes } = await githubRequest(
			`${base}/contents/${encode(segments.slice(refSegments))}?ref=${encodeURIComponent(ref)}`,
			runtime,
			{ accept: "application/vnd.github.raw+json", what: "the file" }
		);
		if (looksBinary(bytes)) {
			throw new FetchUrlError(`Refused: ${path} is a binary file (only text files can be read)`);
		}
		return buildResult({
			requestedUrl,
			finalUrl: requestedUrl,
			source: "github",
			title: path,
			contentType: "text/plain",
			// Same decoder as web pages: a UTF-16 byte-order mark is honoured
			text: decodeBody(bytes, null, "text/plain"),
		});
	};

	// When the URL could name a multi-segment ref, ask the refs API first: with
	// both "release" and "release/v2" existing, /blob/release/v2/README.md means
	// the longer branch even if "release" happens to contain v2/README.md too.
	// The single-segment split remains the fallback (tags, SHAs, plain branches).
	if (segments.length >= 3) {
		const resolved = await resolveGitHubRefSegments(base, segments, runtime);
		if (resolved !== null) {
			try {
				return await readAt(resolved.refSegments);
			} catch (e) {
				if (!(e instanceof FetchUrlError && e.status === 404)) throw e;
			}
		}
	}
	return await readAt(1);
}

/**
 * The existing branch or tag whose name, with at least one slash (the
 * single-segment case is handled separately), forms the longest prefix of the
 * URL segments: how many segments it spans and whether it is a branch
 * ("heads") or a tag ("tags"). Null when none matches. Uses the refs API with
 * the first segment as prefix (anonymously when the token is out of scope).
 *
 * @param {string} base - "/repos/{owner}/{repo}"
 * @param {string[]} segments - URL segments after "/blob/"
 * @param {Object} runtime
 * @returns {Promise<{refSegments: number, kind: "heads"|"tags"}|null>}
 */
async function resolveGitHubRefSegments(base, segments, runtime) {
	const prefix = encodeURIComponent(segments[0]);
	const names = [];
	for (const kind of ["heads", "tags"]) {
		try {
			// Paginated like every other list: a busy prefix can span several pages
			const { items: refs } = await githubList(
				`${base}/git/matching-refs/${kind}/${prefix}?per_page=${GITHUB_PAGE_SIZE}`,
				runtime
			);
			for (const entry of refs) {
				const name = String(entry?.ref || "").replace(new RegExp(`^refs/${kind}/`), "");
				if (name) names.push({ name, kind });
			}
		} catch (e) {
			if (!(e instanceof FetchUrlError && e.status === 404)) throw e;
		}
	}
	let best = null;
	for (const { name, kind } of names) {
		const parts = name.split("/");
		// The ref must be a proper prefix of the URL segments, leaving a file path
		if (parts.length < 2 || parts.length >= segments.length) continue;
		if (
			parts.every((part, index) => part === segments[index]) &&
			(best === null || parts.length > best.refSegments)
		) {
			best = { refSegments: parts.length, kind: /** @type {"heads"|"tags"} */ (kind) };
		}
	}
	return best;
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
 * @param {(text: string, toolName: string) => (string|null)} [options.stageText] - Stages
 *   the complete text of a page whose inline content had to be cut (for the Python
 *   sandbox); returns the staged file name, or null when staging is unavailable
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

	// A result whose inline content had to be cut keeps its complete text aside;
	// when the caller can stage files for the Python sandbox, the full text is
	// staged there and the result says where, so nothing is lost to the cut
	const finish = (result) => {
		const full = fullTextOf(result);
		if (full && typeof options.stageText === "function") {
			try {
				const fileName = options.stageText(full, "fetch_url");
				if (fileName) {
					result.fullTextFile = fileName;
					result.hint =
						`${result.hint || ""} The complete text (${full.length} chars) is staged in the Python sandbox at /data/${fileName}; read it with run_python.`.trim();
				}
			} catch (e) {
				logger?.warn?.(`[FETCH_URL] Could not stage the full text: ${e?.message || e}`);
			}
		}
		return result;
	};

	try {
		// Slack wraps pasted links in <...|label>; models sometimes forward that form
		// Slack wraps links as <url|label> and escapes &, < and > inside them:
		// "?a=1&amp;b=2" is "?a=1&b=2". A bare URL is taken verbatim (a path may
		// legitimately contain "&amp;")
		const wrapped = rawUrl.match(/^<([^|>]+)(?:\|[^>]*)?>$/);
		const cleaned = wrapped
			? wrapped[1].replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
			: rawUrl;
		const url = validateUrlPolicy(cleaned, config);

		const github = parseGitHubUrl(url);
		if (github && github.kind !== "blob") {
			logger?.info?.(
				`[FETCH_URL] GitHub ${github.kind} ${github.owner}/${github.repo}#${github.number}`
			);
			return finish(await readGitHubItem(github, url.toString(), runtime));
		}
		if (github?.kind === "blob") {
			logger?.info?.(`[FETCH_URL] GitHub blob ${github.owner}/${github.repo} ${github.path}`);
			return finish(await readGitHubBlob(github, url.toString(), runtime));
		}

		const result = await readWebPage(url, runtime);
		logger?.info?.(`[FETCH_URL] ${url.hostname} read via ${result.source} (${result.chars} chars)`);
		return finish(result);
	} catch (e) {
		if (e instanceof FetchUrlError) {
			logger?.warn?.(`[FETCH_URL] ${e.message}`);
			return { ok: false, error: e.message, ...(e.hint ? { hint: e.hint } : {}) };
		}
		// Anything else is a bug or an environment problem: details go to the
		// logs, never to the model (paths, module internals, network details)
		logger?.error?.("[FETCH_URL] Unexpected failure", { error: String(e), stack: e?.stack });
		return {
			ok: false,
			error:
				"fetch_url failed unexpectedly while reading the page; the bot's logs have the details.",
		};
	}
}
