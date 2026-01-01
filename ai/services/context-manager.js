/**
 * Context management for conversation history and summarization.
 */

import { TOKEN_LIMITS } from "../config/system-prompt.js";
import { getTextFromResponse, openai } from "./openai.js";

/**
 * Summarize older conversation history to reduce context size.
 *
 * @param {Array} inputItems - All input items
 * @param {number} keepRecentCount - Number of recent messages to keep intact
 * @returns {Promise<Array>} New input array with summarized history
 */
export async function summarizeConversationHistory(
	inputItems,
	keepRecentCount = TOKEN_LIMITS.keepRecentMessages
) {
	// Split input into system prompts, older messages, and recent messages
	const systemItems = [];
	const conversationItems = [];

	for (const item of inputItems || []) {
		if (item?.role === "system" && conversationItems.length === 0) {
			// System prompts at the beginning
			systemItems.push(item);
		} else {
			conversationItems.push(item);
		}
	}

	// Keep recent messages as-is, summarize older ones
	const recentItems = conversationItems.slice(-keepRecentCount);
	const olderItems = conversationItems.slice(0, -keepRecentCount);

	if (olderItems.length === 0) {
		// Nothing to summarize
		return inputItems;
	}

	// Build text representation of older messages for summarization
	const olderTexts = [];

	for (const item of olderItems) {
		const role = item?.role || "unknown";
		const content = item?.content || [];

		for (const c of content) {
			if (c?.text) {
				olderTexts.push(`[${role}]: ${c.text}`);
			} else if (c?.type === "input_image") {
				olderTexts.push(`[${role}]: [attached image]`);
			} else if (c?.type === "input_file") {
				olderTexts.push(`[${role}]: [attached file: ${c.filename || "unknown"}]`);
			}
		}
	}

	if (olderTexts.length === 0) {
		return [...systemItems, ...recentItems];
	}

	console.log(
		`[Context] Summarizing ${olderItems.length} older messages to reduce context size...`
	);

	try {
		// Use a quick summarization call
		const summaryResponse = await openai.responses.create({
			model: TOKEN_LIMITS.summarizationModel,
			input: [
				{
					role: "system",
					content: [
						{
							type: "input_text",
							text: "Summarize the following conversation history concisely, preserving key facts, decisions, technical details, and any unresolved issues. Keep it under 500 words. Output only the summary, no preamble.",
						},
					],
				},
				{
					role: "user",
					content: [{ type: "input_text", text: olderTexts.join("\n\n") }],
				},
			],
			max_output_tokens: TOKEN_LIMITS.summarizationMaxTokens,
		});

		const summaryText =
			getTextFromResponse(summaryResponse) ||
			"Previous conversation occurred but could not be summarized.";

		console.log(`[Context] Conversation summarized to ${summaryText.length} chars`);

		// Build new input with summary
		return [
			...systemItems,
			{
				role: "system",
				content: [
					{
						type: "input_text",
						text: `**Summary of earlier conversation:**\n${summaryText}`,
					},
				],
			},
			...recentItems,
		];
	} catch (e) {
		console.error("[Context] Failed to summarize conversation:", e);
		// Fallback: just use system + recent items
		return [...systemItems, ...recentItems];
	}
}

/**
 * Find the most recent bot message with OpenAI context metadata.
 *
 * @param {Array} messages - Thread messages
 * @param {Object} context - Slack context with BOT_ID and BOT_USER_ID
 * @returns {{index: number, message: Object|null, responseId: string|null}}
 */
export function findLastBotMessage(messages, context) {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		const hasOpenAiMeta =
			msg.metadata?.event_type === "openai_context" && msg.metadata?.event_payload?.response_id;

		const authoredByThisBot =
			(msg.bot_id && context.BOT_ID && msg.bot_id === context.BOT_ID) ||
			(msg.user && context.BOT_USER_ID && msg.user === context.BOT_USER_ID) ||
			(msg.app_id && context.BOT_ID && msg.app_id === context.BOT_ID);

		if (hasOpenAiMeta && (authoredByThisBot || msg.bot_id || msg.app_id)) {
			return {
				index: i,
				message: msg,
				responseId: msg.metadata.event_payload.response_id,
			};
		}
	}

	return { index: -1, message: null, responseId: null };
}

/**
 * Build input items from thread messages after the last bot response.
 *
 * @param {Array} messages - Thread messages
 * @param {number} lastBotIndex - Index of last bot message
 * @param {string} currentMessageTs - Timestamp of current message to skip
 * @param {Object} context - Slack context
 * @param {Function} uploadOnce - Function to upload files
 * @returns {Promise<Array>} Input items for OpenAI
 */
export async function buildConversationInput(
	messages,
	lastBotIndex,
	currentMessageTs,
	context,
	uploadOnce
) {
	const input = [];

	for (let i = lastBotIndex + 1 || 0; i < messages.length; i++) {
		const msg = messages[i];

		// Skip the current incoming message
		if (!msg || msg.ts === currentMessageTs) continue;

		const rawText = (msg.text || "").trim();
		const authorId = msg.user || msg.bot_id || msg.app_id;

		// Determine if this message was authored by our bot
		const authoredByBot =
			(msg.bot_id && context.BOT_ID && msg.bot_id === context.BOT_ID) ||
			(msg.user && context.BOT_USER_ID && msg.user === context.BOT_USER_ID) ||
			(msg.app_id && context.BOT_ID && msg.app_id === context.BOT_ID);

		// 1) Text: assistant for bot, user for humans
		if (rawText) {
			if (authoredByBot) {
				// Assistant role requires output item types
				input.push({
					role: "assistant",
					content: [{ type: "output_text", text: rawText }],
				});
			} else {
				const textForUser =
					authorId && context.userId && authorId === context.userId
						? rawText
						: `<@${authorId}> said: ${rawText}`;

				input.push({
					role: "user",
					content: [{ type: "input_text", text: textForUser }],
				});
			}
		}

		// 2) Files (if any) ALWAYS under 'user' role
		const files = Array.isArray(msg.files) ? msg.files : [];
		const fileItems = [];

		for (const file of files) {
			const result = await uploadOnce(file);
			if (result?.contentItem) {
				fileItems.push(result.contentItem);
			}
		}

		if (fileItems.length && !authoredByBot) {
			const preface =
				authorId && (!context.userId || authorId !== context.userId)
					? [{ type: "input_text", text: `Files from <@${authorId}>:` }]
					: [];

			input.push({ role: "user", content: [...preface, ...fileItems] });
		}
	}

	return input;
}
