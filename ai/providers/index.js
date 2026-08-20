/**
 * AI provider registry.
 *
 * The rest of the Slackbot depends on this abstraction instead of checking
 * AI_PROVIDER directly. A provider exposes:
 *
 * @typedef {Object} AiProvider
 * @property {string} name - "openai" or "ollama"
 * @property {string} model - Active chat model
 * @property {string} endpoint - Base URL used for the Responses API (for logging)
 * @property {Object} client - OpenAI SDK client bound to the provider endpoint
 * @property {number|null} contextWindow - Hard context window in tokens (null = provider-managed)
 * @property {number} maxOutputTokens - Output token cap per turn
 * @property {number} [maxToolOutputChars] - Inline cap for a single tool result (small-context providers)
 * @property {Object} capabilities - Feature flags
 * @property {boolean} capabilities.serverSideState - previous_response_id support
 * @property {boolean} capabilities.hostedFileSearch - Hosted file_search/vector stores
 * @property {boolean} capabilities.codeInterpreter - Hosted code_interpreter
 * @property {boolean} capabilities.hostedWebSearch - Hosted web_search tool
 * @property {boolean} capabilities.providerFileUploads - Files API for Slack attachments
 * @property {boolean} capabilities.toolNamespaces - Deferred tool_search namespaces
 * @property {Function} buildRequest - Build a Responses API streaming request
 * @property {Function} healthCheck - Async health check: {ok, detail?, error?}
 */

import { getAiProviderName, PROVIDER_OLLAMA } from "../config/providers.js";
import { createOllamaProvider } from "./ollama-provider.js";
import { createOpenAiProvider } from "./openai-provider.js";

let cachedProvider = null;

/**
 * Get the active AI provider (singleton).
 *
 * @returns {AiProvider}
 */
export function getProvider() {
	if (!cachedProvider) {
		cachedProvider =
			getAiProviderName() === PROVIDER_OLLAMA ? createOllamaProvider() : createOpenAiProvider();
	}
	return cachedProvider;
}

/**
 * Reset the cached provider (used by tests to re-read the environment).
 */
export function resetProviderCache() {
	cachedProvider = null;
}

/**
 * Translate a provider/transport error into a short, user-friendly Slack message.
 * Detailed errors belong in logs, not in Slack.
 *
 * @param {any} error - The thrown error
 * @param {AiProvider} provider - Active provider
 * @returns {string} Friendly one-liner
 */
export function describeProviderError(error, provider) {
	const message = String(error?.message || error || "").toLowerCase();
	const status = error?.status;

	if (provider?.name === "ollama") {
		if (
			message.includes("econnrefused") ||
			message.includes("fetch failed") ||
			message.includes("connection error") ||
			message.includes("enotfound")
		) {
			return "Can't reach the local AI backend. Someone unplugged it, probably. 🔌";
		}
		if (status === 404 || message.includes("not found")) {
			return "The local AI model isn't installed. Tell whoever runs the GPU box.";
		}
		if (message.includes("timeout") || message.includes("timed out") || status === 408) {
			return "The local AI backend timed out. It's thinking too hard. Try again.";
		}
		if (message.includes("context") && (message.includes("length") || message.includes("window"))) {
			return "This conversation is too long for my local brain. Start a new thread.";
		}
		return "The local AI backend choked on that one. Try again. 🤷";
	}

	return `FFS... 🤦‍♂️ ${error}`;
}
