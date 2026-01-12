/**
 * Function call processing for OpenAI tool calls.
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { executeMcpFunctionCall } from "../mcp_registry.js";
import { executePromQLQuery } from "../prometheus.js";
import { tryParseJsonString } from "../utils/json-parser.js";
import { HARD_MAX_OUTPUT_CHARS } from "../utils/output-handler.js";
import { openai } from "./openai.js";
import { executeWithMiddleware } from "./tool-middleware.js";

/**
 * Process a single function call from OpenAI.
 *
 * @param {Object} functionCall - The function call to process
 * @param {Object} context - Processing context
 * @param {Object} context.client - Slack client
 * @param {Object} context.message - Original Slack message
 * @param {Function} context.say - Say function for replies
 * @param {Array} context.vectorStoreIds - Vector store IDs
 * @param {Object} context.fileTracking - File tracking state
 * @param {Object} context.logger - Logger instance
 * @returns {Promise<Array>} Function call output items
 */
export async function processFunctionCall(functionCall, context) {
	const { name, call_id, arguments: argsStr } = functionCall;
	const { client, message, say, vectorStoreIds, fileTracking, logger } = context;

	logger?.info?.(`[FUNCTION] ${name}`, { call_id: call_id?.slice(-12) });

	let output;

	// Middleware options for caching/pagination/file uploads
	const middlewareOptions = {
		logger,
		openaiClient: openai,
		fileTracking,
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
				output = await handleUpdateKnowledge(args, vectorStoreIds, say);
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
			default:
				output = await executeWithMiddleware(
					name,
					args,
					async (_name, cleanArgs) => handleMcpFunctionCall(_name, cleanArgs, logger),
					middlewareOptions
				);
				break;
		}
	} catch (err) {
		logger?.error?.(`[FUNCTION] Error: ${name}`, { error: err });
		output = { ok: false, error: String(err) };
	}

	// Log summary
	logger?.info?.(`[FUNCTION] ${name} → ${formatOutputSummary(output)}`);

	// Final safety check
	let finalOutputStr = JSON.stringify(output);
	if (finalOutputStr.length > HARD_MAX_OUTPUT_CHARS) {
		logger?.warn?.(`[FUNCTION] Output too large (${finalOutputStr.length} chars)`);
		finalOutputStr = JSON.stringify({
			ok: false,
			error: "Output exceeded maximum size limit",
			hint: "Use smaller maxResults or more specific query parameters.",
		});
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
 * Handle slack_add_reaction function call.
 */
async function handleSlackReaction(args, client, message) {
	const raw = String(args.emoji || "").trim();
	const emoji = raw.replace(/^:+|:+$/g, "") || "thumbsup";

	await client.reactions.add({
		channel: message.channel,
		name: emoji,
		timestamp: message.ts,
	});

	return { ok: true };
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
 * Handle update_knowledge function call.
 */
async function handleUpdateKnowledge(args, vectorStoreIds, say) {
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
					await openai.vectorStores.files.del(existingFileId, {
						vector_store_id: vsId,
					});
					console.log(
						`[update_knowledge] Detached old file ${existingFileId} from vector store ${vsId}`
					);
				} catch (e) {
					console.log(
						`[update_knowledge] Could not detach ${existingFileId} from ${vsId}: ${e.message}`
					);
				}
			}

			// Optionally delete the underlying file
			try {
				await openai.files.delete(existingFileId);
				console.log(`[update_knowledge] Deleted old file object ${existingFileId}`);
			} catch (e) {
				console.log(`[update_knowledge] Could not delete old file ${existingFileId}: ${e.message}`);
			}
		}

		// Upload the new file
		const uploaded = await openai.files.create({
			file: fs.createReadStream(tmpPath),
			purpose: "assistants",
		});
		console.log(`[update_knowledge] Uploaded file ${uploaded.id}: ${fileName}`);

		// Add to all configured vector stores
		const attachResults = [];
		for (const vsId of validVectorStoreIds) {
			try {
				await openai.vectorStores.files.create(vsId, { file_id: uploaded.id });
				console.log(`[update_knowledge] Attached file ${uploaded.id} to vector store ${vsId}`);
				attachResults.push({ vsId, ok: true });
			} catch (e) {
				console.error(`[update_knowledge] Failed to attach file to vector store ${vsId}:`, e);
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
