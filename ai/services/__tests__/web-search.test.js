/**
 * Tests for the pluggable application-side web search.
 */

import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { executeWebSearch, getWebSearchTool, isWebSearchConfigured } from "../web-search.js";

const ENV_KEYS = ["WEB_SEARCH_PROVIDER", "SEARXNG_URL", "OLLAMA_CLOUD_API_KEY"];

describe("web search", () => {
	const savedEnv = {};
	const savedFetch = global.fetch;

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
		global.fetch = savedFetch;
	});

	it("is unavailable when no backend is configured", async () => {
		expect(isWebSearchConfigured()).toBe(false);
		expect(getWebSearchTool()).toBeNull();

		const result = await executeWebSearch({ query: "metricshub" });
		expect(result.ok).toBe(false);
		expect(result.error).toContain("not available");
	});

	it("requires the backend-specific settings, not just the provider name", () => {
		process.env.WEB_SEARCH_PROVIDER = "searxng";
		expect(isWebSearchConfigured()).toBe(false);

		process.env.SEARXNG_URL = "http://searxng.internal:8080";
		expect(isWebSearchConfigured()).toBe(true);
		expect(getWebSearchTool()).toMatchObject({ type: "function", name: "web_search" });
	});

	it("queries SearXNG and normalizes results", async () => {
		process.env.WEB_SEARCH_PROVIDER = "searxng";
		process.env.SEARXNG_URL = "http://searxng.internal:8080/";

		global.fetch = jest.fn(async () => ({
			ok: true,
			json: async () => ({
				results: [
					{ title: "Doc A", url: "https://a.example", content: "Alpha content" },
					{ title: "Doc B", url: "https://b.example", content: "b".repeat(2000) },
					{ title: "No URL entry" },
				],
			}),
		}));

		const result = await executeWebSearch({ query: "prometheus alerts" });

		expect(result.ok).toBe(true);
		expect(result.provider).toBe("searxng");
		const calledUrl = String(global.fetch.mock.calls[0][0]);
		expect(calledUrl).toContain("http://searxng.internal:8080/search");
		expect(calledUrl).toContain("q=prometheus+alerts");
		expect(calledUrl).toContain("format=json");

		expect(result.results).toHaveLength(2);
		expect(result.results[0]).toEqual({
			title: "Doc A",
			url: "https://a.example",
			snippet: "Alpha content",
		});
		// Long snippets are truncated to keep the model context small
		expect(result.results[1].snippet.length).toBeLessThanOrEqual(601);
	});

	it("uses Ollama's hosted search only as explicit opt-in", async () => {
		process.env.WEB_SEARCH_PROVIDER = "ollama-cloud";
		process.env.OLLAMA_CLOUD_API_KEY = "test-key";

		global.fetch = jest.fn(async () => ({
			ok: true,
			json: async () => ({
				results: [{ title: "Hosted", url: "https://x.example", content: "from ollama.com" }],
			}),
		}));

		const result = await executeWebSearch({ query: "test", maxResults: 3 });

		expect(result.ok).toBe(true);
		const [url, init] = global.fetch.mock.calls[0];
		expect(String(url)).toBe("https://ollama.com/api/web_search");
		expect(init.headers.Authorization).toBe("Bearer test-key");
		expect(JSON.parse(init.body)).toEqual({ query: "test", max_results: 3 });
	});

	it("reports backend failures without throwing", async () => {
		process.env.WEB_SEARCH_PROVIDER = "searxng";
		process.env.SEARXNG_URL = "http://searxng.internal:8080";

		global.fetch = jest.fn(async () => ({ ok: false, status: 502 }));

		const result = await executeWebSearch({ query: "anything" });
		expect(result.ok).toBe(false);
		expect(result.error).toContain("502");
	});

	it("rejects empty queries", async () => {
		const result = await executeWebSearch({ query: "  " });
		expect(result.ok).toBe(false);
	});
});
