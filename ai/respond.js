/**
 * Main response handler - orchestrates the AI conversation flow.
 *
 * This module coordinates:
 * - Message validation and context extraction
 * - File uploads and conversation history
 * - Streaming responses from the active AI provider (OpenAI, Ollama, or vLLM)
 * - Function call processing (the agent loop)
 * - Citation handling
 *
 * Conversation state:
 * - OpenAI: server-side via previous_response_id (unchanged behavior)
 * - Ollama/vLLM: application-side; history is stored per Slack thread and
 *   resent as structured input items on every request (their /v1/responses
 *   is used statelessly)
 */

import { getDeploymentContext } from "./config/deployment.js";
import { MAX_AGENT_ITERATIONS } from "./config/providers.js";
import {
	buildSystemPrompt,
	LOADING_MESSAGES,
	SYSTEM_PROMPT,
	systemPromptVersion,
	TOKEN_LIMITS,
} from "./config/system-prompt.js";
import { getMcpServerCount } from "./mcp_registry.js";
import { describeProviderError, getProvider } from "./providers/index.js";
import { processCitations } from "./services/citations.js";
import { isConfigAdmin } from "./services/config-editor.js";
import { trimToContextBudget } from "./services/context-budget.js";
import {
	buildConversationInput,
	buildVisionContext,
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
	createDescribingFileUploadManager,
	createFileUploadManager,
	createNativeImageFileUploadManager,
	createNoopFileUploadManager,
	extractPreviousUploads,
	uploadOutputFilesToSlack,
} from "./services/slack-files.js";
import { streamOnce } from "./services/streaming.js";
import {
	beginRun,
	endRun,
	enqueueIfActive,
	hasPending,
	takePending,
	threadRunKey,
} from "./services/thread-inbox.js";
import { buildToolsArray, logToolWarnings } from "./tools/index.js";
import {
	estimateTokenCount,
	getTokenCalibration,
	isContextWindowError,
	PAYLOAD_CHARS_PER_TOKEN,
	recordTokenCalibration,
	summarizeInputItems,
} from "./utils/tokens.js";

/**
 * In-memory cache: threadTs -> { responseId, promptVersion } of the last
 * OpenAI response, i.e. the chain to continue and the system prompt it runs
 * under. Used to maintain conversation continuity across messages (OpenAI
 * mode only). Cleared on bot restart.
 * @type {Map<string, {responseId: string, promptVersion: string|null}>}
 */
const threadResponseCache = new Map();

/**
 * Slack message length limits
 */
const SLACK_SAFE_LENGTH = 35000; // Leave buffer for markdown formatting overhead (Slack limit is ~40k)

/**
 * Upper bound on thread pages fetched when a whole thread must be replayed
 * (Slack caps a page at 1000 messages; a thread this long is pathological).
 */
const MAX_THREAD_PAGES = 20;

/**
 * Follow conversations.replies pagination from an already-fetched first page
 * and return the complete thread (first page + every following page). Each
 * page is retried once on a Slack error; the function throws rather than
 * return a partial thread, because its caller is about to replace a chain
 * that still holds the missing turns.
 *
 * @param {Object} client - Slack WebClient
 * @param {Object} repliesArgs - Arguments used for the first page (channel, ts, ...)
 * @param {Object} firstPage - Result of the first conversations.replies call
 * @param {Object} [logger]
 * @returns {Promise<Array>} All thread messages in Slack order
 * @throws {Error} When a page cannot be fetched or the thread has too many pages
 */
async function fetchRemainingThreadPages(client, repliesArgs, firstPage, logger) {
	const messages = [...(firstPage.messages || [])];
	let cursor = firstPage.response_metadata?.next_cursor;
	let pages = 0;
	while (cursor) {
		if (pages >= MAX_THREAD_PAGES) {
			throw new Error(`thread has more than ${MAX_THREAD_PAGES} pages`);
		}
		pages += 1;
		const pageArgs = { ...repliesArgs, limit: 200, cursor };
		let page;
		try {
			page = await client.conversations.replies(pageArgs);
		} catch (e) {
			logger?.warn?.("conversations.replies page failed; retrying once", {
				message: e?.message,
				pages,
			});
			await new Promise((resolve) => setTimeout(resolve, 1000));
			page = await client.conversations.replies(pageArgs);
		}
		messages.push(...(page.messages || []));
		cursor = page.has_more ? page.response_metadata?.next_cursor : null;
	}
	logger?.info?.(`[Context] Fetched full thread: ${messages.length} messages (${pages + 1} pages)`);
	return messages;
}

/**
 * Slack message metadata that lets a later turn resume a hosted (OpenAI)
 * chain: the response to continue from, the files already uploaded, and the
 * fingerprint of the system prompt the chain runs under (see
 * systemPromptVersion(); a mismatch on the next turn restarts the chain).
 *
 * @param {Object} params
 * @param {string} params.responseId
 * @param {*} params.uploadedFiles
 * @param {string} params.promptVersion
 * @returns {{event_type: string, event_payload: Object}}
 */
function openaiContextMetadata({ responseId, uploadedFiles, promptVersion }) {
	return {
		event_type: "openai_context",
		event_payload: {
			response_id: responseId,
			uploaded_files: uploadedFiles,
			prompt_version: promptVersion,
		},
	};
}

/**
 * Tools whose results never change the answer (pure Slack side effects).
 * In stateless mode, when a turn already produced the user-visible text and
 * only these tools are pending, no extra model turn is needed — running one
 * makes local models repeat the answer as a duplicate Slack message.
 */
const SIDE_EFFECT_TOOLS = new Set(["slack_add_reaction"]);

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
 * True when an error came from the Slack Web API (@slack/web-api sets
 * `code` to "slack_webapi_*"), as opposed to the AI provider. Slack platform
 * errors like "fatal_error" must not be reported as AI backend failures.
 */
function isSlackApiError(error) {
	return typeof error?.code === "string" && error.code.startsWith("slack_webapi");
}

/**
 * One-shot system note preceding user messages injected into a running turn.
 * Persisted with the conversation in stateless mode, so it is worded to stay
 * accurate when replayed as history on later turns.
 */
function buildInjectedMessagesNudge() {
	return {
		role: "system",
		content: [
			{
				type: "input_text",
				text: "The user sent the additional message(s) below while you were still handling their earlier request. Anything you already posted was delivered — do not repeat it. Fold the new message(s) into your work: adjust course if they change the task, and make sure your final answer addresses them.",
			},
		],
	};
}

/**
 * Main response handler for Slack messages.
 *
 * One run owns a Slack thread at a time. A message that lands while a run is
 * already in flight is queued in the thread inbox: the active run injects it
 * between model turns when it comes from the same requester, and anything
 * still queued when the run ends (posted during the final stream, left by an
 * error, or sent by a different user) is re-dispatched here as its own run.
 *
 * @param {Object} params - Handler parameters from Slack Bolt
 */
export async function respond(params) {
	const { client, logger, message } = params;

	// Skip incomplete messages. A message may carry no text at all when the
	// user posts a bare attachment (screenshot without a caption): the files
	// are the content, so they count as a processable message.
	const messageHasFiles = Array.isArray(message.files) && message.files.length > 0;
	if (!("thread_ts" in message) || !message.thread_ts || (!message.text && !messageHasFiles)) {
		return;
	}

	// The enqueue check and the registration are one synchronous block, so two
	// Bolt events for the same thread can never both start a run
	const inboxKey = threadRunKey({ channel: message.channel, threadTs: message.thread_ts });
	if (enqueueIfActive(inboxKey, { message, slackAppContext: params.slackAppContext })) {
		logger.info(
			`Run already in flight for thread ${message.thread_ts}; queued message ${message.ts}`
		);
		// Best-effort acknowledgment so the user knows the message was seen
		try {
			await client.reactions.add({ channel: message.channel, timestamp: message.ts, name: "eyes" });
		} catch {
			/* cosmetic */
		}
		return;
	}
	beginRun(inboxKey);

	try {
		await respondCore(params);
	} finally {
		for (const entry of endRun(inboxKey)) {
			try {
				await respond({
					...params,
					message: entry.message,
					slackAppContext: entry.slackAppContext,
					context: { ...params.context, userId: entry.message?.user || params.context?.userId },
				});
			} catch (redispatchError) {
				logger.error("Failed to process a message queued behind the previous run", {
					message: redispatchError?.message,
					ts: entry.message?.ts,
				});
			}
		}
	}
}

/**
 * The actual response pipeline for one Slack message (plus any messages the
 * thread inbox injects along the way). Only called by respond(), which owns
 * the thread-inbox registration around it.
 *
 * @param {Object} params - Handler parameters from Slack Bolt
 */
async function respondCore({
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
	const { channel, thread_ts } = message;
	const inboxKey = threadRunKey({ channel, threadTs: thread_ts });

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

	// MetricsHub config editing is allowlist-gated per requesting user: the
	// tools are only exposed to the model when this user may actually use them
	const configEditingAllowed = isConfigAdmin(userId);
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
		// Writes only need an embedding backend (the first write creates the index)
		const knowledgeBaseWritable = knowledgeBase ? knowledgeBase.isWritable() : false;

		// Set initial status (cosmetic: a transient Slack error here must not
		// abort the whole turn)
		try {
			await setTitle(message.text || "(file attachment)");
			await setStatus({
				status: "thinking...",
				loading_messages: LOADING_MESSAGES,
			});
		} catch (e) {
			logger.warn("Failed to set assistant title/status; continuing", {
				message: e?.message,
			});
		}

		// Fetch thread history (retried once: Slack occasionally returns
		// transient platform errors such as "fatal_error")
		const repliesArgs = {
			channel,
			ts: thread_ts,
			include_all_metadata: true,
			limit: 15,
		};
		let thread;
		try {
			thread = await client.conversations.replies(repliesArgs);
		} catch (e) {
			if (!isSlackApiError(e)) {
				throw e;
			}
			logger.warn("conversations.replies failed; retrying once", { message: e?.message });
			await new Promise((resolve) => setTimeout(resolve, 1000));
			thread = await client.conversations.replies(repliesArgs);
		}
		let messages = thread.messages || [];

		// System prompt: capability-adapted (Ollama), plus the organization name of
		// the workspace this message comes from and the deployment notes (both modes)
		const systemPrompt = buildSystemPrompt(provider.capabilities, {
			contextWindow: stateless ? provider.contextWindow : undefined,
			...(await getDeploymentContext({ client, teamId, logger })),
		});
		const promptVersion = systemPromptVersion(systemPrompt);

		// Determine conversation continuity strategy
		let previousResponseId = null;
		// Hosted chains only carry the system prompt from their first turn: when
		// the thread was started under another prompt (older code, changed
		// deployment notes, organization name resolved late) the chain is
		// dropped and re-seeded with the current prompt plus the whole thread
		// history rebuilt from Slack
		let restartHostedChain = false;
		// The prompt the chain this turn extends actually runs under: stamped
		// into the reply's metadata and the cache. Differs from promptVersion
		// only when an old chain has to be continued although it is stale.
		let chainPromptVersion = promptVersion;
		if (!stateless) {
			// Find previous bot response for continuity: the in-process cache
			// first, then the Slack message metadata
			const lastBot = findLastBotMessage(messages, context, logger);
			const cached = threadResponseCache.get(thread_ts);
			const resume =
				cached ??
				(lastBot.responseId
					? { responseId: lastBot.responseId, promptVersion: lastBot.promptVersion }
					: null);

			if (resume && resume.promptVersion !== promptVersion) {
				restartHostedChain = true;
				logger.info(
					`Previous response ${resume.responseId} was produced under system prompt ${resume.promptVersion || "(unversioned)"}, current is ${promptVersion}: restarting the chain with the full thread history`
				);
			} else if (resume) {
				previousResponseId = resume.responseId;
			}
			logger.info(
				`Previous response ID: ${previousResponseId} (from ${cached ? "cache" : "metadata"})`
			);

			// A restarted chain replays the whole thread: the first page above is
			// only a window, so fetch the remaining pages before dropping the
			// server-side chain that held the older turns. If Slack cannot hand
			// out the whole thread right now, the intact old chain is continued
			// (stamped with ITS prompt version so the restart is attempted again
			// on the next turn) rather than replaced by a partial replay.
			if (restartHostedChain && thread.has_more) {
				try {
					messages = await fetchRemainingThreadPages(client, repliesArgs, thread, logger);
				} catch (e) {
					logger.warn(
						`Could not fetch the whole thread (${e?.message}); continuing the previous chain under its own prompt version for this turn`
					);
					restartHostedChain = false;
					previousResponseId = resume.responseId;
					chainPromptVersion = resume.promptVersion;
				}
			}
		}

		// Human participants in this thread (bot messages excluded). Used to warn
		// the approving admin when other people could have injected instructions.
		const threadAuthorIds = new Set(
			messages
				.filter((msg) => !msg.bot_id && msg.user && msg.user !== context?.BOT_USER_ID)
				.map((msg) => msg.user)
		);

		// Set up file upload manager: real uploads (OpenAI Files API), native
		// image input (vLLM multimodal, via the local media store), vision
		// descriptions (Ollama sidecar model), or no-op (attachments become
		// notes). With the local Python sandbox, the local-provider managers
		// also stage data attachments so run_python can read them from /data/.
		const previousUploads = extractPreviousUploads(messages);
		const stageAttachments = provider.capabilities.localCodeInterpreter === true;
		const fileManager = provider.capabilities.providerFileUploads
			? createFileUploadManager(previousUploads, logger)
			: provider.capabilities.imageInput
				? createNativeImageFileUploadManager({ stageAttachments, logger })
				: provider.capabilities.imageDescriptions
					? createDescribingFileUploadManager({
							describeImage: (params) => provider.describeImage(params),
							contextText: buildVisionContext(messages, message),
							stageAttachments,
							logger,
						})
					: createNoopFileUploadManager(logger, { stageAttachments });

		// Upload all files from thread (providers with a Files API only: uploads
		// must exist before the tools array is built so code_interpreter sees
		// them; the describing manager is invoked lazily instead, so cached
		// conversation turns never re-run the vision model)
		if (provider.capabilities.providerFileUploads) {
			for (const msg of messages) {
				const files = Array.isArray(msg.files) ? msg.files : [];
				for (const file of files) {
					await fileManager.uploadOnce(file);
				}
			}
		} else if (fileManager.stageAttachment) {
			// Re-stage every data attachment in the thread on every turn: the
			// sandbox staging map only lives for this message, but the notes
			// persisted in the conversation promise /data/<name> stays readable.
			// Cheap on repeat turns — the bytes are served from the persistent
			// disk staging cache, not re-downloaded from Slack
			for (const msg of messages) {
				const files = Array.isArray(msg.files) ? msg.files : [];
				for (const file of files) {
					await fileManager.stageAttachment(file);
				}
			}
		}

		// Build tools array (will be rebuilt after function calls add files)
		let tools = buildToolsArray({
			vectorStoreIds,
			codeFileIds: fileManager.codeFileIds,
			provider,
			knowledgeBaseAvailable,
			knowledgeBaseWritable,
			configEditingAllowed,
		});

		// Log any configuration warnings
		await logToolWarnings({ vectorStoreIds, provider, knowledgeBaseAvailable, say, logger });

		// Tool schemas ride along with every request but are not input items, so
		// the context-budget trimmer cannot see them; reserve their share
		// explicitly (base 1500 covers the chat template and framing)
		const trimReserveTokens =
			1500 + Math.ceil(JSON.stringify(tools || []).length / PAYLOAD_CHARS_PER_TOKEN);

		// Build initial input
		// OpenAI: skip base system prompt when previous_response_id exists (OpenAI maintains context)
		// Ollama: always include the (capability-adapted) system prompt
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
			// When previous_response_id exists, OpenAI maintains context internally.
			// A restarted chain replays the whole thread, not just what followed
			// the last bot message.
			const lastBot = findLastBotMessage(messages, context, logger);
			const historyInput = await buildConversationInput(
				messages,
				restartHostedChain ? -1 : lastBot.index,
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

		// ALWAYS add current message (regardless of previous_response_id).
		// In stateless mode the appended items (user-context note + message) are
		// also persisted, and an unchanged context note is not re-appended: the
		// resent history then matches the previous request token-for-token, so
		// the server's prefix cache covers the whole previous turn instead of
		// being invalidated right before the previous user message.
		const configAdminNote =
			getMcpServerCount() > 0
				? configEditingAllowed
					? "MetricsHub configuration changes: this user IS an authorized admin (config-editing tools are available)."
					: "MetricsHub configuration changes: this user is NOT authorized; the config-editing tools are disabled for this conversation. If they ask for a configuration change, refuse and point them to an authorized admin."
				: null;
		const appendedCurrentItems = await appendCurrentMessage({
			input,
			message,
			userProfile,
			userDisplayName: `<@${userId}>`,
			uploadOnce: fileManager.uploadOnce,
			slackAppContext,
			filesUnsupported: fileManager.disabled === true,
			priorHistory: stateless ? statelessHistory : null,
			configAdminNote,
		});

		// Everything appended for this run's user messages (context notes + the
		// messages themselves), including injected ones: the context-note dedup
		// in appendCurrentMessage checks it so notes are never repeated
		const appendedThisRun = [...appendedCurrentItems];

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
		let reactedViaTool = false;
		let truncationRetries = 0;

		// Stateless accumulation: items produced during this turn (assistant text,
		// function calls, function outputs) that must be resent on each iteration
		// and persisted at the end
		const turnItems = [];
		let transientItems = [];

		// Only the requesting user's late messages are injected into this run:
		// per-user gating (config admin rights, context notes) differs for anyone
		// else, so their messages wait for their own run after this one
		const isFromRequester = (entry) => entry?.message?.user === userId;

		// Main conversation loop (the agent loop)
		do {
			loopIteration += 1;
			continueLoop = false;

			// Fold in messages the requester sent while this run was working, so
			// the next model call sees them alongside the pending tool results
			const injectedEntries = takePending(inboxKey, isFromRequester);
			if (injectedEntries.length > 0) {
				logger.info?.(`[LOOP] Injecting ${injectedEntries.length} queued message(s) into run`, {
					iteration: loopIteration,
					ts: injectedEntries.map((entry) => entry.message?.ts),
				});

				// New user input restarts the work budget and lifts any forced
				// text-only wrap-up: the model may need tools for the new ask
				loopIteration = 1;
				truncationRetries = 0;
				forceToolChoiceNext = undefined;

				const injectionTarget = stateless ? turnItems : input;
				injectionTarget.push(buildInjectedMessagesNudge());
				for (const entry of injectedEntries) {
					const appended = await appendCurrentMessage({
						input: injectionTarget,
						message: entry.message,
						userProfile,
						userDisplayName: `<@${userId}>`,
						uploadOnce: fileManager.uploadOnce,
						slackAppContext: entry.slackAppContext,
						filesUnsupported: fileManager.disabled === true,
						priorHistory: stateless ? [...statelessHistory, ...appendedThisRun] : appendedThisRun,
						configAdminNote,
					});
					appendedThisRun.push(...appended);
				}

				// Injected attachments may have added code_interpreter files
				// (OpenAI): refresh the tools array before this model call
				if (fileManager.codeFileIds.size > 0) {
					tools = buildToolsArray({
						vectorStoreIds,
						codeFileIds: fileManager.codeFileIds,
						provider,
						knowledgeBaseAvailable,
						knowledgeBaseWritable,
						configEditingAllowed,
					});
				}
			}

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
					promptVersion: chainPromptVersion,
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
						promptVersion: chainPromptVersion,
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
				usage,
			} = streamResult;

			// Feed the server's exact prompt size back into the estimate
			// calibration (see tokens.js). Skipped for forced text-only turns:
			// they omit the tools array, so the schema reserve would not apply.
			if (stateless && usage?.inputTokens > 0 && forceToolChoiceNext !== "none") {
				const estimatedPromptTokens = estimateTokenCount(requestInput) + trimReserveTokens;
				recordTokenCalibration({
					estimatedTokens: estimatedPromptTokens,
					actualTokens: usage.inputTokens,
				});
				logger.info?.("[Context] Prompt token calibration", {
					estimated: estimatedPromptTokens,
					actual: usage.inputTokens,
					...getTokenCalibration(),
				});
			}

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
					// Cache the response ID for this thread, with the prompt its chain runs under
					threadResponseCache.set(thread_ts, {
						responseId,
						promptVersion: chainPromptVersion,
					});
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

			// A turn that consumed the entire output budget without completing a
			// function call was almost certainly cut off mid-generation (typically
			// while emitting a large tool-call argument) — Ollama reports such
			// turns as "completed", so incompleteReason is no help. Continue with
			// a corrective nudge instead of silently stopping mid-task.
			const outputBudgetExhausted =
				typeof usage?.outputTokens === "number" &&
				typeof provider.maxOutputTokens === "number" &&
				usage.outputTokens >= provider.maxOutputTokens;
			if (
				outputBudgetExhausted &&
				(!functionCalls || functionCalls.length === 0) &&
				truncationRetries < 2
			) {
				truncationRetries += 1;
				logger.warn?.("[LOOP] Output token budget exhausted with no tool call; continuing", {
					iteration: loopIteration,
					outputTokens: usage.outputTokens,
					maxOutputTokens: provider.maxOutputTokens,
					truncationRetries,
				});
				const truncationNudge = {
					role: "system",
					content: [
						{
							type: "input_text",
							text: "Your previous turn hit the output token limit and was CUT OFF — any tool call you were preparing was NEVER executed. Do not restate your plan. If you were about to call a tool, call it now with COMPACT arguments; to modify an existing configuration file, use save_config_file with the `edits` parameter (small find/replace operations) — NEVER retype the whole file. If you were instead finishing your final answer, briefly summarize what was cut off.",
						},
					],
				};
				if (stateless) {
					transientItems = [truncationNudge];
				} else {
					input = [truncationNudge];
				}
				continueLoop = true;
				continue;
			}

			// Process function calls
			for (const fc of functionCalls) {
				const outItems = await processFunctionCall(fc, {
					client,
					message,
					userId,
					threadAuthorIds,
					say,
					vectorStoreIds,
					provider,
					knowledgeBase,
					fileTracking: {
						uploadedFiles: fileManager.uploadedFilesThisTurn,
						codeFileIds: fileManager.codeFileIds,
						codeContainerFiles: fileManager.codeContainerFiles,
						sandboxFiles: fileManager.sandboxFiles,
					},
					logger,
				});

				logger.info?.("Executed function call", {
					iteration: loopIteration,
					name: fc?.name,
					call_id: fc?.call_id,
					outItemCount: outItems?.length || 0,
				});

				// A successful reaction is a deliberate user-visible acknowledgment
				// (rule 11 allows an emoji-only response): remember it so a turn
				// that ends without text is not treated as a failed answer
				if (fc?.name === "slack_add_reaction") {
					try {
						if (JSON.parse(outItems[0]?.output || "{}")?.ok === true) {
							reactedViaTool = true;
						}
					} catch {
						/* malformed output: treat as not reacted */
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
				const onlySideEffects = functionCalls.every((fc) => SIDE_EFFECT_TOOLS.has(fc?.name));
				if (hadText && onlySideEffects) {
					// The visible answer was already streamed and the remaining tool
					// results carry no information — an extra turn would only make the
					// model repeat itself or narrate its tool calls in Slack. Stop here.
					logger.info?.(
						"Answer already delivered; skipping extra model turn for side-effect tool results",
						{ iteration: loopIteration, tools: functionCalls.map((fc) => fc?.name) }
					);
					continueLoop = false;
				} else {
					continueLoop = true;
					if (hadText) {
						// The turn's streamed text was an interim note (rule 13) or a partial
						// answer alongside data fetching: continue, but tell the model its
						// message is already posted so it doesn't repeat it
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
					knowledgeBaseWritable,
					configEditingAllowed,
				});
				logger.debug?.("Rebuilt tools array with updated code_interpreter files", {
					codeFileCount: fileManager.codeFileIds.size,
					files: Array.from(fileManager.codeContainerFiles.values()),
				});
			}

			if (!stateless) {
				continueLoop = input.length > 0;
			}

			// A requester message that arrived during this turn (typically while
			// the final answer was streaming) keeps the run alive: the next
			// iteration injects it and the model addresses it in this thread run
			if (!continueLoop && hasPending(inboxKey, isFromRequester)) {
				logger.info?.("[LOOP] Queued message(s) from the requester; continuing the run");
				continueLoop = true;
			}
		} while (continueLoop);

		logger.debug?.("Exiting loop: no tool outputs to feed back", {
			iterations: loopIteration,
			responseIdFromFinalTurn,
		});

		// Persist the conversation for stateless providers
		if (stateless) {
			setConversation(storeKey, [...statelessHistory, ...appendedCurrentItems, ...turnItems]);
		}

		if (hitIterationLimit) {
			await say({
				text: "I've been running tools in circles for too long. Stopping here — narrow the question and try again. 😮‍💨",
			});
			return;
		}

		// Handle final response
		if (stateless) {
			if (!anyTextStreamed) {
				if (lastFullText) {
					await say({ text: lastFullText });
				} else if (!reactedViaTool) {
					// No text AND no reaction: the turn produced nothing user-visible.
					// (A reaction-only response is a legitimate rule-11 answer.)
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
					promptVersion: chainPromptVersion,
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
		// Slack Web API failure (e.g. transient "fatal_error"): the AI provider
		// was not involved — log and report it as what it is
		if (isSlackApiError(e)) {
			logger.error("Slack API error during response handling", {
				code: e?.code,
				slackError: e?.data?.error,
				message: e?.message,
			});
			try {
				await say({ text: "Slack hiccuped mid-request. Not my fault, for once. Try again. 🤷" });
			} catch {
				/* Slack is having a bad day; nothing more to do */
			}
			return;
		}

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
 * Append the current message (preceded by a user-context system note) to input.
 *
 * With priorHistory (stateless providers), the context note is skipped when the
 * history already carries an identical one: repeating it would both waste
 * tokens and, once persisted, change the token stream of the replayed history
 * — breaking the inference server's prefix cache for everything after it.
 *
 * @returns {Promise<Array>} The items appended to input (persisted by stateless callers)
 */
async function appendCurrentMessage({
	input,
	message,
	userProfile,
	userDisplayName,
	uploadOnce,
	slackAppContext,
	filesUnsupported = false,
	priorHistory = null,
	configAdminNote = null,
}) {
	// A bare attachment arrives with empty text: the files are the message
	const contentItems = message.text ? [{ type: "input_text", text: message.text }] : [];

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

	// Never send an empty user message (rejected by the backends). Content can
	// end up empty for a bare attachment whose file produced no content item —
	// either it lives elsewhere (OpenAI code_interpreter files) or it failed.
	if (contentItems.length === 0) {
		contentItems.push({
			type: "input_text",
			text: "[The user sent one or more file attachments without any message text.]",
		});
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
	if (configAdminNote) {
		userContextParts.push(configAdminNote);
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
	const contextNoteText = userContextParts.join("\n");

	// Skip the note when the replayed history already ends with an identical
	// one (same user, same context). A different requesting user or changed
	// Slack context produces a different text and is appended normally.
	const lastContextNote = Array.isArray(priorHistory)
		? priorHistory.findLast(
				(item) =>
					item?.role === "system" &&
					item?.content?.[0]?.type === "input_text" &&
					item.content[0].text.includes("User's Slack ID:")
			)
		: null;

	const appended = [];
	if (lastContextNote?.content?.[0]?.text !== contextNoteText) {
		appended.push({
			role: "system",
			content: [{ type: "input_text", text: contextNoteText }],
		});
	}
	appended.push({ role: "user", content: contentItems });

	input.push(...appended);
	return appended;
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
	promptVersion,
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
							? openaiContextMetadata({
									responseId,
									uploadedFiles: fileManager.uploadedFilesThisTurn,
									promptVersion,
								})
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
						payload.metadata = openaiContextMetadata({
							responseId: seenResponseId,
							uploadedFiles: fileManager.uploadedFilesThisTurn,
							promptVersion,
						});
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
	promptVersion,
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
					metadata: openaiContextMetadata({
						responseId: responseIdFromFinalTurn,
						uploadedFiles: uploadedFilesThisTurn,
						promptVersion,
					}),
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
					metadata: openaiContextMetadata({
						responseId: polled?.id || responseIdFromFinalTurn,
						uploadedFiles: uploadedFilesThisTurn,
						promptVersion,
					}),
				});
				return;
			}
		}

		await suggestSummarizeNow();
		await say?.({
			text: "​",
			metadata: openaiContextMetadata({
				responseId: responseIdFromFinalTurn,
				uploadedFiles: uploadedFilesThisTurn,
				promptVersion,
			}),
		});
	} catch (err) {
		logger?.warn?.("Background recovery failed", { err: String(err) });
		await suggestSummarizeNow();
		await say?.({
			text: "​",
			metadata: openaiContextMetadata({
				responseId: responseIdFromFinalTurn,
				uploadedFiles: uploadedFilesThisTurn,
				promptVersion,
			}),
		});
	}
}
