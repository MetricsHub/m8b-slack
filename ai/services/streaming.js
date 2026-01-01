/**
 * OpenAI streaming handler for processing response events.
 */

import { MODEL_CONFIG } from "../config/system-prompt.js";
import { openai } from "./openai.js";

/**
 * Status display helpers for reasoning output.
 */
const STATUS_CONFIG = {
	maxLength: 50,
	maxItems: 5,
	cooldownMs: 800,
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
	let fullResponseText = "";
	let startedWriting = false;
	let incompleteReason = null;
	let sawCompleted = false;

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

	const unknownEventTypes = Object.create(null);
	const debugMeta = {
		used_previous_response_id: previous_response_id || null,
		used_tool_choice: tool_choice || "auto",
	};

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
				reasoningBuf += evt.delta;
				await flushStatus();
			}

			if (!startedWriting && evt.type === "response.reasoning_text.delta" && evt.delta) {
				evtCounters.reasoning_delta++;
				reasoningBuf += evt.delta;
				await flushStatus();
			}

			// Function call lifecycle
			if (evt.type === "response.output_item.added") {
				const item = evt.item;
				if (item?.type === "function_call") {
					evtCounters.output_item_added_function_call++;
					functionCalls[evt.output_index] = { ...item, arguments: item.arguments || "" };
				} else if (item?.type === "output_file") {
					evtCounters.output_item_added_file++;
				} else if (item?.type === "output_image") {
					evtCounters.output_item_added_image++;
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
				} else {
					evtCounters.other++;
				}
			}

			// Output text streaming
			if (evt.type === "response.output_text.delta" && evt.delta) {
				evtCounters.output_text_delta++;

				if (!startedWriting) {
					startedWriting = true;
					try {
						await setStatus({ status: "writing..." });
					} catch {}

					if (onStreamStart) {
						streamController = await onStreamStart();
					}
				}

				fullResponseText += evt.delta;

				// Clean undesirable tokens
				const cleaned = evt.delta.replace(/\ue200filecite:[^\s]+/g, "").replace(/【】/g, "");

				if (cleaned.length && onTextChunk) {
					await onTextChunk(cleaned, streamController);
				}

				continue;
			}

			// Terminal/diagnostic events
			if (evt.type === "response.completed") {
				evtCounters.response_completed++;
				sawCompleted = true;
			} else if (evt.type === "response.error") {
				evtCounters.response_error++;
				logger?.debug?.("OpenAI stream error event", { error: evt.error || null });
			} else if (evt.type === "response.incomplete") {
				incompleteReason = evt.reason || evt?.response?.status_reason || "unknown";
				unknownEventTypes["response.incomplete"] =
					(unknownEventTypes["response.incomplete"] || 0) + 1;
			} else {
				// Count unknown event types
				const knownTypes = [
					"response.reasoning_summary_text.delta",
					"response.reasoning_text.delta",
					"response.output_item.added",
					"response.function_call_arguments.delta",
					"response.output_item.done",
					"response.output_text.delta",
				];

				if (!knownTypes.includes(evt.type)) {
					evtCounters.other++;
					if (evt?.type) {
						unknownEventTypes[evt.type] = (unknownEventTypes[evt.type] || 0) + 1;
					} else {
						unknownEventTypes["<no-type>"] = (unknownEventTypes["<no-type>"] || 0) + 1;
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
				logger?.debug?.("Failed to stop streamer", { e: String(e) });
			}
		}
	}

	// Build diagnostics summary
	const unknownTypesSummary = Object.entries(unknownEventTypes)
		.sort((a, b) => b[1] - a[1])
		.slice(0, 25)
		.map(([type, count]) => ({ type, count }));

	const hadText = evtCounters.output_text_delta > 0;

	logger?.debug?.("streamOnce summary", {
		responseId: newResponseId,
		startedWriting,
		functionCallCount: functionCalls.filter(Boolean).length,
		fullResponseTextLen: fullResponseText.length,
		evtCounters,
		unknownEventTypes: unknownTypesSummary,
		incompleteReason,
		sawCompleted,
		...debugMeta,
	});

	return {
		functionCalls: functionCalls.filter(Boolean),
		responseId: newResponseId,
		hadText,
		incompleteReason,
		sawCompleted,
		fullResponseText,
		streamController,
		debug: {
			startedWriting,
			fullResponseTextLen: fullResponseText.length,
			evtCounters,
			unknownEventTypes: unknownTypesSummary,
			incompleteReason,
			sawCompleted,
			...debugMeta,
		},
	};
}
