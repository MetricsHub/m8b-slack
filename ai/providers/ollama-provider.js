/**
 * Ollama provider - local models through Ollama's OpenAI-compatible /v1/responses API.
 *
 * Ollama's Responses compatibility is stateless: there is no previous_response_id
 * or conversation support. Conversation history is therefore maintained
 * application-side (see ai/services/conversation-store.js) and resent in `input`.
 *
 * Supported request fields per the Ollama documentation:
 * model, input, instructions, tools, stream, temperature, top_p, max_output_tokens.
 * OpenAI-only fields (reasoning, text, safety_identifier, previous_response_id,
 * hosted tool types) must NOT be sent.
 */

import { OpenAI } from "openai";
import {
	defaultToolOutputChars,
	getCodeSandboxConfig,
	getOllamaConfig,
} from "../config/providers.js";

function isContextLengthExplicit() {
	return Boolean(process.env.OLLAMA_CONTEXT_LENGTH || process.env.OLLAMA_CONTEXT_WINDOW);
}

function matchesModel(name, model) {
	if (!name) return false;
	return name === model || name === `${model}:latest` || name.replace(/:latest$/, "") === model;
}

/**
 * Ask Ollama to load the model into memory (native API: a generate request
 * without a prompt loads the model and returns immediately). This pre-warms
 * the model so the first user doesn't pay the cold start, and guarantees
 * /api/ps can report the effective context length right after.
 *
 * @param {{baseUrl: string, apiKey: string, model: string}} config
 * @returns {Promise<boolean>} true when the model is loaded
 */
async function loadModel(config) {
	const nativeBase = config.baseUrl.replace(/\/v1\/?$/, "");
	try {
		const response = await fetch(`${nativeBase}/api/generate`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${config.apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ model: config.model }),
			// Cold-loading a large model from disk can take a while
			signal: AbortSignal.timeout(180000),
		});
		return response.ok;
	} catch {
		return false;
	}
}

/**
 * Best-effort detection of the context length the Ollama server actually
 * allocates for the model, via the native API (through the same proxy):
 * - /api/ps reports the effective context of currently LOADED models
 *   (ground truth, but only available while the model is in memory);
 * - /api/show reports a Modelfile-pinned num_ctx, when one exists.
 * Returns null when neither source knows.
 *
 * @param {{baseUrl: string, apiKey: string, model: string}} config
 * @returns {Promise<{value: number, source: string}|null>}
 */
async function detectServerContextLength(config) {
	const nativeBase = config.baseUrl.replace(/\/v1\/?$/, "");
	const headers = {
		Authorization: `Bearer ${config.apiKey}`,
		"Content-Type": "application/json",
	};

	// 1. Effective context of the loaded model (exact)
	try {
		const response = await fetch(`${nativeBase}/api/ps`, {
			headers,
			signal: AbortSignal.timeout(10000),
		});
		if (response.ok) {
			const body = await response.json();
			const loaded = (Array.isArray(body?.models) ? body.models : []).find(
				(m) => matchesModel(m?.name, config.model) || matchesModel(m?.model, config.model)
			);
			const contextLength = Number(loaded?.context_length);
			if (Number.isFinite(contextLength) && contextLength > 0) {
				return { value: contextLength, source: "loaded model (/api/ps)" };
			}
		}
	} catch {
		/* native API unavailable: fall through */
	}

	// 2. Modelfile-pinned num_ctx (exact when present; absent = server default applies)
	try {
		const response = await fetch(`${nativeBase}/api/show`, {
			method: "POST",
			headers,
			body: JSON.stringify({ model: config.model }),
			signal: AbortSignal.timeout(10000),
		});
		if (response.ok) {
			const body = await response.json();
			const match = String(body?.parameters || "").match(/num_ctx\s+(\d+)/);
			if (match) {
				return { value: Number(match[1]), source: "Modelfile num_ctx (/api/show)" };
			}
		}
	} catch {
		/* native API unavailable */
	}

	return null;
}

/**
 * Create the Ollama provider descriptor.
 *
 * @returns {import("./index.js").AiProvider}
 */
export function createOllamaProvider() {
	const config = getOllamaConfig();

	const client = new OpenAI({
		baseURL: config.baseUrl,
		apiKey: config.apiKey,
		timeout: config.requestTimeoutMs,
	});

	const provider = {
		name: "ollama",
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
			imageDescriptions: Boolean(config.visionModel),
			toolNamespaces: false,
		},
		buildRequest({ input, tools, tool_choice }) {
			const request = {
				model: config.model,
				input,
				max_output_tokens: config.maxOutputTokens,
				stream: true,
			};

			// tool_choice is not a documented Ollama field; "none" (used to force a
			// text-only continuation turn) is emulated by omitting the tools array.
			if (tool_choice !== "none" && Array.isArray(tools) && tools.length > 0) {
				request.tools = tools;
			}

			return request;
		},
		/**
		 * Describe an image attachment with the sidecar vision model, via
		 * /v1/chat/completions (Ollama's /v1/responses does not accept images).
		 * The vision model typically enforces a small context window (8k for
		 * qwen3-vl:8b-instruct-8k): the prompt stays short, the conversation
		 * context snippet is pre-trimmed by the caller, and the output is capped.
		 *
		 * @param {Object} params
		 * @param {Buffer} params.buffer - Raw image bytes
		 * @param {string} params.mimetype - Image MIME type (image/png, image/jpeg, ...)
		 * @param {string} params.fileName - Original filename (for logging only)
		 * @param {string} [params.contextText] - Short conversation context snippet
		 * @returns {Promise<string>} Description text (throws on failure/empty)
		 */
		async describeImage({ buffer, mimetype, fileName, contextText }) {
			if (!config.visionModel) {
				throw new Error("No vision model configured (OLLAMA_VISION_MODEL)");
			}

			const instructions =
				"You are the eyes of an IT support assistant that cannot see images. " +
				"Describe the attached screenshot factually and completely: transcribe all visible text " +
				"verbatim (error messages, dialog titles, hostnames, paths, commands, metric names and " +
				"values, timestamps), and describe charts or graphs (what is plotted, axes, trends, " +
				"anomalies). Do not guess at causes, do not invent text you cannot read, and do not " +
				"address the user. Output only the description.";

			const userText = contextText
				? `Conversation context (orientation only — describe the image, do not answer the user):\n${contextText}`
				: "Describe the attached image.";

			const response = await client.chat.completions.create({
				model: config.visionModel,
				max_tokens: config.visionMaxOutputTokens,
				temperature: 0.1,
				messages: [
					{ role: "system", content: instructions },
					{
						role: "user",
						content: [
							{ type: "text", text: userText },
							{
								type: "image_url",
								image_url: { url: `data:${mimetype};base64,${buffer.toString("base64")}` },
							},
						],
					},
				],
			});

			const description = response?.choices?.[0]?.message?.content?.trim();
			if (!description) {
				throw new Error(`Vision model returned no description for "${fileName}"`);
			}
			return description;
		},
		async healthCheck() {
			try {
				const response = await fetch(`${config.baseUrl}/models`, {
					headers: { Authorization: `Bearer ${config.apiKey}` },
					signal: AbortSignal.timeout(10000),
				});

				if (!response.ok) {
					return { ok: false, error: `Ollama responded with HTTP ${response.status}` };
				}

				const body = await response.json();
				const models = Array.isArray(body?.data) ? body.data.map((m) => m?.id).filter(Boolean) : [];
				const found = models.some((id) => matchesModel(id, config.model));

				if (!found) {
					return {
						ok: false,
						error: `Model "${config.model}" not found on ${config.baseUrl}. Available: ${models.slice(0, 10).join(", ") || "(none)"}. Pull it with: ollama pull ${config.model}`,
					};
				}

				// Vision model is optional: a missing one degrades screenshot
				// handling to a text note, so warn instead of failing the check
				let visionWarning;
				let visionDetail = "";
				if (config.visionModel) {
					const visionFound = models.some((id) => matchesModel(id, config.visionModel));
					visionDetail = `, vision model "${config.visionModel}" ${visionFound ? "available" : "MISSING"}`;
					if (!visionFound) {
						visionWarning = `Vision model "${config.visionModel}" (OLLAMA_VISION_MODEL) not found on ${config.baseUrl}; image attachments will not be described. Pull it with: ollama pull ${config.visionModel}`;
					}
				}

				// Force-load the model: pre-warms it for the first user and lets
				// /api/ps report the effective context length reliably.
				const modelLoaded = await loadModel(config);

				// Reconcile the context window with what the server actually allocates.
				// Detected server truth beats the default; an explicit env value beats
				// detection only when it is SMALLER (a tighter budget is safe) — a
				// larger env value would cause silent server-side prompt truncation.
				let contextDetail = `context ${provider.contextWindow} (configured; server value not detected)`;
				let warning;
				const detected = await detectServerContextLength(config);

				if (detected) {
					if (!isContextLengthExplicit()) {
						provider.contextWindow = detected.value;
						contextDetail = `context ${detected.value} (detected from ${detected.source})`;
					} else if (provider.contextWindow > detected.value) {
						warning = `Configured OLLAMA_CONTEXT_LENGTH (${provider.contextWindow}) exceeds the server's effective context (${detected.value} from ${detected.source}); using ${detected.value} to avoid silent prompt truncation.`;
						provider.contextWindow = detected.value;
						contextDetail = `context ${detected.value} (server-limited)`;
					} else {
						contextDetail = `context ${provider.contextWindow} (configured; server allows ${detected.value})`;
					}

					// The default inline tool-output cap is derived from the context
					// window; keep it consistent when the window was reconciled
					if (!process.env.OLLAMA_MAX_TOOL_OUTPUT_CHARS) {
						provider.maxToolOutputChars = defaultToolOutputChars(
							provider.contextWindow,
							config.maxOutputTokens
						);
					}
				}

				return {
					ok: true,
					detail: `model "${config.model}" ${modelLoaded ? "loaded" : "available (warm-up failed)"}, ${contextDetail}${visionDetail}`,
					warning: [warning, visionWarning].filter(Boolean).join(" ") || undefined,
				};
			} catch (e) {
				return {
					ok: false,
					error: `Ollama unreachable at ${config.baseUrl}: ${e?.message || e}`,
				};
			}
		},
	};

	return provider;
}
