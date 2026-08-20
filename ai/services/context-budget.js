/**
 * Deterministic context-budget management for providers with a hard context
 * window (Ollama/Qwen at 32K tokens).
 *
 * Strategy:
 * 1. Always retain leading system/developer items (system prompt, user context).
 * 2. Group the remaining items into coherent units so function_call items are
 *    never separated from their function_call_output.
 * 3. Protect the current turn: the group holding the most recent user message
 *    and everything after it is never dropped (a request without a user message
 *    is rejected by Ollama with "no user query found in messages").
 * 4. Truncate oversized tool outputs first, then drop the oldest unprotected
 *    groups, then — as a last resort — truncate remaining tool outputs harder.
 * 5. Insert a short system note when history was trimmed.
 *
 * No summarization request is made here: in Ollama mode nothing may be sent to
 * OpenAI, and a deterministic trim keeps behavior predictable.
 */

import { estimateTokenCount, PAYLOAD_CHARS_PER_TOKEN } from "../utils/tokens.js";

const TRIM_NOTICE = {
	role: "system",
	content: [
		{
			type: "input_text",
			text: "[Note: earlier parts of this conversation were removed to fit the model's context window.]",
		},
	],
};

/**
 * First-pass cap for a single tool output when over budget: a quarter of the
 * budget, in characters at the measured payload density, so it scales with
 * the context window.
 */
const OUTPUT_TRUNCATE_BUDGET_FRACTION = 0.25;
const OUTPUT_TRUNCATE_MIN_FLOOR_CHARS = 4000;

/** Last-resort cap when protected items alone exceed the budget (~500 tokens) */
const OUTPUT_TRUNCATE_MIN_CHARS = 2000;

const TRUNCATION_SUFFIX = "… [truncated to fit the context window]";

/**
 * Group conversational items so tool-call units stay intact:
 * a function_call and its following function_call_output(s) form one group.
 *
 * @param {Array} items - Conversational input items
 * @returns {Array<Array>} Groups of items
 */
function groupItems(items) {
	const groups = [];
	let pendingCallIds = new Set();

	for (const item of items) {
		if (item?.type === "function_call") {
			// Start (or extend) a tool-call group
			if (pendingCallIds.size > 0) {
				groups[groups.length - 1].push(item);
			} else {
				groups.push([item]);
			}
			pendingCallIds.add(item.call_id);
		} else if (item?.type === "function_call_output" && pendingCallIds.has(item.call_id)) {
			groups[groups.length - 1].push(item);
			pendingCallIds.delete(item.call_id);
		} else {
			pendingCallIds = new Set();
			groups.push([item]);
		}
	}

	return groups;
}

/**
 * Truncate function_call_output payloads above a character cap.
 * Items are copied, never mutated.
 *
 * @param {Array<Array>} groups - Item groups
 * @param {number} cap - Maximum output characters
 * @returns {Array<Array>} New groups with truncated outputs
 */
function truncateToolOutputs(groups, cap) {
	return groups.map((group) =>
		group.map((item) => {
			if (
				item?.type === "function_call_output" &&
				typeof item.output === "string" &&
				item.output.length > cap
			) {
				return { ...item, output: item.output.slice(0, cap) + TRUNCATION_SUFFIX };
			}
			return item;
		})
	);
}

/**
 * Trim input items to fit a token budget.
 *
 * @param {Array} items - Full input item list (system prompt first)
 * @param {Object} [options]
 * @param {number} [options.contextWindow] - Model context window in tokens (no-op when absent)
 * @param {number} [options.maxOutputTokens=0] - Reserved output tokens
 * @param {number} [options.reserveTokens=1500] - Extra reserve (tool schemas, chat template)
 * @param {Object} [options.logger] - Logger instance
 * @returns {Array} Items fitting the budget (same array when no trim was needed)
 */
export function trimToContextBudget(
	items,
	{ contextWindow, maxOutputTokens = 0, reserveTokens = 1500, logger } = {}
) {
	if (!Array.isArray(items) || items.length === 0 || !contextWindow) {
		return items;
	}

	const budget = contextWindow - maxOutputTokens - reserveTokens;
	if (budget <= 0) {
		logger?.warn?.("[Context] Context budget is non-positive; sending items unmodified");
		return items;
	}

	if (estimateTokenCount(items) <= budget) {
		return items;
	}

	// Leading system items (system prompt + per-turn context) are always retained
	let headEnd = 0;
	while (headEnd < items.length && items[headEnd]?.role === "system") {
		headEnd++;
	}
	const head = items.slice(0, headEnd);
	let groups = groupItems(items.slice(headEnd));

	// The group holding the most recent user message — and everything after it
	// (this turn's tool calls/results) — is protected from group-dropping
	let protectedStart = groups.length;
	for (let i = groups.length - 1; i >= 0; i--) {
		if (groups[i].some((item) => item?.role === "user")) {
			protectedStart = i;
			break;
		}
	}

	const assemble = () => [...head, TRIM_NOTICE, ...groups.flat()];

	// Step 1: cap oversized tool outputs everywhere (a single huge tool result
	// must never force the rest of the conversation out of the window)
	const firstPassCap = Math.max(
		OUTPUT_TRUNCATE_MIN_FLOOR_CHARS,
		Math.floor(budget * PAYLOAD_CHARS_PER_TOKEN * OUTPUT_TRUNCATE_BUDGET_FRACTION)
	);
	groups = truncateToolOutputs(groups, firstPassCap);

	// Step 2: drop the oldest unprotected groups
	let dropCount = 0;
	while (estimateTokenCount(assemble()) > budget && protectedStart > 0) {
		groups.shift();
		protectedStart--;
		dropCount++;
	}

	// Step 3: last resort — truncate remaining (protected) tool outputs harder
	if (estimateTokenCount(assemble()) > budget) {
		groups = truncateToolOutputs(groups, OUTPUT_TRUNCATE_MIN_CHARS);
	}

	const trimmed = assemble();
	const finalEstimate = estimateTokenCount(trimmed);

	logger?.info?.(
		`[Context] Trimmed ${dropCount} conversation group(s) to fit context budget (${finalEstimate}/${budget} estimated tokens)`
	);

	if (finalEstimate > budget) {
		logger?.warn?.(
			`[Context] Conversation still exceeds budget after trimming (${finalEstimate} > ${budget}); the provider may reject the request`
		);
	}

	return trimmed;
}
