/**
 * Main response handler - orchestrates the AI conversation flow.
 *
 * This module coordinates:
 * - Message validation and context extraction
 * - File uploads and conversation history
 * - Streaming responses from the active AI provider (OpenAI or Ollama)
 * - Function call processing (the agent loop)
 * - Citation handling
 *
 * Conversation state:
 * - OpenAI: server-side via previous_response_id (unchanged behavior)
 * - Ollama: application-side; history is stored per Slack thread and resent
 *   as structured input items on every request (Ollama's /v1/responses is stateless)
 */

import { MAX_AGENT_ITERATIONS } from "./config/providers.js";
import {
	buildSystemPrompt,
	LOADING_MESSAGES,
	SYSTEM_PROMPT,
	TOKEN_LIMITS,
} from "./config/system-prompt.js";
import { describeProviderError, getProvider } from "./providers/index.js";
import { processCitations } from "./services/citations.js";
import { trimToContextBudget } from "./services/context-budget.js";
import {
	buildConversationInput,
	findLastBotMessage,
	summarizeConversationHistory,
} from "./services/context-manager.js";
import {
	conversationKey,
	getConversation,
	setConversation,
} from "./services/conversation-store.js";
import { processFunctionCall } from "./services/function-calls.js";
import { createLocalKnowledgeBase } from "./services/knowledge-base.js";
import {
	continueIfIncomplete,
	createSafetyIdentifier,
	getTextFromResponse,
	getVectorStoreIds,
	pollUntilTerminal,
	recoverFromTerminated,
} from "./services/openai.js";
import {
	createFileUploadManager,
	createNoopFileUploadManager,
	extractPreviousUploads,
	uploadOutputFilesToSlack,
} from "./services/slack-files.js";
import { streamOnce } from "./services/streaming.js";
import { buildToolsArray, logToolWarnings } from "./tools/index.js";
import {
	estimateTokenCount,
	isContextWindowError,
	PAYLOAD_CHARS_PER_TOKEN,
	summarizeInputItems,
} from "./utils/tokens.js";

/**
 * In-memory cache: threadTs -> last OpenAI response_id
 * Used to maintain conversation continuity across messages (OpenAI mode only).
 * Cleared on bot restart.
 */
const threadResponseCache = new Map();

/**
 * Slack message length limits
 */
const SLACK_SAFE_LENGTH = 35000; // Leave buffer for markdown formatting overhead (Slack limit is ~40k)

/**
 * Tools whose results never change the answer (pure Slack side effects).
 * In stateless mode, when a turn already produced the user-visible text and
 * only these tools are pending, no extra model turn is needed — running one
 * makes local models repeat the answer as a duplicate Slack message.
 */
const SIDE_EFFECT_TOOLS = new Set(["slack_add_reaction", "slack_add_reply"]);

/**
 * One-shot nudge for stateless continuation turns after text was already
 * streamed to Slack: without it, local models restate the previous answer.
 */
const NO_REPEAT_NUDGE = {
	role: "system",
	content: [
		{
			type: "input_text",
			text: "Your previous assistant message was already delivered to the user in Slack. Do NOT repeat it. Reply only with new information based on the latest tool results, or with a very short addition if nothing new is needed.",
		},
	],
};

/**
 * Build a resendable function_call input item from a streamed function call.
 * Used in stateless mode where tool calls must be replayed in `input`.
 */
function buildFunctionCallItem(fc) {
	return {
		type: "function_call",
		call_id: fc.call_id,
		name: fc.name,
		arguments: fc.arguments || "{}",
	};
}

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
	body,
	payload,
	say,
	setTitle,
	setStatus,
	slackAppContext,
}) {
	// Skip non-text or incomplete messages
	if (!("text" in message) || !("thread_ts" in message) || !message.text || !message.thread_ts) {
		return;
	}

	const { channel, thread_ts } = message;

	// Safely extract userId and teamId from either context, message, event, or body
	// App_mention wrapper passes them in context, but standard Bolt passes them differently
	const userId =
		context?.userId || message?.user || message?.author_id || payload?.user || body?.event?.user;

	// Bolt's core context usually has teamId; fallback to message.team or body.team_id
	const teamId =
		context?.teamId ||
		message?.team ||
		message?.team_id ||
		payload?.team ||
		body?.team_id ||
		body?.event?.team ||
		body?.team?.id ||
		(context?.enterpriseId ? context.teamId : undefined);

	const userDisplayName = `<@${userId}>`;
	const safetyIdentifier = createSafetyIdentifier(userId, teamId);
	let lastSeenResponseId = null;

	// Resolve the active AI provider (openai or ollama)
	const provider = getProvider();
	const stateless = !provider.capabilities.serverSideState;

	logger.info(`Processing message in thread ${thread_ts} from ${userDisplayName}: ${message.text}`);

	// Fetch user profile
	const userProfile = await fetchUserProfile(client, userId, logger);

	// Helper to suggest follow-up when bot gets tired
	async function suggestSummarizeNow() {
		if (say) {
			await say({ text: "I'm tired of this... Say the magic word." });
		}
	}

	try {
		// Get configuration
		const vectorStoreIds = provider.capabilities.hostedFileSearch ? getVectorStoreIds() : [];

		// Local knowledge base (Ollama mode replacement for hosted file_search)
		const knowledgeBase = provider.capabilities.hostedFileSearch
			? null
			: createLocalKnowledgeBase({ logger });
		const knowledgeBaseAvailable = knowledgeBase ? await knowledgeBase.isAvailable() : false;

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

		// Set up file upload manager (no-op when the provider has no Files API)
		const previousUploads = extractPreviousUploads(messages);
		const fileManager = provider.capabilities.providerFileUploads
			? createFileUploadManager(previousUploads, logger)
			: createNoopFileUploadManager(logger);

		// Upload all files from thread
		if (!fileManager.disabled) {
			for (const msg of messages) {
				const files = Array.isArray(msg.files) ? msg.files : [];
				for (const file of files) {
					await fileManager.uploadOnce(file);
				}
			}
		}

		// Build tools array (will be rebuilt after function calls add files)
		let tools = buildToolsArray({
			vectorStoreIds,
			codeFileIds: fileManager.codeFileIds,
			provider,
			knowledgeBaseAvailable,
		});

		// Log any configuration warnings
		await logToolWarnings({ vectorStoreIds, provider, knowledgeBaseAvailable, say, logger });

		// Tool schemas ride along with every request but are not input items, so
		// the context-budget trimmer cannot see them; reserve their share
		// explicitly (base 1500 covers the chat template and framing)
		const trimReserveTokens =
			1500 + Math.ceil(JSON.stringify(tools || []).length / PAYLOAD_CHARS_PER_TOKEN);

		// Determine conversation continuity strategy
		let previousResponseId = null;
		if (!stateless) {
			// Find previous bot response for continuity
			const lastBot = findLastBotMessage(messages, context, logger);

			// Try cache first, fall back to message metadata
			const cachedResponseId = threadResponseCache.get(thread_ts);
			previousResponseId = cachedResponseId || lastBot.responseId;
			logger.info(
				`Previous response ID: ${previousResponseId} (from ${cachedResponseId ? "cache" : "metadata"})`
			);
		}

		// Build initial input
		// OpenAI: skip base system prompt when previous_response_id exists (OpenAI maintains context)
		// Ollama: always include the (capability-adapted) system prompt
		const systemPrompt = stateless
			? buildSystemPrompt(provider.capabilities, { contextWindow: provider.contextWindow })
			: SYSTEM_PROMPT;
		let input = buildInitialInput({
			codeContainerFiles: fileManager.codeContainerFiles,
			includeBasePrompt: stateless || !previousResponseId,
			systemPrompt,
		});

		// Conversation history
		const storeKey = conversationKey({ teamId, channel, threadTs: thread_ts });
		let statelessHistory = [];

		if (stateless) {
			// Application-side history: use the stored conversation when available,
			// otherwise rebuild the whole thread from Slack (e.g. after a restart)
			const stored = getConversation(storeKey);
			statelessHistory =
				stored ??
				(await buildConversationInput(messages, -1, message.ts, context, fileManager.uploadOnce));
			input.push(...statelessHistory);
			logger.info(
				`[Context] Conversation history: ${statelessHistory.length} items (${stored ? "from store" : "rebuilt from Slack thread"})`
			);
		} else if (!previousResponseId) {
			// Add conversation history ONLY if no previous_response_id
			// When previous_response_id exists, OpenAI maintains context internally
			const lastBot = findLastBotMessage(messages, context, logger);
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
			slackAppContext,
			filesUnsupported: fileManager.disabled === true,
		});
		const currentUserItem = input[input.length - 1];

		// Pre-flight context check
		let contextSummarized = false;
		if (stateless) {
			input = trimToContextBudget(input, {
				contextWindow: provider.contextWindow,
				maxOutputTokens: provider.maxOutputTokens,
				reserveTokens: trimReserveTokens,
				logger,
			});
		} else {
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
		}

		// State for the conversation loop
		let _previousResponseId = previousResponseId;
		let responseIdFromFinalTurn = null;
		let anyTextStreamed = false;
		let sawAnyIncomplete = false;
		let lastFullText = "";
		let forceToolChoiceNext;
		let loopIteration = 0;
		let hitIterationLimit = false;
		let continueLoop = false;
		let repliedViaTool = false;

		// Stateless accumulation: items produced during this turn (assistant text,
		// function calls, function outputs) that must be resent on each iteration
		// and persisted at the end
		const turnItems = [];
		let transientItems = [];

		// Main conversation loop (the agent loop)
		do {
			loopIteration += 1;
			continueLoop = false;

			if (loopIteration > MAX_AGENT_ITERATIONS) {
				hitIterationLimit = true;
				logger.warn(`[LOOP] Agent loop exceeded ${MAX_AGENT_ITERATIONS} iterations; stopping`);
				break;
			}

			// The final permitted iteration must produce the answer, not more tool
			// calls: force a text-only turn so the data gathered so far reaches
			// the user instead of the run dying mid-investigation
			if (loopIteration === MAX_AGENT_ITERATIONS) {
				logger.warn(
					`[LOOP] Final agent iteration (${MAX_AGENT_ITERATIONS}); forcing a text-only answer`
				);
				forceToolChoiceNext = "none";
				const wrapUpNudge = {
					role: "system",
					content: [
						{
							type: "input_text",
							text: "Tool-call limit reached for this request. Do NOT call any more tools. Answer the user now using only the data already gathered above, and say explicitly which requested items are missing or unverified.",
						},
					],
				};
				if (stateless) {
					transientItems = [...transientItems, wrapUpNudge];
				} else {
					input.push(wrapUpNudge);
				}
			}

			// Assemble this iteration's input
			let requestInput;
			if (stateless) {
				requestInput = trimToContextBudget([...input, ...turnItems, ...transientItems], {
					contextWindow: provider.contextWindow,
					maxOutputTokens: provider.maxOutputTokens,
					reserveTokens: trimReserveTokens,
					logger,
				});
			} else {
				requestInput = input;
			}

			logger.info?.("Loop iteration: calling streamOnce", {
				iteration: loopIteration,
				provider: provider.name,
				previous_response_id: _previousResponseId,
				inputCount: requestInput.length,
				inputSummary: summarizeInputItems(requestInput),
			});

			let streamResult;
			try {
				streamResult = await executeStreamWithRetry({
					input: requestInput,
					tools,
					previousResponseId: _previousResponseId,
					forceToolChoiceNext,
					contextSummarized,
					provider,
					setStatus,
					client,
					channel,
					teamId,
					userId,
					safetyIdentifier,
					thread_ts,
					fileManager,
					say,
					logger,
				});
				contextSummarized = streamResult.contextSummarized;
			} catch (streamError) {
				// Check if this is a context window error
				if (isContextWindowError(streamError) && !contextSummarized) {
					contextSummarized = true;

					if (stateless) {
						// Deterministic retry: trim much harder against a halved budget
						logger.info("[Context] Context window exceeded, retrying with a harder trim...");
						await setStatus({ status: "conversation too long, trimming..." });
						requestInput = trimToContextBudget(requestInput, {
							contextWindow: Math.floor(provider.contextWindow / 2),
							maxOutputTokens: provider.maxOutputTokens,
							reserveTokens: trimReserveTokens,
							logger,
						});
					} else {
						logger.info("[Context] Context window exceeded, attempting to summarize and retry...");
						await setStatus({ status: "conversation too long, summarizing..." });
						input = await summarizeConversationHistory(input, 4, logger);
						requestInput = input;
					}

					streamResult = await executeStreamWithRetry({
						input: requestInput,
						tools,
						previousResponseId: _previousResponseId,
						forceToolChoiceNext,
						contextSummarized,
						provider,
						setStatus,
						client,
						channel,
						teamId,
						userId,
						safetyIdentifier,
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

			// Upload any generated files to Slack (code_interpreter output, OpenAI only)
			if (outputFiles && outputFiles.length > 0) {
				logger.info?.("Processing output files from code_interpreter", {
					count: outputFiles.length,
				});
				await uploadOutputFilesToSlack(outputFiles, client, channel, thread_ts, logger);
			}

			// Update state
			if (responseId) {
				responseIdFromFinalTurn = responseId;
				lastSeenResponseId = responseId;
				if (!stateless) {
					_previousResponseId = responseId;
					// Cache the response ID for this thread
					threadResponseCache.set(thread_ts, responseId);
				}
			}
			if (hadText) anyTextStreamed = true;
			if (incompleteReason) sawAnyIncomplete = true;
			if (fullResponseText) lastFullText = fullResponseText;

			// Record the assistant's visible answer for stateless replay/persistence
			if (stateless && fullResponseText) {
				turnItems.push({
					role: "assistant",
					content: [{ type: "output_text", text: fullResponseText }],
				});
			}

			// Prepare next turn
			if (!stateless) input = [];
			transientItems = [];
			forceToolChoiceNext = undefined;

			// Handle incomplete response with no output
			if (!hadText && (!functionCalls || functionCalls.length === 0) && incompleteReason) {
				logger.info?.("Response was incomplete; continuing with forced text-only turn", {
					iteration: loopIteration,
					incompleteReason,
				});
				const continueNudge = {
					role: "system",
					content: [
						{
							type: "input_text",
							text: "Continue and provide the Slack-visible answer now. Do not call tools.",
						},
					],
				};
				if (stateless) {
					transientItems = [continueNudge];
				} else {
					input = [continueNudge];
				}
				forceToolChoiceNext = "none";
				continueLoop = true;
				continue;
			}

			// Process function calls
			for (const fc of functionCalls) {
				const outItems = await processFunctionCall(fc, {
					client,
					message,
					say,
					vectorStoreIds,
					provider,
					knowledgeBase,
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

				// A successful slack_add_reply IS a user-visible answer: track it so
				// the loop doesn't force an extra turn the model fills with rambling
				if (fc?.name === "slack_add_reply") {
					try {
						if (JSON.parse(outItems[0]?.output || "{}")?.ok === true) {
							repliedViaTool = true;
						}
					} catch {
						/* malformed output: treat as not replied */
					}
				}

				if (stateless) {
					// Replay the call and its result on the next iteration
					turnItems.push(buildFunctionCallItem(fc));
					turnItems.push(...outItems);
				} else {
					input.push(...outItems);
				}
			}

			// Decide whether another model turn is needed (stateless providers)
			if (stateless && functionCalls.length > 0) {
				const answerDelivered = hadText || repliedViaTool;
				const onlySideEffects = functionCalls.every((fc) => SIDE_EFFECT_TOOLS.has(fc?.name));
				if (answerDelivered && onlySideEffects) {
					// The visible answer was already streamed (or posted via
					// slack_add_reply) and the remaining tool results carry no
					// information — an extra turn would only make the model repeat
					// itself or narrate its tool calls in Slack. Stop here.
					logger.info?.(
						"Answer already delivered; skipping extra model turn for side-effect tool results",
						{ iteration: loopIteration, tools: functionCalls.map((fc) => fc?.name) }
					);
					continueLoop = false;
				} else {
					continueLoop = true;
					if (answerDelivered) {
						// The turn delivered an answer AND fetched data: continue, but tell
						// the model its previous message is already posted so it doesn't repeat it
						transientItems = [NO_REPEAT_NUDGE];
					}
				}
			}

			// Rebuild tools array to include any newly uploaded code_interpreter files
			if (fileManager.codeFileIds.size > 0) {
				tools = buildToolsArray({
					vectorStoreIds,
					codeFileIds: fileManager.codeFileIds,
					provider,
					knowledgeBaseAvailable,
				});
				logger.debug?.("Rebuilt tools array with updated code_interpreter files", {
					codeFileCount: fileManager.codeFileIds.size,
					files: Array.from(fileManager.codeContainerFiles.values()),
				});
			}

			if (!stateless) {
				continueLoop = input.length > 0;
			}
		} while (continueLoop);

		logger.debug?.("Exiting loop: no tool outputs to feed back", {
			iterations: loopIteration,
			responseIdFromFinalTurn,
		});

		// Persist the conversation for stateless providers
		if (stateless) {
			setConversation(storeKey, [...statelessHistory, currentUserItem, ...turnItems]);
		}

		if (hitIterationLimit) {
			await say({
				text: "I've been running tools in circles for too long. Stopping here — narrow the question and try again. 😮‍💨",
			});
			return;
		}

		// Handle final response
		if (stateless) {
			// A slack_add_reply already put the answer in the thread: nothing to add
			if (!anyTextStreamed && !repliedViaTool) {
				if (lastFullText) {
					await say({ text: lastFullText });
				} else {
					await say({ text: "I've got nothing. Rephrase and try again. 🤷" });
				}
			}
			return;
		}

		if (responseIdFromFinalTurn) {
			if (!anyTextStreamed) {
				await handleNoTextStreamed({
					responseIdFromFinalTurn,
					sawAnyIncomplete,
					say,
					suggestSummarizeNow,
					uploadedFilesThisTurn: fileManager.uploadedFilesThisTurn,
					safetyIdentifier,
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
		logger.error("AI stream error", {
			provider: provider.name,
			message: e?.message,
			status: e?.status,
			request_id: e?.request_id,
			param: e?.param,
			type: e?.type,
		});

		// Stateless providers (Ollama): short friendly message, details stay in logs
		if (stateless) {
			try {
				await say({ text: describeProviderError(e, provider) });
			} catch {
				/* ignore secondary Slack errors */
			}
			return;
		}

		// Handle transport errors gracefully (OpenAI)
		if (
			String(e?.message || "")
				.toLowerCase()
				.includes("terminated") ||
			String(e?.type || "")
				.toLowerCase()
				.includes("server_error")
		) {
			try {
				const recovered = await recoverFromTerminated(lastSeenResponseId, logger, {
					safetyIdentifier,
				});
				if (recovered?.status === "completed") {
					const text = getTextFromResponse(recovered);
					if (text) return await say({ text });
				}
				if (recovered?.status === "incomplete") {
					const cont = await continueIfIncomplete(recovered, { safetyIdentifier });
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
 * @param {string} [options.systemPrompt] - System prompt text (capability-adapted for some providers)
 */
function buildInitialInput({
	codeContainerFiles,
	includeBasePrompt = true,
	systemPrompt = SYSTEM_PROMPT,
}) {
	const input = [];

	// Include base system prompt only on first message
	// When previous_response_id exists, OpenAI maintains this context
	if (includeBasePrompt) {
		input.push({ role: "system", content: [{ type: "input_text", text: systemPrompt }] });
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
async function appendCurrentMessage({
	input,
	message,
	userProfile,
	userDisplayName,
	uploadOnce,
	slackAppContext,
	filesUnsupported = false,
}) {
	const contentItems = [{ type: "input_text", text: message.text }];

	// Upload any attached files
	const files = Array.isArray(message.files) ? message.files : [];
	for (const file of files) {
		if (filesUnsupported) {
			// No provider Files API: surface the attachment as a text note instead
			contentItems.push({
				type: "input_text",
				text: `[Attached file "${file.name || "unknown"}" (${file.mimetype || "unknown type"}) — file analysis is not available on the local AI backend.]`,
			});
			continue;
		}
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
	const slackEntities = Array.isArray(slackAppContext?.entities)
		? slackAppContext.entities
				.filter((entity) => entity?.type && entity?.value)
				.map((entity) => {
					const value =
						typeof entity.value === "string" ? entity.value : JSON.stringify(entity.value);
					return `${entity.type}: ${value}`;
				})
		: [];
	if (slackEntities.length > 0) {
		userContextParts.push(`User's current Slack context:\n${slackEntities.join("\n")}`);
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
	provider,
	setStatus,
	client,
	channel,
	teamId,
	userId,
	safetyIdentifier,
	thread_ts,
	fileManager,
	say,
	logger,
}) {
	let postedFirstLine = false;
	let totalCharsStreamed = 0; // Track message length
	let truncated = false;
	let seenResponseId = null; // Captured at stream start; the streamOnce result is not available yet

	const result = await streamOnce(
		{
			input,
			tools,
			tool_choice: forceToolChoiceNext,
			previous_response_id: previousResponseId,
			safety_identifier: safetyIdentifier,
			provider,
		},
		{
			setStatus,
			logger,
			onStreamStart: async (responseId) => {
				if (responseId) seenResponseId = responseId;
				// streamOnce owns this stream's lifecycle and stops it in its finally block.
				try {
					return client.chatStream({
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
					if (!postedFirstLine && seenResponseId) {
						payload.metadata = {
							event_type: "openai_context",
							event_payload: {
								response_id: seenResponseId,
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
	safetyIdentifier,
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
			const cont = await continueIfIncomplete(final, { safetyIdentifier });
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
			text: "​",
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
			text: "​",
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
