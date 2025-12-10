import { feedbackBlock } from "../listeners/views/feedback_block.js";
import { openai, DEFAULT_SYSTEM_CONTENT } from "./index.js";
import { getOpenAiFunctionTools, executeMcpFunctionCall, getMcpServerCount } from './mcp_registry.js';
import { getPromQLTool, executePromQLQuery } from './prometheus.js';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const respond = async ({ client, context, logger, message, getThreadContext, say, setTitle, setStatus, setSuggestedPrompts }) => {

	// Skip non-text or incomplete messages
  if (!('text' in message) || !('thread_ts' in message) || !message.text || !message.thread_ts) return;

  const { channel, thread_ts } = message;
  const { userId, teamId } = context;

  const userDisplayName = `<@${userId}>`;
  logger.debug(`Processing message in thread ${thread_ts} from ${userDisplayName}: ${message.text}`);
  logger.debug('Context:', { context });

  try {
    // Track the last seen response id across turns for recovery in catch
    let lastSeenResponseId = null;
    // Collect citations seen during streaming (if any) for later Slack post-processing
    const streamCitationMap = new Map();
    async function suggestSummarizeNow() {
      const payload = {
        title: 'Pfffff... I\'m tired of this...',
        prompts: [
          {
            title: '📝 Oh come on!',
            message: 'M8B, summarize now.',
          },
        ],
      };
      if (typeof setSuggestedPrompts === 'function') {
        try { await setSuggestedPrompts(payload); } catch (e) { logger.warn?.('setSuggestedPrompts failed', { e: String(e) }); }
      } else if (say) {
        // Fallback if suggestions API is unavailable
        await say({ text: 'I\'m tired of this... Say the magic word.' });
      }
    }

    // --- OpenAI Response helpers (status-aware) ---
    async function pollUntilTerminal(id, { intervalMs = 800, maxMs = 180000 } = {}) {
      const start = Date.now();
      let r = await openai.responses.retrieve(id);
      while (r?.status === 'queued' || r?.status === 'in_progress') {
        if (Date.now() - start > maxMs) break;
        await new Promise(s => setTimeout(s, intervalMs));
        r = await openai.responses.retrieve(id);
      }
      return r; // completed | incomplete | failed | cancelled | expired | undefined
    }

    function getTextFromResponse(r) {
      try {
        if (!r) return '';
        const out = r.output || r.outputs || [];
        const parts = [];
        for (const item of out) {
          // Responses API commonly returns { type: 'output_text', text: '...' }
          if (item?.type === 'output_text' && typeof item?.text === 'string') {
            parts.push(item.text);
            continue;
          }
          // Try assistant-style content arrays
          const content = item?.content || [];
          for (const c of content) {
            if ((c.type === 'text' || c.type === 'output_text') && typeof c?.text === 'string') parts.push(c.text);
            if (typeof c?.text?.value === 'string') parts.push(c.text.value);
          }
        }
        const text = parts.join(' ').trim();
        return text || '';
      } catch {
        return '';
      }
    }

    async function continueIfIncomplete(r, { boostFactor = 2, maxOut = 4000 } = {}) {
      if (!r || r.status !== 'incomplete') return null;
      const extra = Math.min(Math.max(((r.usage?.output_tokens) ?? 0) * boostFactor, 512), maxOut);
      return openai.responses.create({
        previous_response_id: r.id,
        input: [{ role: 'system', content: [{ type: 'input_text', text: 'Continue the answer. Keep it concise for Slack.' }] }],
        max_output_tokens: extra,
        tool_choice: 'none',
        background: true
      });
    }

    async function recoverFromTerminated(latestResponseId) {
      try {
        if (!latestResponseId) return null;
        const final = await pollUntilTerminal(latestResponseId);
        if (final?.status === 'completed') return final;
        if (final?.status === 'incomplete') {
          const cont = await continueIfIncomplete(final);
          if (cont?.id) return pollUntilTerminal(cont.id);
        }
        return final;
      } catch (err) {
        logger.warn?.('recoverFromTerminated failed', { err: String(err) });
        return null;
      }
    }

    // Estimate rough token count for input (4 chars ~= 1 token as a rough heuristic)
    function estimateTokenCount(inputItems) {
      let chars = 0;
      for (const item of inputItems || []) {
        const content = item?.content || [];
        for (const c of content) {
          if (c?.text) chars += String(c.text).length;
          // Files/images count as ~1000 tokens each roughly
          if (c?.type === 'input_image' || c?.type === 'input_file') chars += 4000;
        }
      }
      return Math.ceil(chars / 4);
    }

    // Summarize older conversation history to reduce context size
    async function summarizeConversationHistory(inputItems, keepRecentCount = 4) {
      // Split input into system prompts, older messages, and recent messages
      const systemItems = [];
      const conversationItems = [];

      for (const item of inputItems || []) {
        if (item?.role === 'system' && conversationItems.length === 0) {
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
        const role = item?.role || 'unknown';
        const content = item?.content || [];
        for (const c of content) {
          if (c?.text) {
            olderTexts.push(`[${role}]: ${c.text}`);
          } else if (c?.type === 'input_image') {
            olderTexts.push(`[${role}]: [attached image]`);
          } else if (c?.type === 'input_file') {
            olderTexts.push(`[${role}]: [attached file: ${c.filename || 'unknown'}]`);
          }
        }
      }

      if (olderTexts.length === 0) {
        return [...systemItems, ...recentItems];
      }

      console.log(`[Context] Summarizing ${olderItems.length} older messages to reduce context size...`);

      try {
        // Use a quick summarization call
        const summaryResponse = await openai.responses.create({
          model: 'gpt-4o-mini',
          input: [
            {
              role: 'system',
              content: [{ type: 'input_text', text: 'Summarize the following conversation history concisely, preserving key facts, decisions, technical details, and any unresolved issues. Keep it under 500 words. Output only the summary, no preamble.' }]
            },
            {
              role: 'user',
              content: [{ type: 'input_text', text: olderTexts.join('\n\n') }]
            }
          ],
          max_output_tokens: 1000,
        });

        const summaryText = getTextFromResponse(summaryResponse) || 'Previous conversation occurred but could not be summarized.';
        console.log(`[Context] Conversation summarized to ${summaryText.length} chars`);

        // Build new input with summary
        return [
          ...systemItems,
          {
            role: 'system',
            content: [{ type: 'input_text', text: `**Summary of earlier conversation:**\n${summaryText}` }]
          },
          ...recentItems
        ];
      } catch (e) {
        console.error('[Context] Failed to summarize conversation:', e);
        // Fallback: just use system + recent items
        return [...systemItems, ...recentItems];
      }
    }

    // Check if an error is a context window overflow error
    function isContextWindowError(e) {
      const msg = String(e?.message || '').toLowerCase();
      const type = String(e?.type || '').toLowerCase();
      return (
        msg.includes('context window') ||
        msg.includes('exceeds') ||
        msg.includes('too many tokens') ||
        (type === 'invalid_request_error' && e?.param === 'input')
      );
    }

    await setTitle(message.text);
    await setStatus({
      status: 'thinking...',
      loading_messages: [
        'First, my coffee...',
        'Pfffff...',
        "Okay, let's hack into Sentry's network...",
        "I'll probably need MetricsHub! ❤️",
        'Stop looking at me, freak!',
      ],
    });

    // Helper: download a Slack file and upload to OpenAI as user_data; returns { contentItem|null, fileId }
    async function slackFileToOpenAIContent(file) {
      const url = file.url_private_download || file.url_private;
      if (!url) return null;
      const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'm8b-'));
      const fileName = file.name || `slack-file-${file.id || Date.now()}`;
      const tmpPath = path.join(tmpDir, fileName);
      const headers = {
        Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
        Accept: '*/*',
        'User-Agent': 'm8b-slackbot/1.0',
      };
      // Use manual redirect to preserve Authorization across domains
      let res = await fetch(url, { headers, redirect: 'manual', cache: 'no-store' });
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        const loc = res.headers.get('location');
        res = await fetch(loc, { headers, cache: 'no-store' });
      }
      if (!res.ok) throw new Error(`Slack file download failed (${res.status})`);
      const contentType = res.headers.get('content-type') || '';
      if (contentType.includes('text/html')) {
        // Likely got a sign-in page due to missing scope or stripped auth
        throw new Error('Slack returned HTML instead of file bytes; check files:read scope and token access');
      }
      const ab = await res.arrayBuffer();
      await fsp.writeFile(tmpPath, Buffer.from(ab));
      const uploaded = await openai.files.create({ file: fs.createReadStream(tmpPath), purpose: 'user_data' });
      const mimetype = file.mimetype || '';
      const lower = (fileName || '').toLowerCase();
      if (mimetype.startsWith('image/')) {
        return { contentItem: { type: 'input_image', detail: 'auto', file_id: uploaded.id }, fileId: uploaded.id };
      }
      const isPdf = mimetype === 'application/pdf' || lower.endsWith('.pdf');
      if (isPdf) {
        return { contentItem: { type: 'input_file', file_id: uploaded.id }, fileId: uploaded.id };
      }
      // Other types are for code_interpreter only
      return { contentItem: null, fileId: uploaded.id };
    }
    // to let OpenAI retrieve past context (so we don't need to send all past messages)
    const thread = await client.conversations.replies({
      channel, ts: thread_ts, include_all_metadata: true, limit: 15
    });
    const msgs = thread.messages || [];

    // Gather previously uploaded OpenAI file IDs from our earlier bot messages to avoid re-uploads
    const previousUploads = new Map(); // slack_file_id -> openai_file_id
    for (const m of msgs) {
      const p = m?.metadata?.event_payload;
      if (m?.metadata?.event_type === 'openai_context' && p && Array.isArray(p.uploaded_files)) {
        for (const u of p.uploaded_files) {
          if (u?.slack_file_id && u?.openai_file_id) previousUploads.set(u.slack_file_id, u.openai_file_id);
        }
      }
    }

  // Upload all files from the entire thread once per call; collect non-image/PDF ids for code_interpreter
  const fileUploadCache = new Map(); // key -> { contentItem, fileId }
  const codeFileIds = new Set();
  const codeContainerFiles = new Map(); // openai_file_id -> filename
  const uploadedFilesThisTurn = [];
    const uploadOnce = async (f) => {
      const key = f.id || f.url_private_download || f.url_private || f.permalink || `${f.name}-${f.timestamp || ''}`;
      if (fileUploadCache.has(key)) return fileUploadCache.get(key);
      try {
        // Reuse previously uploaded file id if available
        const reused = previousUploads.get(f.id);
        if (reused) {
          const mimetype = f.mimetype || '';
          const lower = (f.name || '').toLowerCase();
          let contentItem = null;
          if (mimetype.startsWith('image/')) contentItem = { type: 'input_image', detail: 'auto', file_id: reused };
          else if (mimetype === 'application/pdf' || lower.endsWith('.pdf')) contentItem = { type: 'input_file', file_id: reused, filename: f.name };
          // non-image/PDF goes to code interpreter
          if (!contentItem) {
            codeFileIds.add(reused);
            codeContainerFiles.set(reused, f.name || 'file');
          }
          const res = { contentItem, fileId: reused };
          fileUploadCache.set(key, res);
          return res;
        }

        const res = await slackFileToOpenAIContent(f);
        if (res && !res.contentItem && res.fileId) {
          codeFileIds.add(res.fileId);
          codeContainerFiles.set(res.fileId, f.name || 'file');
        }
        if (res && res.fileId) {
          uploadedFilesThisTurn.push({
            slack_file_id: f.id,
            openai_file_id: res.fileId,
            mimetype: f.mimetype,
            filename: f.name,
            size: f.size,
          });
        }
        fileUploadCache.set(key, res);
        return res;
      } catch (err) {
        logger.debug?.('Upload failed for Slack file', { name: f?.name, err: String(err) });
        return null;
      }
    };
    for (const m of msgs) {
      const files = Array.isArray(m.files) ? m.files : [];
      for (const f of files) {
        await uploadOnce(f);
      }
    }

    // Find the most recent bot message that carries openai_context metadata.
    // Search from the end of the messages array (latest first).
    let lastBotIndex = -1;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      const hasOpenAiMeta = m.metadata?.event_type === 'openai_context' && m.metadata?.event_payload?.response_id;
      const authoredByThisBot = (m.bot_id && context.BOT_ID && m.bot_id === context.BOT_ID) ||
                                (m.user && context.BOT_USER_ID && m.user === context.BOT_USER_ID) ||
                                (m.app_id && context.BOT_ID && m.app_id === context.BOT_ID);
      if (hasOpenAiMeta && (authoredByThisBot || m.bot_id || m.app_id)) {
        lastBotIndex = i;
        break;
      }
    }

    const lastBotMsg = lastBotIndex >= 0 ? msgs[lastBotIndex] : null;
    const previousResponseId = lastBotMsg?.metadata?.event_payload?.response_id || null;
    logger.debug(`Previous response ID: ${previousResponseId}`);

    // Collect any messages that appear AFTER the last bot OpenAI-context message
    // and include them in the input so the model sees what users said since our last reply.
    // Role logic:
    //  - If the message author equals context.userId (the user we're "discussing with"), role='user'
    //  - Otherwise role='system' and prefix with "<@OtherUserId> says: ..."
    const additionalContextInputs = [];
    for (let i = (lastBotIndex + 1) || 0; i < msgs.length; i++) {
      const m = msgs[i];
      // Skip the current incoming message; we'll add it as the final user turn below
      if (!m || m.ts === message.ts) continue;
      const rawText = (m.text || '').trim();
      if (!rawText) continue;

      const authorId = m.user || m.bot_id || m.app_id;
      let role = 'system';
      let text = rawText;
      if (authorId && context.userId && authorId === context.userId) {
        role = 'user';
      } else if (authorId) {
        // Prefix other users' messages so the model knows who said it
        text = `<@${authorId}> says: ${rawText}`;
        role = 'system';
      }

      additionalContextInputs.push({
        role,
        content: [{ type: 'input_text', text }]
      });
    }



    // Run 1 streaming turn. Returns functionCalls and the last response id.
    // - streams reasoning -> setStatus()
    // - streams output -> streamer
    async function streamOnce({ input, tools, tool_choice, previous_response_id }) {
      let newResponseId = null;
      let functionCalls = []; // collected function_call items
      let fullResponseText = '';
      let startedWriting = false;
      let postedFirstLine = false;
      // Streamer provided by Bold SDK for live chat streaming to Slack
      let streamer = null;
      let incompleteReason = null; // capture incomplete reason to decide continuation
      let sawCompleted = false;

      // Diagnostics counters for stream events
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
      // Track unknown event types and their counts
      const unknownEventTypes = Object.create(null);
      const debugMeta = { used_previous_response_id: previous_response_id || null, used_tool_choice: tool_choice || 'auto' };

      // your existing status helpers (reasoningBuf, flushStatus) can be used here
      let reasoningBuf = '';
      let lastStatusAt = 0;
      const MAX_LEN = 50, MAX_ITEMS = 5, STATUS_COOLDOWN_MS = 800;
      const sanitize = (s) => s.replace(/[*_`~]/g, '').replace(/\s+/g, ' ').trim();
      const chunk50 = (s) => {
        const clean = sanitize(s);
        const out = []; let i = 0;
        while (i < clean.length) {
          let end = Math.min(i + MAX_LEN, clean.length);
          if (end < clean.length) {
            const space = clean.lastIndexOf(' ', end);
            if (space > i + 10) end = space;
          }
          out.push(clean.slice(i, end));
          i = end + 1;
        }
        return out;
      };
      let lastSentJson = '';
      async function flushStatus() {
        const now = Date.now();
        if (now - lastStatusAt < STATUS_COOLDOWN_MS) return;
        lastStatusAt = now;
        if (!reasoningBuf.trim()) return;
        const chunks = chunk50(reasoningBuf);
        const tail = chunks.slice(-MAX_ITEMS);
        const payload = JSON.stringify(tail);
        if (payload === lastSentJson) return;
        lastSentJson = payload;
        await setStatus({ status: 'working...', loading_messages: tail });
      }

      // streamer will be created lazily on first output_text.delta so Slack shows "thinking..."

      const stream = await openai.responses.create({
        model: 'gpt-5.1',
        reasoning: { effort: 'medium', summary: 'auto' },
        previous_response_id,
        max_output_tokens: 4000,
        tool_choice: tool_choice ?? 'auto',
        parallel_tool_calls: true,
        tools,
        text: { format: { type: 'text' }, verbosity: 'low' },
        input,
        //metadata: { memory_key: message.thread_ts },
        stream: true,
      });

      let stopResult = null;
      try {
      for await (const evt of stream) {
  if (!newResponseId && evt?.response?.id) { newResponseId = evt.response.id; }
  if (evt?.response?.id) lastSeenResponseId = evt.response.id;



        // reasoning (summary or raw)
        if (!startedWriting && evt.type === 'response.reasoning_summary_text.delta' && evt.delta) {
          evtCounters.reasoning_summary_delta++;
          reasoningBuf += evt.delta; await flushStatus();
        }
        if (!startedWriting && evt.type === 'response.reasoning_text.delta' && evt.delta) {
          evtCounters.reasoning_delta++;
          reasoningBuf += evt.delta; await flushStatus();
        }

        // function-call lifecycle
        if (evt.type === 'response.output_item.added') {
          const it = evt.item;
          if (it?.type === 'function_call') {
            evtCounters.output_item_added_function_call++;
            // seed arguments if missing (SDKs differ)
            functionCalls[evt.output_index] = { ...it, arguments: it.arguments || '' };
          } else if (it?.type === 'output_file') {
            evtCounters.output_item_added_file++;
          } else if (it?.type === 'output_image') {
            evtCounters.output_item_added_image++;
          } else {
            evtCounters.other++;
          }
        }
        if (evt.type === 'response.function_call_arguments.delta') {
          evtCounters.function_call_args_delta++;
          const idx = evt.output_index;
          if (functionCalls[idx]) functionCalls[idx].arguments += (evt.delta || '');
        }
        if (evt.type === 'response.output_item.done') {
          if (evt.item?.type === 'function_call') {
            evtCounters.output_item_done_function_call++;
            // ensure we keep the final shape (includes call_id, name, arguments)
            const idx = evt.output_index;
            const prior = functionCalls[idx] || { arguments: '' };
            functionCalls[idx] = { ...evt.item, arguments: prior.arguments };
          } else {
            evtCounters.other++;
          }
        }

        // output streaming
        if (evt.type === 'response.output_text.delta' && evt.delta) {
          evtCounters.output_text_delta++;
          if (!startedWriting) {
            startedWriting = true;
            // Switch status to writing when first text arrives
            try { await setStatus({ status: 'writing...' }); } catch {}
          }
          fullResponseText += evt.delta;

          // Clean undesirable tokens but DO NOT trim whitespace.
          // Trimming at chunk boundaries can swallow intentional spaces (e.g., after a colon),
          // causing words to collapse together in Slack. Preserve whitespace exactly as streamed.
          const cleaned = evt.delta
            .replace(/\ue200filecite:[^\s]+/g, '')
            .replace(/【】/g, '');
          if (cleaned.length) {
            try {
              // Create streamer on the first actual text chunk so Slack shows the bot as "thinking" until then
              if (!streamer) {
                try {
                  streamer = client.chatStream({
                    channel: channel,
                    recipient_team_id: teamId,
                    recipient_user_id: userId,
                    thread_ts: thread_ts,
                  });
                } catch (err) {
                  logger.debug?.('Failed to create chatStream streamer (will fallback to say)', { err: String(err) });
                  streamer = null;
                }
              }

              if (streamer) {
                await streamer.append({ markdown_text: cleaned });
              } else {
                // Fallback to say() when streamer isn't available
                // Attach metadata once (first posted line) so future turns can reuse files/response id
                const payload = { text: cleaned };
                if (!postedFirstLine && newResponseId) {
                  payload.metadata = {
                    event_type: 'openai_context',
                    event_payload: { response_id: newResponseId, uploaded_files: uploadedFilesThisTurn }
                  };
                  postedFirstLine = true;
                }
                await say(payload);
              }

              // Don't post a metadata-only zero-width message here; we'll attach metadata to the final
              // streamed Slack message after stopping the streamer to avoid extra empty messages.
              // Mark as posted so fallback branches don't try to duplicate metadata handling.
              if (!postedFirstLine && newResponseId) postedFirstLine = true;
            } catch (e) {
              logger.debug?.('Failed to append/say stream chunk', { e: String(e) });
            }
          }
          continue;
        }

        // Terminal/diagnostic events
        if (evt.type === 'response.completed') {
          evtCounters.response_completed++;
          sawCompleted = true;
        } else if (evt.type === 'response.error') {
          evtCounters.response_error++;
          logger.debug?.('OpenAI stream error event', { error: evt.error || null });
        } else if (evt.type === 'response.incomplete') {
          // Model indicates the response is incomplete (e.g., length, tool needs, etc.)
          incompleteReason = evt.reason || evt?.response?.status_reason || 'unknown';
          // Track as unknown type as well; sampler below will include it
          unknownEventTypes['response.incomplete'] = (unknownEventTypes['response.incomplete'] || 0) + 1;
        } else {
          // Count any other events to help us see unknown types
          if (![
            'response.reasoning_summary_text.delta',
            'response.reasoning_text.delta',
            'response.output_item.added',
            'response.function_call_arguments.delta',
            'response.output_item.done',
            'response.output_text.delta',
          ].includes(evt.type)) {
            evtCounters.other++;
            // Sample the unknown event type by name and count occurrences
            if (evt?.type) {
              unknownEventTypes[evt.type] = (unknownEventTypes[evt.type] || 0) + 1;
            } else {
              unknownEventTypes['<no-type>'] = (unknownEventTypes['<no-type>'] || 0) + 1;
            }
          }
        }
      }

      } finally {
        // Ensure streamer is stopped when the OpenAI stream finishes or errors
        try {
          if (streamer && typeof streamer.stop === 'function') stopResult = await streamer.stop();
        } catch (e) {
          logger.debug?.('Failed to stop streamer', { e: String(e) });
        }
      }

      // Attach metadata to the streamed message (if we have a response id and Slack message ts)
      try {
        const msgTs = stopResult?.message?.ts;
        if (msgTs && newResponseId) {
          await client.chat.update({
            channel: channel,
            ts: msgTs,
            metadata: {
              event_type: 'openai_context',
              event_payload: { response_id: newResponseId, uploaded_files: uploadedFilesThisTurn }
            }
          });
        }
      } catch (e) {
        logger.debug?.('Failed to attach metadata to streamed message', { e: String(e) });
      }

      // Final diagnostics
      const unknownTypesSummary = Object.entries(unknownEventTypes)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 25)
        .map(([type, count]) => ({ type, count }));
      const hadText = evtCounters.output_text_delta > 0;
      logger.debug?.('streamOnce summary', {
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

      return { functionCalls: functionCalls.filter(Boolean), responseId: newResponseId, streamer: streamer, hadText, incompleteReason, sawCompleted, fullResponseText, debug: { startedWriting, fullResponseTextLen: fullResponseText.length, evtCounters, unknownEventTypes: unknownTypesSummary, incompleteReason, sawCompleted, ...debugMeta } };
    }

    // Handle large tool outputs by uploading them as JSON files for code_interpreter
    // Returns { output } where output may be the original or a summary with file reference
    const MAX_INLINE_OUTPUT_CHARS = 30000; // ~7500 tokens - outputs smaller than this go inline

    async function handleLargeToolOutput(output, toolName) {
      const outputStr = JSON.stringify(output, null, 2);
      const outputLen = outputStr.length;

      if (outputLen <= MAX_INLINE_OUTPUT_CHARS) {
        // Output is small enough, return inline
        return { output };
      }

      console.log(`[FUNCTION_CALL] Output for ${toolName} is large (${outputLen} chars), uploading as JSON file...`);

      try {
        // Create a temporary JSON file
        const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'm8b-tool-'));
        const timestamp = Date.now();
        const safeToolName = toolName.replace(/[^a-zA-Z0-9_-]/g, '_');
        const fileName = `${safeToolName}_${timestamp}.json`;
        const tmpPath = path.join(tmpDir, fileName);

        // Write the full output as formatted JSON
        await fsp.writeFile(tmpPath, outputStr, 'utf8');

        // Upload to OpenAI
        const uploaded = await openai.files.create({
          file: fs.createReadStream(tmpPath),
          purpose: 'user_data'
        });

        console.log(`[FUNCTION_CALL] Uploaded ${toolName} output as file ${uploaded.id} (${outputLen} chars)`);

        // Track the uploaded file for this turn
        uploadedFilesThisTurn.push({
          tool_output: toolName,
          openai_file_id: uploaded.id,
          size: outputLen
        });

        // Add to codeFileIds so code_interpreter can access it
        codeFileIds.add(uploaded.id);
        codeContainerFiles.set(uploaded.id, fileName);

        // Return a small summary inline with the file reference
        const summaryOutput = {
          ok: output?.ok ?? true,
          dataInFile: true,
          fileId: uploaded.id,
          fileName: fileName,
          originalSize: outputLen,
          hint: `Full ${toolName} output (${outputLen} chars) uploaded as file "${fileName}". Use code_interpreter to read and analyze this JSON file.`,
          // Include a small preview of the data structure
          preview: createOutputPreview(output)
        };

        // Cleanup temp file (async, don't wait)
        fsp.rm(tmpDir, { recursive: true }).catch(() => {});

        return { output: summaryOutput };
      } catch (e) {
        console.error(`[FUNCTION_CALL] Failed to upload ${toolName} output as file:`, e);
        // Fallback: truncate the output
        return { output: truncateOutput(output, MAX_INLINE_OUTPUT_CHARS) };
      }
    }

    // Create a small preview of the output structure for the inline summary
    // Ensures the preview itself doesn't get too large
    const MAX_PREVIEW_CHARS = 5000;

    function createOutputPreview(output) {
      if (!output || typeof output !== 'object') return output;

      const preview = {};

      // Copy simple fields
      for (const [key, value] of Object.entries(output)) {
        if (value === null || typeof value !== 'object') {
          preview[key] = value;
        } else if (Array.isArray(value)) {
          preview[key] = `[Array with ${value.length} items]`;
          // Include first item as sample only if it's small
          if (value.length > 0) {
            const sampleStr = JSON.stringify(value[0]);
            if (sampleStr.length < 500) {
              preview[`${key}_sample`] = value[0];
            } else {
              preview[`${key}_sample`] = '[Sample too large - use code_interpreter to read the file]';
            }
          }
        } else {
          const keys = Object.keys(value);
          preview[key] = `{Object with ${keys.length} keys: ${keys.slice(0, 5).join(', ')}${keys.length > 5 ? '...' : ''}}`;
        }
      }

      // Final safety check - ensure preview isn't too large
      const previewStr = JSON.stringify(preview);
      if (previewStr.length > MAX_PREVIEW_CHARS) {
        return {
          note: 'Preview too large',
          keys: Object.keys(output).slice(0, 20),
          totalKeys: Object.keys(output).length
        };
      }

      return preview;
    }

    // Simple truncation fallback - ensures output never exceeds limit
    const HARD_MAX_OUTPUT_CHARS = 1000000; // 1MB hard limit (well under OpenAI's 10MB)

    function truncateOutput(output, maxChars) {
      const str = JSON.stringify(output);
      if (str.length <= maxChars) return output;

      const truncated = {
        ok: output?.ok ?? true,
        truncated: true,
        originalSize: str.length,
        message: 'Output was too large and has been truncated. The data could not be uploaded as a file.',
        preview: createOutputPreview(output)
      };

      // Safety check - if even the truncated version is too big, strip the preview
      const truncatedStr = JSON.stringify(truncated);
      if (truncatedStr.length > HARD_MAX_OUTPUT_CHARS) {
        return {
          ok: output?.ok ?? true,
          truncated: true,
          originalSize: str.length,
          message: 'Output was too large and has been truncated. The data could not be uploaded as a file.',
          hint: 'Request more specific data to reduce response size.'
        };
      }

      return truncated;
    }

    // Try to parse a value that might be a JSON string (some MCP tools return JSON as string)
    // Recursively handles nested stringified JSON
    function tryParseJsonString(value) {
      if (typeof value === 'string') {
        const trimmed = value.trim();
        // Check if it looks like JSON (starts with { or [)
        if ((trimmed.startsWith('{') && trimmed.endsWith('}')) ||
            (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
          try {
            const parsed = JSON.parse(trimmed);
            // Recursively try to parse in case of nested stringified JSON
            return tryParseJsonString(parsed);
          } catch {
            // Not valid JSON, return as-is
            return value;
          }
        }
        return value;
      }

      if (Array.isArray(value)) {
        return value.map(tryParseJsonString);
      }

      if (value && typeof value === 'object') {
        const result = {};
        for (const [k, v] of Object.entries(value)) {
          result[k] = tryParseJsonString(v);
        }
        return result;
      }

      return value;
    }

    // Run one function call locally and return the next input items to send back.
    async function processFunctionCall(functionCall) {
      const { name, call_id, arguments: argsStr } = functionCall;
      let output = { ok: true };

      console.log(`[FUNCTION_CALL] Processing: ${name} (call_id: ${call_id})`);
      console.log(`[FUNCTION_CALL] Arguments: ${argsStr}`);

      try {
        // Arguments are a JSON string
        const args = argsStr ? JSON.parse(argsStr) : {};

        if (name === 'slack_add_reaction') {
          // slack_add_reaction
          const raw = String(args.emoji || '').trim();
          const emoji = raw.replace(/^:+|:+$/g, '') || 'thumbsup';
          await client.reactions.add({ channel: message.channel, name: emoji, timestamp: message.ts });

        } else if (name === 'slack_add_reply') {
          // slack_add_reply
          const text = String(args.text || '').trim();
          if (text) {
            await say({ markdown_text: text });
          } else {
            logger.debug('slack_add_reply called without text argument');
          }

        } else if (name === 'PromQLQuery') {
          // Prometheus PromQL query
          console.log(`[FUNCTION_CALL] Executing PromQL query`);
          try {
            const res = await executePromQLQuery(args, logger);
            console.log(`[FUNCTION_CALL] PromQL result:`, JSON.stringify(res).slice(0, 500));
            output = res;
          } catch (e) {
            console.error(`[FUNCTION_CALL] PromQL error:`, e);
            output = { ok: false, error: String(e) };
          }

        } else {
          // Delegate to MCP registry for dynamically discovered tools
          console.log(`[FUNCTION_CALL] Delegating to MCP registry: ${name}`);
          try {
            let res = await executeMcpFunctionCall(name, args, logger);
            // Some MCP tools return JSON as a string - try to parse it
            res = tryParseJsonString(res);
            console.log(`[FUNCTION_CALL] MCP result for ${name}:`, JSON.stringify(res).slice(0, 500));
            output = res && typeof res === 'object' ? res : { ok: true, result: res };
          } catch (e) {
            console.error(`[FUNCTION_CALL] MCP error for ${name}:`, e);
            output = { ok: false, error: String(e) };
          }
        }
      } catch (err) {
        console.error(`[FUNCTION_CALL] Error processing ${name}:`, err);
        output = { ok: false, error: String(err) };
      }

      console.log(`[FUNCTION_CALL] Output for ${name}:`, JSON.stringify(output).slice(0, 500));

      // Handle large outputs by uploading them as JSON files for code_interpreter
      const { output: processedOutput } = await handleLargeToolOutput(output, name);

      // Final safety check - ensure we never exceed OpenAI's 10MB limit
      let finalOutputStr = JSON.stringify(processedOutput);
      if (finalOutputStr.length > HARD_MAX_OUTPUT_CHARS) {
        console.warn(`[FUNCTION_CALL] Output still too large after processing (${finalOutputStr.length} chars), applying hard truncation`);
        finalOutputStr = JSON.stringify({
          ok: processedOutput?.ok ?? true,
          error: 'Output exceeded maximum size limit',
          originalSize: finalOutputStr.length,
          hint: 'Request more specific data to reduce response size.'
        });
      }

      // Return the function call output
      return [{
        type: 'function_call_output',
        call_id: call_id,            // CRITICAL: use model-supplied call_id
        output: finalOutputStr
      }];
    }

    // Build tools array (include your other tools too)
    const codeContainerId = process.env.OPENAI_CODE_CONTAINER_ID || process.env.CODE_CONTAINER_ID;
    // Support multiple vector stores via env OPENAI_VECTOR_STORE_IDS (comma-separated)
    // Fallback to OPENAI_VECTOR_STORE_ID for single-id setups.
    const vsFromEnv = (process.env.OPENAI_VECTOR_STORE_IDS || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
    const baseVectorStoreIds = vsFromEnv.length
      ? vsFromEnv
      : (process.env.OPENAI_VECTOR_STORE_ID ? [process.env.OPENAI_VECTOR_STORE_ID] : []);

    // Load MCP server configs from a local, untracked file if present
    let mcpServers = [];
    try {
      const localCfgPath = path.resolve(process.cwd(), 'ai', 'mcp.config.local.js');
      if (fs.existsSync(localCfgPath)) {
        const mod = await import(pathToFileURL(localCfgPath).href);
        const arr = (mod && (mod.default || mod.servers)) || [];
        if (Array.isArray(arr)) mcpServers = arr;
        else logger.warn?.('mcp.config.local.js did not export an array; ignoring.');
      }
    } catch (e) {
      logger.warn?.('Failed to load ai/mcp.config.local.js', { e: String(e) });
    }
    // Backward-compat: if no local config, allow single server via env
    if (!mcpServers.length) {
      const url = process.env.MCP_AGENT_URL;
      const token = process.env.MCP_AGENT_TOKEN;
      if (url && token) mcpServers.push({ server_label: 'm8b-agent-01', server_url: url, token });
    }

    const tools = [
      ...(baseVectorStoreIds.length ? [{
        type: 'file_search',
        vector_store_ids: baseVectorStoreIds,
        max_num_results: 10
      }] : []),
      ...getOpenAiFunctionTools(),
      // Add Prometheus PromQL tool if configured
      ...(getPromQLTool() ? [getPromQLTool()] : []),
      {
        type: "code_interpreter",
        container: { type: "auto", file_ids: Array.from(codeFileIds) },
      },
			{ type: 'web_search_preview' },
      {
        type: 'function',
        name: 'slack_add_reaction',
        description: 'Add a Slack reaction to the user’s last message.',
        parameters: {
          type: 'object',
          properties: {
            emoji: { type: 'string', description: 'Slack emoji shortcode (no colons).' }
          },
          required: ['emoji'],
          additionalProperties: false
        }
      },
      {
        type: 'function',
        name: 'slack_add_reply',
        description: 'Add a Slack reply message in the current thread.',
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'The text (in Slack mrkdwn format) of the reply message.' }
          },
          required: ['text'],
          additionalProperties: false
        }
      }
    ];

      // If no MCP servers configured/valid, notify in logs and warn in Slack
      if (getMcpServerCount() === 0) {
        logger.warn?.('No MetricsHub MCP servers configured. Running without MetricsHub capabilities.');
        try {
          await say({
            text: ':warning: No MetricsHub MCP servers configured. Create ai/mcp.config.local.js or set MCP_AGENT_URL and MCP_AGENT_TOKEN. Running without MetricsHub capabilities.'
          });
        } catch (e) {
          logger.warn?.('Failed to post Slack warning about missing MetricsHub MCP config', { e: String(e) });
        }
      }

      // Warn if no vector stores configured (File Search disabled)
      if (baseVectorStoreIds.length === 0) {
        logger.warn?.('No OpenAI vector stores configured. File Search tool disabled. Set OPENAI_VECTOR_STORE_IDS or OPENAI_VECTOR_STORE_ID.');
      }

    // Initial input (system + user)
    // Build initial input with system messages
    const codeFileNameList = Array.from(codeContainerFiles.values());
    const attachmentGuidance = codeFileNameList.length
      ? `User uploaded files available to code_interpreter: ${codeFileNameList.join(', ')}. Do NOT use File Search for these; read them directly with code_interpreter.`
      : '';
    let input = [
      { role: 'system', content: [{ type: 'input_text', text: DEFAULT_SYSTEM_CONTENT }] },
      ...(attachmentGuidance ? [{ role: 'system', content: [{ type: 'input_text', text: attachmentGuidance }] }] : []),
    ];

    // Include any messages that happened after our last OpenAI-context bot message, with attachments
    // Roles policy for prior turns:
    // - assistant for previous bot messages (text only)
    // - user for previous human messages (current user or others)
    //   * if authored by current user => text = rawText
    //   * if authored by someone else => text = `<@authorId> said: ${rawText}`
    // Files (images, PDFs) are always sent under 'user' role (the Responses API does not allow images under 'system').
    {
      for (let i = (lastBotIndex + 1) || 0; i < msgs.length; i++) {
        const m = msgs[i];
        if (!m || m.ts === message.ts) continue; // skip the current incoming message
        const rawText = (m.text || '').trim();
        const authorId = m.user || m.bot_id || m.app_id;

        // Determine if this message was authored by our bot
        const authoredByBot = (
          (m.bot_id && context.BOT_ID && m.bot_id === context.BOT_ID) ||
          (m.user && context.BOT_USER_ID && m.user === context.BOT_USER_ID) ||
          (m.app_id && context.BOT_ID && m.app_id === context.BOT_ID)
        );

        // 1) Text: assistant for bot, user for humans
        if (rawText) {
          if (authoredByBot) {
            // Assistant role requires output item types (output_text or refusal), not input_text
            input.push({ role: 'assistant', content: [{ type: 'output_text', text: rawText }] });
          } else {
            const textForUser = (authorId && context.userId && authorId === context.userId)
              ? rawText
              : `<@${authorId}> said: ${rawText}`;
            input.push({ role: 'user', content: [{ type: 'input_text', text: textForUser }] });
          }
        }

        // 2) Files (if any) ALWAYS under 'user' role to allow input_image/input_file
        const files = Array.isArray(m.files) ? m.files : [];
        const fileItems = [];
        for (const f of files) {
          const res = await uploadOnce(f);
          if (res?.contentItem) fileItems.push(res.contentItem);
        }
        if (fileItems.length) {
          if (authoredByBot) {
            // Do not include bot attachments as 'assistant' (non-text content is not supported there).
            // Also avoid echoing bot files back as 'user' content.
          } else {
          const preface = (authorId && (!context.userId || authorId !== context.userId))
            ? [{ type: 'input_text', text: `Files from <@${authorId}>:` }]
            : [];
          input.push({ role: 'user', content: [...preface, ...fileItems] });
          }
        }
      }
    }

    // finally include the new incoming user message with any attached files
    {
      const contentItems = [{ type: 'input_text', text: message.text }];
      const files = Array.isArray(message.files) ? message.files : [];
      for (const f of files) {
        const res = await uploadOnce(f);
        if (res?.contentItem) contentItems.push(res.contentItem);
      }
			input.push({ role: 'system', content: [{ type: 'input_text', text: `User name: ${userDisplayName}` }] });
      input.push({ role: 'user', content: contentItems });
    }

    let previous_response_id = previousResponseId || null;
  let streamerToStop = null;
    let responseIdFromFinalTurn = null;
    let loopIteration = 0;
  let anyTextStreamed = false;
  let forceToolChoiceNext = undefined; // can set to 'none' to force text-only
  let sawAnyIncomplete = false;
  let lastFullText = '';
  let contextSummarized = false; // track if we've already summarized to avoid infinite retry

    function summarizeInputItems(items) {
      try {
        return (items || []).map((it, idx) => {
          const types = Array.isArray(it?.content) ? it.content.map(c => c?.type).filter(Boolean) : [];
          const textLens = Array.isArray(it?.content) ? it.content.filter(c => c?.type === 'input_text').map(c => (c.text || '').length) : [];
          const totalText = textLens.reduce((a, b) => a + b, 0);
          return { idx, role: it?.role, types, totalText };
        });
      } catch {
        return [];
      }
    }

    // Pre-flight check: if input is likely too large, proactively summarize
    // GPT-5.1 has ~196k context, but we want to leave room for output and tools
    const estimatedTokens = estimateTokenCount(input);
    const TOKEN_THRESHOLD = 140000; // Leave room for output, tools, etc.
    if (estimatedTokens > TOKEN_THRESHOLD && !contextSummarized) {
      console.log(`[Context] Pre-flight: estimated ${estimatedTokens} tokens exceeds threshold, summarizing...`);
      await setStatus({ status: 'summarizing conversation...' });
      input = await summarizeConversationHistory(input, 6);
      contextSummarized = true;
      console.log(`[Context] After summarization: estimated ${estimateTokenCount(input)} tokens`);
    }

    do {
      loopIteration += 1;
      logger.debug?.('Loop iteration: calling streamOnce', {
        iteration: loopIteration,
        previous_response_id,
        inputCount: input.length,
        inputSummary: summarizeInputItems(input)
      });

      let streamResult;
      try {
        streamResult = await streamOnce({
          input,
          tools,
          previous_response_id,
          tool_choice: forceToolChoiceNext
        });
      } catch (streamError) {
        // Check if this is a context window error and we haven't already tried summarizing
        if (isContextWindowError(streamError) && !contextSummarized) {
          console.log('[Context] Context window exceeded, attempting to summarize and retry...');
          await setStatus({ status: 'conversation too long, summarizing...' });
          input = await summarizeConversationHistory(input, 4);
          contextSummarized = true;
          console.log(`[Context] After summarization: estimated ${estimateTokenCount(input)} tokens`);
          // Retry the streamOnce call with summarized input
          try {
            streamResult = await streamOnce({
              input,
              tools,
              previous_response_id,
              tool_choice: forceToolChoiceNext
            });
          } catch (retryError) {
            // If it still fails, re-throw the error
            throw retryError;
          }
        } else {
          // Not a context window error or already tried summarizing, re-throw
          throw streamError;
        }
      }

      const { functionCalls, responseId, streamer, hadText, incompleteReason, sawCompleted, fullResponseText, debug: streamDebug } = streamResult;

      logger.debug?.('streamOnce returned', {
        iteration: loopIteration,
        responseId,
        functionCallCount: (functionCalls || []).length,
        startedStreamer: !!streamer,
        streamDebug
      });

    if (streamer && !streamerToStop) streamerToStop = streamer; // streamer now always null
  if (responseId) { responseIdFromFinalTurn = responseId; lastSeenResponseId = responseId; }
      if (hadText) anyTextStreamed = true;
  if (incompleteReason) sawAnyIncomplete = true;
  if (fullResponseText) lastFullText = fullResponseText;

      // Prepare next turn
      previous_response_id = responseId || previous_response_id;
      input = [];
      forceToolChoiceNext = undefined;

      // If the model signaled an incomplete response and produced no text and no tool calls,
      // ask it to continue with a text-only turn.
      if (!hadText && (!functionCalls || functionCalls.length === 0) && incompleteReason) {
        logger.debug?.('Response was incomplete; continuing with forced text-only turn', {
          iteration: loopIteration,
          incompleteReason
        });
        input = [{
          role: 'system',
          content: [{ type: 'input_text', text: 'Continue and provide the Slack-visible answer now. Do not call tools.' }]
        }];
        forceToolChoiceNext = 'none';
        // Continue the loop with this new input
        logger.debug?.('Prepared continuation input after response.incomplete', {
          nextInputCount: input.length
        });
        continue;
      }

      // Execute all function calls we just got and push their outputs as inputs
      for (const fc of functionCalls) {
        const outItems = await processFunctionCall(fc);
        logger.debug?.('Executed function call', {
          iteration: loopIteration,
          name: fc?.name,
          call_id: fc?.call_id,
          outItemCount: outItems?.length || 0
        });
        input.push(...outItems);
      }

      logger.debug?.('Post-tool input prepared', {
        iteration: loopIteration,
        nextInputCount: input.length,
        nextInputSummary: summarizeInputItems(input)
      });

      // Loop again only if we produced tool outputs to feed back
    } while (input.length > 0);

    if (input.length === 0) {
      logger.debug?.('Exiting loop: no tool outputs to feed back', {
        iterations: loopIteration,
        finalPreviousResponseId: previous_response_id,
        responseIdFromFinalTurn
      });
    }

    // Finish: we already posted lines via say(). If nothing was streamed, attempt recovery.
    if (responseIdFromFinalTurn) {
      if (!anyTextStreamed) {
        // No lines posted => attempt to recover via status polling/continuation once
        try {
          const final = await pollUntilTerminal(responseIdFromFinalTurn);
          if (final?.status === 'completed') {
            const text = getTextFromResponse(final);
            if (text) {
              await say({
                text,
                metadata: {
                  event_type: 'openai_context',
                  event_payload: { response_id: responseIdFromFinalTurn, uploaded_files: uploadedFilesThisTurn }
                }
              });
            } else {
              await suggestSummarizeNow();
              // still carry metadata with a minimal message
              await say?.({
                text: '\u200B',
                metadata: {
                  event_type: 'openai_context',
                  event_payload: { response_id: responseIdFromFinalTurn, uploaded_files: uploadedFilesThisTurn }
                }
              });
            }
          } else if (final?.status === 'incomplete' && sawAnyIncomplete) {
            const cont = await continueIfIncomplete(final);
            const polled = cont?.id ? await pollUntilTerminal(cont.id) : null;
            const text = getTextFromResponse(polled);
            if (text) {
              await say?.({
                text,
                metadata: {
                  event_type: 'openai_context',
                  event_payload: { response_id: (polled?.id || responseIdFromFinalTurn), uploaded_files: uploadedFilesThisTurn }
                }
              });
            } else {
              await suggestSummarizeNow();
              await say?.({
                text: '\u200B',
                metadata: {
                  event_type: 'openai_context',
                  event_payload: { response_id: (polled?.id || responseIdFromFinalTurn), uploaded_files: uploadedFilesThisTurn }
                }
              });
            }
          } else {
            await suggestSummarizeNow();
            await say?.({
              text: '\u200B',
              metadata: {
                event_type: 'openai_context',
                event_payload: { response_id: responseIdFromFinalTurn, uploaded_files: uploadedFilesThisTurn }
              }
            });
          }
        } catch (err) {
          logger.warn?.('Background recovery failed', { err: String(err) });
          await suggestSummarizeNow();
          await say?.({
            text: '\u200B',
            metadata: {
              event_type: 'openai_context',
              event_payload: { response_id: responseIdFromFinalTurn, uploaded_files: uploadedFilesThisTurn }
            }
          });
        }
      }

      // --- Post-process citations (file_search annotations and filecite markers) ---
      try {
        const final = await pollUntilTerminal(responseIdFromFinalTurn);
        const citationMap = new Map(); // file_id -> filename
        if (final?.output && Array.isArray(final.output)) {
          for (const item of final.output) {
            if (item?.type === 'message') {
              const parts = item.content || [];
              for (const p of parts) {
                const anns = p?.annotations || [];
                for (const a of anns) {
                  if (a?.type === 'file_citation' && a?.file_id) {
                    citationMap.set(a.file_id, a.filename || a.file_id);
                  }
                }
              }
            } else if (item?.type === 'output_text') {
              const anns = item?.annotations || [];
              for (const a of anns) {
                if (a?.type === 'file_citation' && a?.file_id) {
                  citationMap.set(a.file_id, a.filename || a.file_id);
                }
              }
            }
          }
        }

        const originalText = lastFullText || '';
        const hasFileCiteTokens = /\ue200filecite:[^\s]+/g.test(originalText);
        const stripFileCiteTokens = (txt) => txt.replace(/\ue200filecite:[^\s]+/g, '');

        if (citationMap.size > 0 || hasFileCiteTokens) {
          // Merge any annotations captured during streaming with final annotation map
          for (const [k, v] of streamCitationMap.entries()) if (!citationMap.has(k)) citationMap.set(k, v);
          const cleanedText = stripFileCiteTokens(originalText).trim();
          const filenames = Array.from(new Set([...citationMap.values()])).slice(0, 10);

          // Upload up to 3 cited files to Slack via Vector Store file content endpoint
          const uploadedSlackFiles = [];
          const upTo = 3;
          let count = 0;
          const vectorStoreIds = Array.isArray(baseVectorStoreIds) ? baseVectorStoreIds : [];
          if (!vectorStoreIds.length) {
            logger.debug?.('No vector store IDs configured; skipping attachment fetches for citations');
          } else {
            for (const [fileId, filename] of citationMap.entries()) {
              if (count >= upTo) break;
              try {
                // Try each configured vector store until one returns content
                let res = null;
                let usedVs = null;
                for (const vsId of vectorStoreIds) {
                  const url = `https://api.openai.com/v1/vector_stores/${vsId}/files/${fileId}/content`;
                  const attempt = await fetch(url, { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, Accept: '*/*' } });
                  if (attempt.ok) { res = attempt; usedVs = vsId; break; }
                }
                if (res && res.ok) {
                  const contentType = res.headers.get('content-type') || '';
                  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'm8b-src-'));
                  const baseSafeName = filename || `${fileId}.bin`;
                  let finalName = baseSafeName;
                  let fileBuffer;

                  if (contentType.includes('application/json')) {
                    // Vector Store content often returns a JSON page with data[] chunks
                    try {
                      const json = await res.json();
                      const parts = [];
                      const data = Array.isArray(json?.data) ? json.data : [];
                      for (const d of data) {
                        if (typeof d?.text === 'string') parts.push(d.text);
                        else if (typeof d?.value === 'string') parts.push(d.value);
                      }
                      const text = parts.join('\n\n').trim();
                      fileBuffer = Buffer.from(text || '', 'utf8');
                      // Prefer a readable text extension if none was provided
                      const lower = (baseSafeName || '').toLowerCase();
                      const hasKnownExt = /\.(md|markdown|txt|pdf|csv|json|yaml|yml)$/i.test(lower);
                      if (!hasKnownExt) finalName = `${path.parse(baseSafeName).name || fileId}.md`;
                    } catch {
                      // Fallback to binary if parsing failed
                      const ab = await res.arrayBuffer();
                      fileBuffer = Buffer.from(ab);
                    }
                  } else {
                    const ab = await res.arrayBuffer();
                    fileBuffer = Buffer.from(ab);
                  }

                  const tmpPath = path.join(tmpDir, finalName);
                  await fsp.writeFile(tmpPath, fileBuffer);
                  const up = await client.files.uploadV2({ channel_id: channel, thread_ts: thread_ts, file: fs.createReadStream(tmpPath), filename: finalName, title: finalName });
                  if (up?.ok) { uploadedSlackFiles.push(finalName); count += 1; }
                } else {
                  logger.debug?.('Vector store file content fetch failed for all stores', { fileId, vectorStoreIds });
                }
              } catch (e) {
                logger.debug?.('Failed to fetch/upload cited file (vector store content)', { fileId, vectorStoreIds, e: String(e) });
              }
            }
          }

          // Post a short sources line so users see which files were cited
          if (filenames.length) {
            await say?.({ text: `Sources: ${filenames.join(', ')}` });
          }
        }
      } catch (e) {
        logger.debug?.('Citation post-processing skipped/failed', { e: String(e) });
      }
    } else {
      // No response id? log and still end cleanly
      logger.warn('No response ID was received from OpenAI');
    }

  } catch (e) {
    console.error('OpenAI/stream error', {
      message: e?.message,
      status: e?.status,
      request_id: e?.request_id,
      param: e?.param,
      type: e?.type
    });
    // Handle transport aborts gracefully by polling once (avoid surfacing error to user)
    if (String(e?.message || '').toLowerCase().includes('terminated') || String(e?.type || '').toLowerCase().includes('server_error')) {
      try {
        const recovered = await recoverFromTerminated(lastSeenResponseId);
        if (recovered?.status === 'completed') {
          const text = getTextFromResponse(recovered);
          if (text) return await say({ text });
        }
        if (recovered?.status === 'incomplete') {
          const cont = await continueIfIncomplete(recovered);
          const polled = cont?.id ? await pollUntilTerminal(cont.id) : null;
          const text = getTextFromResponse(polled);
          if (text) return await say({ text });
        }
      } catch { /* ignore */ }
      // As a last resort, suggest a quick follow-up prompt instead of posting an error
      await suggestSummarizeNow();
      return;
    }
    // Non-transport errors: surface briefly
    await say({ text: `FFS... 🤦‍♂️ ${e}` });
  }
};
