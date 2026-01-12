/**
 * OpenAI streaming handler for processing response events.
 */

import path from "node:path";
import { MODEL_CONFIG } from "../config/system-prompt.js";
import { openai } from "./openai.js";

/**
 * List assistant-created files in an OpenAI code_interpreter container.
 * Only returns files with source="assistant" (files the LLM wrote, not user uploads).
 * @param {string} containerId - The container ID
 * @param {number} minCreatedAt - Only return files created after this Unix timestamp
 * @param {Object} logger - Logger instance
 * @returns {Promise<Array>} Array of file objects with file_id and filename
 */
async function listContainerFiles(containerId, minCreatedAt, logger) {
	try {
		logger?.info?.("[CODE_INTERPRETER] Fetching container files list", {
			containerId,
			minCreatedAt,
		});

		const response = await fetch(`https://api.openai.com/v1/containers/${containerId}/files`, {
			headers: {
				Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
				"OpenAI-Beta": "responses=v1",
			},
		});

		if (!response.ok) {
			const errorText = await response.text();
			logger?.error?.("[CODE_INTERPRETER] Container files list failed", {
				status: response.status,
				errorText,
			});
			return [];
		}

		const data = await response.json();
		const files = data?.data || [];

		// Only keep files created by the assistant (not user uploads) AND created after minCreatedAt
		const assistantFiles = files
			.filter((f) => {
				if (f.source !== "assistant") return false;
				// Filter by creation time to only get files from THIS turn
				if (minCreatedAt && f.created_at && f.created_at < minCreatedAt) {
					logger?.info?.("[CODE_INTERPRETER] Skipping old file", {
						filename: f.filename || path.basename(f.path || ""),
						created_at: f.created_at,
						minCreatedAt,
					});
					return false;
				}
				return true;
			})
			.map((f) => {
				// Extract filename from path (API returns 'path', not 'sandbox_path')
				const filepath = f.path || f.sandbox_path || "";
				const filename = f.filename || f.name || path.basename(filepath);
				return {
					file_id: f.id,
					filename,
					path: filepath,
					created_at: f.created_at,
				};
			});

		logger?.info?.("[CODE_INTERPRETER] Container files found", {
			totalFiles: files.length,
			assistantFiles: assistantFiles.length,
			files: assistantFiles.map((f) => ({ filename: f.filename, path: f.path })),
		});

		return assistantFiles;
	} catch (e) {
		logger?.error?.("[CODE_INTERPRETER] Failed to list container files", {
			containerId,
			error: String(e),
		});
		return [];
	}
}

/**
 * Status display helpers for reasoning output.
 */
const STATUS_CONFIG = {
	maxLength: 50,
	maxItems: 5,
	cooldownMs: 800,
};

/**
 * Safety limits for runaway generation detection
 */
const SAFETY_LIMITS = {
	maxOutputChars: 50000, // Hard stop if output exceeds this
	repetitionWindowSize: 200, // Check last N chars for repetition
	repetitionThreshold: 0.85, // If >85% of chars are identical, stop
};

function sanitizeForStatus(text) {
	return text
		.replace(/[*_`~]/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

function chunkText(text, maxLen = STATUS_CONFIG.maxLength) {
	const clean = sanitizeForStatus(text);
	const chunks = [];
	let i = 0;

	while (i < clean.length) {
		let end = Math.min(i + maxLen, clean.length);
		if (end < clean.length) {
			const space = clean.lastIndexOf(" ", end);
			if (space > i + 10) end = space;
		}
		chunks.push(clean.slice(i, end));
		i = end + 1;
	}

	return chunks;
}

/**
 * Detect repetitive output that indicates runaway generation.
 * Returns true if the text appears to be stuck in a loop.
 */
function detectRepetition(text, windowSize = SAFETY_LIMITS.repetitionWindowSize) {
	if (text.length < windowSize) return false;

	const window = text.slice(-windowSize);
	const chars = {};

	for (const char of window) {
		chars[char] = (chars[char] || 0) + 1;
	}

	// Find most common character
	const maxCount = Math.max(...Object.values(chars));
	const repetitionRatio = maxCount / windowSize;

	return repetitionRatio > SAFETY_LIMITS.repetitionThreshold;
}

/**
 * Stream one turn of OpenAI response.
 *
 * @param {Object} params - Stream parameters
 * @param {Array} params.input - Input items for the model
 * @param {Array} params.tools - Available tools
 * @param {string} params.tool_choice - Tool choice setting
 * @param {string} params.previous_response_id - Previous response ID for continuity
 * @param {Object} callbacks - Callback functions
 * @param {Function} callbacks.setStatus - Status update callback
 * @param {Function} callbacks.onTextChunk - Text chunk callback
 * @param {Function} callbacks.onStreamStart - Called when streaming starts
 * @param {Object} callbacks.logger - Logger instance
 * @returns {Promise<Object>} Stream result
 */
export async function streamOnce({ input, tools, tool_choice, previous_response_id }, callbacks) {
	const { setStatus, onTextChunk, onStreamStart, logger } = callbacks;

	let newResponseId = null;
	const functionCalls = [];
	const outputFiles = []; // Track files generated by code_interpreter
	let fullResponseText = "";
	let startedWriting = false;
	let incompleteReason = null;
	let sawCompleted = false;
	let lastContainerId = null; // Track container ID for end-of-stream file query
	const streamStartTime = Math.floor(Date.now() / 1000); // Unix timestamp for filtering old files

	// Event counters for diagnostics
	const evtCounters = {
		reasoning_summary_delta: 0,
		reasoning_delta: 0,
		output_text_delta: 0,
		output_item_added_function_call: 0,
		output_item_done_function_call: 0,
		function_call_args_delta: 0,
		output_item_added_file: 0,
		output_item_added_image: 0,
		response_error: 0,
		response_completed: 0,
		other: 0,
	};

	const otherEventTypes = Object.create(null);
	const debugMeta = {
		used_previous_response_id: previous_response_id || null,
		used_tool_choice: tool_choice || "auto",
	};

	// Events we handle or expect but don't need to count as "unknown"
	const expectedOtherEvents = new Set([
		"response.created",
		"response.in_progress",
		"response.function_call_arguments.done",
		"response.reasoning_summary_part.added",
		"response.reasoning_summary_text.done",
		"response.reasoning_summary_part.done",
		"response.content_part.added",
		"response.content_part.done",
		"response.output_text.done",
	]);

	// Reasoning buffer for status updates
	let reasoningBuf = "";
	let lastStatusAt = 0;
	let lastSentJson = "";

	async function flushStatus() {
		const now = Date.now();
		if (now - lastStatusAt < STATUS_CONFIG.cooldownMs) return;
		lastStatusAt = now;

		if (!reasoningBuf.trim()) return;

		const chunks = chunkText(reasoningBuf);
		const tail = chunks.slice(-STATUS_CONFIG.maxItems);
		const payload = JSON.stringify(tail);

		if (payload === lastSentJson) return;
		lastSentJson = payload;

		await setStatus({ status: "working...", loading_messages: tail });
	}

	// Create the stream
	const stream = await openai.responses.create({
		model: MODEL_CONFIG.model,
		reasoning: MODEL_CONFIG.reasoning,
		previous_response_id,
		max_output_tokens: MODEL_CONFIG.maxOutputTokens,
		tool_choice: tool_choice ?? "auto",
		parallel_tool_calls: true,
		tools,
		text: MODEL_CONFIG.text,
		input,
		stream: true,
	});

	let streamController = null;

	try {
		for await (const evt of stream) {
			// Track response ID
			if (!newResponseId && evt?.response?.id) {
				newResponseId = evt.response.id;
			}

			// Process reasoning events (before text output starts)
			if (!startedWriting && evt.type === "response.reasoning_summary_text.delta" && evt.delta) {
				evtCounters.reasoning_summary_delta++;
				const wasEmpty = reasoningBuf.length === 0;
				reasoningBuf += evt.delta;
				if (wasEmpty) {
					logger?.info?.("[REASONING] LLM started reasoning (summary mode)");
				}
				await flushStatus();
			}

			if (!startedWriting && evt.type === "response.reasoning_text.delta" && evt.delta) {
				evtCounters.reasoning_delta++;
				const wasEmpty = reasoningBuf.length === 0;
				reasoningBuf += evt.delta;
				if (wasEmpty) {
					logger?.info?.("[REASONING] LLM started reasoning (detailed mode)");
				}
				await flushStatus();
			}

			// Function call lifecycle
			if (evt.type === "response.output_item.added") {
				const item = evt.item;
				if (item?.type === "function_call") {
					evtCounters.output_item_added_function_call++;
					functionCalls[evt.output_index] = { ...item, arguments: item.arguments || "" };
					logger?.info?.("[ACTION] LLM initiated function call", {
						name: item.name,
						call_id: item.call_id,
					});
				} else if (item?.type === "output_file") {
					evtCounters.output_item_added_file++;
					// Capture file info - will be populated fully in output_item.done
					outputFiles[evt.output_index] = { type: "file", ...item };
				} else if (item?.type === "output_image") {
					evtCounters.output_item_added_image++;
					// Capture image info - will be populated fully in output_item.done
					outputFiles[evt.output_index] = { type: "image", ...item };
				} else {
					evtCounters.other++;
				}
			}

			if (evt.type === "response.function_call_arguments.delta") {
				evtCounters.function_call_args_delta++;
				const idx = evt.output_index;
				if (functionCalls[idx]) {
					functionCalls[idx].arguments += evt.delta || "";
				}
			}

			if (evt.type === "response.output_item.done") {
				if (evt.item?.type === "function_call") {
					evtCounters.output_item_done_function_call++;
					const idx = evt.output_index;
					const prior = functionCalls[idx] || { arguments: "" };
					functionCalls[idx] = { ...evt.item, arguments: prior.arguments };
					logger?.info?.("[ACTION] Function call completed", {
						name: evt.item.name,
						call_id: evt.item.call_id,
						argumentsLength: prior.arguments.length,
					});
				} else if (evt.item?.type === "message") {
					// Extract container_file_citation annotations from message content
					for (const contentItem of evt.item.content || []) {
						if (contentItem?.type === "output_text" && contentItem.annotations) {
							for (const annotation of contentItem.annotations) {
								if (annotation.type === "container_file_citation" && annotation.file_id) {
									outputFiles.push({
										type: "file",
										file_id: annotation.file_id,
										filename: annotation.filename,
										container_id: annotation.container_id,
									});
									logger?.info?.("[CODE_INTERPRETER] File from container_file_citation", {
										file_id: annotation.file_id,
										filename: annotation.filename,
										container_id: annotation.container_id,
									});
								}
							}
						}
					}
				} else if (evt.item?.type === "code_interpreter_call") {
					// Track container ID for querying files at the end
					const code = evt.item?.code_interpreter?.input || evt.item?.input || evt.item?.code || "";
					const containerId = evt.item?.container_id;
					const results = evt.item?.results || [];

					logger?.info?.("[CODE_INTERPRETER] LLM executed Python code", {
						codeLength: code.length,
						codePreview: code.slice(0, 200) + (code.length > 200 ? "..." : ""),
						containerId,
					});

					// Track container ID - we'll query for files once at the END of streaming
					if (containerId) {
						lastContainerId = containerId;
					}

					// Process files from results if explicitly returned
					for (const result of results) {
						if (result?.type === "files") {
							for (const file of result.files || []) {
								if (file?.file_id) {
									outputFiles.push({
										type: "file",
										file_id: file.file_id,
										filename: file.filename || file.name,
										mime_type: file.mime_type,
										container_id: containerId,
									});
									logger?.info?.("[CODE_INTERPRETER] Generated file from results", {
										file_id: file.file_id,
										filename: file.filename || file.name,
									});
								}
							}
						}
					}
				} else if (evt.item?.type === "output_file" || evt.item?.type === "output_image") {
					// Update with final file info
					const idx = evt.output_index;
					if (outputFiles[idx]) {
						outputFiles[idx] = {
							...outputFiles[idx],
							...evt.item,
							file_id: evt.item.file_id || evt.item.id,
						};
					} else {
						outputFiles.push({
							type: evt.item?.type === "output_image" ? "image" : "file",
							...evt.item,
							file_id: evt.item.file_id || evt.item.id,
						});
					}
					logger?.info?.("Output file/image done", { item: evt.item });
				} else {
					evtCounters.other++;
				}
			}

			// Output text streaming
			if (evt.type === "response.output_text.delta" && evt.delta) {
				evtCounters.output_text_delta++;

				if (!startedWriting) {
					startedWriting = true;
					// Log reasoning summary before starting text output
					if (reasoningBuf.length > 0) {
						// Show more of the reasoning (up to 1500 chars) for better debugging
						const reasoningPreview =
							reasoningBuf.length > 1500
								? `${reasoningBuf.slice(0, 1500)}... [${reasoningBuf.length - 1500} more chars]`
								: reasoningBuf;
						logger?.info?.(
							`[REASONING] LLM reasoning complete (${reasoningBuf.length} chars):\n${reasoningPreview}`
						);
					}

					logger?.info?.("[OUTPUT] LLM started writing response");
					try {
						await setStatus({ status: "writing..." });
					} catch {}

					if (onStreamStart) {
						streamController = await onStreamStart(newResponseId);
					}
				}

				fullResponseText += evt.delta;

				// Safety check: detect runaway generation
				if (fullResponseText.length > SAFETY_LIMITS.maxOutputChars) {
					logger?.error?.("Output exceeded safety limit - terminating stream", {
						length: fullResponseText.length,
						limit: SAFETY_LIMITS.maxOutputChars,
					});
					incompleteReason = "output_too_long";
					break;
				}

				// Safety check: detect repetitive output (infinite loop)
				if (detectRepetition(fullResponseText)) {
					logger?.error?.("Detected repetitive output pattern - terminating stream", {
						length: fullResponseText.length,
						lastChars: fullResponseText.slice(-200),
					});
					incompleteReason = "repetitive_output";
					break;
				}

				// Clean undesirable tokens
				const cleaned = evt.delta.replace(/\ue200filecite:[^\s]+/g, "").replace(/【】/g, "");
				if (cleaned.length && onTextChunk) {
					await onTextChunk(cleaned, streamController);
				}
				continue;
			}

			// Handle annotation.added events - annotations are streamed as separate events
			if (evt.type === "response.output_text.annotation.added") {
				const annotation = evt.annotation;
				if (annotation?.type === "file_path" && annotation.file_path?.file_id) {
					const fileId = annotation.file_path.file_id;
					const text = annotation.text || "";
					// Extract filename from sandbox path
					const filenameMatch = text.match(/sandbox:\/mnt\/data\/([^)\s]+)/);
					const filename = filenameMatch?.[1] || "generated_file";

					outputFiles.push({
						type: "file",
						file_id: fileId,
						filename: filename,
						annotation_text: text,
					});

					logger?.info?.("[CODE_INTERPRETER] File annotation from stream", {
						file_id: fileId,
						filename: filename,
						annotation_text: text,
					});
				}
				continue;
			}

			// Terminal/diagnostic events
			if (evt.type === "response.completed") {
				evtCounters.response_completed++;
				sawCompleted = true;
			} else if (evt.type === "response.error") {
				evtCounters.response_error++;
				logger?.info?.("OpenAI stream error event", { error: evt.error || null });
			} else if (evt.type === "response.incomplete") {
				incompleteReason = evt.reason || evt?.response?.status_reason || "unknown";
				otherEventTypes["response.incomplete"] = (otherEventTypes["response.incomplete"] || 0) + 1;
			} else {
				// Count event types we don't explicitly handle
				const knownTypes = [
					"response.reasoning_summary_text.delta",
					"response.reasoning_text.delta",
					"response.output_item.added",
					"response.function_call_arguments.delta",
					"response.output_item.done",
					"response.output_text.delta",
					"response.output_text.annotation.added",
					"response.completed",
					"response.error",
					"response.incomplete",
				];

				if (!knownTypes.includes(evt.type)) {
					evtCounters.other++;
					// Only track truly unexpected events, not expected lifecycle events
					if (evt?.type && !expectedOtherEvents.has(evt.type)) {
						otherEventTypes[evt.type] = (otherEventTypes[evt.type] || 0) + 1;
					}
				}
			}
		}
	} finally {
		// Stop streamer if active
		if (streamController && typeof streamController.stop === "function") {
			try {
				await streamController.stop();
			} catch (e) {
				logger?.info?.("Failed to stop streamer", { e: String(e) });
			}
		}
	}

	// Query container for files ONCE at the end of streaming
	// This ensures we get all files created during the entire code_interpreter session
	if (lastContainerId && outputFiles.length === 0) {
		logger?.info?.("[CODE_INTERPRETER] Querying container for files at end of stream", {
			containerId: lastContainerId,
			streamStartTime,
		});
		try {
			// Pass streamStartTime to only get files created during THIS turn
			const containerFiles = await listContainerFiles(lastContainerId, streamStartTime, logger);
			for (const file of containerFiles) {
				outputFiles.push({
					type: "file",
					file_id: file.file_id,
					filename: file.filename,
					container_id: lastContainerId,
				});
				logger?.info?.("[CODE_INTERPRETER] Found file in container", {
					file_id: file.file_id,
					filename: file.filename,
				});
			}
		} catch (e) {
			logger?.warn?.("[CODE_INTERPRETER] Failed to list container files at end", {
				containerId: lastContainerId,
				error: String(e),
			});
		}
	}

	// Build diagnostics summary (only include if there are unexpected events)
	const otherTypesSummary = Object.entries(otherEventTypes)
		.sort((a, b) => b[1] - a[1])
		.slice(0, 10)
		.map(([type, count]) => ({ type, count }));

	const hadText = evtCounters.output_text_delta > 0;
	const validFunctionCalls = functionCalls.filter(Boolean);
	const validFiles = outputFiles.filter((f) => f?.file_id);

	// Summary log for key actions
	logger?.info?.("[STREAM_COMPLETE] Turn finished", {
		responseId: newResponseId,
		hadReasoning: reasoningBuf.length > 0,
		reasoningLength: reasoningBuf.length,
		hadTextOutput: hadText,
		textLength: fullResponseText.length,
		functionCalls: validFunctionCalls.map((fc) => ({
			name: fc.name,
			call_id: fc.call_id,
		})),
		outputFiles: validFiles.map((f) => ({
			type: f.type,
			filename: f.filename,
			file_id: f.file_id?.slice(0, 20),
		})),
		status: sawCompleted
			? "completed"
			: incompleteReason
				? `incomplete: ${incompleteReason}`
				: "unknown",
	});

	// Only log detailed summary if there's something notable
	const summaryDetails = {
		responseId: newResponseId?.slice(-12), // Just the last 12 chars for readability
		functions: validFunctionCalls.length || undefined,
		files: validFiles.length || undefined,
		textChars: fullResponseText.length || undefined,
		reasoningChars: reasoningBuf.length || undefined,
		incomplete: incompleteReason || undefined,
	};
	// Add unexpected events only if present
	if (otherTypesSummary.length > 0) {
		summaryDetails.unexpectedEvents = otherTypesSummary;
	}
	logger?.info?.("[STREAM] Turn complete", summaryDetails);

	// Filter and deduplicate output files by file_id
	const validOutputFiles = outputFiles
		.filter((f) => f?.file_id)
		.reduce((acc, file) => {
			// Only add if we haven't seen this file_id yet
			if (!acc.some((f) => f.file_id === file.file_id)) {
				acc.push(file);
			}
			return acc;
		}, []);

	// Log if duplicates were removed
	const duplicateCount = outputFiles.filter((f) => f?.file_id).length - validOutputFiles.length;
	if (duplicateCount > 0) {
		logger?.info?.("[STREAM_COMPLETE] Removed duplicate files", {
			duplicateCount,
			uniqueFileCount: validOutputFiles.length,
		});
	}

	return {
		functionCalls: functionCalls.filter(Boolean),
		outputFiles: validOutputFiles,
		responseId: newResponseId,
		hadText,
		incompleteReason,
		sawCompleted,
		fullResponseText,
		streamController,
		debug: {
			startedWriting,
			fullResponseTextLen: fullResponseText.length,
			outputFileCount: validOutputFiles.length,
			evtCounters,
			otherEventTypes: otherTypesSummary,
			incompleteReason,
			sawCompleted,
			...debugMeta,
		},
	};
}
