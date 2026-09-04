/**
 * AI provider configuration.
 *
 * Selects between the hosted OpenAI backend (default), a local backend
 * exposing the OpenAI-compatible /v1/responses API (Ollama or vLLM), or any
 * other OpenAI-compatible endpoint (a corporate inference proxy, a NIM, a
 * LiteLLM gateway, ...) through the generic "openai-compatible" provider.
 *
 * Every self-hosted mode (ollama / vllm / openai-compatible) reads ONE common
 * vocabulary of variables, AI_*, documented in .env.example:
 *
 *   AI_BASE_URL, AI_API_KEY, AI_MODEL, AI_CONTEXT_LENGTH, AI_MAX_OUTPUT_TOKENS,
 *   AI_REQUEST_TIMEOUT_MS, AI_MAX_TOOL_OUTPUT_CHARS, AI_EMBEDDING_MODEL,
 *   AI_EMBEDDING_BASE_URL, AI_EMBEDDING_API_KEY, AI_EMBEDDING_QUERY_PREFIX,
 *   AI_EMBEDDING_DOCUMENT_PREFIX
 *
 * AI_PROVIDER is a preset selector: it fixes the defaults (Ollama's port,
 * vLLM's dummy key, ...) and the backend quirks (sidecar vision, strict input,
 * single-model adoption). Vendor-prefixed names (OLLAMA_MODEL, VLLM_BASE_URL,
 * ...) are accepted as DEPRECATED aliases of the AI_* names for the active
 * preset, and take precedence over them so existing deployments keep working
 * unchanged; getDeprecatedAiVariables() lists the ones in use for a startup
 * warning. Only genuinely vendor-specific settings keep a vendor prefix:
 * OLLAMA_VISION_MODEL / OLLAMA_VISION_MAX_OUTPUT_TOKENS (the sidecar vision
 * path through Ollama's chat endpoint) and OLLAMA_CONTEXT_LENGTH, a permanent
 * alias named after Ollama's own server variable so the same line works on
 * both sides.
 */

import { PAYLOAD_CHARS_PER_TOKEN } from "../utils/tokens.js";

export const PROVIDER_OPENAI = "openai";
export const PROVIDER_OLLAMA = "ollama";
export const PROVIDER_VLLM = "vllm";
export const PROVIDER_OPENAI_COMPATIBLE = "openai-compatible";

/**
 * Maximum agent-loop iterations (model -> tool calls -> model) per Slack message.
 * Prevents runaway tool loops on both providers. The final permitted iteration
 * forces a text-only answer, so a capped run still reports what it found; 15
 * leaves headroom for genuine multi-step investigations (check -> spot anomaly
 * -> drill down -> verify) above the ~4-turn happy path.
 */
export const MAX_AGENT_ITERATIONS = (() => {
	const parsed = Number.parseInt(process.env.AI_MAX_AGENT_ITERATIONS || "", 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 15;
})();

function parsePositiveInt(value, fallback) {
	const parsed = Number.parseInt(value || "", 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Whether an environment value is a valid positive integer, i.e. whether
 * parsePositiveInt() would honor it rather than fall back to the default.
 * Providers use this to decide if a setting was EXPLICITLY configured
 * ("AI_CONTEXT_LENGTH=oops" is not).
 *
 * @param {string|undefined} value - Raw environment value
 * @returns {boolean}
 */
function isPositiveInt(value) {
	return parsePositiveInt(value, null) !== null;
}

/**
 * Get the configured AI provider name.
 *
 * @returns {string} "openai", "ollama", "vllm", or "openai-compatible"
 */
export function getAiProviderName() {
	const raw = (process.env.AI_PROVIDER || PROVIDER_OPENAI).trim().toLowerCase();
	if (raw === PROVIDER_OLLAMA) return PROVIDER_OLLAMA;
	if (raw === PROVIDER_VLLM) return PROVIDER_VLLM;
	if (raw === PROVIDER_OPENAI_COMPATIBLE) return PROVIDER_OPENAI_COMPATIBLE;
	return PROVIDER_OPENAI;
}

/**
 * Parse a boolean environment flag ("true"/"1"/"yes" = true, case-insensitive).
 *
 * @param {string|undefined} value - Raw environment value
 * @param {boolean} fallback - Value when unset or empty
 * @returns {boolean}
 */
export function parseBooleanFlag(value, fallback) {
	const raw = (value || "").trim().toLowerCase();
	if (!raw) return fallback;
	return raw === "true" || raw === "1" || raw === "yes";
}

/**
 * Default inline cap for a single tool result: ~40% of the usable budget,
 * converted to characters at the measured payload token density, so it
 * scales with the context window and stays honest about what tool outputs
 * actually cost the model.
 *
 * @param {number} contextWindow - Model context window in tokens
 * @param {number} maxOutputTokens - Reserved output tokens
 * @returns {number} Inline cap in characters
 */
export function defaultToolOutputChars(contextWindow, maxOutputTokens) {
	const usableBudgetChars =
		Math.max(contextWindow - maxOutputTokens - 1500, 4000) * PAYLOAD_CHARS_PER_TOKEN;
	return Math.max(20000, Math.floor(usableBudgetChars * 0.4));
}

/**
 * Get the local Python code sandbox (Pyodide) configuration.
 *
 * The sandbox backs the run_python function tool on providers without a hosted
 * code_interpreter (Ollama). Enabled by default; set CODE_SANDBOX_ENABLED=false
 * to turn the tool off entirely.
 *
 * @returns {{enabled: boolean, timeoutMs: number, packageCacheDir: string,
 *   maxOutputFileBytes: number, maxInputFileBytes: number, stagingDir: string,
 *   stagingCacheMaxBytes: number}}
 */
export function getCodeSandboxConfig() {
	return {
		enabled: (process.env.CODE_SANDBOX_ENABLED || "true").trim().toLowerCase() !== "false",
		// One execution's wall-clock budget. The first run that imports a package
		// (numpy, pandas, ...) also downloads it (cached on disk afterwards), so
		// the default leaves room for a cold package fetch.
		timeoutMs: parsePositiveInt(process.env.CODE_SANDBOX_TIMEOUT_MS, 60000),
		// Where Pyodide caches downloaded Python packages between runs/restarts
		packageCacheDir: process.env.CODE_SANDBOX_PACKAGE_CACHE_DIR || "node_modules/.cache/pyodide",
		// Total size cap for files a single execution may hand back for Slack upload
		maxOutputFileBytes: parsePositiveInt(
			process.env.CODE_SANDBOX_MAX_OUTPUT_FILE_BYTES,
			20 * 1024 * 1024
		),
		// Size cap for a single user attachment staged into /data for run_python.
		// Attachments are streamed to disk (never buffered whole in memory) and
		// the sandbox reads them through a NODEFS mount, so this can be large;
		// Pyodide's ~2 GB WASM heap is the practical limit on what Python can
		// then load at once.
		maxInputFileBytes: parsePositiveInt(
			process.env.CODE_SANDBOX_MAX_INPUT_FILE_BYTES,
			100 * 1024 * 1024
		),
		// On-disk staging area: downloaded attachments (cache/, reused across
		// turns and restarts) and per-execution /data directories (exec-*)
		stagingDir: process.env.CODE_SANDBOX_STAGING_DIR || "node_modules/.cache/m8b-staging",
		// Total size the download cache may grow to before oldest files are evicted
		stagingCacheMaxBytes: parsePositiveInt(
			process.env.CODE_SANDBOX_STAGING_CACHE_MAX_BYTES,
			2 * 1024 * 1024 * 1024
		),
	};
}

// ---------------------------------------------------------------------------
// Common AI_* settings and their deprecated vendor-prefixed aliases
// ---------------------------------------------------------------------------

/**
 * Settings shared by every self-hosted preset, as the suffix after "AI_".
 */
const COMMON_SETTINGS = [
	"BASE_URL",
	"API_KEY",
	"MODEL",
	"CONTEXT_LENGTH",
	"MAX_OUTPUT_TOKENS",
	"REQUEST_TIMEOUT_MS",
	"MAX_TOOL_OUTPUT_CHARS",
	"EMBEDDING_MODEL",
	"EMBEDDING_BASE_URL",
	"EMBEDDING_API_KEY",
	"EMBEDDING_QUERY_PREFIX",
	"EMBEDDING_DOCUMENT_PREFIX",
];

/**
 * Vendor prefix whose `<PREFIX>_<SETTING>` names are accepted as aliases of
 * `AI_<SETTING>` for a preset. The generic preset has none.
 */
const ALIAS_PREFIX = {
	[PROVIDER_OLLAMA]: "OLLAMA",
	[PROVIDER_VLLM]: "VLLM",
};

/**
 * Aliases that are NOT deprecated. OLLAMA_CONTEXT_LENGTH is deliberately named
 * after Ollama's own server-side variable so the identical line can configure
 * both the server (num_ctx) and the bot.
 */
const PERMANENT_ALIASES = new Set(["OLLAMA_CONTEXT_LENGTH"]);

/**
 * Former names that are no longer read at all, with their replacement (they
 * are still reported by getDeprecatedAiVariables so operators notice).
 */
const REMOVED_VARIABLES = {
	[PROVIDER_OLLAMA]: { OLLAMA_CONTEXT_WINDOW: "AI_CONTEXT_LENGTH" },
};

/**
 * Read one common setting for a preset: the vendor alias wins over the AI_*
 * name, which wins over the caller's default. Empty values count as unset
 * unless `allowEmpty` is given (task prefixes: an empty override means "no
 * prefix").
 *
 * @param {string} providerName - Preset ("ollama", "vllm", "openai-compatible")
 * @param {string} setting - Suffix after "AI_" (e.g. "MODEL")
 * @param {{allowEmpty?: boolean}} [options]
 * @returns {{value: string|undefined, source: string}} The raw value and the
 *   variable it came from; `source` is the canonical AI_* name when unset
 */
export function readAiSetting(providerName, setting, { allowEmpty = false } = {}) {
	const canonical = `AI_${setting}`;
	const prefix = ALIAS_PREFIX[providerName];
	const candidates = prefix ? [`${prefix}_${setting}`, canonical] : [canonical];
	for (const name of candidates) {
		const raw = process.env[name];
		if (raw === undefined) continue;
		if (raw === "" && !allowEmpty) continue;
		return { value: raw, source: name };
	}
	return { value: undefined, source: canonical };
}

/**
 * Deprecated vendor-prefixed variables currently set for a preset, with the
 * AI_* name to use instead. Logged once at startup; the aliases keep working.
 *
 * @param {string} [providerName] - Preset (defaults to the active one)
 * @returns {Array<{name: string, replacement: string, removed: boolean}>}
 */
export function getDeprecatedAiVariables(providerName = getAiProviderName()) {
	const found = [];
	const prefix = ALIAS_PREFIX[providerName];
	if (prefix) {
		for (const setting of COMMON_SETTINGS) {
			const alias = `${prefix}_${setting}`;
			if (process.env[alias] !== undefined && !PERMANENT_ALIASES.has(alias)) {
				found.push({ name: alias, replacement: `AI_${setting}`, removed: false });
			}
		}
	}
	for (const [name, replacement] of Object.entries(REMOVED_VARIABLES[providerName] || {})) {
		if (process.env[name] !== undefined) {
			found.push({ name, replacement, removed: true });
		}
	}
	return found;
}

/**
 * Build the common part of a self-hosted preset's configuration.
 *
 * @param {string} providerName - Preset
 * @param {{baseUrl: string, apiKey: string, model: string}} defaults - Preset defaults
 * @returns {{baseUrl: string, apiKey: string, model: string, contextWindow: number,
 *   contextLengthExplicit: boolean, maxOutputTokens: number, requestTimeoutMs: number,
 *   maxToolOutputChars: number, maxToolOutputCharsExplicit: boolean,
 *   envNames: {model: string, contextLength: string, maxOutputTokens: string}}}
 */
function getCommonConfig(providerName, defaults) {
	const read = (setting) => readAiSetting(providerName, setting);

	const contextLength = read("CONTEXT_LENGTH");
	const contextWindow = parsePositiveInt(contextLength.value, 32768);
	const maxOutput = read("MAX_OUTPUT_TOKENS");
	const maxOutputTokens = parsePositiveInt(maxOutput.value, 4000);
	const maxToolOutput = read("MAX_TOOL_OUTPUT_CHARS");

	return {
		baseUrl: (read("BASE_URL").value || defaults.baseUrl).replace(/\/+$/, ""),
		apiKey: read("API_KEY").value || defaults.apiKey,
		model: (read("MODEL").value || defaults.model || "").trim(),
		contextWindow,
		// "Explicit" means a VALID value: an invalid one falls back to the default
		// and must not be treated as an operator decision
		contextLengthExplicit: isPositiveInt(contextLength.value),
		maxOutputTokens,
		requestTimeoutMs: parsePositiveInt(read("REQUEST_TIMEOUT_MS").value, 300000),
		maxToolOutputChars: parsePositiveInt(
			maxToolOutput.value,
			defaultToolOutputChars(contextWindow, maxOutputTokens)
		),
		maxToolOutputCharsExplicit: isPositiveInt(maxToolOutput.value),
		// Variable names quoted in health-check messages: the alias actually in
		// use, or the canonical AI_* name to set
		envNames: {
			model: read("MODEL").source,
			contextLength: contextLength.source,
			maxOutputTokens: maxOutput.source,
		},
	};
}

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

/**
 * Get the Ollama preset configuration.
 *
 * Common settings come from AI_* (or their OLLAMA_* aliases); the API key is a
 * dummy value required by the OpenAI SDK that the Ollama server does not
 * check. OLLAMA_VISION_MODEL / OLLAMA_VISION_MAX_OUTPUT_TOKENS are Ollama
 * specific: the sidecar vision model that describes image attachments as text
 * through /v1/chat/completions (Ollama's /v1/responses has no image input).
 *
 * @returns {ReturnType<typeof getCommonConfig> & {visionModel: string,
 *   visionMaxOutputTokens: number}}
 */
export function getOllamaConfig() {
	return {
		...getCommonConfig(PROVIDER_OLLAMA, {
			baseUrl: "http://localhost:11434/v1",
			apiKey: "ollama",
			model: "qwen3.8:27b",
		}),
		// Optional sidecar vision model (e.g. qwen3-vl:8b-instruct-8k). Empty =
		// image descriptions disabled. Vision models often enforce a small
		// context (8k), so the description output cap must stay modest to leave
		// room for the image tokens.
		visionModel: (process.env.OLLAMA_VISION_MODEL || "").trim(),
		visionMaxOutputTokens: parsePositiveInt(process.env.OLLAMA_VISION_MAX_OUTPUT_TOKENS, 600),
	};
}

/**
 * Get the vLLM preset configuration.
 *
 * The model may be left unset: vLLM serves a single model per instance, so the
 * health check adopts the served model automatically. The context length may
 * also be left unset: the health check detects max_model_len via /v1/models
 * (an explicit smaller value still wins as a tighter budget).
 *
 * @returns {ReturnType<typeof getCommonConfig>}
 */
export function getVllmConfig() {
	return getCommonConfig(PROVIDER_VLLM, {
		baseUrl: "http://localhost:8000/v1",
		apiKey: "vllm",
		model: "",
	});
}

/**
 * Get the generic OpenAI-compatible preset configuration.
 *
 * This preset makes no assumption about the server beyond the OpenAI Responses
 * API surface: AI_MODEL is therefore required (a gateway typically serves many
 * models), image input is opt-in (AI_IMAGE_INPUT) and the strict chat-template
 * conforming that vLLM needs is opt-in (AI_STRICT_INPUT).
 *
 * @returns {ReturnType<typeof getCommonConfig> & {imageInput: boolean, strictInput: boolean}}
 */
export function getOpenAiCompatibleConfig() {
	return {
		...getCommonConfig(PROVIDER_OPENAI_COMPATIBLE, {
			baseUrl: "http://localhost:8000/v1",
			// Some gateways enforce a key, some ignore it; the SDK requires one either way
			apiKey: "none",
			model: "",
		}),
		imageInput: parseBooleanFlag(process.env.AI_IMAGE_INPUT, false),
		strictInput: parseBooleanFlag(process.env.AI_STRICT_INPUT, false),
	};
}

function getPresetConfig(providerName) {
	switch (providerName) {
		case PROVIDER_OLLAMA:
			return getOllamaConfig();
		case PROVIDER_VLLM:
			return getVllmConfig();
		case PROVIDER_OPENAI_COMPATIBLE:
			return getOpenAiCompatibleConfig();
		default:
			return null;
	}
}

// ---------------------------------------------------------------------------
// Knowledge-base embeddings
// ---------------------------------------------------------------------------

/**
 * Per-task `input_type` values an embedding API requires, if any.
 *
 * @param {string} model - Embedding model name
 * @returns {{query: string, document: string}} Empty strings = field not sent
 */
export function getEmbeddingInputTypes(model) {
	const queryOverride = process.env.AI_EMBEDDING_QUERY_INPUT_TYPE;
	const documentOverride = process.env.AI_EMBEDDING_DOCUMENT_INPUT_TYPE;
	if (queryOverride !== undefined || documentOverride !== undefined) {
		return { query: (queryOverride || "").trim(), document: (documentOverride || "").trim() };
	}
	// NVIDIA retrieval embedders (nv-embedqa-e5-v5, llama-3.2-nv-embedqa-1b-v2,
	// nv-embed-v1, ...) reject requests without input_type
	if (/nv-embed|embedqa/i.test(model)) {
		return { query: "query", document: "passage" };
	}
	return { query: "", document: "" };
}

/**
 * Operator overrides for the embedding task prefixes
 * (AI_EMBEDDING_QUERY_PREFIX / AI_EMBEDDING_DOCUMENT_PREFIX, or their OLLAMA_*
 * aliases). Setting either one, even empty, replaces the per-model defaults.
 *
 * @param {string} [providerName] - Preset (defaults to the active one)
 * @returns {{query: string, document: string}|null} null = no override
 */
export function getEmbeddingPrefixOverrides(providerName = getAiProviderName()) {
	const query = readAiSetting(providerName, "EMBEDDING_QUERY_PREFIX", { allowEmpty: true });
	const document = readAiSetting(providerName, "EMBEDDING_DOCUMENT_PREFIX", {
		allowEmpty: true,
	});
	if (query.value === undefined && document.value === undefined) return null;
	return { query: query.value || "", document: document.value || "" };
}

/**
 * Get the embedding backend for the local knowledge base, based on the active
 * AI provider. Returns null when no embedding backend applies: OpenAI mode uses
 * hosted file_search; the other presets need AI_EMBEDDING_MODEL (Ollama
 * defaults it to nomic-embed-text), served from AI_EMBEDDING_BASE_URL or, by
 * default, the chat base URL with the chat API key. vLLM is the exception: a
 * vLLM instance serves a single model, so the chat instance cannot embed and
 * AI_EMBEDDING_BASE_URL must point to a dedicated endpoint.
 *
 * The entry carries `inputTypes`: some embedding APIs (NVIDIA NIM's nv-embedqa
 * / nv-embed models) require a per-request `input_type` of "query" or
 * "passage" instead of, or in addition to, the text prefixes other models use.
 * Detected from the model name, overridable with AI_EMBEDDING_QUERY_INPUT_TYPE
 * / AI_EMBEDDING_DOCUMENT_INPUT_TYPE (set both empty to send none).
 *
 * @param {string} [providerName] - Provider name (defaults to the active one)
 * @returns {{baseUrl: string, apiKey: string, model: string,
 *   inputTypes: {query: string, document: string}}|null}
 */
export function getEmbeddingBackendConfig(providerName = getAiProviderName()) {
	const chat = getPresetConfig(providerName);
	if (!chat) return null;

	const read = (setting) => readAiSetting(providerName, setting).value;
	const defaultModel = providerName === PROVIDER_OLLAMA ? "nomic-embed-text" : "";
	const model = (read("EMBEDDING_MODEL") || defaultModel).trim();
	if (!model) return null;

	const baseUrl = (read("EMBEDDING_BASE_URL") || "").trim().replace(/\/+$/, "");
	if (!baseUrl && providerName === PROVIDER_VLLM) return null;

	return {
		baseUrl: baseUrl || chat.baseUrl,
		apiKey: read("EMBEDDING_API_KEY") || chat.apiKey,
		model,
		inputTypes: getEmbeddingInputTypes(model),
	};
}
