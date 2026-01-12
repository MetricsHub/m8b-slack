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
import {
	createFileUploadManager,
	extractPreviousUploads,
	uploadOutputFilesToSlack,
} from "./services/slack-files.js";
import { streamOnce } from "./services/streaming.js";
import { buildToolsArray, logToolWarnings } from "./tools/index.js";
import { estimateTokenCount, isContextWindowError, summarizeInputItems } from "./utils/tokens.js";

/**
 * In-memory cache: threadTs -> last OpenAI response_id
 * Used to maintain conversation continuity across messages.
 * Cleared on bot restart.
 */
const threadResponseCache = new Map();

/**
 * Slack message length limits
 */
const SLACK_SAFE_LENGTH = 35000; // Leave buffer for markdown formatting overhead (Slack limit is ~40k)

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

	logger.info(`Processing message in thread ${thread_ts} from ${userDisplayName}: ${message.text}`);

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
		const lastBot = findLastBotMessage(messages, context, logger);

		// Try cache first, fall back to message metadata
		const cachedResponseId = threadResponseCache.get(thread_ts);

		// Build tools array (will be rebuilt after function calls add files)
		let tools = buildToolsArray({
			vectorStoreIds,
			codeFileIds: fileManager.codeFileIds,
		});

		// Log any configuration warnings
		await logToolWarnings({ vectorStoreIds, say, logger });

		// Determine if we have a previous response ID (for conversation continuity)
		// Use cached response ID (for cross-message continuity) or fall back to metadata
		const previousResponseId = cachedResponseId || lastBot.responseId;

		// Build initial input
		// Skip base system prompt when previous_response_id exists (OpenAI maintains context)
		let input = buildInitialInput({
			codeContainerFiles: fileManager.codeContainerFiles,
			includeBasePrompt: !previousResponseId,
		});

		// Add conversation history ONLY if no previous_response_id
		// When previous_response_id exists, OpenAI maintains context internally
		if (!previousResponseId) {
			const historyInput = await buildConversationInput(
				messages,
				lastBot.index,
				message.ts,
				context,
				fileManager.uploadOnce
			);
			input.push(...historyInput);
			logger.info(`Included conversation history: ${historyInput.length} items`);
		} else {
			logger.info(
				`Skipping conversation history (using previous_response_id: ${previousResponseId})`
			);
		}

		// ALWAYS add current message (regardless of previous_response_id)
		await appendCurrentMessage({
			input,
			message,
			userProfile,
			userDisplayName: `<@${userId}>`,
			uploadOnce: fileManager.uploadOnce,
		});

		// Pre-flight context check
		let contextSummarized = false;
		const estimatedTokens = estimateTokenCount(input);

		if (estimatedTokens > TOKEN_LIMITS.contextThreshold) {
			logger.info(
				`[Context] Pre-flight: estimated ${estimatedTokens} tokens exceeds threshold, summarizing...`
			);
			await setStatus({ status: "summarizing conversation..." });
			input = await summarizeConversationHistory(input, 6, logger);
			contextSummarized = true;
			logger.info(`[Context] After summarization: estimated ${estimateTokenCount(input)} tokens`);
		}

		// State for the conversation loop
		let _previousResponseId = previousResponseId;
		let responseIdFromFinalTurn = null;
		let _lastSeenResponseId = null;
		let anyTextStreamed = false;
		let sawAnyIncomplete = false;
		let lastFullText = "";
		let forceToolChoiceNext;
		let loopIteration = 0;

		logger.info(
			`Previous response ID: ${_previousResponseId} (from ${cachedResponseId ? "cache" : "metadata"})`
		);

		// Main conversation loop
		do {
			loopIteration += 1;
			logger.info?.("Loop iteration: calling streamOnce", {
				iteration: loopIteration,
				previous_response_id: _previousResponseId,
				inputCount: input.length,
				inputSummary: summarizeInputItems(input),
			});

			let streamResult;
			try {
				streamResult = await executeStreamWithRetry({
					input,
					tools,
					previousResponseId: _previousResponseId,
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
					logger.info("[Context] Context window exceeded, attempting to summarize and retry...");
					await setStatus({ status: "conversation too long, summarizing..." });
					input = await summarizeConversationHistory(input, 4, logger);
					contextSummarized = true;

					streamResult = await executeStreamWithRetry({
						input,
						tools,
						previousResponseId: _previousResponseId,
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

			const {
				functionCalls,
				outputFiles,
				responseId,
				hadText,
				incompleteReason,
				fullResponseText,
			} = streamResult;

			// Upload any generated files to Slack
			if (outputFiles && outputFiles.length > 0) {
				logger.info?.("Processing output files from code_interpreter", {
					count: outputFiles.length,
				});
				await uploadOutputFilesToSlack(outputFiles, client, channel, thread_ts, logger);
			}

			// Update state
			if (responseId) {
				responseIdFromFinalTurn = responseId;
				_lastSeenResponseId = responseId;
				_previousResponseId = responseId;
				// Cache the response ID for this thread
				threadResponseCache.set(thread_ts, responseId);
			}
			if (hadText) anyTextStreamed = true;
			if (incompleteReason) sawAnyIncomplete = true;
			if (fullResponseText) lastFullText = fullResponseText;

			// Prepare next turn
			input = [];
			forceToolChoiceNext = undefined;

			// Handle incomplete response with no output
			if (!hadText && (!functionCalls || functionCalls.length === 0) && incompleteReason) {
				logger.info?.("Response was incomplete; continuing with forced text-only turn", {
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

				logger.info?.("Executed function call", {
					iteration: loopIteration,
					name: fc?.name,
					call_id: fc?.call_id,
					outItemCount: outItems?.length || 0,
				});

				input.push(...outItems);
			}

			// Rebuild tools array to include any newly uploaded code_interpreter files
			if (fileManager.codeFileIds.size > 0) {
				tools = buildToolsArray({
					vectorStoreIds,
					codeFileIds: fileManager.codeFileIds,
				});
				logger.debug?.("Rebuilt tools array with updated code_interpreter files", {
					codeFileCount: fileManager.codeFileIds.size,
					files: Array.from(fileManager.codeContainerFiles.values()),
				});
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
		logger.error("OpenAI/stream error", {
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
 * @param {Object} options
 * @param {Map} options.codeContainerFiles - Files uploaded to code_interpreter
 * @param {boolean} options.includeBasePrompt - Whether to include base system prompt (false for subsequent messages)
 */
function buildInitialInput({ codeContainerFiles, includeBasePrompt = true }) {
	const input = [];

	// Include base system prompt only on first message
	// When previous_response_id exists, OpenAI maintains this context
	if (includeBasePrompt) {
		input.push({ role: "system", content: [{ type: "input_text", text: SYSTEM_PROMPT }] });
	}

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
	let totalCharsStreamed = 0; // Track message length
	let truncated = false;

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
			onStreamStart: async (responseId) => {
				// Create Slack streamer on first text output
				try {
					streamer = client.chatStream({
						channel,
						recipient_team_id: teamId,
						recipient_user_id: userId,
						thread_ts,
						metadata: responseId
							? {
									event_type: "openai_context",
									event_payload: {
										response_id: responseId,
										uploaded_files: fileManager.uploadedFilesThisTurn,
									},
								}
							: undefined,
					});
					return streamer;
				} catch (err) {
					logger?.info?.("Failed to create chatStream streamer", { err: String(err) });
					return null;
				}
			},
			onTextChunk: async (cleaned, streamController) => {
				// Check if we're approaching Slack's message length limit
				if (totalCharsStreamed + cleaned.length > SLACK_SAFE_LENGTH) {
					if (!truncated) {
						truncated = true;
						const remaining = Math.max(0, SLACK_SAFE_LENGTH - totalCharsStreamed);
						const truncatedChunk = cleaned.slice(0, remaining);
						const warning = "\n\n... _(output truncated - message too long)_";

						if (streamController) {
							if (truncatedChunk.length > 0) {
								await streamController.append({ markdown_text: truncatedChunk });
							}
							await streamController.append({ markdown_text: warning });
						} else {
							const text = truncatedChunk + warning;
							await say({ text });
						}

						totalCharsStreamed += truncatedChunk.length + warning.length;
						logger?.warn?.("Truncated streaming output - exceeded Slack message limit", {
							totalChars: totalCharsStreamed,
							limit: SLACK_SAFE_LENGTH,
						});
					}
					// Drop remaining chunks
					return;
				}

				totalCharsStreamed += cleaned.length;

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

	// Stop the streamer
	if (streamer) {
		try {
			await streamer.stop();
			logger?.info?.("Stopped stream", { response_id: result.responseId });
		} catch (e) {
			logger?.warn?.("Failed to stop stream", { error: String(e) });
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
