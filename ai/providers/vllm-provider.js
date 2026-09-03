/**
 * vLLM provider - local models through vLLM's OpenAI-compatible /v1/responses API.
 *
 * A preset of the shared OpenAI-compatible provider
 * (see ./openai-compatible-provider.js) with what vLLM specifically needs:
 *
 * - Stateless use: vLLM's Responses store is an unbounded, process-local
 *   in-memory store, so previous_response_id is deliberately NOT used and the
 *   conversation history is resent in `input`.
 * - Native vision: the served model is multimodal, so image attachments are
 *   passed as input_image items (the `detail` field is REQUIRED by vLLM's
 *   schema, validated on vLLM 0.27.1), referencing local media-store URLs
 *   when M8B_MEDIA_BASE_URL is configured.
 * - Strict input conforming: the stock Qwen chat template accepts a single
 *   leading system message and rejects the output_text-list assistant shape.
 * - One model per instance: the served model is adopted when VLLM_MODEL is
 *   unset, and max_model_len from /v1/models sizes the context window.
 */

import { getVllmConfig } from "../config/providers.js";
import { createOpenAiCompatibleProvider } from "./openai-compatible-provider.js";

/**
 * Create the vLLM provider descriptor.
 *
 * @returns {import("./index.js").AiProvider}
 */
export function createVllmProvider() {
	const config = getVllmConfig();

	return createOpenAiCompatibleProvider({
		name: "vllm",
		label: "vLLM",
		baseUrl: config.baseUrl,
		apiKey: config.apiKey,
		model: config.model,
		contextWindow: config.contextWindow,
		contextLengthExplicit: config.contextLengthExplicit,
		maxOutputTokens: config.maxOutputTokens,
		maxToolOutputChars: config.maxToolOutputChars,
		maxToolOutputCharsExplicit: config.maxToolOutputCharsExplicit,
		requestTimeoutMs: config.requestTimeoutMs,
		imageInput: true,
		strictInput: true,
		adoptSingleServedModel: true,
		// vLLM always serves /v1/models: any failure there is a real failure
		tolerateMissingModelList: false,
		envNames: {
			model: "VLLM_MODEL",
			contextLength: "VLLM_CONTEXT_LENGTH",
			maxOutputTokens: "VLLM_MAX_OUTPUT_TOKENS",
		},
	});
}
