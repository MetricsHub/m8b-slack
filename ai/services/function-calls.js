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
import { estimatePayloadTokens, PAYLOAD_CHARS_PER_TOKEN } from "../utils/tokens.js";
import { executePython } from "./code-sandbox.js";
import {
	handleDeleteResourceConfig,
	handleGetConfigFile,
	handleGetResourceConfig,
	handleListConfigFiles,
	handleModifyResourceConfig,
	handleRequestCredentials,
	handleSaveConfigFile,
} from "./config-editor.js";
import { executeFetchUrl, isFetchUrlEnabled } from "./fetch-url.js";
import { openai } from "./openai.js";
import { uploadGeneratedFilesToSlack } from "./slack-files.js";
import { executeWithMiddleware } from "./tool-middleware.js";
import { executeWebSearch } from "./web-search.js";

/**
 * Process a single function call from the model.
 *
 * @param {Object} functionCall - The function call to process
 * @param {Object} context - Processing context
 * @param {Object} context.client - Slack client
 * @param {Object} context.message - Original Slack message
 * @param {string} [context.userId] - Slack user ID of the requesting user
 * @param {Set<string>} [context.threadAuthorIds] - Human authors seen in this Slack thread
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
	const {
		client,
		message,
		userId,
		threadAuthorIds,
		say,
		vectorStoreIds,
		fileTracking,
		provider,
		knowledgeBase,
		logger,
	} = context;

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
		// Without a Files API, large outputs are staged for the local Python
		// sandbox instead (read back with run_python from /data/)
		sandboxFiles:
			!providerFileUploads && provider?.capabilities?.localCodeInterpreter
				? fileTracking?.sandboxFiles
				: null,
	};

	try {
		const args = argsStr ? JSON.parse(argsStr) : {};

		// Route to appropriate handler with middleware for pagination/caching
		switch (name) {
			// Internal Slack functions - no caching needed
			case "slack_add_reaction":
				output = await handleSlackReaction(args, client, message);
				break;

			case "update_knowledge":
				output = knowledgeBase
					? await handleLocalUpdateKnowledge(args, knowledgeBase, say, logger)
					: await handleUpdateKnowledge(args, vectorStoreIds, say, logger);
				break;

			// MetricsHub configuration editing (REST API; human-in-the-loop for
			// credentials and change approval — no caching, no middleware)
			case "list_config_files":
				output = await handleListConfigFiles(args, { userId, logger });
				break;

			case "get_config_file":
				output = await handleGetConfigFile(args, { userId, logger });
				break;

			case "get_resource_config":
				output = await handleGetResourceConfig(args, { userId, logger });
				break;

			case "modify_resource_config":
				output = await handleModifyResourceConfig(args, {
					client,
					message,
					say,
					userId,
					threadAuthorIds,
					logger,
				});
				break;

			case "delete_resource_config":
				output = await handleDeleteResourceConfig(args, {
					client,
					message,
					say,
					userId,
					threadAuthorIds,
					logger,
				});
				break;

			case "request_credentials":
				output = await handleRequestCredentials(args, { client, message, say, userId, logger });
				break;

			case "save_config_file":
				output = await handleSaveConfigFile(args, {
					client,
					message,
					say,
					userId,
					threadAuthorIds,
					logger,
				});
				break;

			// Application-side web search (Ollama mode)
			case "web_search":
				output = await executeWebSearch(args, logger);
				break;

			// Application-side page reader (function-only providers). Through the
			// middleware so a long page is staged for run_python instead of being
			// truncated blindly by the provider inline cap. An MCP server that
			// exports its own fetch_url keeps it (the built-in is not offered then)
			case "fetch_url":
				// The switch removes page reading entirely, MCP-provided readers included
				if (!isFetchUrlEnabled()) {
					output = {
						ok: false,
						error: "fetch_url is disabled on this deployment (FETCH_URL_ENABLED=false).",
					};
					break;
				}
				output = await executeWithMiddleware(
					name,
					args,
					async (_name, cleanArgs) =>
						getOpenAiFunctionTools().some((tool) => tool.name === "fetch_url")
							? handleMcpFunctionCall(_name, cleanArgs, logger)
							: executeFetchUrl(cleanArgs, logger),
					middlewareOptions
				);
				break;

			// Local Python sandbox (Ollama mode replacement for code_interpreter)
			case "run_python":
				output = provider?.capabilities?.localCodeInterpreter
					? await handleRunPython(args, { client, message, fileTracking, logger })
					: { ok: false, error: "run_python is not available for this provider" };
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

	// Provider-specific inline cap: small-context providers (Ollama) cannot
	// absorb tool outputs sized for OpenAI's context window. The char cap
	// encodes a TOKEN budget at the nominal payload density; dense payloads
	// (numeric tables at ~1.5 chars/token) must be cut proportionally shorter
	// to stay within the same token budget.
	const maxToolOutputChars = provider?.maxToolOutputChars;
	if (maxToolOutputChars) {
		const tokenBudget = Math.floor(maxToolOutputChars / PAYLOAD_CHARS_PER_TOKEN);
		const estimatedTokens = estimatePayloadTokens(finalOutputStr);
		if (estimatedTokens > tokenBudget) {
			const density = finalOutputStr.length / estimatedTokens;
			const charCap = Math.min(maxToolOutputChars, Math.floor(tokenBudget * density));
			logger?.warn?.(
				`[FUNCTION] ${name} output (~${estimatedTokens} tokens, ${finalOutputStr.length} chars) exceeds the provider inline cap (~${tokenBudget} tokens); truncating to ${charCap} chars`
			);
			const truncationHint =
				"Tool output was TRUNCATED to fit the local model's context window; data for some requested items may be missing entirely. Do NOT guess, assume, or invent values for items you cannot see in the data above. Either call this tool again for ONE host/item at a time to get complete data, or explicitly tell the user that data is missing.";
			if (typeof output === "string") {
				// Markdown outputs truncate as plain text: JSON-wrapping would
				// escape every newline and quote, inflating the payload and making
				// the surviving tables much harder for the model to read
				const originalChars = finalOutputStr.length;
				const kept = finalOutputStr.slice(0, Math.max(charCap - 600, 1000));
				finalOutputStr = `${kept}\n\n[TRUNCATED: showing ${kept.length} of ${originalChars} chars. ${truncationHint}]`;
			} else {
				// The staged/uploaded full copy (middleware `_file`) is what lets the
				// model recover the truncated data: keep it out of the sliced blob
				// and inside the envelope, with room reserved for it
				const fileRef = output && typeof output === "object" ? output._file : undefined;
				const fileRefChars = fileRef ? JSON.stringify(fileRef).length : 0;
				const envelope = {
					ok: output?.ok ?? true,
					truncated: true,
					originalChars: finalOutputStr.length,
					data: finalOutputStr.slice(0, Math.max(charCap - 500 - fileRefChars, 1000)),
					hint: fileRef?.hint ? `${truncationHint} ${fileRef.hint}` : truncationHint,
				};
				if (fileRef) envelope._file = fileRef;
				finalOutputStr = JSON.stringify(envelope);
			}
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
 * Handle run_python: execute LLM-written Python in the local Pyodide sandbox
 * and deliver any files it wrote to /outputs straight to the Slack thread.
 *
 * @param {Object} args - Tool arguments ({code})
 * @param {Object} context - {client, message, fileTracking, logger}
 * @returns {Promise<Object>} Model-facing execution summary
 */
async function handleRunPython(args, { client, message, fileTracking, logger }) {
	const code = String(args.code || "");
	if (!code.trim()) {
		return { ok: false, error: "No Python code provided" };
	}

	// Files staged during this turn (large tool outputs) appear under /data/
	const sandboxFiles =
		fileTracking?.sandboxFiles instanceof Map ? fileTracking.sandboxFiles : new Map();
	const inputFiles = [...sandboxFiles.entries()].map(([name, data]) => ({ name, data }));

	const execution = await executePython({ code, inputFiles, logger });

	logger?.info?.("[SANDBOX] run_python finished", {
		ok: execution.ok,
		durationMs: execution.durationMs,
		outputFiles: execution.outputFiles.map((f) => f.name),
		stdoutChars: execution.stdout.length,
		stderrChars: execution.stderr.length,
	});

	const summary = { ok: execution.ok };
	if (execution.error) summary.error = execution.error;
	if (execution.stdout) summary.stdout = execution.stdout;
	if (execution.stderr) summary.stderr = execution.stderr;
	if (execution.result) summary.result = execution.result;
	if (execution.skippedFiles?.length) {
		summary.skippedFiles = execution.skippedFiles;
		summary.skippedHint = "These output files exceeded the size cap and were NOT delivered.";
	}
	if (inputFiles.length > 0) {
		summary.inputFilesAvailable = inputFiles.map((file) => `/data/${file.name}`);
	}

	if (execution.outputFiles.length > 0) {
		const uploaded = await uploadGeneratedFilesToSlack(
			execution.outputFiles,
			client,
			message.channel,
			message.thread_ts,
			logger
		);
		if (uploaded) {
			summary.filesDeliveredToSlack = execution.outputFiles.map((file) => file.name);
			summary.note =
				"The generated files were already posted to the Slack thread. Confirm the file names to the user; NEVER mention sandbox paths (/outputs/, /data/) or download links.";
		} else {
			summary.ok = false;
			summary.error = `${summary.error ? `${summary.error}; ` : ""}the generated files could not be posted to Slack`;
		}
	}

	return summary;
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
