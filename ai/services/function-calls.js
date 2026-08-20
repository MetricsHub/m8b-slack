/**
 * Function call processing for OpenAI tool calls.
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { executeMcpFunctionCall, getOpenAiFunctionTools } from "../mcp_registry.js";
import { executePromQLQuery } from "../prometheus.js";
import { tryParseJsonString } from "../utils/json-parser.js";
import { HARD_MAX_OUTPUT_CHARS } from "../utils/output-handler.js";
import { openai } from "./openai.js";
import { executeWithMiddleware } from "./tool-middleware.js";
import { executeWebSearch } from "./web-search.js";

/**
 * Process a single function call from the model.
 *
 * @param {Object} functionCall - The function call to process
 * @param {Object} context - Processing context
 * @param {Object} context.client - Slack client
 * @param {Object} context.message - Original Slack message
 * @param {Function} context.say - Say function for replies
 * @param {Array} context.vectorStoreIds - Vector store IDs
 * @param {Object} context.fileTracking - File tracking state
 * @param {import("../providers/index.js").AiProvider} [context.provider] - Active AI provider
 * @param {Object} [context.knowledgeBase] - Local knowledge base (Ollama mode)
 * @param {Object} context.logger - Logger instance
 * @returns {Promise<Array>} Function call output items
 */
export async function processFunctionCall(functionCall, context) {
	const { name, call_id, arguments: argsStr } = functionCall;
	const { client, message, say, vectorStoreIds, fileTracking, provider, knowledgeBase, logger } =
		context;

	logger?.info?.(`[FUNCTION] ${name}`, { call_id: call_id?.slice(-12) });

	let output;

	// Middleware options for caching/pagination/file uploads.
	// Large-output file uploads use the OpenAI Files API and are only enabled
	// when the active provider supports them.
	const providerFileUploads = provider ? provider.capabilities.providerFileUploads : true;
	const middlewareOptions = {
		logger,
		openaiClient: providerFileUploads ? openai : null,
		fileTracking: providerFileUploads ? fileTracking : null,
	};

	try {
		const args = argsStr ? JSON.parse(argsStr) : {};

		// Route to appropriate handler with middleware for pagination/caching
		switch (name) {
			// Internal Slack functions - no caching needed
			case "slack_add_reaction":
				output = await handleSlackReaction(args, client, message);
				break;

			case "slack_add_reply":
				output = await handleSlackReply(args, say, logger);
				break;

			case "update_knowledge":
				output = knowledgeBase
					? await handleLocalUpdateKnowledge(args, knowledgeBase, say, logger)
					: await handleUpdateKnowledge(args, vectorStoreIds, say, logger);
				break;

			// Application-side web search (Ollama mode)
			case "web_search":
				output = await executeWebSearch(args, logger);
				break;

			// Local knowledge base retrieval (Ollama mode)
			case "search_knowledge_base":
				output = knowledgeBase
					? await knowledgeBase.search(args?.query, args?.topK)
					: { ok: false, error: "Knowledge base search is not available for this provider" };
				break;

			// Prometheus - use middleware for potential large results
			case "PromQLQuery":
				output = await executeWithMiddleware(
					name,
					args,
					async (_name, cleanArgs) => executePromQLQuery(cleanArgs, logger),
					middlewareOptions
				);
				break;

			// MCP functions - use middleware for caching and pagination
			default: {
				const knownMcpTools = new Set(getOpenAiFunctionTools().map((tool) => tool.name));
				if (!knownMcpTools.has(name)) {
					logger?.warn?.(`[FUNCTION] Unknown function requested: ${name}`);
					output = { ok: false, error: `Unknown function: ${name}` };
					break;
				}

				output = await executeWithMiddleware(
					name,
					args,
					async (_name, cleanArgs) => handleMcpFunctionCall(_name, cleanArgs, logger),
					middlewareOptions
				);
				break;
			}
		}
	} catch (err) {
		logger?.error?.(`[FUNCTION] Error: ${name}`, { error: err });
		output = { ok: false, error: String(err) };
	}

	// Log summary
	logger?.info?.(`[FUNCTION] ${name} → ${formatOutputSummary(output)}`);

	// Final safety checks. String outputs (telemetry rendered as Markdown
	// tables by the middleware) go out raw — JSON-escaping them would re-add
	// the overhead the Markdown rendering removed.
	let finalOutputStr = typeof output === "string" ? output : JSON.stringify(output);
	if (finalOutputStr.length > HARD_MAX_OUTPUT_CHARS) {
		logger?.warn?.(`[FUNCTION] Output too large (${finalOutputStr.length} chars)`);
		finalOutputStr = JSON.stringify({
			ok: false,
			error: "Output exceeded maximum size limit",
			hint: "Use smaller maxResults or more specific query parameters.",
		});
	}

	// Provider-specific inline cap: small-context providers (Ollama at 32K)
	// cannot absorb tool outputs sized for OpenAI's context window. Keep a
	// truncated payload so the model can still extract the key facts.
	const maxToolOutputChars = provider?.maxToolOutputChars;
	if (maxToolOutputChars && finalOutputStr.length > maxToolOutputChars) {
		logger?.warn?.(
			`[FUNCTION] ${name} output (${finalOutputStr.length} chars) exceeds the provider inline cap (${maxToolOutputChars}); truncating`
		);
		const truncationHint =
			"Tool output was TRUNCATED to fit the local model's context window; data for some requested items may be missing entirely. Do NOT guess, assume, or invent values for items you cannot see in the data above. Either call this tool again for ONE host/item at a time to get complete data, or explicitly tell the user that data is missing.";
		if (typeof output === "string") {
			// Markdown outputs truncate as plain text: JSON-wrapping would
			// escape every newline and quote, inflating the payload and making
			// the surviving tables much harder for the model to read
			const originalChars = finalOutputStr.length;
			const kept = finalOutputStr.slice(0, Math.max(maxToolOutputChars - 600, 1000));
			finalOutputStr = `${kept}\n\n[TRUNCATED: showing ${kept.length} of ${originalChars} chars. ${truncationHint}]`;
		} else {
			finalOutputStr = JSON.stringify({
				ok: output?.ok ?? true,
				truncated: true,
				originalChars: finalOutputStr.length,
				data: finalOutputStr.slice(0, Math.max(maxToolOutputChars - 500, 1000)),
				hint: truncationHint,
			});
		}
	}

	return [
		{
			type: "function_call_output",
			call_id: call_id,
			output: finalOutputStr,
		},
	];
}

/**
 * Format output for logging.
 */
function formatOutputSummary(output) {
	// Markdown-rendered outputs are multiline; keep the log entry on one line
	if (typeof output === "string") {
		const firstLine = output.split("\n", 1)[0].slice(0, 60);
		return `markdown, ${output.length} chars: ${firstLine}`;
	}

	if (!output || typeof output !== "object") {
		return String(output).slice(0, 80);
	}

	const parts = [];
	if (output.ok === true) parts.push("✓");
	else if (output.ok === false) parts.push("✗");

	if (output.error) return `✗ ${String(output.error).slice(0, 80)}`;

	if (output.hosts) {
		const count = typeof output.hosts === "object" ? Object.keys(output.hosts).length : 0;
		parts.push(`${count} hosts`);
	}
	if (output._pagination?.total) {
		parts.push(`(${output._pagination.returned}/${output._pagination.total})`);
	}

	return parts.length > 0 ? parts.join(" ") : "ok";
}

/**
 * Common emoji names models emit that are not valid Slack shortcodes.
 */
const EMOJI_ALIASES = {
	facepalm: "person_facepalming",
	face_palm: "person_facepalming",
	shrug: "person_shrugging",
	thumbs_up: "thumbsup",
	"thumbs-up": "thumbsup",
	thumbs_down: "thumbsdown",
	check: "white_check_mark",
	party: "tada",
};

/**
 * Handle slack_add_reaction function call.
 */
async function handleSlackReaction(args, client, message) {
	const raw = String(args.emoji || "").trim();
	const cleaned = raw.replace(/^:+|:+$/g, "").toLowerCase() || "thumbsup";
	const emoji = EMOJI_ALIASES[cleaned] || cleaned;

	try {
		await client.reactions.add({
			channel: message.channel,
			name: emoji,
			timestamp: message.ts,
		});
		return { ok: true };
	} catch (e) {
		if (e?.data?.error === "invalid_name") {
			return {
				ok: false,
				error: `"${emoji}" is not a valid Slack emoji shortcode`,
				hint: "Use a standard shortcode such as eyes, thumbsup, tada, person_facepalming, or person_shrugging. Do not retry more than once.",
			};
		}
		if (e?.data?.error === "already_reacted") {
			return { ok: true, note: "Reaction was already present" };
		}
		throw e;
	}
}

/**
 * Handle slack_add_reply function call.
 */
async function handleSlackReply(args, say, logger) {
	const text = String(args.text || "").trim();

	if (text) {
		await say({ markdown_text: text });
		return { ok: true };
	}

	logger?.debug?.("slack_add_reply called without text argument");
	return { ok: false, error: "No text provided" };
}

/**
 * Handle update_knowledge against the local knowledge base (Ollama mode).
 */
async function handleLocalUpdateKnowledge(args, knowledgeBase, say, logger) {
	const content = String(args.content || "").trim();
	const title = String(args.title || "knowledge-entry").trim();
	const replaceDocId = args.fileId ? String(args.fileId).trim() : undefined;

	if (!content) {
		return { ok: false, error: "Content is required for update_knowledge" };
	}

	const result = await knowledgeBase.addDocument({ title, content, replaceDocId });

	if (result.ok) {
		await say({ text: `:brain: Knowledge updated: "${title}"` });
		return {
			ok: true,
			message: `Knowledge entry "${title}" has been saved to the local knowledge base.`,
			fileId: result.docId,
			fileName: result.file,
			replacedFileId: replaceDocId || null,
		};
	}

	logger?.error?.("[update_knowledge] Local knowledge base write failed", {
		error: result.error,
	});
	return result;
}

/**
 * Handle update_knowledge function call.
 */
async function handleUpdateKnowledge(args, vectorStoreIds, say, logger) {
	const content = String(args.content || "").trim();
	const title = String(args.title || "knowledge-entry").trim();
	const existingFileId = args.fileId ? String(args.fileId).trim() : null;

	if (!content) {
		return { ok: false, error: "Content is required for update_knowledge" };
	}

	const validVectorStoreIds = vectorStoreIds.filter((id) => id && typeof id === "string");

	if (validVectorStoreIds.length === 0) {
		return { ok: false, error: "No Vector Store configured. Cannot update knowledge." };
	}

	try {
		// Create a temporary file with the content
		const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "m8b-knowledge-"));
		const safeTitle = title
			.replace(/[^a-zA-Z0-9_\-\s]/g, "")
			.replace(/\s+/g, "-")
			.slice(0, 100);
		const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
		const fileName = `${safeTitle}-${timestamp}.md`;
		const tmpPath = path.join(tmpDir, fileName);

		// Write content as markdown
		const fullContent = `# ${title}\n\nCreated: ${new Date().toISOString()}\n\n${content}`;
		await fsp.writeFile(tmpPath, fullContent, "utf8");

		// If replacing an existing file, detach it first
		if (existingFileId) {
			for (const vsId of validVectorStoreIds) {
				try {
					await openai.vectorStores.files.delete(existingFileId, {
						vector_store_id: vsId,
					});
					logger?.info?.(
						`[update_knowledge] Detached old file ${existingFileId} from vector store ${vsId}`
					);
				} catch (e) {
					logger?.info?.(
						`[update_knowledge] Could not detach ${existingFileId} from ${vsId}: ${e.message}`
					);
				}
			}

			// Optionally delete the underlying file
			try {
				await openai.files.delete(existingFileId);
				logger?.info?.(`[update_knowledge] Deleted old file object ${existingFileId}`);
			} catch (e) {
				logger?.info?.(
					`[update_knowledge] Could not delete old file ${existingFileId}: ${e.message}`
				);
			}
		}

		// Upload the new file
		const uploaded = await openai.files.create({
			file: fs.createReadStream(tmpPath),
			purpose: "assistants",
		});
		logger?.info?.(`[update_knowledge] Uploaded file ${uploaded.id}: ${fileName}`);

		// Add to all configured vector stores
		const attachResults = [];
		for (const vsId of validVectorStoreIds) {
			try {
				await openai.vectorStores.files.create(vsId, { file_id: uploaded.id });
				logger?.info?.(`[update_knowledge] Attached file ${uploaded.id} to vector store ${vsId}`);
				attachResults.push({ vsId, ok: true });
			} catch (e) {
				logger?.error?.(`[update_knowledge] Failed to attach file to vector store ${vsId}:`, e);
				attachResults.push({ vsId, ok: false, error: e.message });
			}
		}

		// Cleanup temp file
		fsp.rm(tmpDir, { recursive: true }).catch(() => {});

		const successfulStores = attachResults.filter((r) => r.ok).map((r) => r.vsId);

		if (successfulStores.length > 0) {
			await say({ text: `:brain: Knowledge updated: "${title}"` });

			return {
				ok: true,
				message: `Knowledge entry "${title}" has been saved. Indexing will complete in the background.`,
				fileId: uploaded.id,
				fileName: fileName,
				vectorStores: successfulStores,
				replacedFileId: existingFileId || null,
			};
		}

		return {
			ok: false,
			error: "File was uploaded but could not be attached to any Vector Store",
			fileId: uploaded.id,
			attachResults: attachResults,
		};
	} catch (e) {
		return { ok: false, error: String(e) };
	}
}

/**
 * Handle MCP function calls (raw execution, middleware handles caching/pagination).
 */
async function handleMcpFunctionCall(name, args, logger) {
	try {
		let result = await executeMcpFunctionCall(name, args, logger);
		result = tryParseJsonString(result);
		return result && typeof result === "object" ? result : { ok: true, result: result };
	} catch (e) {
		logger?.error?.(`[MCP] Error for ${name}:`, { error: e });
		return { ok: false, error: String(e) };
	}
}
