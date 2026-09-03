/**
 * OpenAI-compatible provider - any backend exposing the OpenAI Responses API
 * (`/v1/responses` with streaming and function tools) other than OpenAI itself:
 * a corporate inference proxy, an NVIDIA NIM, a LiteLLM gateway, vLLM, ...
 *
 * The backend is treated as STATELESS: `previous_response_id` is never sent,
 * conversation history stays application-side (see
 * ai/services/conversation-store.js) and is resent in `input`. Only fields
 * that every Responses implementation accepts are emitted: model, input,
 * tools, stream, max_output_tokens. OpenAI-only fields (reasoning, text,
 * safety_identifier, previous_response_id, hosted tool types) are NOT sent.
 *
 * `createOpenAiCompatibleProvider(options)` is the shared implementation; the
 * generic `AI_PROVIDER=openai-compatible` mode (configured by `AI_*` variables)
 * and the `vllm` preset are both built on it. Behaviors that depend on the
 * served model rather than on the API are options:
 *
 * - `imageInput`: the model reads images natively via input_image items,
 *   referencing local media-store URLs (ai/services/media-store.js) or inline
 *   base64 data URLs when the media store is not configured
 * - `strictInput`: conform input items for servers with strict chat-template
 *   schemas (one leading system message, no mid-conversation system messages,
 *   assistant history as plain strings) - see conformInputItems()
 * - `adoptSingleServedModel`: when the model is unset and the server lists
 *   exactly one model, adopt it (vLLM serves one model per instance)
 */

import { OpenAI } from "openai";
import {
	defaultToolOutputChars,
	getCodeSandboxConfig,
	getEmbeddingBackendConfig,
} from "../config/providers.js";
import {
	getMediaStoreConfig,
	isMediaStoreConfigured,
	replaceUnavailableMediaImages,
} from "../services/media-store.js";

/**
 * Conform input items to what a strict chat template accepts. Three documented
 * incompatibilities with the item shapes the app (and Ollama) uses, all
 * observed on vLLM with the stock Qwen template:
 *
 * 1. Exactly ONE system message is allowed, and it must be message #1
 *    ("400 System message must be at the beginning"). The app legitimately
 *    builds several leading system items (base prompt, attachment guidance,
 *    first-turn user context): they are merged into one system message.
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
export function conformInputItems(input) {
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
 * Read the served context length from a /v1/models entry. vLLM reports
 * `max_model_len`; other servers use `context_length` or `context_window`
 * (or nothing at all, in which case the configured value stands).
 *
 * @param {Object} served - Model entry from /v1/models
 * @returns {{value: number, field: string}|null}
 */
function readServedContextLength(served) {
	for (const field of ["max_model_len", "context_length", "context_window"]) {
		const value = Number(served?.[field]);
		if (Number.isFinite(value) && value > 0) return { value, field };
	}
	return null;
}

/**
 * Probe the embedding endpoint configured for the knowledge base with one tiny
 * request. Gateways front embedding models of mixed reliability, so this is a
 * warning-level check: a failure never blocks startup, and search_knowledge_base
 * already degrades to an error result at query time.
 *
 * @param {{baseUrl: string, apiKey: string, model: string}} backend
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
async function probeEmbeddings(backend) {
	try {
		const response = await fetch(`${backend.baseUrl}/embeddings`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${backend.apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ model: backend.model, input: ["health check"] }),
			signal: AbortSignal.timeout(10000),
		});
		if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };
		const body = await response.json();
		if (!Array.isArray(body?.data?.[0]?.embedding)) {
			return { ok: false, error: "no embedding vector in the response" };
		}
		return { ok: true };
	} catch (e) {
		return { ok: false, error: e?.message || String(e) };
	}
}

/**
 * Create an OpenAI-compatible provider descriptor.
 *
 * @param {Object} options
 * @param {string} options.name - Provider name reported to the app ("openai-compatible", "vllm")
 * @param {string} options.label - Human label for log/health messages ("AI backend", "vLLM")
 * @param {string} options.baseUrl - Base URL ending in /v1
 * @param {string} options.apiKey - Bearer token (dummy value if the server ignores it)
 * @param {string} options.model - Model name; "" to adopt the single served model (see adoptSingleServedModel)
 * @param {number} options.contextWindow - Configured/default context window in tokens
 * @param {boolean} options.contextLengthExplicit - Whether the context window was set explicitly
 *   (an explicit value is kept when smaller than the server's, capped when larger)
 * @param {number} options.maxOutputTokens - Output token cap per turn
 * @param {number} options.maxToolOutputChars - Inline cap for a single tool result
 * @param {boolean} options.maxToolOutputCharsExplicit - Whether that cap was set explicitly
 *   (otherwise it is re-derived when the context window is reconciled with the server)
 * @param {number} options.requestTimeoutMs - Per-request timeout for the SDK client
 * @param {boolean} [options.imageInput=false] - Model reads images natively (input_image items)
 * @param {boolean} [options.strictInput=false] - Apply conformInputItems() to every request
 * @param {boolean} [options.adoptSingleServedModel=false] - Adopt the only served model when unset
 * @param {{model: string, contextLength: string}} options.envNames - Variable names quoted in messages
 * @returns {import("./index.js").AiProvider}
 */
export function createOpenAiCompatibleProvider(options) {
	const {
		name,
		label,
		baseUrl,
		apiKey,
		model,
		contextWindow,
		contextLengthExplicit,
		maxOutputTokens,
		maxToolOutputChars,
		maxToolOutputCharsExplicit,
		requestTimeoutMs,
		imageInput = false,
		strictInput = false,
		adoptSingleServedModel = false,
		envNames,
	} = options;

	const client = new OpenAI({
		baseURL: baseUrl,
		apiKey,
		timeout: requestTimeoutMs,
	});

	const provider = {
		name,
		isLocal: true,
		// May be "" until the health check adopts the single served model
		model,
		endpoint: baseUrl,
		client,
		contextWindow,
		maxOutputTokens,
		maxToolOutputChars,
		capabilities: {
			serverSideState: false,
			hostedFileSearch: false,
			codeInterpreter: false,
			localCodeInterpreter: getCodeSandboxConfig().enabled,
			hostedWebSearch: false,
			providerFileUploads: false,
			imageDescriptions: false,
			imageInput,
			toolNamespaces: false,
		},
		buildRequest({ input, tools, tool_choice }) {
			// An expired media file would fail the whole request (vLLM answers
			// 422), so swap dead image references for a text marker first
			let requestInput = imageInput ? replaceUnavailableMediaImages(input) : input;
			if (strictInput) requestInput = conformInputItems(requestInput);

			const request = {
				// provider.model, not options.model: the health check may have
				// adopted the served model when the configured one was unset
				model: provider.model,
				input: requestInput,
				max_output_tokens: maxOutputTokens,
				stream: true,
			};

			// tool_choice "none" (used to force a text-only continuation turn) is
			// emulated by omitting the tools array: it saves the tool-schema tokens
			// and behaves identically on every backend.
			if (tool_choice !== "none" && Array.isArray(tools) && tools.length > 0) {
				request.tools = tools;
			}

			return request;
		},
		async healthCheck() {
			try {
				const response = await fetch(`${baseUrl}/models`, {
					headers: { Authorization: `Bearer ${apiKey}` },
					signal: AbortSignal.timeout(10000),
				});

				const warnings = [];

				if (!response.ok) {
					// A gateway may not expose the model list. With an explicit model
					// that is a degraded check, not a failure; without one it is fatal.
					if (provider.model) {
						warnings.push(
							`${label} answered HTTP ${response.status} on ${baseUrl}/models: model "${provider.model}" and context length could not be verified.`
						);
						return {
							ok: true,
							detail: `model "${provider.model}" (unverified), context ${provider.contextWindow} (configured)`,
							warning: warnings.join(" "),
						};
					}
					return {
						ok: false,
						error: `${label} responded with HTTP ${response.status} on ${baseUrl}/models; set ${envNames.model} explicitly.`,
					};
				}

				const body = await response.json();
				const models = Array.isArray(body?.data) ? body.data : [];
				const modelIds = models.map((m) => m?.id).filter(Boolean);

				let served = models.find((m) => m?.id === provider.model);
				if (!provider.model) {
					if (!adoptSingleServedModel || models.length !== 1) {
						return {
							ok: false,
							error: `${envNames.model} is not set and ${baseUrl} serves ${models.length} models (${modelIds.join(", ") || "none"}); set ${envNames.model} explicitly.`,
						};
					}
					served = models[0];
					provider.model = served.id;
				} else if (!served) {
					return {
						ok: false,
						error: `Model "${provider.model}" not found on ${baseUrl}. Available: ${modelIds.join(", ") || "(none)"}.`,
					};
				}

				// Reconcile the context window with the server's reported value.
				// Detected server truth beats the default; an explicit env value
				// beats detection only when it is SMALLER (a tighter budget is
				// safe) — a larger value would let oversized prompts through.
				const detected = readServedContextLength(served);
				let contextDetail = `context ${provider.contextWindow} (configured; server value not reported)`;

				if (!detected && !contextLengthExplicit) {
					// Gateways rarely report the window: an unconfigured default is a
					// guess, and a wrong guess either wastes the model's context or
					// gets requests rejected once the conversation grows
					contextDetail = `context ${provider.contextWindow} (DEFAULT; server value not reported)`;
					warnings.push(
						`The server does not report the model's context length and ${envNames.contextLength} is not set: using the default ${provider.contextWindow}. Set ${envNames.contextLength} to the model's real context window.`
					);
				}

				if (detected) {
					if (!contextLengthExplicit) {
						provider.contextWindow = detected.value;
						contextDetail = `context ${detected.value} (detected from /v1/models ${detected.field})`;
					} else if (provider.contextWindow > detected.value) {
						warnings.push(
							`Configured ${envNames.contextLength} (${provider.contextWindow}) exceeds the server's ${detected.field} (${detected.value}); using ${detected.value} to avoid rejected requests.`
						);
						provider.contextWindow = detected.value;
						contextDetail = `context ${detected.value} (server-limited)`;
					} else {
						contextDetail = `context ${provider.contextWindow} (configured; server allows ${detected.value})`;
					}

					// The default inline tool-output cap is derived from the context
					// window; keep it consistent when the window was reconciled
					if (!maxToolOutputCharsExplicit) {
						provider.maxToolOutputChars = defaultToolOutputChars(
							provider.contextWindow,
							maxOutputTokens
						);
					}
				}

				// Native vision works either way; without the media store the
				// resent history carries full base64 images, which gets heavy
				let mediaDetail = "";
				if (imageInput) {
					if (isMediaStoreConfigured()) {
						mediaDetail = `, media store at ${getMediaStoreConfig().baseUrl}`;
					} else {
						mediaDetail = ", media store NOT configured (images sent inline as base64)";
						warnings.push(
							"M8B_MEDIA_BASE_URL is not set: image attachments are embedded as base64 in every resent request. Configure the media store for production use."
						);
					}
				}

				// Knowledge base embeddings: warn (never fail) when the endpoint misbehaves
				let embeddingDetail = "";
				const embeddingBackend = getEmbeddingBackendConfig(name);
				if (embeddingBackend) {
					const probe = await probeEmbeddings(embeddingBackend);
					if (probe.ok) {
						embeddingDetail = `, embeddings "${embeddingBackend.model}" ok`;
					} else {
						embeddingDetail = `, embeddings "${embeddingBackend.model}" FAILING`;
						warnings.push(
							`Embedding model "${embeddingBackend.model}" at ${embeddingBackend.baseUrl} failed a test request (${probe.error}); knowledge base searches will report the knowledge base as unavailable until it recovers.`
						);
					}
				}

				return {
					ok: true,
					detail: `model "${provider.model}" available, ${contextDetail}${mediaDetail}${embeddingDetail}`,
					warning: warnings.join(" ") || undefined,
				};
			} catch (e) {
				return {
					ok: false,
					error: `${label} unreachable at ${baseUrl}: ${e?.message || e}`,
				};
			}
		},
	};

	return provider;
}
