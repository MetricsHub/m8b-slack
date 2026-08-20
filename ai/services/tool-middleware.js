/**
 * Tool middleware - unified caching and pagination for all tool calls.
 *
 * This middleware sits between the LLM function calls and the actual tool providers
 * (MCP, Prometheus, Slack, etc.) and handles:
 * - Result caching for pagination across multiple calls
 * - Consistent pagination for large results
 * - Size-aware output limiting
 * - File uploads for very large outputs (accessible via code_interpreter)
 * - Markdown table rendering for MetricsHub telemetry (token-efficient inline form)
 */

import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** Default maximum items to return per page */
export const DEFAULT_MAX_RESULTS = 100;

/** Maximum characters for inline output (~125K tokens) - above this, upload as file */
export const MAX_INLINE_OUTPUT_CHARS = 500000;

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
 * @param {Object} [options] - Options object
 * @param {Object} [options.logger] - Logger instance
 * @param {Object} [options.openaiClient] - OpenAI client for file uploads
 * @param {Object} [options.fileTracking] - File tracking state for uploaded files
 * @returns {Promise<Object|string>} Processed output with pagination and file reference;
 *   telemetry-shaped outputs return a Markdown string instead of JSON
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

	// Compress MCP output to reduce payload size (removes verbose/redundant fields)
	result = compressMcpOutput(result, name, logger);

	// Always upload the full result as a file (if we have the client)
	let uploadedFile = null;
	if (openaiClient && fileTracking) {
		uploadedFile = await uploadOutputAsFile(result, name, openaiClient, fileTracking, logger);
	}

	// Inline representation: MetricsHub telemetry renders as Markdown tables
	// (~65% fewer tokens than the compressed JSON, content-lossless). The
	// uploaded file keeps the full JSON for code_interpreter, which genuinely
	// parses it programmatically.
	const telemetryMarkdown = telemetryToMarkdown(result);
	if (telemetryMarkdown !== null) {
		const jsonSize = JSON.stringify(result).length;
		const savingsPercent = (((jsonSize - telemetryMarkdown.length) / jsonSize) * 100).toFixed(1);
		logger?.info?.(
			`[MIDDLEWARE] Rendered ${name} telemetry as Markdown: ${jsonSize} → ${telemetryMarkdown.length} chars (${savingsPercent}% reduction)`
		);

		let inline = telemetryMarkdown;
		if (uploadedFile) {
			inline += `\n\n> Full JSON (${jsonSize} chars) uploaded as "${uploadedFile.fileName}". Use code_interpreter to read and analyze it programmatically.`;
		}

		if (inline.length <= HARD_MAX_OUTPUT_CHARS) {
			return inline;
		}
		// Over the hard limit even as Markdown: fall through to the JSON path,
		// whose size handling (pagination + ensureSafeSize) already covers it
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

// ============================================================================
// MCP Output Compression
// ============================================================================

/**
 * Fields to remove from MCP metric objects (reduce payload size).
 */
const METRIC_FIELDS_TO_REMOVE = [
	"resetMetricsTime",
	"name",
	"updated",
	"type",
	"collectTime",
	"previousCollectTime",
	"previousValue",
];

/**
 * Fields to remove from MCP monitor objects.
 */
const MONITOR_FIELDS_TO_REMOVE = ["discoveryTime", "identifyingAttributeKeys"];

/**
 * Metric name prefixes to drop entirely: MetricsHub's internal job telemetry
 * (how long its own collection jobs took) — monitoring-of-the-monitor, with
 * no diagnostic value for the monitored host itself.
 */
const METRIC_NAME_PREFIXES_TO_REMOVE = ["metricshub.job."];

/**
 * Monitor attribute keys that only exist for machine correlation (identifier
 * plumbing) and carry no diagnostic value for the model. Human-meaningful
 * attributes (mountpoint, filesystem type, sensor location, serial number,
 * vendor, ...) are kept — this is a denylist, not an allowlist.
 */
const MONITOR_ATTRIBUTES_TO_REMOVE = [
	"id",
	"entityTypeId",
	"connector_id",
	"hw.parent.id",
	"parent.id",
];

/**
 * Boolean flags to remove when false (they add no information).
 */
const FALSE_FLAGS_TO_REMOVE = ["connector", "endpoint", "endpointHost", "is_endpoint"];

/**
 * Recursively remove empty objects and arrays from an object.
 * @param {*} obj - The object to clean
 * @returns {*} Cleaned object or undefined if empty
 */
function removeEmptyObjects(obj) {
	if (obj === null || typeof obj !== "object") {
		return obj;
	}

	if (Array.isArray(obj)) {
		const cleaned = obj.map(removeEmptyObjects).filter((item) => item !== undefined);
		return cleaned.length > 0 ? cleaned : undefined;
	}

	const cleaned = {};
	for (const [key, value] of Object.entries(obj)) {
		const cleanedValue = removeEmptyObjects(value);
		if (cleanedValue !== undefined) {
			cleaned[key] = cleanedValue;
		}
	}

	return Object.keys(cleaned).length > 0 ? cleaned : undefined;
}

/**
 * Remove duplicate content from legacyTextParameters.StatusInformation.
 * The field often contains the same output twice (once as "Result:" and again as "Result:" under "Message:").
 * @param {string} statusInfo - The StatusInformation string
 * @returns {string} Deduplicated string
 */
function deduplicateStatusInformation(statusInfo) {
	if (!statusInfo || typeof statusInfo !== "string") {
		return statusInfo;
	}

	// Pattern: content appears after "Result:" and then again after "Message:...Result:"
	// We keep only the first occurrence and the conclusion
	const messageMarker = "\n\nMessage:\n====================================\n";
	const conclusionMarker = "\n====================================\n\nConclusion:";

	const messageIdx = statusInfo.indexOf(messageMarker);
	const conclusionIdx = statusInfo.indexOf(conclusionMarker);

	if (messageIdx === -1 || conclusionIdx === -1) {
		return statusInfo;
	}

	// Keep everything before Message and the Conclusion
	const beforeMessage = statusInfo.substring(0, messageIdx);
	const conclusionPart = statusInfo.substring(
		conclusionIdx + "\n====================================\n\n".length
	);

	return `${beforeMessage}\n\n${conclusionPart}`;
}

/**
 * Compress a single metric object by removing verbose fields.
 * @param {Object} metric - A metric object with name, value, attributes, etc.
 * @returns {Object} Compressed metric
 */
function compressMetric(metric) {
	if (!metric || typeof metric !== "object") {
		return metric;
	}

	const compressed = {};
	for (const [key, value] of Object.entries(metric)) {
		if (METRIC_FIELDS_TO_REMOVE.includes(key)) {
			continue;
		}
		compressed[key] = value;
	}

	return compressed;
}

/**
 * Compress metrics object (keyed by metric name).
 * @param {Object} metrics - Object with metric names as keys
 * @returns {Object} Compressed metrics object
 */
function compressMetrics(metrics) {
	if (!metrics || typeof metrics !== "object") {
		return metrics;
	}

	const compressed = {};
	for (const [metricName, metricData] of Object.entries(metrics)) {
		if (METRIC_NAME_PREFIXES_TO_REMOVE.some((prefix) => metricName.startsWith(prefix))) {
			continue;
		}
		compressed[metricName] = compressMetric(metricData);
	}

	return compressed;
}

/**
 * Compress a monitor's attributes object: drop identifier plumbing and
 * names that are already embedded in entityName.
 * @param {Object} attributes - Monitor attributes
 * @returns {Object} Compressed attributes
 */
function compressAttributes(attributes) {
	if (!attributes || typeof attributes !== "object" || Array.isArray(attributes)) {
		return attributes;
	}

	const entityName = typeof attributes.entityName === "string" ? attributes.entityName : null;
	const compressed = {};

	for (const [key, value] of Object.entries(attributes)) {
		if (MONITOR_ATTRIBUTES_TO_REMOVE.includes(key)) {
			continue;
		}
		// instanceName/name usually duplicate a substring of entityName
		if (
			(key === "instanceName" || key === "name") &&
			typeof value === "string" &&
			entityName?.includes(value)
		) {
			continue;
		}
		compressed[key] = value;
	}

	return compressed;
}

/**
 * Compress a monitor object by removing verbose fields and compressing nested metrics.
 * @param {Object} monitor - A monitor object from MetricsHub
 * @returns {Object} Compressed monitor
 */
function compressMonitor(monitor) {
	if (!monitor || typeof monitor !== "object") {
		return monitor;
	}

	const compressed = {};

	for (const [key, value] of Object.entries(monitor)) {
		// Skip fields we want to remove
		if (MONITOR_FIELDS_TO_REMOVE.includes(key)) {
			continue;
		}

		// The literal type "monitor" is tautological (real types like "cpu" are kept)
		if (key === "type" && value === "monitor") {
			continue;
		}

		// Strip identifier plumbing from attributes
		if (key === "attributes" && value && typeof value === "object") {
			const compressedAttributes = compressAttributes(value);
			if (compressedAttributes && Object.keys(compressedAttributes).length > 0) {
				compressed[key] = compressedAttributes;
			}
			continue;
		}

		// Remove false boolean flags
		if (FALSE_FLAGS_TO_REMOVE.includes(key) && value === false) {
			continue;
		}

		// Compress nested metrics
		if (key === "metrics" && value && typeof value === "object") {
			const compressedMetrics = compressMetrics(value);
			if (compressedMetrics && Object.keys(compressedMetrics).length > 0) {
				compressed[key] = compressedMetrics;
			}
			continue;
		}

		// Deduplicate StatusInformation (textParams is the current-shape name
		// for what the legacy shape called legacyTextParameters)
		if ((key === "legacyTextParameters" || key === "textParams") && value?.StatusInformation) {
			const deduped = deduplicateStatusInformation(value.StatusInformation);
			if (deduped?.trim()) {
				compressed[key] = { ...value, StatusInformation: deduped };
			}
			continue;
		}

		// Aggregate metric maps (numericMetrics: {name: {avg,min,...}},
		// stateSetMetrics: {name: [{value,count}]}) get the same
		// internal-telemetry filtering as per-instance metrics
		if (
			(key === "numericMetrics" || key === "stateSetMetrics") &&
			value &&
			typeof value === "object"
		) {
			const filtered = {};
			for (const [metricName, metricValue] of Object.entries(value)) {
				if (METRIC_NAME_PREFIXES_TO_REMOVE.some((prefix) => metricName.startsWith(prefix))) {
					continue;
				}
				filtered[metricName] = metricValue;
			}
			if (Object.keys(filtered).length > 0) {
				compressed[key] = filtered;
			}
			continue;
		}

		compressed[key] = value;
	}

	return compressed;
}

/**
 * Compress MCP telemetry output by removing redundant fields.
 * Traverses the structure looking for monitors arrays and compresses each monitor.
 * @param {*} data - The data to compress (recursively searches for monitors)
 * @returns {*} Compressed data
 */
function compressMcpTelemetry(data) {
	if (data === null || typeof data !== "object") {
		return data;
	}

	if (Array.isArray(data)) {
		return data.map(compressMcpTelemetry);
	}

	const result = {};

	for (const [key, value] of Object.entries(data)) {
		if (key === "monitors" && Array.isArray(value)) {
			// Legacy shape: monitors as a flat array
			result[key] = value.map(compressMonitor);
		} else if (key === "monitors" && typeof value === "object" && value !== null) {
			// Current MetricsHub shape: monitors keyed by monitor type
			// (file_system, cpu, memory, ...), each an array of monitor instances
			const compressedMonitors = {};
			for (const [monitorType, instances] of Object.entries(value)) {
				compressedMonitors[monitorType] = Array.isArray(instances)
					? instances.map(compressMonitor)
					: compressMcpTelemetry(instances);
			}
			result[key] = compressedMonitors;
		} else if (typeof value === "object" && value !== null) {
			// Recurse into nested objects
			result[key] = compressMcpTelemetry(value);
		} else {
			result[key] = value;
		}
	}

	return result;
}

// ============================================================================
// Telemetry Markdown tables
// ============================================================================

/**
 * Minimum length for a shared metric-name prefix to be worth factoring out of
 * table column headers (shorter prefixes save less than the heading note costs).
 */
const MIN_METRIC_PREFIX_LENGTH = 8;

/**
 * Render a value as a Markdown table cell: pipes and newlines would break the
 * table grid, everything else stays verbatim so the model can copy values into
 * follow-up tool calls.
 * @param {*} value - Cell value
 * @returns {string} Sanitized cell text
 */
function sanitizeCell(value) {
	if (value === null || value === undefined) return "";
	// Non-integer numbers carry ~16 digits of collection noise; 6 significant
	// digits keep full diagnostic value at a fraction of the tokens. Integers
	// (byte counts, ids, flags) stay exact.
	if (typeof value === "number" && !Number.isInteger(value)) {
		return String(Number(value.toPrecision(6)));
	}
	const str = typeof value === "object" ? JSON.stringify(value) : String(value);
	return str.replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
}

/**
 * Flatten a monitor instance into three ordered column groups:
 * top-level fields (nested one-level objects like legacyTextParameters become
 * dotted keys), attributes, and metrics.
 * @param {Object} instance - A monitor instance ({attributes, metrics, ...})
 * @returns {{fields: Map, attributes: Map, metrics: Map}|null} Flattened row
 */
function flattenMonitorInstance(instance) {
	if (!instance || typeof instance !== "object" || Array.isArray(instance)) {
		return null;
	}

	const fields = new Map();
	const attributes = new Map();
	const metrics = new Map();

	for (const [key, value] of Object.entries(instance)) {
		if (key === "attributes" && value && typeof value === "object" && !Array.isArray(value)) {
			for (const [attrKey, attrValue] of Object.entries(value)) {
				attributes.set(attrKey, attrValue);
			}
		} else if (key === "metrics" && value && typeof value === "object" && !Array.isArray(value)) {
			for (const [metricName, metricValue] of Object.entries(value)) {
				metrics.set(metricName, metricValue);
			}
		} else if (value && typeof value === "object" && !Array.isArray(value)) {
			for (const [nestedKey, nestedValue] of Object.entries(value)) {
				fields.set(`${key}.${nestedKey}`, nestedValue);
			}
		} else {
			fields.set(key, value);
		}
	}

	return { fields, attributes, metrics };
}

/**
 * Find a shared metric-name prefix that can be factored out of a table's
 * metric column headers. The prefix must end at a "." inside the metric name
 * part (never inside "rate(...)" wrappers or "{...}" labels) so full names
 * reconstruct unambiguously as prefix + column header.
 * @param {string[]} names - Metric column names
 * @returns {string} The prefix, or "" when factoring does not apply
 */
function commonMetricPrefix(names) {
	if (names.length < 2) return "";

	let prefix = names[0];
	for (const name of names.slice(1)) {
		let i = 0;
		while (i < prefix.length && i < name.length && prefix[i] === name[i]) i++;
		prefix = prefix.slice(0, i);
		if (!prefix) return "";
	}

	const braceIdx = prefix.indexOf("{");
	if (braceIdx !== -1) prefix = prefix.slice(0, braceIdx);
	const parenIdx = prefix.indexOf("(");
	if (parenIdx !== -1) prefix = prefix.slice(0, parenIdx);

	const lastDot = prefix.lastIndexOf(".");
	if (lastDot === -1) return "";
	prefix = prefix.slice(0, lastDot + 1);

	if (prefix.length < MIN_METRIC_PREFIX_LENGTH) return "";
	if (names.some((name) => name.length <= prefix.length)) return "";

	return prefix;
}

/**
 * Detect a monitor-type aggregate instance: MetricsHub appends one instance
 * per monitor type that has no identity (no attributes) and no per-instance
 * metrics — only numericMetrics ({name: {avg,min,max,sum,count}}) and/or
 * stateSetMetrics ({name: [{value, count}]}) summarizing the other instances.
 * Merged into the instance table these become one column per aggregate name
 * with JSON-blob cells; they render far smaller as their own stat table.
 * @param {*} instance - A monitor instance
 * @returns {boolean} True when the instance holds only aggregate maps
 */
function isAggregateOnlyInstance(instance) {
	if (!instance || typeof instance !== "object" || Array.isArray(instance)) return false;

	// MetricsHub marks its per-type aggregate instance explicitly
	if (instance.type === "summary") return true;

	let hasAggregates = false;
	for (const [key, value] of Object.entries(instance)) {
		if (key === "numericMetrics" || key === "stateSetMetrics") {
			hasAggregates = true;
			continue;
		}
		if (key === "totalMonitors") continue;
		if (
			(key === "attributes" || key === "metrics") &&
			value &&
			typeof value === "object" &&
			Object.keys(value).length === 0
		) {
			continue;
		}
		return false;
	}

	return hasAggregates;
}

/**
 * Render a monitor type's aggregate instances as a compact stat table
 * (one row per metric name, one column per stat) plus one line per
 * state-set summary.
 * @param {Array} aggregateInstances - Instances matched by isAggregateOnlyInstance
 * @param {number} regularCount - Number of regular instances of the same type
 * @returns {string|null} Markdown block, or null when there is nothing to render
 */
function buildAggregateBlock(aggregateInstances, regularCount) {
	const numeric = {};
	const stateSets = {};
	let totalMonitors = null;
	for (const instance of aggregateInstances) {
		Object.assign(numeric, instance.numericMetrics || {});
		Object.assign(stateSets, instance.stateSetMetrics || {});
		if (typeof instance.totalMonitors === "number") totalMonitors = instance.totalMonitors;
	}

	// An aggregate over a single instance repeats that instance's row verbatim
	// (avg = min = max = sum = value) — nothing worth rendering
	if (totalMonitors === 1 && regularCount >= 1) return null;

	const instancesLabel = totalMonitors !== null ? `${totalMonitors} instances` : "instances";
	const parts = [];

	const numericNames = Object.keys(numeric);
	if (numericNames.length > 0) {
		// Stat columns: union of the aggregate objects' keys (avg, min, ...)
		const statCols = [];
		const seenStats = new Set();
		for (const name of numericNames) {
			const stats = numeric[name];
			if (!stats || typeof stats !== "object") continue;
			for (const key of Object.keys(stats)) {
				if (!seenStats.has(key)) {
					seenStats.add(key);
					statCols.push(key);
				}
			}
		}

		const prefix = commonMetricPrefix(numericNames);
		const prefixNote = prefix ? ` — metric rows omit the prefix \`${prefix}\`` : "";
		const headers = ["metric", ...statCols].map(sanitizeCell);
		const rows = numericNames.map((name) => {
			const stats = numeric[name] && typeof numeric[name] === "object" ? numeric[name] : {};
			const shownName = prefix ? name.slice(prefix.length) : name;
			const cells = [shownName, ...statCols.map((key) => stats[key])].map(sanitizeCell);
			return `| ${cells.join(" | ")} |`;
		});

		parts.push(
			`Aggregates across ${instancesLabel}${prefixNote}:\n\n${[
				`| ${headers.join(" | ")} |`,
				`|${headers.map(() => "---").join("|")}|`,
				...rows,
			].join("\n")}`
		);
	}

	for (const [name, states] of Object.entries(stateSets)) {
		const summary = (Array.isArray(states) ? states : [states])
			.map((s) =>
				s && typeof s === "object"
					? `${sanitizeCell(s.value)} ×${sanitizeCell(s.count)}`
					: sanitizeCell(s)
			)
			.join(", ");
		parts.push(`State summary — ${sanitizeCell(name)}: ${summary}`);
	}

	return parts.length > 0 ? parts.join("\n\n") : null;
}

/**
 * Build one Markdown table for a monitor type. Columns are the union of
 * attribute keys, then metric names, then remaining instance fields (each
 * group in first-seen order) — identity attributes lead the table and text
 * blobs like StatusInformation trail it; rows are instances; missing cells
 * stay empty; all-empty rows are skipped. Aggregate-only instances render
 * as a separate stat block below the table.
 * @param {string} monitorType - The monitor type key (file_system, cpu, ...)
 * @param {Array} instances - Monitor instances of that type
 * @returns {string|null} Markdown section, or null when nothing renders
 */
function buildMonitorTable(monitorType, instances) {
	const aggregateInstances = [];
	const regularInstances = [];
	for (const instance of instances) {
		(isAggregateOnlyInstance(instance) ? aggregateInstances : regularInstances).push(instance);
	}

	const aggregateBlock = buildAggregateBlock(aggregateInstances, regularInstances.length);

	const flattened = regularInstances.map(flattenMonitorInstance).filter(Boolean);
	if (flattened.length === 0) {
		if (!aggregateBlock) return null;
		return `## ${monitorType} (0)\n\n${aggregateBlock}`;
	}

	const fieldCols = [];
	const attrCols = [];
	const metricCols = [];
	const seenFields = new Set();
	const seenAttrs = new Set();
	const seenMetrics = new Set();

	for (const row of flattened) {
		for (const key of row.fields.keys()) {
			if (!seenFields.has(key)) {
				seenFields.add(key);
				fieldCols.push(key);
			}
		}
		for (const key of row.attributes.keys()) {
			if (!seenAttrs.has(key)) {
				seenAttrs.add(key);
				attrCols.push(key);
			}
		}
		for (const key of row.metrics.keys()) {
			if (!seenMetrics.has(key)) {
				seenMetrics.add(key);
				metricCols.push(key);
			}
		}
	}

	if (fieldCols.length + attrCols.length + metricCols.length === 0) return null;

	// Assemble the cell matrix (rows × columns), dropping all-empty rows
	const columns = [
		...attrCols.map((key) => ({ name: key, group: "attributes" })),
		...metricCols.map((key) => ({ name: key, group: "metrics" })),
		...fieldCols.map((key) => ({ name: key, group: "fields" })),
	];
	const matrix = [];
	for (const row of flattened) {
		const cells = columns.map((col) => {
			const map =
				col.group === "attributes"
					? row.attributes
					: col.group === "metrics"
						? row.metrics
						: row.fields;
			return sanitizeCell(map.get(col.name));
		});
		if (cells.every((cell) => cell === "")) continue;
		matrix.push(cells);
	}
	if (matrix.length === 0) {
		if (!aggregateBlock) return null;
		return `## ${monitorType} (0)\n\n${aggregateBlock}`;
	}

	// Omit columns that duplicate another column's values on every row
	// (MetricsHub often reports the same numbers under two names, e.g.
	// rate(system.cpu.time{...}) === system.cpu.utilization{...}, and
	// name === instanceName). Constant columns are never treated as
	// duplicates — pairing two coincidentally identical constants would
	// mislead more than it saves.
	const duplicateNotes = [];
	const keptIdx = [];
	const signatureToColumn = new Map();
	for (let i = 0; i < columns.length; i++) {
		const values = matrix.map((cells) => cells[i]);
		const distinct = new Set(values);
		const signature = JSON.stringify(values);
		const original = signatureToColumn.get(signature);
		if (original !== undefined && distinct.size >= 2) {
			duplicateNotes.push(
				`Column \`${columns[i].name}\` is omitted: identical values to \`${columns[original].name}\`.`
			);
			continue;
		}
		if (original === undefined) signatureToColumn.set(signature, i);
		keptIdx.push(i);
	}

	const keptColumns = keptIdx.map((i) => columns[i]);
	const keptMetricNames = keptColumns.filter((c) => c.group === "metrics").map((c) => c.name);
	const prefix = commonMetricPrefix(keptMetricNames);

	const headers = keptColumns.map((col) =>
		sanitizeCell(col.group === "metrics" && prefix ? col.name.slice(prefix.length) : col.name)
	);
	const rows = matrix.map((cells) => `| ${keptIdx.map((i) => cells[i]).join(" | ")} |`);

	const prefixNote = prefix ? ` — metric columns omit the prefix \`${prefix}\`` : "";
	const heading = `## ${monitorType} (${rows.length})${prefixNote}`;
	const headerLine = `| ${headers.join(" | ")} |`;
	const separator = `|${headers.map(() => "---").join("|")}|`;

	const parts = [heading, [headerLine, separator, ...rows].join("\n")];
	if (duplicateNotes.length > 0) parts.push(duplicateNotes.join("\n"));
	if (aggregateBlock) parts.push(aggregateBlock);
	return parts.join("\n\n");
}

/**
 * Render MetricsHub telemetry output as Markdown tables.
 *
 * Applies only when the output matches the current MetricsHub shape:
 * results[].result.hosts[].response.telemetry.monitors, with monitors keyed
 * by type and each type an array of {attributes, metrics} instances. JSON
 * repeats every metric name per instance; a table pays for each distinct name
 * once as a column header (~65% fewer chars on real telemetry). The rendering
 * is content-lossless: every field, attribute, metric name, value, and status
 * survives — only the packaging changes.
 *
 * Any other shape (ListHosts, PromQL, legacy flat monitors arrays, errors)
 * returns null so the caller keeps the JSON representation.
 *
 * @param {*} output - Compressed tool output
 * @returns {string|null} Markdown document, or null when the shape does not match
 */
export function telemetryToMarkdown(output) {
	if (!output || typeof output !== "object" || Array.isArray(output)) return null;
	if (output.ok === false) return null;
	if (!Array.isArray(output.results) || output.results.length === 0) return null;

	const sections = [];

	for (const entry of output.results) {
		if (!entry || typeof entry !== "object" || entry.ok === false) return null;

		const hosts = entry.result?.hosts;
		if (!Array.isArray(hosts) || hosts.length === 0) return null;

		for (const host of hosts) {
			if (typeof host?.hostname !== "string") return null;

			const monitors = host.response?.telemetry?.monitors;
			if (!monitors || typeof monitors !== "object" || Array.isArray(monitors)) return null;

			const monitorTypes = Object.entries(monitors);
			if (monitorTypes.length === 0) return null;

			// Two host entries can legitimately share one hostname (OS view +
			// hardware view) — each keeps its own section
			const agentLabel =
				typeof entry.server_label === "string" ? ` (agent: ${entry.server_label})` : "";
			const hostLines = [`# Host: ${host.hostname}${agentLabel}`];

			for (const [monitorType, instances] of monitorTypes) {
				if (!Array.isArray(instances)) return null;
				const table = buildMonitorTable(monitorType, instances);
				if (table) hostLines.push(table);
			}

			sections.push(hostLines.join("\n\n"));
		}
	}

	if (sections.length === 0) return null;
	return sections.join("\n\n");
}

/**
 * Compress MCP tool output to reduce payload size.
 * Applies telemetry compression and removes empty objects.
 *
 * @param {*} output - The raw MCP tool output
 * @param {string} toolName - Name of the tool (for conditional logic)
 * @param {Object} logger - Logger instance
 * @returns {*} Compressed output
 */
export function compressMcpOutput(output, toolName, logger) {
	if (!output || typeof output !== "object") {
		return output;
	}

	const originalSize = JSON.stringify(output).length;

	// Apply telemetry compression (handles monitors arrays)
	let compressed = compressMcpTelemetry(output);

	// Remove empty objects throughout
	compressed = removeEmptyObjects(compressed) || {};

	const compressedSize = JSON.stringify(compressed).length;
	const savings = originalSize - compressedSize;
	const savingsPercent = ((savings / originalSize) * 100).toFixed(1);

	if (savings > 1000) {
		logger?.info?.(
			`[MIDDLEWARE] Compressed ${toolName} output: ${originalSize} → ${compressedSize} chars (${savingsPercent}% reduction)`
		);
	}

	return compressed;
}
