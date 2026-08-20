/**
 * OpenAI provider - wraps the existing hosted OpenAI Responses API behavior.
 */

import { MODEL_CONFIG } from "../config/system-prompt.js";
import { openai } from "../services/openai.js";
import { buildResponseRequest } from "../services/streaming.js";

/**
 * Create the OpenAI provider descriptor.
 *
 * @returns {import("./index.js").AiProvider}
 */
export function createOpenAiProvider() {
	return {
		name: "openai",
		model: MODEL_CONFIG.model,
		endpoint: "https://api.openai.com/v1",
		client: openai,
		// Context management stays threshold-based (TOKEN_LIMITS); no hard window here.
		contextWindow: null,
		maxOutputTokens: MODEL_CONFIG.maxOutputTokens,
		capabilities: {
			serverSideState: true,
			hostedFileSearch: true,
			codeInterpreter: true,
			hostedWebSearch: true,
			providerFileUploads: true,
			toolNamespaces: true,
		},
		buildRequest(params) {
			return buildResponseRequest(params);
		},
		async healthCheck() {
			if (!process.env.OPENAI_API_KEY) {
				return { ok: false, error: "OPENAI_API_KEY is not set" };
			}
			return { ok: true, detail: "API key configured" };
		},
	};
}
