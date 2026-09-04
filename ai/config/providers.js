/**
 * AI provider configuration.
 *
 * Selects between the hosted OpenAI backend (default), a local backend
 * exposing the OpenAI-compatible /v1/responses API (Ollama or vLLM), or any
 * other OpenAI-compatible endpoint (a corporate inference proxy, a NIM, a
 * LiteLLM gateway, ...) through the generic "openai-compatible" provider.
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

/**
 * Get the Ollama backend configuration from environment variables.
 *
 * OLLAMA_API_KEY is a dummy value required by the OpenAI SDK; the local
 * Ollama server does not check it.
 *
 * @returns {{baseUrl: string, apiKey: string, model: string, embeddingModel: string,
 *   visionModel: string, visionMaxOutputTokens: number,
 *   contextWindow: number, maxOutputTokens: number, requestTimeoutMs: number,
 *   maxToolOutputChars: number}}
 */
export function getOllamaConfig() {
	// Named like Ollama's own server-side variable so the same value/line can
	// be used on both sides; they must match Ollama's effective num_ctx.
	// OLLAMA_CONTEXT_WINDOW is the deprecated former name, kept as fallback.
	const contextWindow = parsePositiveInt(
		process.env.OLLAMA_CONTEXT_LENGTH || process.env.OLLAMA_CONTEXT_WINDOW,
		32768
	);
	const maxOutputTokens = parsePositiveInt(process.env.OLLAMA_MAX_OUTPUT_TOKENS, 4000);

	// Inline cap for a single tool result: scales with the context window so
	// raising OLLAMA_CONTEXT_LENGTH automatically allows bigger tool outputs

	return {
		baseUrl: (process.env.OLLAMA_BASE_URL || "http://localhost:11434/v1").replace(/\/+$/, ""),
		apiKey: process.env.OLLAMA_API_KEY || "ollama",
		model: process.env.OLLAMA_MODEL || "qwen3.8:27b",
		embeddingModel: process.env.OLLAMA_EMBEDDING_MODEL || "nomic-embed-text",
		// Optional sidecar vision model used to describe image attachments as text
		// (e.g. qwen3-vl:8b-instruct-8k). Empty = image descriptions disabled.
		// Called through /v1/chat/completions: Ollama's /v1/responses has no image input.
		// Vision models often enforce a small context (8k), so the description
		// output cap must stay modest to leave room for the image tokens.
		visionModel: (process.env.OLLAMA_VISION_MODEL || "").trim(),
		visionMaxOutputTokens: parsePositiveInt(process.env.OLLAMA_VISION_MAX_OUTPUT_TOKENS, 600),
		contextWindow,
		maxOutputTokens,
		requestTimeoutMs: parsePositiveInt(process.env.OLLAMA_REQUEST_TIMEOUT_MS, 300000),
		maxToolOutputChars: parsePositiveInt(
			process.env.OLLAMA_MAX_TOOL_OUTPUT_CHARS,
			defaultToolOutputChars(contextWindow, maxOutputTokens)
		),
	};
}

/**
 * Get the vLLM backend configuration from environment variables.
 *
 * VLLM_MODEL may be left unset: vLLM serves a single model per instance, so
 * the health check adopts the served model automatically. VLLM_CONTEXT_LENGTH
 * may also be left unset: the health check detects max_model_len via
 * /v1/models (an explicit smaller value still wins as a tighter budget).
 *
 * @returns {{baseUrl: string, apiKey: string, model: string, contextWindow: number,
 *   contextLengthExplicit: boolean, maxOutputTokens: number, requestTimeoutMs: number,
 *   maxToolOutputChars: number, maxToolOutputCharsExplicit: boolean}}
 */
export function getVllmConfig() {
	const contextWindow = parsePositiveInt(process.env.VLLM_CONTEXT_LENGTH, 32768);
	const maxOutputTokens = parsePositiveInt(process.env.VLLM_MAX_OUTPUT_TOKENS, 4000);

	return {
		baseUrl: (process.env.VLLM_BASE_URL || "http://localhost:8000/v1").replace(/\/+$/, ""),
		apiKey: process.env.VLLM_API_KEY || "vllm",
		model: (process.env.VLLM_MODEL || "").trim(),
		contextWindow,
		// "Explicit" means a VALID value: an invalid one falls back to the default
		// and must not be treated as an operator decision
		contextLengthExplicit: isPositiveInt(process.env.VLLM_CONTEXT_LENGTH),
		maxOutputTokens,
		requestTimeoutMs: parsePositiveInt(process.env.VLLM_REQUEST_TIMEOUT_MS, 300000),
		maxToolOutputChars: parsePositiveInt(
			process.env.VLLM_MAX_TOOL_OUTPUT_CHARS,
			defaultToolOutputChars(contextWindow, maxOutputTokens)
		),
		maxToolOutputCharsExplicit: isPositiveInt(process.env.VLLM_MAX_TOOL_OUTPUT_CHARS),
	};
}

/**
 * Get the generic OpenAI-compatible backend configuration from environment
 * variables (AI_PROVIDER=openai-compatible).
 *
 * This provider makes no assumption about the server beyond the OpenAI
 * Responses API surface: AI_MODEL is therefore required (a gateway typically
 * serves many models), image input is opt-in (AI_IMAGE_INPUT), the strict
 * chat-template conforming that vLLM needs is opt-in (AI_STRICT_INPUT), and
 * the knowledge base is enabled only when an embedding model is configured
 * (AI_EMBEDDING_MODEL, served from AI_EMBEDDING_BASE_URL or, by default, the
 * same base URL).
 *
 * @returns {{baseUrl: string, apiKey: string, model: string, contextWindow: number,
 *   contextLengthExplicit: boolean, maxOutputTokens: number, requestTimeoutMs: number,
 *   maxToolOutputChars: number, maxToolOutputCharsExplicit: boolean,
 *   imageInput: boolean, strictInput: boolean}}
 */
export function getOpenAiCompatibleConfig() {
	const contextWindow = parsePositiveInt(process.env.AI_CONTEXT_LENGTH, 32768);
	const maxOutputTokens = parsePositiveInt(process.env.AI_MAX_OUTPUT_TOKENS, 4000);

	return {
		baseUrl: (process.env.AI_BASE_URL || "http://localhost:8000/v1").replace(/\/+$/, ""),
		// Some gateways enforce a key, some ignore it; the SDK requires one either way
		apiKey: process.env.AI_API_KEY || "none",
		model: (process.env.AI_MODEL || "").trim(),
		contextWindow,
		// "Explicit" means a VALID value: an invalid one falls back to the default
		// and must not be treated as an operator decision
		contextLengthExplicit: isPositiveInt(process.env.AI_CONTEXT_LENGTH),
		maxOutputTokens,
		requestTimeoutMs: parsePositiveInt(process.env.AI_REQUEST_TIMEOUT_MS, 300000),
		maxToolOutputChars: parsePositiveInt(
			process.env.AI_MAX_TOOL_OUTPUT_CHARS,
			defaultToolOutputChars(contextWindow, maxOutputTokens)
		),
		maxToolOutputCharsExplicit: isPositiveInt(process.env.AI_MAX_TOOL_OUTPUT_CHARS),
		imageInput: parseBooleanFlag(process.env.AI_IMAGE_INPUT, false),
		strictInput: parseBooleanFlag(process.env.AI_STRICT_INPUT, false),
	};
}

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
 * Get the embedding backend for the local knowledge base, based on the active
 * AI provider. Returns null when no embedding backend applies (OpenAI mode
 * uses hosted file_search; vLLM mode needs a dedicated endpoint because a
 * vLLM instance serves a single model, so the chat instance cannot embed;
 * the generic openai-compatible mode needs AI_EMBEDDING_MODEL, served from
 * AI_EMBEDDING_BASE_URL or the chat base URL).
 *
 * The openai-compatible entry may carry `inputTypes`: some embedding APIs
 * (NVIDIA NIM's nv-embedqa / nv-embed models) require a per-request
 * `input_type` of "query" or "passage" instead of, or in addition to, the text
 * prefixes other models use. Detected from the model name, overridable with
 * AI_EMBEDDING_QUERY_INPUT_TYPE / AI_EMBEDDING_DOCUMENT_INPUT_TYPE (set both
 * empty to send none).
 *
 * @param {string} [providerName] - Provider name (defaults to the active one)
 * @returns {{baseUrl: string, apiKey: string, model: string,
 *   inputTypes?: {query: string, document: string}}|null}
 */
export function getEmbeddingBackendConfig(providerName = getAiProviderName()) {
	if (providerName === PROVIDER_OLLAMA) {
		const { baseUrl, apiKey, embeddingModel } = getOllamaConfig();
		return { baseUrl, apiKey, model: embeddingModel };
	}

	if (providerName === PROVIDER_VLLM) {
		const baseUrl = (process.env.VLLM_EMBEDDING_BASE_URL || "").trim().replace(/\/+$/, "");
		const model = (process.env.VLLM_EMBEDDING_MODEL || "").trim();
		if (!baseUrl || !model) return null;
		return {
			baseUrl,
			apiKey: process.env.VLLM_EMBEDDING_API_KEY || process.env.VLLM_API_KEY || "vllm",
			model,
		};
	}

	if (providerName === PROVIDER_OPENAI_COMPATIBLE) {
		const chat = getOpenAiCompatibleConfig();
		const model = (process.env.AI_EMBEDDING_MODEL || "").trim();
		if (!model) return null;
		const baseUrl = (process.env.AI_EMBEDDING_BASE_URL || "").trim().replace(/\/+$/, "");
		return {
			baseUrl: baseUrl || chat.baseUrl,
			apiKey: process.env.AI_EMBEDDING_API_KEY || chat.apiKey,
			model,
			inputTypes: getEmbeddingInputTypes(model),
		};
	}

	return null;
}
