/**
 * vLLM provider - local models through vLLM's OpenAI-compatible /v1/responses API.
 *
 * Like Ollama, this backend is treated as stateless: vLLM's Responses API
 * store is an unbounded, process-local in-memory store, so previous_response_id
 * is deliberately NOT used and conversation history stays application-side
 * (see ai/services/conversation-store.js) and is resent in `input`.
 *
 * Unlike Ollama, the served model is multimodal: image attachments are passed
 * natively as input_image items (capabilities.imageInput). Images are
 * referenced by short internal URLs from the local media store when
 * M8B_MEDIA_BASE_URL is configured (see ai/services/media-store.js), so
 * resent history stays small; without it they degrade to inline base64 data
 * URLs. vLLM's input_image schema REQUIRES the `detail` field (validated on
 * vLLM 0.27.1), so every item the app builds carries it.
 *
 * Only fields vLLM supports are sent: model, input, tools, stream,
 * max_output_tokens. OpenAI-only fields (reasoning, text, safety_identifier,
 * previous_response_id, hosted tool types) must NOT be sent.
 */

import { OpenAI } from "openai";
import {
	defaultToolOutputChars,
	getCodeSandboxConfig,
	getVllmConfig,
} from "../config/providers.js";
import {
	getMediaStoreConfig,
	isMediaStoreConfigured,
	replaceUnavailableMediaImages,
} from "../services/media-store.js";

function isContextLengthExplicit() {
	return Boolean(process.env.VLLM_CONTEXT_LENGTH);
}

/**
 * Conform input items to what the served model's chat template accepts. Three
 * documented incompatibilities with the item shapes the app (and Ollama) uses:
 *
 * 1. The standard Qwen chat template allows exactly ONE system message, and
 *    it must be message #1 ("400 System message must be at the beginning").
 *    The app legitimately builds several leading system items (base prompt,
 *    attachment guidance, first-turn user context): they are merged into one
 *    system message. (The earlier INT8 checkpoint shipped an Unsloth-style
 *    template that merged leading system messages itself; the stock template
 *    does not, so the merge must happen here.)
 * 2. Mid-conversation system items (continuation/no-repeat nudges, trim
 *    notices, later user-context notes) are rejected outright: they are
 *    re-roled as clearly labeled user notes.
 * 3. Replayed assistant history items carry content as
 *    [{type:"output_text", text}], which vLLM's EasyInputMessage schema does
 *    not accept (the output_text-list form belongs to the full
 *    ResponseOutputMessage shape with id/status/annotations). An assistant
 *    message in `input` must carry its content as a plain string instead.
 *
 * The transform is deterministic, so identical conversations still produce
 * identical token prefixes for the server's prefix cache. The input array is
 * returned as-is when nothing needs to change.
 *
 * @param {Array} input - Responses API input items
 * @returns {Array} The same array, or a copy with conformed items
 */
function conformInputItems(input) {
	if (!Array.isArray(input)) return input;

	let leadingSystemCount = 0;
	while (leadingSystemCount < input.length && input[leadingSystemCount]?.role === "system") {
		leadingSystemCount++;
	}

	let changed = false;
	const result = [];

	// Merge the leading system block into a single system message
	if (leadingSystemCount > 1) {
		const texts = [];
		for (const item of input.slice(0, leadingSystemCount)) {
			if (typeof item.content === "string") {
				texts.push(item.content);
			} else {
				for (const c of item.content ?? []) {
					if (c?.type === "input_text" && c.text) texts.push(c.text);
				}
			}
		}
		result.push({ role: "system", content: [{ type: "input_text", text: texts.join("\n\n") }] });
		changed = true;
	} else if (leadingSystemCount === 1) {
		result.push(input[0]);
	}

	for (const item of input.slice(leadingSystemCount)) {
		if (item?.role === "system") {
			changed = true;
			result.push({
				...item,
				role: "user",
				content: Array.isArray(item.content)
					? item.content.map((c) =>
							c?.type === "input_text" ? { ...c, text: `[System note] ${c.text}` } : c
						)
					: item.content,
			});
		} else if (
			item?.role === "assistant" &&
			Array.isArray(item.content) &&
			item.content.length > 0 &&
			item.content.every((c) => c?.type === "output_text" && typeof c.text === "string")
		) {
			changed = true;
			result.push({ ...item, content: item.content.map((c) => c.text).join("") });
		} else {
			result.push(item);
		}
	}

	return changed ? result : input;
}

/**
 * Create the vLLM provider descriptor.
 *
 * @returns {import("./index.js").AiProvider}
 */
export function createVllmProvider() {
	const config = getVllmConfig();

	const client = new OpenAI({
		baseURL: config.baseUrl,
		apiKey: config.apiKey,
		timeout: config.requestTimeoutMs,
	});

	const provider = {
		name: "vllm",
		isLocal: true,
		// May be "" until the health check adopts the single served model
		model: config.model,
		endpoint: config.baseUrl,
		client,
		contextWindow: config.contextWindow,
		maxOutputTokens: config.maxOutputTokens,
		maxToolOutputChars: config.maxToolOutputChars,
		capabilities: {
			serverSideState: false,
			hostedFileSearch: false,
			codeInterpreter: false,
			localCodeInterpreter: getCodeSandboxConfig().enabled,
			hostedWebSearch: false,
			providerFileUploads: false,
			imageDescriptions: false,
			imageInput: true,
			toolNamespaces: false,
		},
		buildRequest({ input, tools, tool_choice }) {
			const request = {
				// provider.model, not config.model: the health check may have
				// adopted the served model when VLLM_MODEL was left unset
				model: provider.model,
				// An expired media file would fail the whole request with a 422,
				// so swap dead image references for a text marker first; then
				// conform item shapes to vLLM's stricter schema (mid-conversation
				// system nudges, replayed assistant messages)
				input: conformInputItems(replaceUnavailableMediaImages(input)),
				max_output_tokens: config.maxOutputTokens,
				stream: true,
			};

			// tool_choice "none" (used to force a text-only continuation turn) is
			// emulated by omitting the tools array: it saves the tool-schema tokens
			// and behaves identically on local models.
			if (tool_choice !== "none" && Array.isArray(tools) && tools.length > 0) {
				request.tools = tools;
			}

			return request;
		},
		async healthCheck() {
			try {
				const response = await fetch(`${config.baseUrl}/models`, {
					headers: { Authorization: `Bearer ${config.apiKey}` },
					signal: AbortSignal.timeout(10000),
				});

				if (!response.ok) {
					return { ok: false, error: `vLLM responded with HTTP ${response.status}` };
				}

				const body = await response.json();
				const models = Array.isArray(body?.data) ? body.data : [];
				const modelIds = models.map((m) => m?.id).filter(Boolean);

				// vLLM serves one model per instance: adopt it when VLLM_MODEL is unset
				let served = models.find((m) => m?.id === provider.model);
				if (!provider.model) {
					if (models.length !== 1) {
						return {
							ok: false,
							error: `VLLM_MODEL is not set and ${config.baseUrl} serves ${models.length} models (${modelIds.join(", ") || "none"}); set VLLM_MODEL explicitly.`,
						};
					}
					served = models[0];
					provider.model = served.id;
				} else if (!served) {
					return {
						ok: false,
						error: `Model "${provider.model}" not found on ${config.baseUrl}. Available: ${modelIds.join(", ") || "(none)"}.`,
					};
				}

				// Reconcile the context window with the server's max_model_len.
				// Detected server truth beats the default; an explicit env value
				// beats detection only when it is SMALLER (a tighter budget is
				// safe) — a larger value would let oversized prompts through.
				const detected = Number(served?.max_model_len);
				let contextDetail = `context ${provider.contextWindow} (configured; server value not reported)`;
				let warning;

				if (Number.isFinite(detected) && detected > 0) {
					if (!isContextLengthExplicit()) {
						provider.contextWindow = detected;
						contextDetail = `context ${detected} (detected from /v1/models max_model_len)`;
					} else if (provider.contextWindow > detected) {
						warning = `Configured VLLM_CONTEXT_LENGTH (${provider.contextWindow}) exceeds the server's max_model_len (${detected}); using ${detected} to avoid rejected requests.`;
						provider.contextWindow = detected;
						contextDetail = `context ${detected} (server-limited)`;
					} else {
						contextDetail = `context ${provider.contextWindow} (configured; server allows ${detected})`;
					}

					// The default inline tool-output cap is derived from the context
					// window; keep it consistent when the window was reconciled
					if (!process.env.VLLM_MAX_TOOL_OUTPUT_CHARS) {
						provider.maxToolOutputChars = defaultToolOutputChars(
							provider.contextWindow,
							config.maxOutputTokens
						);
					}
				}

				// Native vision works either way; without the media store the
				// resent history carries full base64 images, which gets heavy
				let mediaDetail;
				let mediaWarning;
				if (isMediaStoreConfigured()) {
					mediaDetail = `media store at ${getMediaStoreConfig().baseUrl}`;
				} else {
					mediaDetail = "media store NOT configured (images sent inline as base64)";
					mediaWarning =
						"M8B_MEDIA_BASE_URL is not set: image attachments are embedded as base64 in every resent request. Configure the media store for production use.";
				}

				return {
					ok: true,
					detail: `model "${provider.model}" available, ${contextDetail}, ${mediaDetail}`,
					warning: [warning, mediaWarning].filter(Boolean).join(" ") || undefined,
				};
			} catch (e) {
				return {
					ok: false,
					error: `vLLM unreachable at ${config.baseUrl}: ${e?.message || e}`,
				};
			}
		},
	};

	return provider;
}
