import { feedbackBlock } from "../listeners/views/feedback_block.js";
import { openai, DEFAULT_SYSTEM_CONTENT } from "./index.js";
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

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
        reasoning: { effort: 'low', summary: 'auto' },
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

    // Run one function call locally and return the next input items to send back.
    async function processFunctionCall(functionCall) {
      const { name, call_id, arguments: argsStr } = functionCall;
      let output = { ok: true };

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

        } else {
          output = { ok: false, error: `Unhandled tool: ${name}` };
        }
      } catch (err) {
        output = { ok: false, error: String(err) };
      }

      // This is the Responses API way to return tool output without submitToolOutputs:
      // feed a new input with type 'function_call_output'
      return [{
        type: 'function_call_output',
        call_id: call_id,            // CRITICAL: use model-supplied call_id
        output: JSON.stringify(output)
      }];
    }

    // Build tools array (include your other tools too)
    const codeContainerId = process.env.OPENAI_CODE_CONTAINER_ID || process.env.CODE_CONTAINER_ID;
    const baseVectorStoreIds = ['vs_6901f2d030b48191ba844f57b7b703ff'];
      const MCP_AGENT_TOKEN = process.env.MCP_AGENT_TOKEN;
      const MCP_AGENT_URL = process.env.MCP_AGENT_URL;
      const includeMcp = !!(MCP_AGENT_TOKEN && MCP_AGENT_URL);
      const mcpHeaders = includeMcp ? { Authorization: `Bearer ${MCP_AGENT_TOKEN}` } : undefined;
    const tools = [
      {
        type: 'file_search',
        vector_store_ids: baseVectorStoreIds,
        max_num_results: 10
      },
        ...(includeMcp ? [{
          type: 'mcp',
          server_label: 'MetricsHub',
          server_url: MCP_AGENT_URL,
          require_approval: 'never',
          headers: mcpHeaders
        }] : []),
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

      // If MetricsHub MCP is not configured, notify in logs and warn in Slack
      if (!includeMcp) {
        logger.warn?.('MetricsHub MCP is not configured. Running without MetricsHub capabilities.', {
          haveToken: !!MCP_AGENT_TOKEN,
          haveUrl: !!MCP_AGENT_URL
        });
        try {
          await say({
            text: ':warning: MetricsHub MCP is not configured (set MCP_AGENT_URL and MCP_AGENT_TOKEN). Running without MetricsHub capabilities.'
          });
        } catch (e) {
          logger.warn?.('Failed to post Slack warning about missing MetricsHub MCP config', { e: String(e) });
        }
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
    {
      for (let i = (lastBotIndex + 1) || 0; i < msgs.length; i++) {
        const m = msgs[i];
        if (!m || m.ts === message.ts) continue; // skip the current incoming message
        const rawText = (m.text || '').trim();
        const authorId = m.user || m.bot_id || m.app_id;
        let role = 'system';
        let text = rawText;
        if (authorId && context.userId && authorId === context.userId) {
          role = 'user';
        } else if (authorId && rawText) {
          text = `<@${authorId}> says: ${rawText}`;
        }

        const contentItems = [];
        if (text) contentItems.push({ type: 'input_text', text });
        const files = Array.isArray(m.files) ? m.files : [];
        for (const f of files) {
          const res = await uploadOnce(f);
          if (res?.contentItem) contentItems.push(res.contentItem);
        }
        if (contentItems.length) input.push({ role, content: contentItems });
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

    do {
      loopIteration += 1;
      logger.debug?.('Loop iteration: calling streamOnce', {
        iteration: loopIteration,
        previous_response_id,
        inputCount: input.length,
        inputSummary: summarizeInputItems(input)
      });

      const { functionCalls, responseId, streamer, hadText, incompleteReason, sawCompleted, fullResponseText, debug: streamDebug } = await streamOnce({
        input,
        tools,
        previous_response_id,
        tool_choice: forceToolChoiceNext
      });

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
          const vectorStoreId = (Array.isArray(baseVectorStoreIds) && baseVectorStoreIds[0]) || process.env.OPENAI_VECTOR_STORE_ID;
          if (!vectorStoreId) {
            logger.debug?.('No vector store ID available; skipping attachment fetches for citations');
          } else {
            for (const [fileId, filename] of citationMap.entries()) {
              if (count >= upTo) break;
              try {
                const url = `https://api.openai.com/v1/vector_stores/${vectorStoreId}/files/${fileId}/content`;
                const res = await fetch(url, { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, Accept: '*/*' } });
                if (res.ok) {
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
                  logger.debug?.('Vector store file content fetch failed', { fileId, vectorStoreId, status: res.status });
                }
              } catch (e) {
                logger.debug?.('Failed to fetch/upload cited file (vector store content)', { fileId, vectorStoreId, e: String(e) });
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
