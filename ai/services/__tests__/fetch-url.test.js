/**
 * Tests for the application-side page reader (fetch_url).
 *
 * Network access is replaced by an in-memory routing table: fetchImpl answers
 * by URL, lookup resolves every host to a public address unless a test says
 * otherwise. No test opens a socket.
 */

import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import {
	executeFetchUrl,
	findLlmsTxtEntry,
	getFetchUrlConfig,
	getFetchUrlTool,
	githubTokenAllowedFor,
	isBlockedAddress,
	llmsTxtLinks,
	looksBinary,
	MAX_CONTENT_CHARS,
	markdownSiblingUrl,
	parseGitHubUrl,
	validateUrlPolicy,
} from "../fetch-url.js";

const ENV_KEYS = [
	"FETCH_URL_ENABLED",
	"FETCH_URL_ALLOWED_HOSTS",
	"FETCH_URL_BLOCKED_HOSTS",
	"FETCH_URL_TIMEOUT_MS",
	"FETCH_URL_MAX_BYTES",
	"GITHUB_TOKEN",
];

const PUBLIC_IP = "93.184.216.34";

const baseConfig = {
	timeoutMs: 5000,
	maxBytes: 2 * 1024 * 1024,
	allowedHosts: [],
	blockedHosts: [],
	githubToken: "",
};

function response(
	body,
	{ status = 200, contentType = "text/html; charset=utf-8", headers = {} } = {}
) {
	const bytes = Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ""), "utf8");
	const allHeaders = new Headers(headers);
	if (contentType !== null && !allHeaders.has("content-type")) {
		allHeaders.set("content-type", contentType);
	}
	return {
		ok: status >= 200 && status < 300,
		status,
		headers: allHeaders,
		body: { cancel: async () => {} },
		arrayBuffer: async () =>
			bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
	};
}

const notFound = () => response("Not Found", { status: 404, contentType: "text/plain" });

/**
 * Build a fetch double from a {url: response | (init) => response} table.
 * Unknown URLs answer 404.
 */
function makeFetch(routes) {
	return jest.fn(async (url, init) => {
		const key = String(url);
		const route = routes[key];
		if (!route) return notFound();
		return typeof route === "function" ? route(init, key) : route;
	});
}

const publicLookup = jest.fn(async () => [{ address: PUBLIC_IP, family: 4 }]);

function run(args, { routes = {}, lookup = publicLookup, config = {} } = {}) {
	const fetchImpl = makeFetch(routes);
	const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
	return executeFetchUrl(args, logger, {
		fetchImpl,
		lookup,
		config: { ...baseConfig, ...config },
	}).then((result) => ({ result, fetchImpl, logger }));
}

const HTML_PAGE = `<html><head><title>Guide</title></head><body>
<nav>Menu</nav><main><h1>Guide</h1><p>${"Real content. ".repeat(30)}</p><script>x()</script></main></body></html>`;

describe("fetch_url configuration", () => {
	const savedEnv = {};

	beforeEach(() => {
		for (const key of ENV_KEYS) {
			savedEnv[key] = process.env[key];
			delete process.env[key];
		}
	});

	afterEach(() => {
		for (const key of ENV_KEYS) {
			if (savedEnv[key] === undefined) delete process.env[key];
			else process.env[key] = savedEnv[key];
		}
	});

	it("is enabled by default and removed by FETCH_URL_ENABLED=false", async () => {
		expect(getFetchUrlTool()).toMatchObject({ type: "function", name: "fetch_url" });
		expect(getFetchUrlTool().parameters.required).toEqual(["url"]);

		process.env.FETCH_URL_ENABLED = "false";
		expect(getFetchUrlTool()).toBeNull();

		const result = await executeFetchUrl({ url: "https://example.com/" });
		expect(result.ok).toBe(false);
		expect(result.error).toContain("disabled");
	});

	it("canonicalizes internationalized host-list entries the way URLs spell them", () => {
		process.env.FETCH_URL_BLOCKED_HOSTS = "évil.example, Docs.Example.COM., *.münchen.de";
		process.env.FETCH_URL_ALLOWED_HOSTS = "bücher.example";
		const config = getFetchUrlConfig();
		expect(config.blockedHosts).toEqual([
			"xn--vil-9la.example",
			"docs.example.com",
			"xn--mnchen-3ya.de",
		]);
		expect(config.allowedHosts).toEqual(["xn--bcher-kva.example"]);
		// A URL to the Unicode spelling carries the Punycode host: the block entry matches
		expect(() => validateUrlPolicy("https://évil.example/page", config)).toThrow(/blocked/);
		expect(() => validateUrlPolicy("https://sub.münchen.de/", config)).toThrow(/blocked/);
		expect(validateUrlPolicy("https://bücher.example/", config).hostname).toBe(
			"xn--bcher-kva.example"
		);
	});

	it("rejects a missing url", async () => {
		const result = await executeFetchUrl({});
		expect(result.ok).toBe(false);
		expect(result.error).toContain("Missing required parameter");
	});
});

describe("address policy", () => {
	it("recognizes private, loopback, link-local, metadata and reserved IPv4 ranges", () => {
		for (const address of [
			"127.0.0.1",
			"127.5.6.7",
			"10.0.0.1",
			"172.16.0.1",
			"172.31.255.255",
			"192.168.1.1",
			"169.254.169.254",
			"100.64.0.1",
			"0.0.0.0",
			"224.0.0.1",
			"255.255.255.255",
			"198.18.0.1",
			"168.63.129.16", // Azure platform address (WireServer)
		]) {
			expect(isBlockedAddress(address)).toBe(true);
		}
		for (const address of ["8.8.8.8", "93.184.216.34", "172.32.0.1", "11.0.0.1", "100.128.0.1"]) {
			expect(isBlockedAddress(address)).toBe(false);
		}
	});

	it("recognizes IPv6 loopback, unique-local, link-local, multicast and mapped IPv4", () => {
		for (const address of [
			"::1",
			"::",
			"fd12:3456::1",
			"fc00::1",
			"fe80::1%eth0",
			"ff02::1",
			"::ffff:127.0.0.1",
			"::ffff:c0a8:0101",
			"::ffff:0:169.254.169.254",
			"::ffff:0:a9fe:a9fe",
			"64:ff9b::10.0.0.1",
			"2001:db8::1",
			"2002:7f00:0001::1",
			"100::1",
		]) {
			expect(isBlockedAddress(address)).toBe(true);
		}
		for (const address of [
			"2606:2800:220:1:248:1893:25c8:1946",
			"::ffff:8.8.8.8",
			"::ffff:0:8.8.8.8",
			"64:ff9b::8.8.8.8",
		]) {
			expect(isBlockedAddress(address)).toBe(false);
		}
		expect(isBlockedAddress("not-an-ip")).toBe(true);
	});

	it("refuses non-http schemes, credentials and literal private hosts before any request", async () => {
		for (const url of [
			"ftp://example.com/file",
			"file:///etc/passwd",
			"javascript:alert(1)",
			"https://user:pw@example.com/",
			"http://127.0.0.1:8080/admin",
			"http://[::1]/",
			"http://[fd00::1]/",
			"http://169.254.169.254/latest/meta-data/",
			"http://localhost:3000/",
			"http://app.localhost/",
			"not a url",
		]) {
			const { result, fetchImpl } = await run({ url });
			expect(result.ok).toBe(false);
			expect(result.error).toMatch(/Refused|Invalid URL/);
			expect(fetchImpl).not.toHaveBeenCalled();
		}
	});

	it("refuses hostnames that resolve to a private address", async () => {
		const lookup = jest.fn(async () => [
			{ address: PUBLIC_IP, family: 4 },
			{ address: "10.1.2.3", family: 4 },
		]);
		const { result, fetchImpl } = await run({ url: "https://intranet.example.com/" }, { lookup });
		expect(result.ok).toBe(false);
		expect(result.error).toContain("10.1.2.3");
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("refuses redirects to private addresses, whatever the first hop", async () => {
		const routes = {
			"https://example.com/": response("", {
				status: 302,
				headers: { location: "http://192.168.0.10/secret" },
			}),
		};
		const { result, fetchImpl } = await run({ url: "https://example.com/" }, { routes });
		expect(result.ok).toBe(false);
		expect(result.error).toContain("192.168.0.10");
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it("redacts the query string of redirect targets in the logs", async () => {
		const routes = {
			"https://example.com/download": response("", {
				status: 302,
				headers: { location: "https://cdn.example.com/file.txt?token=secret789" },
			}),
			"https://cdn.example.com/file.txt?token=secret789": response("content", {
				contentType: "text/plain",
			}),
		};
		const { result, logger } = await run({ url: "https://example.com/download" }, { routes });
		expect(result.ok).toBe(true);
		const logged = [
			...logger.info.mock.calls,
			...logger.debug.mock.calls,
			...logger.warn.mock.calls,
		]
			.flat()
			.map(String)
			.join("\n");
		expect(logged).toContain("redirected");
		expect(logged).not.toContain("secret789");
	});

	it("follows public redirects (relative Location included) and caps the hop count", async () => {
		const routes = {
			"https://example.com/old": response("", { status: 301, headers: { location: "/new" } }),
			"https://example.com/new": response("# Moved here", { contentType: "text/markdown" }),
			"https://loop.example.com/": response("", { status: 302, headers: { location: "/" } }),
		};
		const moved = await run({ url: "https://example.com/old" }, { routes });
		expect(moved.result.ok).toBe(true);
		expect(moved.result.finalUrl).toBe("https://example.com/new");
		expect(moved.result.content).toBe("# Moved here");

		const looped = await run({ url: "https://loop.example.com/" }, { routes });
		expect(looped.result.ok).toBe(false);
		expect(looped.result.error).toContain("redirects");
	});

	it("applies the allowed and blocked host lists as suffix matches", async () => {
		const routes = {
			"https://docs.example.com/": response("ok", { contentType: "text/plain" }),
			"https://evil.example.org/": response("ok", { contentType: "text/plain" }),
		};
		const allowed = await run(
			{ url: "https://docs.example.com/" },
			{ routes, config: { allowedHosts: ["example.com"] } }
		);
		expect(allowed.result.ok).toBe(true);

		const outside = await run(
			{ url: "https://evil.example.org/" },
			{ routes, config: { allowedHosts: ["example.com"] } }
		);
		expect(outside.result.ok).toBe(false);
		expect(outside.result.error).toContain("FETCH_URL_ALLOWED_HOSTS");

		const blocked = await run(
			{ url: "https://docs.example.com/" },
			{ routes, config: { blockedHosts: ["example.com"] } }
		);
		expect(blocked.result.ok).toBe(false);
		expect(blocked.result.error).toContain("FETCH_URL_BLOCKED_HOSTS");

		// A blocked host stays blocked even when allowed
		const both = await run(
			{ url: "https://docs.example.com/" },
			{ routes, config: { allowedHosts: ["example.com"], blockedHosts: ["docs.example.com"] } }
		);
		expect(both.result.ok).toBe(false);
	});

	it("exposes the policy check for callers", () => {
		expect(() => validateUrlPolicy("http://10.0.0.1/", baseConfig)).toThrow(/Refused/);
		expect(validateUrlPolicy("https://example.com/x", baseConfig).hostname).toBe("example.com");
	});
});

describe("limits", () => {
	it("refuses responses above the size cap, declared or streamed", async () => {
		const routes = {
			"https://big.example.com/declared": response("x", {
				contentType: "text/plain",
				headers: { "content-length": "5000000" },
			}),
			"https://big.example.com/streamed": response("x".repeat(3000), { contentType: "text/plain" }),
		};
		const declared = await run({ url: "https://big.example.com/declared" }, { routes });
		expect(declared.result.ok).toBe(false);
		expect(declared.result.error).toContain("FETCH_URL_MAX_BYTES");

		const streamed = await run(
			{ url: "https://big.example.com/streamed" },
			{ routes, config: { maxBytes: 2000 } }
		);
		expect(streamed.result.ok).toBe(false);
		expect(streamed.result.error).toContain("FETCH_URL_MAX_BYTES");
	});

	it("refuses binary and non-text content types with a clear note", async () => {
		const routes = {
			"https://example.com/report.pdf": response(Buffer.from("%PDF-1.7"), {
				contentType: "application/pdf",
			}),
		};
		const { result } = await run({ url: "https://example.com/report.pdf" }, { routes });
		expect(result.ok).toBe(false);
		expect(result.error).toContain("application/pdf");
		expect(result.error).toContain("not a text document");
	});

	it("refuses binary bodies served without or with a wrong Content-Type", async () => {
		const png = Buffer.concat([
			Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
			Buffer.alloc(64, 0),
		]);
		const routes = {
			"https://store.example.com/blob": response(
				Buffer.from("%PDF-1.7\n%\xe2\xe3\xcf\xd3", "latin1"),
				{
					contentType: null,
				}
			),
			"https://store.example.com/image": response(png, { contentType: "text/plain" }),
			"https://store.example.com/notes": response("just text, no header", { contentType: null }),
			"https://docs.example.com/page": response(HTML_PAGE),
			"https://docs.example.com/page.md": response(png, { contentType: "text/markdown" }),
		};
		const untyped = await run({ url: "https://store.example.com/blob" }, { routes });
		expect(untyped.result.ok).toBe(false);
		expect(untyped.result.error).toContain("binary document without a Content-Type");

		const mislabelled = await run({ url: "https://store.example.com/image" }, { routes });
		expect(mislabelled.result.ok).toBe(false);
		expect(mislabelled.result.error).toContain("labelled text/plain");

		// Untyped genuine text is still accepted
		const text = await run({ url: "https://store.example.com/notes" }, { routes });
		expect(text.result).toMatchObject({
			ok: true,
			source: "text",
			content: "just text, no header",
		});

		// A binary blob on the sibling .md path is skipped, not returned as Markdown
		const page = await run({ url: "https://docs.example.com/page" }, { routes });
		expect(page.result.source).toBe("html");
	});

	it("sniffs binary content by signature, NUL bytes and control-character density", () => {
		expect(looksBinary(Buffer.from("%PDF-1.4 ..."))).toBe(true);
		expect(looksBinary(Buffer.from([0x1f, 0x8b, 0x08, 0x00]))).toBe(true);
		expect(looksBinary(Buffer.from("PK\x03\x04rest", "latin1"))).toBe(true);
		// Two ASCII letters are not a signature: text may start with "MZ ..."
		expect(looksBinary(Buffer.from("MZ tools and configuration notes"))).toBe(false);
		expect(looksBinary(Buffer.from("abc\x00def", "latin1"))).toBe(true);
		expect(looksBinary(Buffer.from("\x01\x02\x03\x04\x05\x06\x07\x08 text", "latin1"))).toBe(true);
		expect(looksBinary(Buffer.from("﻿BOM then text"))).toBe(false);
		expect(looksBinary(Buffer.from("tabs\tand\nnewlines\r\nand\x1b[0mANSI are text"))).toBe(false);
		expect(looksBinary(Buffer.from("Café — naïve UTF-8 ✓"))).toBe(false);
		expect(looksBinary(new Uint8Array(0))).toBe(false);
	});

	it("caps the text handed to the model and says so", async () => {
		const routes = {
			"https://example.com/huge.txt": response("y".repeat(MAX_CONTENT_CHARS + 500), {
				contentType: "text/plain",
			}),
		};
		const { result } = await run({ url: "https://example.com/huge.txt" }, { routes });
		expect(result.ok).toBe(true);
		expect(result.truncated).toBe(true);
		expect(result.chars).toBeLessThanOrEqual(MAX_CONTENT_CHARS);
		expect(result.chars).toBeGreaterThan(MAX_CONTENT_CHARS - 10);
		expect(result.totalChars).toBe(MAX_CONTENT_CHARS + 500);

		// The cap bounds the SERIALIZED size: a body of quotes doubles when JSON-escaped
		const quotes = await run(
			{ url: "https://example.com/quotes.txt" },
			{
				routes: {
					"https://example.com/quotes.txt": response('"'.repeat(700000), {
						contentType: "text/plain",
					}),
				},
			}
		);
		expect(quotes.result.truncated).toBe(true);
		expect(JSON.stringify(quotes.result.content).length).toBeLessThanOrEqual(MAX_CONTENT_CHARS);
		expect(quotes.result.chars).toBeGreaterThan(MAX_CONTENT_CHARS / 2 - 10);
	});

	it("stages the complete text for the sandbox when the inline content had to be cut", async () => {
		const staged = new Map();
		const body = '"'.repeat(700000);
		const fetchImpl = makeFetch({
			"https://example.com/quotes.txt": response(body, { contentType: "text/plain" }),
		});
		const result = await executeFetchUrl(
			{ url: "https://example.com/quotes.txt" },
			{ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
			{
				fetchImpl,
				lookup: publicLookup,
				config: baseConfig,
				stageText: (text, toolName) => {
					const name = `${toolName}_full.txt`;
					staged.set(name, text);
					return name;
				},
			}
		);
		expect(result.truncated).toBe(true);
		expect(result.fullTextFile).toBe("fetch_url_full.txt");
		expect(staged.get("fetch_url_full.txt")).toBe(body);
		expect(result.hint).toContain("/data/fetch_url_full.txt");
		// Without a staging hook nothing is promised
		const plain = await run(
			{ url: "https://example.com/quotes.txt" },
			{
				routes: { "https://example.com/quotes.txt": response(body, { contentType: "text/plain" }) },
			}
		);
		expect(plain.result.fullTextFile).toBeUndefined();
	});

	it("ignores meta charset declarations inside comments and script bodies", async () => {
		const utf8 = Buffer.from(
			'<html><head><!-- <meta charset="windows-1252"> --><script>var s = \'<meta charset="windows-1252">\';</script><title>Café</title></head><body><p>Café</p></body></html>',
			"utf8"
		);
		const routes = { "https://example.com/inert": response(utf8, { contentType: "text/html" }) };
		const { result } = await run({ url: "https://example.com/inert" }, { routes });
		expect(result.title).toBe("Café");
		expect(result.content).toContain("Café");
	});

	it("does not mistake '<!--' inside a quoted attribute for a comment when sniffing the charset", async () => {
		// To the tokenizer the "<!--" in the title attribute is text: the meta that
		// follows is live and the page is Windows-1252, not UTF-8
		const latin = Buffer.from(
			'<html><head><div title="<!--"><meta charset="windows-1252"><!-- --></head><body><p>Caf\xe9</p></body></html>',
			"latin1"
		);
		const routes = { "https://example.com/quoted": response(latin, { contentType: "text/html" }) };
		const { result } = await run({ url: "https://example.com/quoted" }, { routes });
		expect(result.content).toContain("Café");
	});

	it("does not mistake 'charset=' inside another attribute's value for a declaration", async () => {
		const utf8 = Buffer.from(
			'<html><head><meta name="description" content="Example of charset=windows-1252 pages"><title>Café</title></head><body><p>Café</p></body></html>',
			"utf8"
		);
		const routes = { "https://example.com/desc": response(utf8, { contentType: "text/html" }) };
		const { result } = await run({ url: "https://example.com/desc" }, { routes });
		expect(result.title).toBe("Café");
		expect(result.content).toContain("Café");
		// The http-equiv form still counts
		const latin = Buffer.from(
			'<html><head><meta http-equiv="Content-Type" content="text/html; charset=windows-1252"></head><body><p>Caf\xe9</p></body></html>',
			"latin1"
		);
		const equiv = await run(
			{ url: "https://example.com/equiv" },
			{ routes: { "https://example.com/equiv": response(latin, { contentType: "text/html" }) } }
		);
		expect(equiv.result.content).toContain("Café");
	});

	it("reports HTTP errors and network failures without throwing", async () => {
		const routes = {
			"https://example.com/missing": notFound(),
			"https://example.com/private": response("", { status: 403 }),
			"https://example.com/boom": () => {
				throw new TypeError("fetch failed", { cause: new Error("ECONNREFUSED") });
			},
		};
		expect((await run({ url: "https://example.com/missing" }, { routes })).result).toMatchObject({
			ok: false,
			error: expect.stringContaining("HTTP 404"),
		});
		expect((await run({ url: "https://example.com/private" }, { routes })).result).toMatchObject({
			ok: false,
			hint: expect.stringContaining("authentication"),
		});
		expect((await run({ url: "https://example.com/boom" }, { routes })).result).toMatchObject({
			ok: false,
			error: expect.stringContaining("ECONNREFUSED"),
		});
	});
});

describe("transport hardening", () => {
	it("hides unexpected internal errors from the model, keeping them in the logs", async () => {
		const routes = {
			"https://example.com/odd": () => ({
				...response("x", { contentType: "text/plain" }),
				arrayBuffer: async () => {
					throw new TypeError("ENOENT: /srv/m8b/internal/secret-path.js exploded");
				},
			}),
		};
		const { result, logger } = await run({ url: "https://example.com/odd" }, { routes });
		expect(result.ok).toBe(false);
		expect(result.error).toContain("unexpectedly");
		expect(result.error).not.toContain("secret-path");
		expect(result.error).not.toContain("ENOENT");
		expect(logger.error).toHaveBeenCalledWith(
			expect.stringContaining("Unexpected failure"),
			expect.objectContaining({ error: expect.stringContaining("secret-path") })
		);
	});

	it("accepts UTF-16 text (declared charset or BOM) despite its NUL bytes", async () => {
		const declared = Buffer.from("Hello UTF-16 world\nline two", "utf16le");
		const withBom = Buffer.concat([Buffer.from([0xff, 0xfe]), declared]);
		const routes = {
			"https://example.com/utf16.txt": response(declared, {
				contentType: "text/plain; charset=utf-16le",
			}),
			"https://example.com/bom.txt": response(withBom, { contentType: "text/plain" }),
			// Code units 0x0001 (control characters) once decoded as UTF-16LE
			"https://example.com/really-binary": response(
				Buffer.from(Array.from({ length: 400 }, (_, i) => (i % 2 === 0 ? 0x01 : 0x00))),
				{ contentType: "text/plain; charset=utf-16le" }
			),
		};
		const declaredResult = await run({ url: "https://example.com/utf16.txt" }, { routes });
		expect(declaredResult.result.ok).toBe(true);
		expect(declaredResult.result.content).toBe("Hello UTF-16 world\nline two");

		const bomResult = await run({ url: "https://example.com/bom.txt" }, { routes });
		expect(bomResult.result.ok).toBe(true);
		expect(bomResult.result.content).toContain("Hello UTF-16 world");

		// A UTF-16 label does not launder actual binary data
		const binary = await run({ url: "https://example.com/really-binary" }, { routes });
		expect(binary.result.ok).toBe(false);
		expect(looksBinary(Buffer.from("plain", "utf16le"), "utf-16")).toBe(false);
		// A charset label cannot launder a known binary format
		expect(looksBinary(Buffer.from("%PDF-1.7 ..."), "utf-16le")).toBe(true);
		expect(looksBinary(Buffer.from("PK\x03\x04rest", "latin1"), "utf-16")).toBe(true);
		expect(looksBinary(Buffer.from("plain", "utf16le"))).toBe(true);
	});

	it("cancels the body of a response rejected on its declared size", async () => {
		const cancel = jest.fn(async () => {});
		const routes = {
			"https://big.example.com/": () => ({
				...response("x", { contentType: "text/plain", headers: { "content-length": "9000000" } }),
				body: { cancel },
			}),
		};
		const { result } = await run({ url: "https://big.example.com/" }, { routes });
		expect(result.ok).toBe(false);
		expect(cancel).toHaveBeenCalledTimes(1);
	});

	it("bounds the preliminary DNS lookup by the request timeout", async () => {
		const stalled = jest.fn(() => new Promise(() => {}));
		const started = Date.now();
		const { result, fetchImpl } = await run(
			{ url: "https://slow-dns.example.com/" },
			{ lookup: stalled, config: { timeoutMs: 80 } }
		);
		expect(Date.now() - started).toBeLessThan(2000);
		expect(result.ok).toBe(false);
		expect(result.error).toContain("DNS resolution of slow-dns.example.com timed out");
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("drops credentials when a redirect leaves the origin", async () => {
		const seen = [];
		const routes = {
			"https://api.github.com/repos/acme/tool/issues/12": (init) => {
				seen.push(init.headers.Authorization);
				return response("", {
					status: 302,
					headers: { location: "https://mirror.example.net/issue.json" },
				});
			},
			"https://mirror.example.net/issue.json": (init) => {
				seen.push(init.headers.Authorization);
				return response(JSON.stringify({ number: 12, title: "T", state: "open" }), {
					contentType: "application/json",
				});
			},
			"https://mirror.example.net/repos/acme/tool/issues/12/comments?per_page=100": response("[]", {
				contentType: "application/json",
			}),
		};
		await run(
			{ url: "https://github.com/acme/tool/issues/12" },
			{ routes, config: { githubToken: "ghp_secret" } }
		);
		expect(seen[0]).toBe("Bearer ghp_secret");
		expect(seen[1]).toBeUndefined();
	});

	it("drops the GitHub token when a same-origin redirect lands on an out-of-scope repository", async () => {
		// A renamed/transferred repository: GitHub redirects /repos/acme/tool to /repos/other/tool
		const seen = [];
		const routes = {
			"https://api.github.com/repos/acme/tool/issues/12": (init) => {
				seen.push(init.headers.Authorization);
				return response("", {
					status: 301,
					headers: { location: "https://api.github.com/repos/other/tool/issues/12" },
				});
			},
			"https://api.github.com/repos/other/tool/issues/12": (init) => {
				seen.push(init.headers.Authorization);
				return response(JSON.stringify({ number: 12, title: "T", state: "open" }), {
					contentType: "application/json",
				});
			},
			"https://api.github.com/repos/acme/tool/issues/12/comments?per_page=100": response("[]", {
				contentType: "application/json",
			}),
		};
		await run(
			{ url: "https://github.com/acme/tool/issues/12" },
			{ routes, config: { githubToken: "ghp_secret", githubTokenRepos: ["acme/*"] } }
		);
		expect(seen).toEqual(["Bearer ghp_secret", undefined]);
	});

	it("keeps the derived-host exemption on a same-host redirect (repository rename)", async () => {
		// Only github.com is allowed; api.github.com is reached as a derived host,
		// and GitHub's rename redirect stays on api.github.com
		const routes = {
			"https://api.github.com/repos/acme/old-name/issues/12": response("", {
				status: 301,
				headers: { location: "https://api.github.com/repos/acme/tool/issues/12" },
			}),
			"https://api.github.com/repos/acme/tool/issues/12": response(
				JSON.stringify({ number: 12, title: "Renamed", state: "open" }),
				{ contentType: "application/json" }
			),
			"https://api.github.com/repos/acme/old-name/issues/12/comments?per_page=100": response("[]", {
				contentType: "application/json",
			}),
		};
		const { result } = await run(
			{ url: "https://github.com/acme/old-name/issues/12" },
			{ routes, config: { allowedHosts: ["github.com"] } }
		);
		expect(result.ok).toBe(true);
		expect(result.title).toBe("Renamed");

		// Leaving the derived host puts the full policy back
		const away = await run(
			{ url: "https://github.com/acme/old-name/issues/12" },
			{
				routes: {
					"https://api.github.com/repos/acme/old-name/issues/12": response("", {
						status: 302,
						headers: { location: "https://mirror.example.net/x" },
					}),
				},
				config: { allowedHosts: ["github.com"] },
			}
		);
		expect(away.result.ok).toBe(false);
		expect(away.result.error).toContain("FETCH_URL_ALLOWED_HOSTS");
	});

	it("drops the token on a redirect to a numeric /repositories/{id} route", async () => {
		// The destination does not name its repository, so the scope cannot be checked
		const seen = [];
		const routes = {
			"https://api.github.com/repos/acme/tool/issues/12": (init) => {
				seen.push(init.headers.Authorization);
				return response("", {
					status: 301,
					headers: { location: "https://api.github.com/repositories/98765/issues/12" },
				});
			},
			"https://api.github.com/repositories/98765/issues/12": (init) => {
				seen.push(init.headers.Authorization);
				return response(JSON.stringify({ number: 12, title: "T", state: "open" }), {
					contentType: "application/json",
				});
			},
			"https://api.github.com/repos/acme/tool/issues/12/comments?per_page=100": response("[]", {
				contentType: "application/json",
			}),
		};
		await run(
			{ url: "https://github.com/acme/tool/issues/12" },
			{ routes, config: { githubToken: "ghp_secret", githubTokenRepos: ["acme/*"] } }
		);
		expect(seen).toEqual(["Bearer ghp_secret", undefined]);
	});

	it("keeps credentials on a same-origin redirect", async () => {
		const seen = [];
		const routes = {
			"https://api.github.com/repos/acme/tool/issues/12": (init) => {
				seen.push(init.headers.Authorization);
				return response("", { status: 301, headers: { location: "/repos/acme/tool/issues/12/" } });
			},
			"https://api.github.com/repos/acme/tool/issues/12/": (init) => {
				seen.push(init.headers.Authorization);
				return response(JSON.stringify({ number: 12, title: "T", state: "open" }), {
					contentType: "application/json",
				});
			},
			"https://api.github.com/repos/acme/tool/issues/12/comments?per_page=100": response("[]", {
				contentType: "application/json",
			}),
		};
		await run(
			{ url: "https://github.com/acme/tool/issues/12" },
			{ routes, config: { githubToken: "ghp_secret" } }
		);
		expect(seen).toEqual(["Bearer ghp_secret", "Bearer ghp_secret"]);
	});

	it("routes HTML mislabelled as text/plain through the HTML reader", async () => {
		const routes = {
			"https://misconfigured.example.com/": response(
				`<body><nav>Menu</nav><main><h1>Title</h1><p>${"Body text. ".repeat(30)}</p></main></body>`,
				{ contentType: "text/plain" }
			),
			"https://preamble.example.com/": response(
				`\n<!-- generated -->\n<!DOCTYPE html><html><body><p>${"Paragraph. ".repeat(30)}</p></body></html>`,
				{ contentType: "text/plain" }
			),
			// A tutorial that merely mentions markup is the plain text it claims to be
			"https://tutorial.example.com/notes.txt": response(
				`Step 1: open the file.\nStep 2: write <html><body>Hello</body></html> into it.\nStep 3: <script>alert(1)</script> is not allowed.`,
				{ contentType: "text/plain" }
			),
		};
		const body = await run({ url: "https://misconfigured.example.com/" }, { routes });
		expect(body.result.source).toBe("html");
		expect(body.result.content).toContain("# Title");
		expect(body.result.content).not.toContain("<nav>");
		expect(body.result.content).not.toContain("Menu");

		const preamble = await run({ url: "https://preamble.example.com/" }, { routes });
		expect(preamble.result.source).toBe("html");
		expect(preamble.result.content).not.toContain("<html>");

		const tutorial = await run({ url: "https://tutorial.example.com/notes.txt" }, { routes });
		expect(tutorial.result.source).toBe("text");
		expect(tutorial.result.content).toContain("<script>alert(1)</script> is not allowed");
	});
});

describe("content negotiation", () => {
	it("sends a Markdown-first Accept header and uses a Markdown response as-is", async () => {
		const routes = {
			"https://docs.example.com/guide": response("# Guide\n\nHello.", {
				contentType: "text/markdown; charset=utf-8",
			}),
		};
		const { result, fetchImpl } = await run({ url: "https://docs.example.com/guide" }, { routes });
		expect(result).toMatchObject({
			ok: true,
			source: "markdown",
			url: "https://docs.example.com/guide",
			finalUrl: "https://docs.example.com/guide",
			content: "# Guide\n\nHello.",
		});
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		const init = fetchImpl.mock.calls[0][1];
		expect(init.headers.Accept).toMatch(/^text\/markdown/);
		expect(init.headers.Accept).toContain("text/html");
		expect(init.redirect).toBe("manual");
		expect(init.headers["User-Agent"]).toContain("M8B");
	});

	it("uses plain text responses directly", async () => {
		const routes = {
			"https://example.com/robots.txt": response("User-agent: *\nDisallow:", {
				contentType: "text/plain",
			}),
		};
		const { result } = await run({ url: "https://example.com/robots.txt" }, { routes });
		expect(result.source).toBe("text");
		expect(result.content).toBe("User-agent: *\nDisallow:");
	});

	it("prefers the sibling .md rendition of an HTML page", async () => {
		const routes = {
			"https://docs.example.com/guide/install.html": response(HTML_PAGE),
			"https://docs.example.com/guide/install.md": response("# Install\n\nFrom Markdown.", {
				contentType: "text/markdown",
			}),
		};
		const { result, fetchImpl } = await run(
			{ url: "https://docs.example.com/guide/install.html" },
			{ routes }
		);
		expect(result).toMatchObject({
			ok: true,
			source: "markdown",
			title: "Guide",
			finalUrl: "https://docs.example.com/guide/install.md",
			content: "# Install\n\nFrom Markdown.",
		});
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});

	it("looks for index.html.md on directory URLs", async () => {
		const routes = {
			"https://docs.example.com/guide/": response(HTML_PAGE),
			"https://docs.example.com/guide/index.html.md": response("# Dir", {
				contentType: "text/plain",
			}),
		};
		const { result } = await run({ url: "https://docs.example.com/guide/" }, { routes });
		expect(result.source).toBe("markdown");
		expect(result.content).toBe("# Dir");
	});

	it("ignores an HTML answer on the .md path (SPA fallback) and consults llms.txt", async () => {
		const routes = {
			"https://docs.example.com/guide/install": response(HTML_PAGE),
			"https://docs.example.com/guide/install.md": response(HTML_PAGE),
			// The index maps the site's pages to a Markdown mirror on another host
			"https://docs.example.com/llms.txt": response(
				"# Docs\n\n- [Other](https://md.example.com/guide/other.html.md)\n- [Install](https://md.example.com/guide/install.html.md): how to install",
				{ contentType: "text/plain" }
			),
			"https://md.example.com/guide/install.html.md": response("# Install via llms.txt", {
				contentType: "text/markdown",
			}),
		};
		const { result, fetchImpl } = await run(
			{ url: "https://docs.example.com/guide/install" },
			{ routes }
		);
		expect(result.source).toBe("llms.txt");
		expect(result.content).toBe("# Install via llms.txt");
		expect(result.finalUrl).toBe("https://md.example.com/guide/install.html.md");
		expect(fetchImpl.mock.calls.map((call) => String(call[0]))).toEqual([
			"https://docs.example.com/guide/install",
			"https://docs.example.com/guide/install.md",
			"https://docs.example.com/llms.txt",
			"https://md.example.com/guide/install.html.md",
		]);
	});

	it("falls back to the HTML page reduced to text", async () => {
		const routes = { "https://docs.example.com/guide/install": response(HTML_PAGE) };
		const { result, fetchImpl } = await run(
			{ url: "https://docs.example.com/guide/install" },
			{ routes }
		);
		expect(result).toMatchObject({ ok: true, source: "html", title: "Guide" });
		expect(result.content).toContain("# Guide");
		expect(result.content).toContain("Real content.");
		expect(result.content).not.toContain("Menu");
		expect(result.content).not.toContain("x()");
		// page, sibling .md, llms.txt — then no more guessing
		expect(fetchImpl).toHaveBeenCalledTimes(3);
	});

	it("hands over JSON and XML verbatim", async () => {
		const routes = {
			"https://api.example.com/status": response('{"ok":true}', {
				contentType: "application/json",
			}),
		};
		const { result } = await run({ url: "https://api.example.com/status" }, { routes });
		expect(result.source).toBe("text");
		expect(result.content).toBe('{"ok":true}');
	});

	it("decodes legacy charsets from the header or the meta tag", async () => {
		const latin = Buffer.from(
			'<html><head><meta charset="iso-8859-1"><title>Caf\xe9</title></head><body><p>Caf\xe9</p></body></html>',
			"latin1"
		);
		const routes = {
			"https://example.com/latin": response(latin, { contentType: "text/html" }),
		};
		const { result } = await run({ url: "https://example.com/latin" }, { routes });
		expect(result.title).toBe("Café");
		expect(result.content).toContain("Café");
	});

	it("honours the XML encoding declaration when the HTTP charset is missing", async () => {
		const latinXml = Buffer.from(
			'<?xml version="1.0" encoding="iso-8859-1"?><rss><channel><title>Caf\xe9 du march\xe9</title></channel></rss>',
			"latin1"
		);
		const routes = {
			"https://example.com/feed.xml": response(latinXml, { contentType: "application/rss+xml" }),
			"https://example.com/data.xml": response(latinXml, { contentType: "text/xml" }),
		};
		for (const url of ["https://example.com/feed.xml", "https://example.com/data.xml"]) {
			const { result } = await run({ url }, { routes });
			expect(result.ok).toBe(true);
			expect(result.source).toBe("text");
			expect(result.content).toContain("Café du marché");
		}
	});

	it("lets a UTF-8 byte-order mark override a wrong declared charset", async () => {
		// WHATWG decode: the BOM is sniffed before any label, so a UTF-8 document
		// served as windows-1252 (or declaring it in a meta tag) is still UTF-8
		const bom = Buffer.from([0xef, 0xbb, 0xbf]);
		const html = Buffer.concat([
			bom,
			Buffer.from(
				'<html><head><meta charset="windows-1252"></head><body><p>Café du marché</p></body></html>',
				"utf8"
			),
		]);
		const text = Buffer.concat([bom, Buffer.from("Café du marché", "utf8")]);
		const routes = {
			"https://example.com/page": response(html, {
				contentType: "text/html; charset=windows-1252",
			}),
			"https://example.com/note.txt": response(text, {
				contentType: "text/plain; charset=iso-8859-1",
			}),
		};
		for (const url of ["https://example.com/page", "https://example.com/note.txt"]) {
			const { result } = await run({ url }, { routes });
			expect(result.ok).toBe(true);
			expect(result.content).toContain("Café du marché");
			expect(result.content).not.toContain("Ã");
			expect(result.content).not.toContain("\uFEFF");
			expect(result.content).not.toContain("ï»¿");
		}
	});

	it("accepts whitespace in the HTTP charset parameter", async () => {
		const latin = Buffer.from("<html><body><p>Caf\xe9 du march\xe9</p></body></html>", "latin1");
		const routes = {
			"https://example.com/spaced-header": response(latin, {
				contentType: "text/html; charset = windows-1252",
			}),
		};
		const { result } = await run({ url: "https://example.com/spaced-header" }, { routes });
		expect(result.content).toContain("Café du marché");
	});

	it("accepts whitespace around the meta charset assignment", async () => {
		const latin = Buffer.from(
			'<html><head><meta charset = "windows-1252"><title>Caf\xe9</title></head><body><p>Caf\xe9</p></body></html>',
			"latin1"
		);
		const routes = { "https://example.com/spaced": response(latin, { contentType: "text/html" }) };
		const { result } = await run({ url: "https://example.com/spaced" }, { routes });
		expect(result.title).toBe("Café");
		expect(result.content).toContain("Café");
	});

	it("caps a hostile title so the body is still delivered", async () => {
		const page = `<html><head><title>${"T".repeat(500000)}</title></head><body><p>${"Body. ".repeat(30)}</p></body></html>`;
		const routes = { "https://example.com/long-title": response(page) };
		const { result } = await run({ url: "https://example.com/long-title" }, { routes });
		expect(result.ok).toBe(true);
		expect(result.title.length).toBeLessThanOrEqual(300);
		expect(result.content).toContain("Body.");
	});

	it("ignores XML encoding declarations that are not at the start of the document", async () => {
		const utf8 = Buffer.from(
			'<rss><!-- example: <?xml version="1.0" encoding="windows-1252"?> --><channel><title>Café</title></channel></rss>',
			"utf8"
		);
		const routes = {
			"https://example.com/feed.xml": response(utf8, { contentType: "application/rss+xml" }),
		};
		const { result } = await run({ url: "https://example.com/feed.xml" }, { routes });
		expect(result.content).toContain("Café");
		// A UTF-8 BOM ahead of the declaration wins over it: the document IS UTF-8,
		// whatever the (contradicting) declaration says
		const bom = Buffer.concat([
			Buffer.from([0xef, 0xbb, 0xbf]),
			Buffer.from(
				'<?xml version="1.0" encoding="windows-1252"?><rss><title>Café</title></rss>',
				"utf8"
			),
		]);
		const withBom = await run(
			{ url: "https://example.com/bom.xml" },
			{ routes: { "https://example.com/bom.xml": response(bom, { contentType: "text/xml" }) } }
		);
		expect(withBom.result.content).toContain("Café");
	});

	it("ignores HTML meta charset declarations inside XML documents", async () => {
		// An Atom entry embedding XHTML with <meta charset="windows-1252">: the feed
		// is UTF-8 and HTML meta declarations have no authority over XML
		const feed = Buffer.from(
			'<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><entry><content type="xhtml">' +
				'<div xmlns="http://www.w3.org/1999/xhtml"><meta charset="windows-1252"/><p>Café du marché</p></div>' +
				"</content></entry></feed>",
			"utf8"
		);
		const routes = {
			"https://example.com/feed.xml": response(feed, { contentType: "application/atom+xml" }),
			"https://example.com/data.xml": response(feed, { contentType: "text/xml" }),
		};
		for (const url of ["https://example.com/feed.xml", "https://example.com/data.xml"]) {
			const { result } = await run({ url }, { routes });
			expect(result.ok).toBe(true);
			expect(result.content).toContain("Café du marché");
		}
		// The same meta element still decides for an HTML document without an HTTP charset
		const html = Buffer.from(
			'<html><head><meta charset="windows-1252"><title>Caf\xe9</title></head><body><p>Caf\xe9</p></body></html>',
			"latin1"
		);
		const page = await run(
			{ url: "https://example.com/page" },
			{ routes: { "https://example.com/page": response(html, { contentType: "text/html" }) } }
		);
		expect(page.result.content).toContain("Café");
	});

	it("accepts whitespace around the XML encoding assignment", async () => {
		const latinXml = Buffer.from(
			'<?xml version="1.0" encoding = "windows-1252"?><rss><channel><title>Caf\xe9</title></channel></rss>',
			"latin1"
		);
		const routes = {
			"https://example.com/spaced.xml": response(latinXml, { contentType: "application/rss+xml" }),
		};
		const { result } = await run({ url: "https://example.com/spaced.xml" }, { routes });
		expect(result.content).toContain("Café");
	});

	it("leaves entity-looking text in a bare URL untouched", async () => {
		// Only Slack's <url|label> form is escaped; a bare URL may name "/R&amp;D" for real
		const seen = [];
		const routes = {
			"https://example.com/R&amp;D": (_init, url) => {
				seen.push(url);
				return response("dept", { contentType: "text/plain" });
			},
		};
		const { result } = await run({ url: "https://example.com/R&amp;D" }, { routes });
		expect(result.ok).toBe(true);
		expect(seen).toEqual(["https://example.com/R&amp;D"]);
	});

	it("decodes Slack's escaped entities inside a wrapped URL", async () => {
		const seen = [];
		const routes = {
			"https://example.com/search?a=1&b=2": (_init, url) => {
				seen.push(url);
				return response("results", { contentType: "text/plain" });
			},
		};
		const { result } = await run(
			{ url: "<https://example.com/search?a=1&amp;b=2|example.com>" },
			{ routes }
		);
		expect(result.ok).toBe(true);
		expect(seen).toEqual(["https://example.com/search?a=1&b=2"]);
	});

	it("never logs the query string of a Markdown candidate (signed URLs, tokens)", async () => {
		const routes = {
			"https://docs.example.com/guide?token=secret123": response(HTML_PAGE),
			"https://docs.example.com/guide.md?token=secret123": response("# Guide", {
				contentType: "text/markdown",
			}),
			"https://other.example.com/page?sig=secret456": response(HTML_PAGE),
			// Unusable candidate (HTML on the .md path) → debug log path
			"https://other.example.com/page.md?sig=secret456": response(HTML_PAGE),
		};
		const found = await run({ url: "https://docs.example.com/guide?token=secret123" }, { routes });
		expect(found.result.source).toBe("markdown");
		const unusable = await run({ url: "https://other.example.com/page?sig=secret456" }, { routes });
		expect(unusable.result.source).toBe("html");
		for (const { logger } of [found, unusable]) {
			const logged = [
				...logger.info.mock.calls,
				...logger.debug.mock.calls,
				...logger.warn.mock.calls,
			]
				.flat()
				.map(String)
				.join("\n");
			expect(logged).not.toContain("secret123");
			expect(logged).not.toContain("secret456");
		}
	});

	it("keeps the query string on Markdown alternatives and skips llms.txt for queried pages", async () => {
		const routes = {
			"https://docs.example.com/guide?version=2": response(HTML_PAGE),
			"https://docs.example.com/guide.md?version=2": response("# Guide v2", {
				contentType: "text/markdown",
			}),
			// The default rendition must NOT be preferred over the requested version
			"https://docs.example.com/guide.md": response("# Guide v1", { contentType: "text/markdown" }),
			"https://docs.example.com/llms.txt": response(
				"- [Guide](https://docs.example.com/guide.md)",
				{
					contentType: "text/plain",
				}
			),
		};
		const withSibling = await run({ url: "https://docs.example.com/guide?version=2" }, { routes });
		expect(withSibling.result.source).toBe("markdown");
		expect(withSibling.result.content).toBe("# Guide v2");
		expect(withSibling.result.finalUrl).toBe("https://docs.example.com/guide.md?version=2");

		// No queried sibling: llms.txt is not consulted, the HTML itself is converted
		const noSibling = await run(
			{ url: "https://docs.example.com/guide?version=2" },
			{
				routes: {
					"https://docs.example.com/guide?version=2": response(HTML_PAGE),
					"https://docs.example.com/llms.txt": routes["https://docs.example.com/llms.txt"],
					"https://docs.example.com/guide.md": routes["https://docs.example.com/guide.md"],
				},
			}
		);
		expect(noSibling.result.source).toBe("html");
		expect(noSibling.fetchImpl.mock.calls.map((call) => String(call[0]))).toEqual([
			"https://docs.example.com/guide?version=2",
			"https://docs.example.com/guide.md?version=2",
		]);
	});

	it("unwraps Slack link syntax", async () => {
		const routes = {
			"https://example.com/page": response("plain", { contentType: "text/plain" }),
		};
		const { result } = await run(
			{ url: "<https://example.com/page|example.com/page>" },
			{ routes }
		);
		expect(result.ok).toBe(true);
		expect(result.url).toBe("https://example.com/page");
	});
});

describe("markdownSiblingUrl / findLlmsTxtEntry", () => {
	it("derives the llms.txt-convention sibling", () => {
		const sibling = (url) => markdownSiblingUrl(new URL(url));
		expect(sibling("https://d.example/docs/page")).toBe("https://d.example/docs/page.md");
		// The query stays (it may select the content), the fragment goes
		expect(sibling("https://d.example/docs/page.html?x=1#top")).toBe(
			"https://d.example/docs/page.md?x=1"
		);
		expect(sibling("https://d.example/docs/")).toBe("https://d.example/docs/index.html.md");
		expect(sibling("https://d.example")).toBe("https://d.example/index.html.md");
		expect(sibling("https://d.example/docs/page.md")).toBeNull();
		expect(sibling("https://d.example/notes.txt")).toBeNull();
	});

	it("parses llms.txt links in one linear pass, hostile input included", () => {
		expect(
			llmsTxtLinks("- [A](https://d.example/a.md): x\n- https://d.example/b.md\n[C](/c.md)")
		).toEqual(["https://d.example/a.md", "/c.md", "https://d.example/b.md"]);
		// Candidates with whitespace before the ")" are not links
		expect(llmsTxtLinks("[A](https://d.example/a b.md)")).toEqual([]);
		// A flood of "](" with no closing ")" must not make the scan quadratic
		const flood = "](".repeat(500000);
		const started = Date.now();
		expect(llmsTxtLinks(flood)).toEqual([]);
		expect(Date.now() - started).toBeLessThan(1000);
		expect(findLlmsTxtEntry(flood, new URL("https://d.example/x"))).toBeNull();
	});

	it("keeps path case when matching llms.txt entries (case-sensitive sites)", () => {
		const index = "- [g](https://d.example/guide.md)\n- [G](https://d.example/Guide.md)";
		expect(findLlmsTxtEntry(index, new URL("https://d.example/Guide"))).toBe(
			"https://d.example/Guide.md"
		);
		expect(findLlmsTxtEntry(index, new URL("https://d.example/guide"))).toBe(
			"https://d.example/guide.md"
		);
	});

	it("matches llms.txt entries by page path, tolerating .html and trailing slashes", () => {
		const index = [
			"# Project",
			"",
			"- [Install](https://d.example/docs/install.md): setup",
			"- [Config](/docs/config/index.html.md)",
			"- https://d.example/docs/faq.md",
		].join("\n");
		const find = (url) => findLlmsTxtEntry(index, new URL(url));
		expect(find("https://d.example/docs/install")).toBe("https://d.example/docs/install.md");
		expect(find("https://d.example/docs/install.html")).toBe("https://d.example/docs/install.md");
		expect(find("https://d.example/docs/config/")).toBe(
			"https://d.example/docs/config/index.html.md"
		);
		expect(find("https://d.example/docs/faq")).toBe("https://d.example/docs/faq.md");
		expect(find("https://d.example/docs/unknown")).toBeNull();
		expect(findLlmsTxtEntry("", new URL("https://d.example/x"))).toBeNull();
	});
});

describe("GitHub", () => {
	const issue = {
		number: 12,
		title: "Collector crashes on empty config",
		state: "open",
		user: { login: "alice" },
		created_at: "2026-08-30T10:00:00Z",
		labels: [{ name: "bug" }],
		html_url: "https://github.com/acme/tool/issues/12",
		repository_url: "https://api.github.com/repos/acme/tool",
		body: "Steps: run with an empty file.\n\nExpected: a clear error.",
	};
	const comments = [
		{ user: { login: "bob" }, created_at: "2026-08-31T09:00:00Z", body: "Reproduced on 3.2." },
	];

	it("parses issue, pull request and blob URLs", () => {
		expect(
			parseGitHubUrl(new URL("https://github.com/acme/tool/issues/12#issuecomment-1"))
		).toEqual({
			kind: "issue",
			owner: "acme",
			repo: "tool",
			number: 12,
		});
		expect(parseGitHubUrl(new URL("https://github.com/acme/tool/pull/7/files"))).toMatchObject({
			kind: "pull",
			number: 7,
		});
		expect(parseGitHubUrl(new URL("https://github.com/acme/tool/blob/main/src/a.js"))).toEqual({
			kind: "blob",
			owner: "acme",
			repo: "tool",
			ref: "main",
			path: "src/a.js",
			segments: ["main", "src", "a.js"],
			rawUrl: "https://raw.githubusercontent.com/acme/tool/main/src/a.js",
		});
		// Percent-encoded path segments are decoded once
		expect(
			parseGitHubUrl(new URL("https://github.com/acme/tool/blob/v1.0/docs/guide v2.md"))
		).toMatchObject({ ref: "v1.0", path: "docs/guide v2.md" });
		expect(parseGitHubUrl(new URL("https://github.com/acme/tool"))).toBeNull();
		expect(parseGitHubUrl(new URL("https://github.com/acme/tool/issues"))).toBeNull();
		expect(parseGitHubUrl(new URL("https://gitlab.com/acme/tool/issues/12"))).toBeNull();
	});

	it("reads an issue and its comments through the REST API, sending the token only there", async () => {
		const routes = {
			"https://api.github.com/repos/acme/tool/issues/12": (init) => {
				expect(init.headers.Authorization).toBe("Bearer ghp_test");
				expect(init.headers.Accept).toBe("application/vnd.github+json");
				return response(JSON.stringify(issue), { contentType: "application/json" });
			},
			"https://api.github.com/repos/acme/tool/issues/12/comments?per_page=100": response(
				JSON.stringify(comments),
				{ contentType: "application/json" }
			),
		};
		const { result, fetchImpl } = await run(
			{ url: "https://github.com/acme/tool/issues/12" },
			{ routes, config: { githubToken: "ghp_test" } }
		);
		expect(result).toMatchObject({
			ok: true,
			source: "github",
			title: "Collector crashes on empty config",
			url: "https://github.com/acme/tool/issues/12",
			finalUrl: "https://github.com/acme/tool/issues/12",
		});
		expect(result.content).toContain("# Collector crashes on empty config (#12)");
		expect(result.content).toContain("Issue in acme/tool");
		expect(result.content).toContain("State: open");
		expect(result.content).toContain("Author: @alice");
		expect(result.content).toContain("Labels: bug");
		expect(result.content).toContain("Steps: run with an empty file.");
		expect(result.content).toContain("## Comments (1)");
		expect(result.content).toContain("### @bob — 2026-08-31");
		expect(result.content).toContain("Reproduced on 3.2.");
		expect(fetchImpl).toHaveBeenCalledTimes(2);
		expect(
			fetchImpl.mock.calls.every((call) => String(call[0]).startsWith("https://api.github.com/"))
		).toBe(true);
	});

	it("reads a pull request with its reviews", async () => {
		const pull = {
			...issue,
			number: 7,
			title: "Fix empty config crash",
			merged: true,
			state: "closed",
			html_url: "https://github.com/acme/tool/pull/7",
			base: { ref: "main", repo: { full_name: "acme/tool" } },
			head: { ref: "fix/empty-config" },
			commits: 2,
			changed_files: 3,
			additions: 40,
			deletions: 5,
		};
		const reviews = [
			{
				user: { login: "carol" },
				state: "APPROVED",
				submitted_at: "2026-09-01T08:00:00Z",
				body: "LGTM",
			},
			{ user: { login: "dave" }, state: "PENDING", body: "" },
		];
		const reviewComments = [
			{
				user: { login: "carol" },
				path: "src/config.js",
				line: 42,
				created_at: "2026-09-01T07:50:00Z",
				body: "Guard against an empty file here too.",
			},
			{
				user: { login: "erin" },
				path: "README.md",
				original_line: 3,
				created_at: "2026-09-01T07:55:00Z",
				body: "Typo: 'recieve'.",
			},
		];
		const json = (value) => response(JSON.stringify(value), { contentType: "application/json" });
		const routes = {
			"https://api.github.com/repos/acme/tool/pulls/7": json(pull),
			"https://api.github.com/repos/acme/tool/issues/7/comments?per_page=100": json([]),
			"https://api.github.com/repos/acme/tool/pulls/7/reviews?per_page=100": json(reviews),
			"https://api.github.com/repos/acme/tool/pulls/7/comments?per_page=100": json(reviewComments),
		};
		const { result, fetchImpl } = await run(
			{ url: "https://github.com/acme/tool/pull/7" },
			{ routes }
		);
		expect(result.ok).toBe(true);
		expect(result.content).toContain("Pull request in acme/tool");
		expect(result.content).toContain("State: closed (merged)");
		expect(result.content).toContain("Branch: fix/empty-config → main");
		expect(result.content).toContain("Changes: 2 commits, 3 files, +40/-5");
		expect(result.content).toContain("## Reviews (1)");
		expect(result.content).toContain("@carol: approved (2026-09-01) — LGTM");
		expect(result.content).not.toContain("dave");
		// Inline review comments (their own endpoint) carry the actual feedback
		expect(result.content).toContain("## Review comments (2)");
		expect(result.content).toContain("### @carol on src/config.js:42 — 2026-09-01");
		expect(result.content).toContain("Guard against an empty file here too.");
		expect(result.content).toContain("### @erin on README.md:3 — 2026-09-01");
		expect(result.content).not.toContain("## Comments");
		expect(fetchImpl).toHaveBeenCalledTimes(4);
		// No token configured: no Authorization header at all
		expect(fetchImpl.mock.calls.every((call) => !call[1].headers.Authorization)).toBe(true);
	});

	it("explains 404s in terms of private repositories and GITHUB_TOKEN", async () => {
		const { result } = await run({ url: "https://github.com/acme/secret/issues/1" });
		expect(result.ok).toBe(false);
		expect(result.error).toContain("private");
		expect(result.hint).toContain("GITHUB_TOKEN");
	});

	it("maps public blob URLs to their raw file, anonymously", async () => {
		const routes = {
			"https://raw.githubusercontent.com/acme/tool/main/README.md": (init) => {
				expect(init.headers.Authorization).toBeUndefined();
				return response("# Tool\n\nReadme.", { contentType: "text/plain; charset=utf-8" });
			},
		};
		// No token at all, and a token scoped to another repository: both anonymous
		for (const config of [
			{ allowedHosts: ["github.com"] },
			{ githubToken: "ghp_test", githubTokenRepos: ["other/*"], allowedHosts: ["github.com"] },
		]) {
			const { result } = await run(
				{ url: "https://github.com/acme/tool/blob/main/README.md" },
				{ routes, config }
			);
			expect(result).toMatchObject({
				ok: true,
				source: "text",
				url: "https://github.com/acme/tool/blob/main/README.md",
				finalUrl: "https://raw.githubusercontent.com/acme/tool/main/README.md",
				content: "# Tool\n\nReadme.",
			});
		}
	});

	it("resolves slash-containing refs for public blobs once the raw URL 404s", async () => {
		const requested = [];
		const json = (value) => response(JSON.stringify(value), { contentType: "application/json" });
		const api = "https://api.github.com/repos/acme/tool";
		const routes = {
			// The single-segment split is tried first on the raw host (no API budget spent)
			"https://raw.githubusercontent.com/acme/tool/feature/foo/docs/guide.md": () => {
				requested.push("raw");
				return notFound();
			},
			// Then the refs API, anonymously: the longest matching branch or tag wins
			[`${api}/git/matching-refs/heads/feature?per_page=100`]: (init) => {
				requested.push("refs");
				expect(init.headers.Authorization).toBeUndefined();
				return json([{ ref: "refs/heads/feature" }, { ref: "refs/heads/feature/foo" }]);
			},
			[`${api}/git/matching-refs/tags/feature?per_page=100`]: json([]),
			// ...and the file is re-read under the explicit refs/heads form
			"https://raw.githubusercontent.com/acme/tool/refs/heads/feature/foo/docs/guide.md": () => {
				requested.push("retry");
				return response("# On feature/foo", { contentType: "text/plain" });
			},
		};
		const config = { allowedHosts: ["github.com"] };
		const url = "https://github.com/acme/tool/blob/feature/foo/docs/guide.md";
		const { result } = await run({ url }, { routes, config });
		expect(requested).toEqual(["raw", "refs", "retry"]);
		expect(result).toMatchObject({
			ok: true,
			source: "text",
			url,
			finalUrl: "https://raw.githubusercontent.com/acme/tool/refs/heads/feature/foo/docs/guide.md",
			content: "# On feature/foo",
		});

		// A tag with a slash is read the same way, under refs/tags
		const tagged = await run(
			{ url: "https://github.com/acme/tool/blob/release/v2/README.md" },
			{
				routes: {
					[`${api}/git/matching-refs/heads/release?per_page=100`]: json([]),
					[`${api}/git/matching-refs/tags/release?per_page=100`]: json([
						{ ref: "refs/tags/release/v2" },
					]),
					"https://raw.githubusercontent.com/acme/tool/refs/tags/release/v2/README.md": response(
						"# v2",
						{ contentType: "text/plain" }
					),
				},
				config,
			}
		);
		expect(tagged.result).toMatchObject({ ok: true, content: "# v2" });

		// The refs API cannot answer (anonymous rate limit): the original 404 stands
		const limited = await run(
			{ url },
			{
				routes: {
					[`${api}/git/matching-refs/heads/feature?per_page=100`]: response("", {
						status: 403,
						contentType: "application/json",
						headers: { "x-ratelimit-remaining": "0" },
					}),
				},
				config,
			}
		);
		expect(limited.result.ok).toBe(false);
		expect(limited.result.error).toContain("HTTP 404");
	});

	it("decodes token-scoped UTF-16 blobs through the BOM-aware decoder", async () => {
		const utf16 = Buffer.concat([
			Buffer.from([0xff, 0xfe]),
			Buffer.from("# Notes en UTF-16", "utf16le"),
		]);
		const routes = {
			"https://api.github.com/repos/acme/tool/contents/NOTES.md?ref=main": response(utf16, {
				contentType: "application/octet-stream",
			}),
			"https://api.github.com/repos/acme/tool/git/matching-refs/heads/main?per_page=100": response(
				"[]",
				{ contentType: "application/json" }
			),
			"https://api.github.com/repos/acme/tool/git/matching-refs/tags/main?per_page=100": response(
				"[]",
				{ contentType: "application/json" }
			),
		};
		const { result } = await run(
			{ url: "https://github.com/acme/tool/blob/main/NOTES.md" },
			{ routes, config: { githubToken: "ghp_test", githubTokenRepos: ["acme/tool"] } }
		);
		expect(result.ok).toBe(true);
		expect(result.content).toBe("# Notes en UTF-16");
	});

	it("reads blobs of token-scoped repositories through the API raw media type", async () => {
		const routes = {
			"https://api.github.com/repos/acme/tool/contents/docs/guide%20v2.md?ref=main": (init) => {
				expect(init.headers.Authorization).toBe("Bearer ghp_test");
				expect(init.headers.Accept).toBe("application/vnd.github.raw+json");
				return response("# Private guide", { contentType: "text/plain; charset=utf-8" });
			},
			"https://api.github.com/repos/acme/tool/contents/bin/app.png?ref=main": response(
				Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]),
				{ contentType: "application/octet-stream" }
			),
		};
		const config = { githubToken: "ghp_test", githubTokenRepos: ["acme/tool"] };
		const { result, fetchImpl } = await run(
			{ url: "https://github.com/acme/tool/blob/main/docs/guide v2.md" },
			{ routes, config }
		);
		expect(result).toMatchObject({
			ok: true,
			source: "github",
			title: "docs/guide v2.md",
			content: "# Private guide",
		});
		// The token never went anywhere but api.github.com
		expect(
			fetchImpl.mock.calls.every((call) => String(call[0]).startsWith("https://api.github.com/"))
		).toBe(true);

		const binary = await run(
			{ url: "https://github.com/acme/tool/blob/main/bin/app.png" },
			{ routes, config }
		);
		expect(binary.result.ok).toBe(false);
		expect(binary.result.error).toContain("binary file");
	});

	it("resolves slash-containing refs when reading token-scoped blobs", async () => {
		const requested = [];
		const json = (value) => response(JSON.stringify(value), { contentType: "application/json" });
		const base = "https://api.github.com/repos/acme/tool";
		const routes = {
			// ref=feature is tried first (the common single-segment case) and does not exist
			[`${base}/contents/foo/docs/guide.md?ref=feature`]: (init) => {
				requested.push("feature");
				expect(init.headers.Authorization).toBe("Bearer ghp_test");
				return notFound();
			},
			// The refs API lists what starts with "feature": the longest URL prefix wins
			[`${base}/git/matching-refs/heads/feature?per_page=100`]: () => {
				requested.push("refs");
				return json([
					{ ref: "refs/heads/feature" },
					{ ref: "refs/heads/feature/foo" },
					{ ref: "refs/heads/feature/foo/docs/guide.md/impossible" },
				]);
			},
			[`${base}/contents/docs/guide.md?ref=feature%2Ffoo`]: () => {
				requested.push("feature/foo");
				return response("# On feature/foo", { contentType: "text/plain" });
			},
			// Five-segment branch name: no cap on the number of slashes
			[`${base}/contents/alice/features/new/ui/README.md?ref=users`]: notFound(),
			// The matching ref sits on the SECOND page of the refs listing
			[`${base}/git/matching-refs/heads/users?per_page=100`]: response(
				JSON.stringify([{ ref: "refs/heads/users/alice" }, { ref: "refs/heads/users/bob" }]),
				{
					contentType: "application/json",
					headers: {
						link: `<${base}/git/matching-refs/heads/users?per_page=100&page=2>; rel="next"`,
					},
				}
			),
			[`${base}/git/matching-refs/heads/users?per_page=100&page=2`]: json([
				{ ref: "refs/heads/users/alice/features/new/ui" },
			]),
			[`${base}/git/matching-refs/tags/users?per_page=100`]: json([]),
			[`${base}/contents/README.md?ref=users%2Falice%2Ffeatures%2Fnew%2Fui`]: response(
				"# Deep ref",
				{
					contentType: "text/plain",
				}
			),
		};
		const config = { githubToken: "ghp_test", githubTokenRepos: ["acme/tool"] };
		const { result } = await run(
			{ url: "https://github.com/acme/tool/blob/feature/foo/docs/guide.md" },
			{ routes, config }
		);
		// The refs API is consulted first (longest matching ref wins); the tags
		// lookup 404s (not routed) and is tolerated; the one-segment split is never tried
		expect(requested).toEqual(["refs", "feature/foo"]);
		expect(result).toMatchObject({ ok: true, source: "github", title: "docs/guide.md" });
		expect(result.content).toBe("# On feature/foo");

		const deep = await run(
			{ url: "https://github.com/acme/tool/blob/users/alice/features/new/ui/README.md" },
			{ routes, config }
		);
		expect(deep.result).toMatchObject({ ok: true, title: "README.md", content: "# Deep ref" });

		// No branch or tag matches: the original 404 is reported, with its hint
		const missing = await run({ url: "https://github.com/acme/tool/blob/a/b/c.md" }, { config });
		expect(missing.result.ok).toBe(false);
		expect(missing.result.error).toContain("404");
	});

	it("falls back to the single-segment ref when no longer branch matches the URL", async () => {
		const json = (value) => response(JSON.stringify(value), { contentType: "application/json" });
		const base = "https://api.github.com/repos/acme/tool";
		const requested = [];
		const routes = {
			[`${base}/git/matching-refs/heads/main?per_page=100`]: json([{ ref: "refs/heads/main" }]),
			[`${base}/git/matching-refs/tags/main?per_page=100`]: json([]),
			[`${base}/contents/docs/guide.md?ref=main`]: () => {
				requested.push("main");
				return response("# Main", { contentType: "text/plain" });
			},
		};
		const { result } = await run(
			{ url: "https://github.com/acme/tool/blob/main/docs/guide.md" },
			{ routes, config: { githubToken: "ghp_test", githubTokenRepos: ["acme/tool"] } }
		);
		expect(requested).toEqual(["main"]);
		expect(result).toMatchObject({ ok: true, title: "docs/guide.md", content: "# Main" });
	});

	it("still honours the host policy on github.com itself", async () => {
		const { result, fetchImpl } = await run(
			{ url: "https://github.com/acme/tool/issues/12" },
			{ config: { blockedHosts: ["github.com"] } }
		);
		expect(result.ok).toBe(false);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("keeps the block list authoritative for derived hosts (blocked always wins)", async () => {
		// raw.githubusercontent.com and api.github.com are exempt from the ALLOW
		// list (derived from a checked github.com URL) but never from the block list
		const raw = await run(
			{ url: "https://github.com/acme/tool/blob/main/README.md" },
			{ config: { blockedHosts: ["raw.githubusercontent.com"] } }
		);
		expect(raw.result.ok).toBe(false);
		expect(raw.result.error).toContain("raw.githubusercontent.com is blocked");
		expect(raw.fetchImpl).not.toHaveBeenCalled();

		const api = await run(
			{ url: "https://github.com/acme/tool/issues/12" },
			{ config: { blockedHosts: ["api.github.com"] } }
		);
		expect(api.result.ok).toBe(false);
		expect(api.result.error).toContain("api.github.com is blocked");
		expect(api.fetchImpl).not.toHaveBeenCalled();
	});

	it("scopes the shared token to GITHUB_TOKEN_REPOS", () => {
		expect(githubTokenAllowedFor([], "acme", "tool")).toBe(true);
		expect(githubTokenAllowedFor(["acme/tool"], "acme", "tool")).toBe(true);
		expect(githubTokenAllowedFor(["acme/tool"], "Acme", "Tool")).toBe(true);
		expect(githubTokenAllowedFor(["acme/*"], "acme", "other")).toBe(true);
		// Only "owner/repo" and "owner/*" are accepted: a bare owner (or the "owner/"
		// typo, normalized to it) is a malformed entry and grants nothing
		expect(githubTokenAllowedFor(["acme"], "acme", "other")).toBe(false);
		expect(githubTokenAllowedFor(["acme"], "acme", "tool")).toBe(false);
		expect(githubTokenAllowedFor(["acme/tool"], "acme", "other")).toBe(false);
		expect(githubTokenAllowedFor(["acme/*"], "evil", "tool")).toBe(false);
	});

	it("sends the token only for repositories in scope, and says so on a 404", async () => {
		const seen = {};
		const json = (value) => response(JSON.stringify(value), { contentType: "application/json" });
		const routes = {
			"https://api.github.com/repos/acme/tool/issues/12": (init) => {
				seen.inScope = init.headers.Authorization;
				return json(issue);
			},
			"https://api.github.com/repos/acme/tool/issues/12/comments?per_page=100": json([]),
			"https://api.github.com/repos/other/secret/issues/1": (init) => {
				seen.outOfScope = init.headers.Authorization;
				return notFound();
			},
		};
		const config = { githubToken: "ghp_test", githubTokenRepos: ["acme/*"] };

		const inScope = await run(
			{ url: "https://github.com/acme/tool/issues/12" },
			{ routes, config }
		);
		expect(inScope.result.ok).toBe(true);
		expect(seen.inScope).toBe("Bearer ghp_test");

		const outOfScope = await run(
			{ url: "https://github.com/other/secret/issues/1" },
			{ routes, config }
		);
		expect(outOfScope.result.ok).toBe(false);
		expect(seen.outOfScope).toBeUndefined();
		expect(outOfScope.result.hint).toContain("GITHUB_TOKEN_REPOS");
	});

	it("keeps the scoped token on pagination links spelled /repositories/{id}/...", async () => {
		const seen = [];
		const json = (value, headers = {}) =>
			response(JSON.stringify(value), { contentType: "application/json", headers });
		const routes = {
			"https://api.github.com/repos/acme/tool/issues/4": (init) => {
				seen.push(init.headers.Authorization);
				return json(issue);
			},
			"https://api.github.com/repos/acme/tool/issues/4/comments?per_page=100": (init) => {
				seen.push(init.headers.Authorization);
				return json(
					[{ user: { login: "c1" }, created_at: "2026-09-01T00:00:00Z", body: "page one" }],
					{
						link: '<https://api.github.com/repositories/123456/issues/4/comments?per_page=100&page=2>; rel="next"',
					}
				);
			},
			"https://api.github.com/repositories/123456/issues/4/comments?per_page=100&page=2": (
				init
			) => {
				seen.push(init.headers.Authorization);
				return json([
					{ user: { login: "c2" }, created_at: "2026-09-02T00:00:00Z", body: "page two" },
				]);
			},
		};
		const { result } = await run(
			{ url: "https://github.com/acme/tool/issues/4" },
			{ routes, config: { githubToken: "ghp_test", githubTokenRepos: ["acme/tool"] } }
		);
		expect(result.ok).toBe(true);
		expect(result.content).toContain("page two");
		expect(seen).toEqual(["Bearer ghp_test", "Bearer ghp_test", "Bearer ghp_test"]);
	});

	it("keeps the issue when a supplementary list cannot be loaded", async () => {
		const routes = {
			"https://api.github.com/repos/acme/tool/issues/12": response(JSON.stringify(issue), {
				contentType: "application/json",
			}),
			// Comments: rate-limited
			"https://api.github.com/repos/acme/tool/issues/12/comments?per_page=100": response("", {
				status: 403,
				headers: { "x-ratelimit-remaining": "0" },
			}),
		};
		const { result } = await run({ url: "https://github.com/acme/tool/issues/12" }, { routes });
		expect(result.ok).toBe(true);
		expect(result.content).toContain("# Collector crashes on empty config (#12)");
		expect(result.content).not.toContain("## Comments");
		expect(result.note).toContain("comments could not be loaded");
		expect(result.note).toContain("rate limit");
	});

	it("follows Link pagination on comment and review lists and reports truncation", async () => {
		const json = (value, headers = {}) =>
			response(JSON.stringify(value), { contentType: "application/json", headers });
		const pull = { ...issue, number: 9, html_url: "https://github.com/acme/tool/pull/9" };
		const review = (i) => ({
			user: { login: `r${i}` },
			state: "APPROVED",
			submitted_at: "2026-09-01T08:00:00Z",
			body: "",
		});
		const base = "https://api.github.com/repos/acme/tool";
		const routes = {
			[`${base}/pulls/9`]: json(pull),
			// Comments: two pages
			[`${base}/issues/9/comments?per_page=100`]: json(
				[{ user: { login: "c1" }, created_at: "2026-09-01T00:00:00Z", body: "first page" }],
				{ link: `<${base}/issues/9/comments?per_page=100&page=2>; rel="next"` }
			),
			[`${base}/issues/9/comments?per_page=100&page=2`]: json([
				{ user: { login: "c2" }, created_at: "2026-09-02T00:00:00Z", body: "second page" },
			]),
			// Reviews: more pages than the cap
			[`${base}/pulls/9/reviews?per_page=100`]: json([review(1)], {
				link: `<${base}/pulls/9/reviews?per_page=100&page=2>; rel="next"`,
			}),
			[`${base}/pulls/9/comments?per_page=100`]: json([]),
		};
		for (let page = 2; page <= 7; page++) {
			routes[`${base}/pulls/9/reviews?per_page=100&page=${page}`] = json([review(page)], {
				link: `<${base}/pulls/9/reviews?per_page=100&page=${page + 1}>; rel="next"`,
			});
		}
		const { result, fetchImpl } = await run(
			{ url: "https://github.com/acme/tool/pull/9" },
			{ routes }
		);
		expect(result.ok).toBe(true);
		expect(result.content).toContain("## Comments (2)");
		expect(result.content).toContain("second page");
		expect(result.content).toContain("## Reviews (5)");
		expect(result.content).toContain("@r5:");
		expect(result.content).not.toContain("@r6:");
		expect(result.note).toContain("Only the first 500 reviews are included.");
		expect(result.note).not.toContain("comments are included");
		// 1 item + 2 comment pages + 5 review pages + 1 review-comments page
		expect(fetchImpl).toHaveBeenCalledTimes(9);
	});

	it("refuses pagination links that leave api.github.com", async () => {
		const routes = {
			"https://api.github.com/repos/acme/tool/issues/3": response(JSON.stringify(issue), {
				contentType: "application/json",
			}),
			"https://api.github.com/repos/acme/tool/issues/3/comments?per_page=100": response("[]", {
				contentType: "application/json",
				headers: { link: '<https://evil.example.net/steal>; rel="next"' },
			}),
		};
		const { result, fetchImpl } = await run(
			{ url: "https://github.com/acme/tool/issues/3" },
			{ routes }
		);
		// The issue itself is still returned; the off-origin page is refused and noted
		expect(result.ok).toBe(true);
		expect(result.content).toContain("Collector crashes on empty config");
		expect(result.note).toContain("comments could not be loaded");
		expect(result.note).toContain("outside https://api.github.com");
		expect(fetchImpl.mock.calls.some((call) => String(call[0]).includes("evil"))).toBe(false);
	});
});
