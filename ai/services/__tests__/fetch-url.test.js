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
	getFetchUrlTool,
	isBlockedAddress,
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
		expect(result.chars).toBe(MAX_CONTENT_CHARS);
		expect(result.totalChars).toBe(MAX_CONTENT_CHARS + 500);
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
		expect(sibling("https://d.example/docs/page.html?x=1#top")).toBe(
			"https://d.example/docs/page.md"
		);
		expect(sibling("https://d.example/docs/")).toBe("https://d.example/docs/index.html.md");
		expect(sibling("https://d.example")).toBe("https://d.example/index.html.md");
		expect(sibling("https://d.example/docs/page.md")).toBeNull();
		expect(sibling("https://d.example/notes.txt")).toBeNull();
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
			rawUrl: "https://raw.githubusercontent.com/acme/tool/main/src/a.js",
		});
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

	it("maps blob URLs to their raw file without sending the token", async () => {
		const routes = {
			"https://raw.githubusercontent.com/acme/tool/main/README.md": (init) => {
				expect(init.headers.Authorization).toBeUndefined();
				return response("# Tool\n\nReadme.", { contentType: "text/plain; charset=utf-8" });
			},
		};
		const { result } = await run(
			{ url: "https://github.com/acme/tool/blob/main/README.md" },
			{ routes, config: { githubToken: "ghp_test", allowedHosts: ["github.com"] } }
		);
		expect(result).toMatchObject({
			ok: true,
			source: "text",
			url: "https://github.com/acme/tool/blob/main/README.md",
			finalUrl: "https://raw.githubusercontent.com/acme/tool/main/README.md",
			content: "# Tool\n\nReadme.",
		});
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
});
