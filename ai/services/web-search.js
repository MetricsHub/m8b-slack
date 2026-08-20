/**
 * Application-side web search for providers without a hosted web_search tool.
 *
 * Pluggable backends:
 * - searxng:      self-hosted SearXNG instance (WEB_SEARCH_PROVIDER=searxng, SEARXNG_URL=...)
 * - ollama-cloud: Ollama's hosted web-search API, explicit opt-in only
 *                 (WEB_SEARCH_PROVIDER=ollama-cloud, OLLAMA_CLOUD_API_KEY=...)
 *
 * If no backend is configured, web search is reported as unavailable — it never
 * silently falls back to OpenAI or any other hosted service.
 */

/** Maximum results returned to the model */
const DEFAULT_MAX_RESULTS = 5;
const MAX_RESULTS_CAP = 10;

/** Snippets are truncated so search results never flood the model context */
const SNIPPET_MAX_CHARS = 600;

const OLLAMA_CLOUD_SEARCH_URL = "https://ollama.com/api/web_search";

/**
 * Function tool definition for application-side web search.
 */
export const WEB_SEARCH_TOOL = {
	type: "function",
	name: "web_search",
	description:
		"Search the web for current information. Returns a list of results with title, url, and a short snippet. Use it for facts you cannot verify from MetricsHub, the knowledge base, or the conversation.",
	parameters: {
		type: "object",
		properties: {
			query: {
				type: "string",
				description: "The search query.",
			},
			maxResults: {
				type: "number",
				description: `Maximum number of results to return (1-${MAX_RESULTS_CAP}, default ${DEFAULT_MAX_RESULTS}).`,
			},
		},
		required: ["query"],
		additionalProperties: false,
	},
};

/**
 * Get the configured web-search backend name.
 *
 * @returns {string|null} "searxng", "ollama-cloud", or null when unset
 */
export function getWebSearchProviderName() {
	const raw = (process.env.WEB_SEARCH_PROVIDER || "").trim().toLowerCase();
	return raw || null;
}

/**
 * Check whether a usable web-search backend is configured.
 *
 * @returns {boolean}
 */
export function isWebSearchConfigured() {
	const name = getWebSearchProviderName();
	if (name === "searxng") return Boolean(process.env.SEARXNG_URL);
	if (name === "ollama-cloud") return Boolean(process.env.OLLAMA_CLOUD_API_KEY);
	return false;
}

/**
 * Get the web_search function tool, or null when no backend is configured.
 *
 * @returns {Object|null}
 */
export function getWebSearchTool() {
	return isWebSearchConfigured() ? WEB_SEARCH_TOOL : null;
}

function truncateSnippet(text) {
	const clean = String(text || "")
		.replace(/\s+/g, " ")
		.trim();
	return clean.length > SNIPPET_MAX_CHARS ? `${clean.slice(0, SNIPPET_MAX_CHARS)}…` : clean;
}

function normalizeResults(rawResults, maxResults) {
	return (rawResults || [])
		.filter((r) => r && (r.url || r.link))
		.slice(0, maxResults)
		.map((r) => ({
			title: String(r.title || r.url || "Untitled").slice(0, 200),
			url: String(r.url || r.link),
			snippet: truncateSnippet(r.content || r.snippet || r.description || ""),
		}));
}

async function searchSearxng(query, maxResults, logger) {
	const base = process.env.SEARXNG_URL.replace(/\/+$/, "");
	const url = new URL(`${base}/search`);
	url.searchParams.set("q", query);
	url.searchParams.set("format", "json");

	const response = await fetch(url.toString(), {
		headers: { Accept: "application/json" },
		signal: AbortSignal.timeout(20000),
	});

	if (!response.ok) {
		throw new Error(`SearXNG returned HTTP ${response.status}`);
	}

	const body = await response.json();
	const results = normalizeResults(body?.results, maxResults);
	logger?.info?.(`[WEB_SEARCH] searxng returned ${results.length} results`);
	return results;
}

async function searchOllamaCloud(query, maxResults, logger) {
	const response = await fetch(OLLAMA_CLOUD_SEARCH_URL, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${process.env.OLLAMA_CLOUD_API_KEY}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ query, max_results: maxResults }),
		signal: AbortSignal.timeout(20000),
	});

	if (!response.ok) {
		throw new Error(`Ollama web search returned HTTP ${response.status}`);
	}

	const body = await response.json();
	const results = normalizeResults(body?.results, maxResults);
	logger?.info?.(`[WEB_SEARCH] ollama-cloud returned ${results.length} results`);
	return results;
}

/**
 * Execute a web_search function call.
 *
 * @param {Object} args - {query, maxResults?}
 * @param {Object} [logger] - Logger instance
 * @returns {Promise<Object>} {ok, provider, query, results} or {ok: false, error}
 */
export async function executeWebSearch(args, logger) {
	const query = String(args?.query || "").trim();
	if (!query) {
		return { ok: false, error: "Missing required parameter: query" };
	}

	if (!isWebSearchConfigured()) {
		return {
			ok: false,
			error:
				"Web search is not available: no search backend is configured (set WEB_SEARCH_PROVIDER).",
		};
	}

	const requested = Number(args?.maxResults);
	const maxResults =
		Number.isFinite(requested) && requested > 0
			? Math.min(Math.floor(requested), MAX_RESULTS_CAP)
			: DEFAULT_MAX_RESULTS;

	const providerName = getWebSearchProviderName();

	try {
		const results =
			providerName === "searxng"
				? await searchSearxng(query, maxResults, logger)
				: await searchOllamaCloud(query, maxResults, logger);

		return { ok: true, provider: providerName, query, results };
	} catch (e) {
		logger?.error?.(`[WEB_SEARCH] ${providerName} search failed`, { error: String(e) });
		return { ok: false, error: `Web search failed: ${e?.message || e}` };
	}
}
