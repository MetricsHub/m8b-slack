/**
 * AI provider configuration.
 *
 * Selects between the hosted OpenAI backend (default) and a local Ollama backend
 * exposing the OpenAI-compatible /v1/responses API.
 */

export const PROVIDER_OPENAI = "openai";
export const PROVIDER_OLLAMA = "ollama";

/**
 * Maximum agent-loop iterations (model -> tool calls -> model) per Slack message.
 * Prevents runaway tool loops on both providers.
 */
export const MAX_AGENT_ITERATIONS = (() => {
	const parsed = Number.parseInt(process.env.AI_MAX_AGENT_ITERATIONS || "", 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 10;
})();

function parsePositiveInt(value, fallback) {
	const parsed = Number.parseInt(value || "", 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Get the configured AI provider name.
 *
 * @returns {string} "openai" or "ollama"
 */
export function getAiProviderName() {
	const raw = (process.env.AI_PROVIDER || PROVIDER_OPENAI).trim().toLowerCase();
	return raw === PROVIDER_OLLAMA ? PROVIDER_OLLAMA : PROVIDER_OPENAI;
}

/**
 * Get the Ollama backend configuration from environment variables.
 *
 * OLLAMA_API_KEY is a dummy value required by the OpenAI SDK; the local
 * Ollama server does not check it.
 *
 * @returns {{baseUrl: string, apiKey: string, model: string, embeddingModel: string,
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

	// Inline cap for a single tool result. Default scales with the context
	// window (~40% of the usable budget, in chars at ~4 chars/token) so raising
	// OLLAMA_CONTEXT_LENGTH automatically allows bigger tool outputs.
	const usableBudgetChars = Math.max(contextWindow - maxOutputTokens - 1500, 4000) * 4;
	const defaultToolOutputChars = Math.max(20000, Math.floor(usableBudgetChars * 0.4));

	return {
		baseUrl: (process.env.OLLAMA_BASE_URL || "http://localhost:11434/v1").replace(/\/+$/, ""),
		apiKey: process.env.OLLAMA_API_KEY || "ollama",
		model: process.env.OLLAMA_MODEL || "qwen3.8:27b",
		embeddingModel: process.env.OLLAMA_EMBEDDING_MODEL || "nomic-embed-text",
		contextWindow,
		maxOutputTokens,
		requestTimeoutMs: parsePositiveInt(process.env.OLLAMA_REQUEST_TIMEOUT_MS, 300000),
		maxToolOutputChars: parsePositiveInt(
			process.env.OLLAMA_MAX_TOOL_OUTPUT_CHARS,
			defaultToolOutputChars
		),
	};
}
