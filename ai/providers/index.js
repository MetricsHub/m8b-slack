/**
 * AI provider registry.
 *
 * The rest of the Slackbot depends on this abstraction instead of checking
 * AI_PROVIDER directly. A provider exposes:
 *
 * @typedef {Object} AiProvider
 * @property {string} name - "openai", "ollama", "vllm", or "openai-compatible"
 * @property {boolean} [isLocal] - Self-hosted backend (anything but OpenAI): nothing is ever
 *   sent to OpenAI, and the friendly local error messages apply
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
 * @property {boolean} capabilities.localCodeInterpreter - App-side Python sandbox (run_python via Pyodide)
 * @property {boolean} capabilities.hostedWebSearch - Hosted web_search tool
 * @property {boolean} capabilities.providerFileUploads - Files API for Slack attachments
 * @property {boolean} capabilities.imageDescriptions - Sidecar vision model describes image attachments as text
 * @property {boolean} capabilities.imageInput - Model reads images natively via input_image items
 * @property {boolean} capabilities.toolNamespaces - Deferred tool_search namespaces
 * @property {Function} buildRequest - Build a Responses API streaming request
 * @property {Function} [describeImage] - Describe an image attachment as text (imageDescriptions providers)
 * @property {Function} healthCheck - Async health check: {ok, detail?, error?}
 */

import {
	getAiProviderName,
	getOpenAiCompatibleConfig,
	PROVIDER_OLLAMA,
	PROVIDER_OPENAI_COMPATIBLE,
	PROVIDER_VLLM,
} from "../config/providers.js";
import { createOllamaProvider } from "./ollama-provider.js";
import { createOpenAiCompatibleProvider } from "./openai-compatible-provider.js";
import { createOpenAiProvider } from "./openai-provider.js";
import { createVllmProvider } from "./vllm-provider.js";

/**
 * Build the generic OpenAI-compatible provider from the AI_* environment.
 *
 * @returns {AiProvider}
 */
function createGenericProvider() {
	const config = getOpenAiCompatibleConfig();
	// A gateway usually fronts many models, so the bot never guesses one. The
	// health check would report the gap, but app.js only logs that result and
	// starts anyway: reject the unusable configuration before anything runs.
	if (!config.model) {
		throw new Error(
			`AI_PROVIDER=openai-compatible requires AI_MODEL (the served model to use; GET ${config.baseUrl}/models lists the available IDs)`
		);
	}
	return createOpenAiCompatibleProvider({
		name: PROVIDER_OPENAI_COMPATIBLE,
		label: "AI backend",
		baseUrl: config.baseUrl,
		apiKey: config.apiKey,
		model: config.model,
		contextWindow: config.contextWindow,
		contextLengthExplicit: Boolean(process.env.AI_CONTEXT_LENGTH),
		maxOutputTokens: config.maxOutputTokens,
		maxToolOutputChars: config.maxToolOutputChars,
		maxToolOutputCharsExplicit: Boolean(process.env.AI_MAX_TOOL_OUTPUT_CHARS),
		requestTimeoutMs: config.requestTimeoutMs,
		imageInput: config.imageInput,
		strictInput: config.strictInput,
		adoptSingleServedModel: false,
		envNames: { model: "AI_MODEL", contextLength: "AI_CONTEXT_LENGTH" },
	});
}

let cachedProvider = null;

/**
 * Get the active AI provider (singleton).
 *
 * @returns {AiProvider}
 */
export function getProvider() {
	if (!cachedProvider) {
		const name = getAiProviderName();
		switch (name) {
			case PROVIDER_OLLAMA:
				cachedProvider = createOllamaProvider();
				break;
			case PROVIDER_VLLM:
				cachedProvider = createVllmProvider();
				break;
			case PROVIDER_OPENAI_COMPATIBLE:
				cachedProvider = createGenericProvider();
				break;
			default:
				cachedProvider = createOpenAiProvider();
		}
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

	if (provider?.isLocal) {
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
