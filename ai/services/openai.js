/**
 * OpenAI client initialization and response helpers.
 */

import { OpenAI } from "openai";

// OpenAI client singleton
export const openai = new OpenAI({
	apiKey: process.env.OPENAI_API_KEY,
});

/**
 * Poll an OpenAI response until it reaches a terminal state.
 *
 * @param {string} responseId - The response ID to poll
 * @param {Object} options - Polling options
 * @param {number} options.intervalMs - Polling interval in milliseconds
 * @param {number} options.maxMs - Maximum time to poll in milliseconds
 * @returns {Promise<Object|null>} The final response or null
 */
export async function pollUntilTerminal(responseId, { intervalMs = 800, maxMs = 180000 } = {}) {
	const start = Date.now();
	let response = await openai.responses.retrieve(responseId);

	while (response?.status === "queued" || response?.status === "in_progress") {
		if (Date.now() - start > maxMs) break;
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
		response = await openai.responses.retrieve(responseId);
	}

	return response; // completed | incomplete | failed | cancelled | expired | undefined
}

/**
 * Extract text content from an OpenAI response.
 *
 * @param {Object} response - The OpenAI response object
 * @returns {string} Extracted text content
 */
export function getTextFromResponse(response) {
	try {
		if (!response) return "";

		const output = response.output || response.outputs || [];
		const parts = [];

		for (const item of output) {
			// Responses API commonly returns { type: 'output_text', text: '...' }
			if (item?.type === "output_text" && typeof item?.text === "string") {
				parts.push(item.text);
				continue;
			}

			// Try assistant-style content arrays
			const content = item?.content || [];
			for (const c of content) {
				if ((c.type === "text" || c.type === "output_text") && typeof c?.text === "string") {
					parts.push(c.text);
				}
				if (typeof c?.text?.value === "string") {
					parts.push(c.text.value);
				}
			}
		}

		return parts.join(" ").trim();
	} catch {
		return "";
	}
}

/**
 * Continue an incomplete response with additional tokens.
 *
 * @param {Object} response - The incomplete response
 * @param {Object} options - Continuation options
 * @param {number} options.boostFactor - Multiplier for additional tokens
 * @param {number} options.maxOut - Maximum output tokens for continuation
 * @returns {Promise<Object|null>} New response or null
 */
export async function continueIfIncomplete(response, { boostFactor = 2, maxOut = 4000 } = {}) {
	if (!response || response.status !== "incomplete") return null;

	const extra = Math.min(Math.max((response.usage?.output_tokens ?? 0) * boostFactor, 512), maxOut);

	return openai.responses.create({
		previous_response_id: response.id,
		input: [
			{
				role: "system",
				content: [
					{
						type: "input_text",
						text: "Continue the answer. Keep it concise for Slack.",
					},
				],
			},
		],
		max_output_tokens: extra,
		tool_choice: "none",
		background: true,
	});
}

/**
 * Attempt to recover text from a terminated/failed response.
 *
 * @param {string} latestResponseId - The response ID to recover
 * @param {Object} logger - Logger instance
 * @returns {Promise<Object|null>} Recovered response or null
 */
export async function recoverFromTerminated(latestResponseId, logger) {
	try {
		if (!latestResponseId) return null;

		const final = await pollUntilTerminal(latestResponseId);

		if (final?.status === "completed") return final;

		if (final?.status === "incomplete") {
			const continuation = await continueIfIncomplete(final);
			if (continuation?.id) {
				return pollUntilTerminal(continuation.id);
			}
		}

		return final;
	} catch (err) {
		logger?.warn?.("recoverFromTerminated failed", { err: String(err) });
		return null;
	}
}

/**
 * Get vector store IDs from environment variables.
 *
 * @returns {string[]} Array of vector store IDs
 */
export function getVectorStoreIds() {
	const fromEnv = (process.env.OPENAI_VECTOR_STORE_IDS || "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);

	if (fromEnv.length) {
		return fromEnv;
	}

	if (process.env.OPENAI_VECTOR_STORE_ID) {
		return [process.env.OPENAI_VECTOR_STORE_ID];
	}

	return [];
}
