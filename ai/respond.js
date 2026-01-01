/**
 * Main response handler - orchestrates the OpenAI conversation flow.
 *
 * This module coordinates:
 * - Message validation and context extraction
 * - File uploads and conversation history
 * - OpenAI streaming responses
 * - Function call processing
 * - Citation handling
 */

import { LOADING_MESSAGES, SYSTEM_PROMPT, TOKEN_LIMITS } from "./config/system-prompt.js";
import { processCitations } from "./services/citations.js";
import {
	buildConversationInput,
	findLastBotMessage,
	summarizeConversationHistory,
} from "./services/context-manager.js";
import { processFunctionCall } from "./services/function-calls.js";
import {
	continueIfIncomplete,
	getTextFromResponse,
	getVectorStoreIds,
	pollUntilTerminal,
	recoverFromTerminated,
} from "./services/openai.js";
import { createFileUploadManager, extractPreviousUploads } from "./services/slack-files.js";
import { streamOnce } from "./services/streaming.js";
import { buildToolsArray, logToolWarnings } from "./tools/index.js";
import { estimateTokenCount, isContextWindowError, summarizeInputItems } from "./utils/tokens.js";

/**
 * Main response handler for Slack messages.
 *
 * @param {Object} params - Handler parameters from Slack Bolt
 */
export async function respond({
	client,
	context,
	logger,
	message,
	say,
	setTitle,
	setStatus,
	setSuggestedPrompts,
}) {
	// Skip non-text or incomplete messages
	if (!("text" in message) || !("thread_ts" in message) || !message.text || !message.thread_ts) {
		return;
	}

	const { channel, thread_ts } = message;
	const { userId, teamId } = context;
	const userDisplayName = `<@${userId}>`;

	logger.debug(
		`Processing message in thread ${thread_ts} from ${userDisplayName}: ${message.text}`
	);

	// Fetch user profile
	const userProfile = await fetchUserProfile(client, userId, logger);

	// Helper to suggest follow-up when bot gets tired
	async function suggestSummarizeNow() {
		const payload = {
			title: "Pfffff... I'm tired of this...",
			prompts: [{ title: "📝 Oh come on!", message: "M8B, summarize now." }],
		};

		if (typeof setSuggestedPrompts === "function") {
			try {
				await setSuggestedPrompts(payload);
			} catch (e) {
				logger.warn?.("setSuggestedPrompts failed", { e: String(e) });
			}
		} else if (say) {
			await say({ text: "I'm tired of this... Say the magic word." });
		}
	}

	try {
		// Get configuration
		const vectorStoreIds = getVectorStoreIds();

		// Set initial status
		await setTitle(message.text);
		await setStatus({
			status: "thinking...",
			loading_messages: LOADING_MESSAGES,
		});

		// Fetch thread history
		const thread = await client.conversations.replies({
			channel,
			ts: thread_ts,
			include_all_metadata: true,
			limit: 15,
		});
		const messages = thread.messages || [];

		// Set up file upload manager
		const previousUploads = extractPreviousUploads(messages);
		const fileManager = createFileUploadManager(previousUploads, logger);

		// Upload all files from thread
		for (const msg of messages) {
			const files = Array.isArray(msg.files) ? msg.files : [];
			for (const file of files) {
				await fileManager.uploadOnce(file);
			}
		}

		// Find previous bot response for continuity
		const lastBot = findLastBotMessage(messages, context);
		logger.debug(`Previous response ID: ${lastBot.responseId}`);

		// Build tools array
		const tools = buildToolsArray({
			vectorStoreIds,
			codeFileIds: fileManager.codeFileIds,
		});

		// Log any configuration warnings
		await logToolWarnings({ vectorStoreIds, say, logger });

		// Build initial input
		let input = buildInitialInput({
			codeContainerFiles: fileManager.codeContainerFiles,
		});

		// Add conversation history
		const historyInput = await buildConversationInput(
			messages,
			lastBot.index,
			message.ts,
			context,
			fileManager.uploadOnce
		);
		input.push(...historyInput);

		// Add current message with user context
		await appendCurrentMessage({
			input,
			message,
			userProfile,
			userDisplayName,
			uploadOnce: fileManager.uploadOnce,
		});

		// Pre-flight context check
		let contextSummarized = false;
		const estimatedTokens = estimateTokenCount(input);

		if (estimatedTokens > TOKEN_LIMITS.contextThreshold) {
			console.log(
				`[Context] Pre-flight: estimated ${estimatedTokens} tokens exceeds threshold, summarizing...`
			);
			await setStatus({ status: "summarizing conversation..." });
			input = await summarizeConversationHistory(input, 6);
			contextSummarized = true;
			console.log(`[Context] After summarization: estimated ${estimateTokenCount(input)} tokens`);
		}

		// State for the conversation loop
		let previousResponseId = lastBot.responseId;
		let responseIdFromFinalTurn = null;
		let _lastSeenResponseId = null;
		let anyTextStreamed = false;
		let sawAnyIncomplete = false;
		let lastFullText = "";
		let forceToolChoiceNext;
		let loopIteration = 0;

		// Main conversation loop
		do {
			loopIteration += 1;
			logger.debug?.("Loop iteration: calling streamOnce", {
				iteration: loopIteration,
				previous_response_id: previousResponseId,
				inputCount: input.length,
				inputSummary: summarizeInputItems(input),
			});

			let streamResult;
			try {
				streamResult = await executeStreamWithRetry({
					input,
					tools,
					previousResponseId,
					forceToolChoiceNext,
					contextSummarized,
					setStatus,
					client,
					channel,
					teamId,
					userId,
					thread_ts,
					fileManager,
					say,
					logger,
				});
				contextSummarized = streamResult.contextSummarized;
			} catch (streamError) {
				// Check if this is a context window error
				if (isContextWindowError(streamError) && !contextSummarized) {
					console.log("[Context] Context window exceeded, attempting to summarize and retry...");
					await setStatus({ status: "conversation too long, summarizing..." });
					input = await summarizeConversationHistory(input, 4);
					contextSummarized = true;

					streamResult = await executeStreamWithRetry({
						input,
						tools,
						previousResponseId,
						forceToolChoiceNext,
						contextSummarized,
						setStatus,
						client,
						channel,
						teamId,
						userId,
						thread_ts,
						fileManager,
						say,
						logger,
					});
				} else {
					throw streamError;
				}
			}

			const { functionCalls, responseId, hadText, incompleteReason, fullResponseText } =
				streamResult;

			// Update state
			if (responseId) {
				responseIdFromFinalTurn = responseId;
				_lastSeenResponseId = responseId;
			}
			if (hadText) anyTextStreamed = true;
			if (incompleteReason) sawAnyIncomplete = true;
			if (fullResponseText) lastFullText = fullResponseText;

			// Prepare next turn
			previousResponseId = responseId || previousResponseId;
			input = [];
			forceToolChoiceNext = undefined;

			// Handle incomplete response with no output
			if (!hadText && (!functionCalls || functionCalls.length === 0) && incompleteReason) {
				logger.debug?.("Response was incomplete; continuing with forced text-only turn", {
					iteration: loopIteration,
					incompleteReason,
				});
				input = [
					{
						role: "system",
						content: [
							{
								type: "input_text",
								text: "Continue and provide the Slack-visible answer now. Do not call tools.",
							},
						],
					},
				];
				forceToolChoiceNext = "none";
				continue;
			}

			// Process function calls
			for (const fc of functionCalls) {
				const outItems = await processFunctionCall(fc, {
					client,
					message,
					say,
					vectorStoreIds,
					fileTracking: {
						uploadedFiles: fileManager.uploadedFilesThisTurn,
						codeFileIds: fileManager.codeFileIds,
						codeContainerFiles: fileManager.codeContainerFiles,
					},
					logger,
				});

				logger.debug?.("Executed function call", {
					iteration: loopIteration,
					name: fc?.name,
					call_id: fc?.call_id,
					outItemCount: outItems?.length || 0,
				});

				input.push(...outItems);
			}
		} while (input.length > 0);

		logger.debug?.("Exiting loop: no tool outputs to feed back", {
			iterations: loopIteration,
			responseIdFromFinalTurn,
		});

		// Handle final response
		if (responseIdFromFinalTurn) {
			if (!anyTextStreamed) {
				await handleNoTextStreamed({
					responseIdFromFinalTurn,
					sawAnyIncomplete,
					say,
					suggestSummarizeNow,
					uploadedFilesThisTurn: fileManager.uploadedFilesThisTurn,
					logger,
				});
			}

			// Process citations
			await processCitations({
				responseId: responseIdFromFinalTurn,
				fullText: lastFullText,
				vectorStoreIds,
				channel,
				thread_ts,
				client,
				say,
				logger,
			});
		} else {
			logger.warn("No response ID was received from OpenAI");
		}
	} catch (e) {
		console.error("OpenAI/stream error", {
			message: e?.message,
			status: e?.status,
			request_id: e?.request_id,
			param: e?.param,
			type: e?.type,
		});

		// Handle transport errors gracefully
		if (
			String(e?.message || "")
				.toLowerCase()
				.includes("terminated") ||
			String(e?.type || "")
				.toLowerCase()
				.includes("server_error")
		) {
			try {
				const recovered = await recoverFromTerminated(lastSeenResponseId, logger);
				if (recovered?.status === "completed") {
					const text = getTextFromResponse(recovered);
					if (text) return await say({ text });
				}
				if (recovered?.status === "incomplete") {
					const cont = await continueIfIncomplete(recovered);
					const polled = cont?.id ? await pollUntilTerminal(cont.id) : null;
					const text = getTextFromResponse(polled);
					if (text) return await say({ text });
				}
			} catch {
				/* ignore recovery errors */
			}

			await suggestSummarizeNow();
			return;
		}

		// Non-transport errors
		await say({ text: `FFS... 🤦‍♂️ ${e}` });
	}
}

/**
 * Fetch user profile information.
 */
async function fetchUserProfile(client, userId, logger) {
	let userRealName = null;
	let userTimezone = null;

	try {
		const userInfo = await client.users.info({ user: userId });
		if (userInfo?.ok && userInfo?.user) {
			userRealName =
				userInfo.user.real_name || userInfo.user.profile?.real_name || userInfo.user.name;
			userTimezone = userInfo.user.tz || userInfo.user.tz_label;
			logger.debug(`User profile fetched: ${userRealName}, timezone: ${userTimezone}`);
		}
	} catch (e) {
		logger.debug?.("Failed to fetch user profile", { userId, e: String(e) });
	}

	return { userRealName, userTimezone };
}

/**
 * Build initial input with system prompts.
 */
function buildInitialInput({ codeContainerFiles }) {
	const input = [{ role: "system", content: [{ type: "input_text", text: SYSTEM_PROMPT }] }];

	// Add attachment guidance if files are present
	const codeFileNames = Array.from(codeContainerFiles.values());
	if (codeFileNames.length) {
		const guidance = `User uploaded files available to code_interpreter: ${codeFileNames.join(", ")}. Do NOT use File Search for these; read them directly with code_interpreter.`;
		input.push({ role: "system", content: [{ type: "input_text", text: guidance }] });
	}

	return input;
}

/**
 * Append current message to input.
 */
async function appendCurrentMessage({ input, message, userProfile, userDisplayName, uploadOnce }) {
	const contentItems = [{ type: "input_text", text: message.text }];

	// Upload any attached files
	const files = Array.isArray(message.files) ? message.files : [];
	for (const file of files) {
		const result = await uploadOnce(file);
		if (result?.contentItem) {
			contentItems.push(result.contentItem);
		}
	}

	// Build user context message
	const userContextParts = [];
	if (userProfile.userRealName) {
		userContextParts.push(`User's real name: ${userProfile.userRealName}`);
	}
	userContextParts.push(
		`User's Slack ID: ${userDisplayName} (always use this format to mention the user)`
	);
	if (userProfile.userTimezone) {
		userContextParts.push(`User's timezone: ${userProfile.userTimezone}`);
	}

	input.push({
		role: "system",
		content: [{ type: "input_text", text: userContextParts.join("\n") }],
	});
	input.push({ role: "user", content: contentItems });
}

/**
 * Execute stream with context summarization retry.
 */
async function executeStreamWithRetry({
	input,
	tools,
	previousResponseId,
	forceToolChoiceNext,
	contextSummarized,
	setStatus,
	client,
	channel,
	teamId,
	userId,
	thread_ts,
	fileManager,
	say,
	logger,
}) {
	let streamer = null;
	let postedFirstLine = false;

	const result = await streamOnce(
		{
			input,
			tools,
			tool_choice: forceToolChoiceNext,
			previous_response_id: previousResponseId,
		},
		{
			setStatus,
			logger,
			onStreamStart: async () => {
				// Create Slack streamer on first text output
				try {
					streamer = client.chatStream({
						channel,
						recipient_team_id: teamId,
						recipient_user_id: userId,
						thread_ts,
					});
					return streamer;
				} catch (err) {
					logger?.debug?.("Failed to create chatStream streamer", { err: String(err) });
					return null;
				}
			},
			onTextChunk: async (cleaned, streamController) => {
				if (streamController) {
					await streamController.append({ markdown_text: cleaned });
				} else {
					// Fallback to say()
					const payload = { text: cleaned };
					if (!postedFirstLine && result?.responseId) {
						payload.metadata = {
							event_type: "openai_context",
							event_payload: {
								response_id: result.responseId,
								uploaded_files: fileManager.uploadedFilesThisTurn,
							},
						};
						postedFirstLine = true;
					}
					await say(payload);
				}
			},
		}
	);

	// Attach metadata to streamed message
	if (streamer && result.responseId) {
		try {
			const stopResult = await streamer.stop();
			const msgTs = stopResult?.message?.ts;
			if (msgTs) {
				await client.chat.update({
					channel,
					ts: msgTs,
					metadata: {
						event_type: "openai_context",
						event_payload: {
							response_id: result.responseId,
							uploaded_files: fileManager.uploadedFilesThisTurn,
						},
					},
				});
			}
		} catch (e) {
			logger?.debug?.("Failed to attach metadata to streamed message", { e: String(e) });
		}
	}

	return { ...result, contextSummarized };
}

/**
 * Handle case when no text was streamed.
 */
async function handleNoTextStreamed({
	responseIdFromFinalTurn,
	sawAnyIncomplete,
	say,
	suggestSummarizeNow,
	uploadedFilesThisTurn,
	logger,
}) {
	try {
		const final = await pollUntilTerminal(responseIdFromFinalTurn);

		if (final?.status === "completed") {
			const text = getTextFromResponse(final);
			if (text) {
				await say({
					text,
					metadata: {
						event_type: "openai_context",
						event_payload: {
							response_id: responseIdFromFinalTurn,
							uploaded_files: uploadedFilesThisTurn,
						},
					},
				});
				return;
			}
		} else if (final?.status === "incomplete" && sawAnyIncomplete) {
			const cont = await continueIfIncomplete(final);
			const polled = cont?.id ? await pollUntilTerminal(cont.id) : null;
			const text = getTextFromResponse(polled);
			if (text) {
				await say({
					text,
					metadata: {
						event_type: "openai_context",
						event_payload: {
							response_id: polled?.id || responseIdFromFinalTurn,
							uploaded_files: uploadedFilesThisTurn,
						},
					},
				});
				return;
			}
		}

		await suggestSummarizeNow();
		await say?.({
			text: "\u200B",
			metadata: {
				event_type: "openai_context",
				event_payload: {
					response_id: responseIdFromFinalTurn,
					uploaded_files: uploadedFilesThisTurn,
				},
			},
		});
	} catch (err) {
		logger?.warn?.("Background recovery failed", { err: String(err) });
		await suggestSummarizeNow();
		await say?.({
			text: "\u200B",
			metadata: {
				event_type: "openai_context",
				event_payload: {
					response_id: responseIdFromFinalTurn,
					uploaded_files: uploadedFilesThisTurn,
				},
			},
		});
	}
}
