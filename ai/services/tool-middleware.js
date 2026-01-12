/**
 * Tool middleware - unified caching and pagination for all tool calls.
 *
 * This middleware sits between the LLM function calls and the actual tool providers
 * (MCP, Prometheus, Slack, etc.) and handles:
 * - Result caching for pagination across multiple calls
 * - Consistent pagination for large results
 * - Size-aware output limiting
 * - File uploads for very large outputs (accessible via code_interpreter)
 */

import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** Default maximum items to return per page */
export const DEFAULT_MAX_RESULTS = 100;

/** Maximum characters for inline output (~7500 tokens) - above this, upload as file */
export const MAX_INLINE_OUTPUT_CHARS = 30000;

/** Hard limit (1MB, well under OpenAI's 10MB limit) */
export const HARD_MAX_OUTPUT_CHARS = 1000000;

/** Cache TTL in milliseconds (5 minutes) */
const RESULT_CACHE_TTL_MS = 5 * 60 * 1000;

/** Maximum cache entries before cleanup */
const MAX_CACHE_ENTRIES = 100;

// In-memory result cache
const resultCache = new Map(); // cacheId -> { data, timestamp, toolName }

/**
 * Generate a cache key from tool name and args (excluding pagination params).
 */
function generateCacheKey(toolName, args) {
	const normalizedArgs = { ...args };
	delete normalizedArgs.offset;
	delete normalizedArgs.maxResults;
	delete normalizedArgs._cacheId;

	const sortedArgs = JSON.stringify(normalizedArgs, Object.keys(normalizedArgs).sort());
	const hash = crypto.createHash("sha256").update(`${toolName}:${sortedArgs}`).digest("hex");
	return hash.substring(0, 16);
}

/**
 * Get cached result if available and not expired.
 */
function getCachedResult(cacheId, logger) {
	const entry = resultCache.get(cacheId);
	if (!entry) return null;

	if (Date.now() - entry.timestamp > RESULT_CACHE_TTL_MS) {
		resultCache.delete(cacheId);
		logger?.info?.(`[CACHE] Expired: ${cacheId}`);
		return null;
	}

	logger?.info?.(`[CACHE] Hit: ${cacheId} (${entry.toolName})`);
	return entry.data;
}

/**
 * Store result in cache.
 */
function setCachedResult(cacheId, toolName, data, logger) {
	// Cleanup if cache is full
	if (resultCache.size >= MAX_CACHE_ENTRIES) {
		cleanupCache(logger);
	}

	resultCache.set(cacheId, { data, timestamp: Date.now(), toolName });
	logger?.info?.(`[CACHE] Stored: ${cacheId} (${toolName})`);
}

/**
 * Remove expired entries and oldest if still over limit.
 */
function cleanupCache(logger) {
	const now = Date.now();
	let removed = 0;

	for (const [key, entry] of resultCache) {
		if (now - entry.timestamp > RESULT_CACHE_TTL_MS) {
			resultCache.delete(key);
			removed++;
		}
	}

	if (resultCache.size >= MAX_CACHE_ENTRIES) {
		const entries = [...resultCache.entries()].sort((a, b) => a[1].timestamp - b[1].timestamp);
		const toRemove = entries.slice(0, Math.floor(MAX_CACHE_ENTRIES / 2));
		for (const [key] of toRemove) {
			resultCache.delete(key);
			removed++;
		}
	}

	logger?.info?.(`[CACHE] Cleanup: removed ${removed}, remaining ${resultCache.size}`);
}

/**
 * Find the primary data array/object in tool output.
 */
function findPrimaryData(output) {
	if (!output || typeof output !== "object") return null;

	const knownFields = [
		"items",
		"results",
		"data",
		"records",
		"entries",
		"list",
		"hosts",
		"metrics",
		"series",
		"events",
		"alerts",
	];

	for (const field of knownFields) {
		if (Array.isArray(output[field]) && output[field].length > 0) {
			return { key: field, data: output[field], isObject: false };
		}
		if (
			output[field] &&
			typeof output[field] === "object" &&
			!Array.isArray(output[field]) &&
			Object.keys(output[field]).length > 0
		) {
			return { key: field, data: output[field], isObject: true };
		}
	}

	// Fallback: any large array
	for (const [key, value] of Object.entries(output)) {
		if (Array.isArray(value) && value.length > 5) {
			return { key, data: value, isObject: false };
		}
	}

	return null;
}

/**
 * Paginate tool output.
 */
function paginateOutput(output, offset, limit, cacheId) {
	const primary = findPrimaryData(output);
	if (!primary) return { output, paginated: false };

	const { key, data, isObject } = primary;
	const total = isObject ? Object.keys(data).length : data.length;

	// If data fits in one page and offset is 0, return as-is
	if (total <= limit && offset === 0) {
		return { output, paginated: false };
	}

	// Apply pagination
	let paginatedData;
	let returned;

	if (isObject) {
		const keys = Object.keys(data);
		const selectedKeys = keys.slice(offset, offset + limit);
		paginatedData = {};
		for (const k of selectedKeys) {
			paginatedData[k] = data[k];
		}
		returned = selectedKeys.length;
	} else {
		paginatedData = data.slice(offset, offset + limit);
		returned = paginatedData.length;
	}

	const hasMore = offset + returned < total;
	const paginatedOutput = { ...output };
	paginatedOutput[key] = paginatedData;
	paginatedOutput._pagination = {
		offset,
		limit,
		returned,
		total,
		hasMore,
		nextOffset: hasMore ? offset + returned : null,
		field: key,
		hint: hasMore
			? `Showing ${returned} of ${total} ${key}. To get more, call this tool again with _cacheId="${cacheId}" and offset=${offset + returned}.`
			: `Showing all ${total} ${key}.`,
	};

	return { output: paginatedOutput, paginated: true };
}

/**
 * Ensure output is under the hard limit.
 * If exceeded, return error with file reference (if available).
 */
function ensureSafeSize(output, toolName, logger) {
	const outputStr = JSON.stringify(output);

	if (outputStr.length <= HARD_MAX_OUTPUT_CHARS) {
		return output;
	}

	logger?.warn?.(`[MIDDLEWARE] Output too large (${outputStr.length} chars) for ${toolName}`);

	// Preserve file reference if present - the data IS available via code_interpreter
	const fileRef = output?._file;

	return {
		ok: false,
		error: `Output too large for inline (${outputStr.length} chars)`,
		_file: fileRef,
		hint: fileRef
			? `Full data uploaded as "${fileRef.fileName}". Use code_interpreter to read and analyze the JSON file.`
			: "Use smaller maxResults (e.g., 10-50) or more specific query parameters.",
	};
}

/**
 * Creates a small preview of the output structure for inline summaries.
 */
function createOutputPreview(output) {
	if (!output || typeof output !== "object") {
		return output;
	}

	const preview = {};

	for (const [key, value] of Object.entries(output)) {
		if (value === null || typeof value !== "object") {
			preview[key] = value;
		} else if (Array.isArray(value)) {
			preview[key] = `[Array: ${value.length} items]`;
			if (value.length > 0) {
				const sampleStr = JSON.stringify(value[0]);
				if (sampleStr.length < 500) {
					preview[`${key}_sample`] = value[0];
				}
			}
		} else {
			const keys = Object.keys(value);
			preview[key] = `{Object: ${keys.length} keys}`;
		}
	}

	return preview;
}

/**
 * Upload large output as a JSON file for code_interpreter access.
 *
 * @param {Object} output - The output to upload
 * @param {string} toolName - Name of the tool
 * @param {Object} openaiClient - OpenAI client instance
 * @param {Object} fileTracking - File tracking state
 * @param {Object} logger - Logger instance
 * @returns {Promise<Object>} Summary with file reference
 */
async function uploadOutputAsFile(output, toolName, openaiClient, fileTracking, logger) {
	const outputStr = JSON.stringify(output, null, 2);
	const outputLen = outputStr.length;

	logger?.info?.(`[MIDDLEWARE] Uploading ${toolName} output as file (${outputLen} chars)`);

	try {
		// Create a temporary JSON file
		const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "m8b-tool-"));
		const timestamp = Date.now();
		const safeToolName = toolName.replace(/[^a-zA-Z0-9_-]/g, "_");
		const fileName = `${safeToolName}_${timestamp}.json`;
		const tmpPath = path.join(tmpDir, fileName);

		// Write the full output as formatted JSON
		await fsp.writeFile(tmpPath, outputStr, "utf8");

		// Upload to OpenAI
		const uploaded = await openaiClient.files.create({
			file: fs.createReadStream(tmpPath),
			purpose: "user_data",
		});

		logger?.info?.(`[MIDDLEWARE] Uploaded ${toolName} output as file ${uploaded.id}`);

		// Track the uploaded file
		if (fileTracking?.uploadedFiles) {
			fileTracking.uploadedFiles.push({
				tool_output: toolName,
				openai_file_id: uploaded.id,
				size: outputLen,
			});
		}

		// Add to codeFileIds so code_interpreter can access it
		if (fileTracking?.codeFileIds) {
			fileTracking.codeFileIds.add(uploaded.id);
		}
		if (fileTracking?.codeContainerFiles) {
			fileTracking.codeContainerFiles.set(uploaded.id, fileName);
		}

		// Cleanup temp file (async, don't wait)
		fsp.rm(tmpDir, { recursive: true }).catch(() => {});

		// Return a small summary inline with the file reference
		return {
			ok: output?.ok ?? true,
			dataInFile: true,
			fileId: uploaded.id,
			fileName: fileName,
			originalSize: outputLen,
			hint: `Full ${toolName} output (${outputLen} chars) uploaded as file "${fileName}". Use code_interpreter to read and analyze this JSON file.`,
			preview: createOutputPreview(output),
		};
	} catch (e) {
		logger?.error?.(`[MIDDLEWARE] Failed to upload ${toolName} output as file:`, { error: e });
		// Return null to indicate upload failed - caller should handle fallback
		return null;
	}
}

/**
 * Execute a tool call with caching, pagination, and file upload.
 *
 * The full (non-paginated) result is always uploaded as a JSON file for code_interpreter access.
 * The inline response is paginated for efficient context usage.
 *
 * @param {string} name - Tool name
 * @param {Object} args - Tool arguments (may include offset, maxResults, _cacheId)
 * @param {Function} executor - Function that executes the actual tool call: (name, args) => result
 * @param {Object} options - Options object
 * @param {Object} options.logger - Logger instance
 * @param {Object} [options.openaiClient] - OpenAI client for file uploads
 * @param {Object} [options.fileTracking] - File tracking state for uploaded files
 * @returns {Promise<Object>} Processed output with pagination and file reference
 */
export async function executeWithMiddleware(name, args, executor, options = {}) {
	const { logger, openaiClient, fileTracking } = options;

	// Extract pagination params
	const maxResults =
		typeof args?.maxResults === "number" && args.maxResults > 0
			? args.maxResults
			: DEFAULT_MAX_RESULTS;
	const offset = typeof args?.offset === "number" && args.offset >= 0 ? args.offset : 0;

	// Generate or use provided cache key
	const cacheId = args?._cacheId || generateCacheKey(name, args);

	// Check cache first (for pagination requests)
	const cachedData = getCachedResult(cacheId, logger);
	if (cachedData) {
		// Paginate from cache - file was already uploaded on first call
		const { output: paginatedOutput } = paginateOutput(
			cachedData.result,
			offset,
			maxResults,
			cacheId
		);

		// Add file reference if we uploaded one
		if (cachedData.fileId) {
			paginatedOutput._file = {
				fileId: cachedData.fileId,
				fileName: cachedData.fileName,
				hint: `Full data available in file "${cachedData.fileName}". Use code_interpreter to analyze.`,
			};
		}

		return ensureSafeSize(paginatedOutput, name, logger);
	}

	// Strip pagination params before calling the actual tool
	const cleanArgs = { ...args };
	delete cleanArgs.offset;
	delete cleanArgs.maxResults;
	delete cleanArgs._cacheId;

	// Execute the actual tool call
	let result;
	try {
		result = await executor(name, cleanArgs);
	} catch (e) {
		logger?.error?.(`[MIDDLEWARE] Tool execution failed: ${name}`, { error: e });
		return { ok: false, error: String(e) };
	}

	// Always upload the full result as a file (if we have the client)
	let uploadedFile = null;
	if (openaiClient && fileTracking) {
		uploadedFile = await uploadOutputAsFile(result, name, openaiClient, fileTracking, logger);
	}

	// Check if result needs pagination
	const primary = findPrimaryData(result);
	const dataSize = primary
		? primary.isObject
			? Object.keys(primary.data).length
			: primary.data.length
		: 0;

	// Cache the result and file reference for pagination requests
	if (dataSize > maxResults || dataSize > DEFAULT_MAX_RESULTS) {
		setCachedResult(
			cacheId,
			name,
			{
				result,
				fileId: uploadedFile?.fileId,
				fileName: uploadedFile?.fileName,
			},
			logger
		);
	}

	// Apply pagination to inline response
	const { output: paginatedOutput, paginated } = paginateOutput(
		result,
		offset,
		maxResults,
		cacheId
	);

	// Add cache ID if we paginated (so LLM can request more)
	if (paginated && paginatedOutput._pagination) {
		paginatedOutput._cacheId = cacheId;
	}

	// Add file reference to inline output
	if (uploadedFile) {
		paginatedOutput._file = {
			fileId: uploadedFile.fileId,
			fileName: uploadedFile.fileName,
			hint: `Full data (${JSON.stringify(result).length} chars) uploaded as "${uploadedFile.fileName}". Use code_interpreter to read and analyze.`,
		};
	}

	return ensureSafeSize(paginatedOutput, name, logger);
}

/**
 * Clear the result cache (useful for testing).
 */
export function clearCache() {
	resultCache.clear();
}

/**
 * Get cache stats (useful for debugging).
 */
export function getCacheStats() {
	return {
		size: resultCache.size,
		keys: [...resultCache.keys()],
	};
}
