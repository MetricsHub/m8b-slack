/**
 * Handles large tool outputs by uploading them as files.
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** Maximum characters for inline output (~7500 tokens) */
export const MAX_INLINE_OUTPUT_CHARS = 30000;

/** Hard limit (1MB, well under OpenAI's 10MB limit) */
export const HARD_MAX_OUTPUT_CHARS = 1000000;

/** Maximum preview size */
const MAX_PREVIEW_CHARS = 5000;

/**
 * Ensures output is under the hard character limit.
 *
 * @param {Object} output - The output to check
 * @param {string} toolName - Name of the tool (for error messages)
 * @param {number} originalSize - Original size of the output
 * @returns {Object} Safe output under the limit
 */
export function ensureSafeOutput(output, toolName, originalSize) {
	const outputStr = JSON.stringify(output);

	if (outputStr.length <= HARD_MAX_OUTPUT_CHARS) {
		return output;
	}

	// Nuclear option - return minimal error message
	console.warn(
		`[OUTPUT_HANDLER] Output for ${toolName} still too large (${outputStr.length} chars), using nuclear truncation`
	);

	return {
		ok: false,
		error: `Output too large (${originalSize || outputStr.length} chars). Data could not be processed.`,
		hint: "Use more specific query parameters to reduce the result size.",
	};
}

/**
 * Creates a small preview of the output structure for inline summaries.
 *
 * @param {Object} output - The output to preview
 * @returns {Object} A small preview of the structure
 */
export function createOutputPreview(output) {
	if (!output || typeof output !== "object") {
		return output;
	}

	const preview = {};

	// Copy simple fields
	for (const [key, value] of Object.entries(output)) {
		if (value === null || typeof value !== "object") {
			preview[key] = value;
		} else if (Array.isArray(value)) {
			preview[key] = `[Array with ${value.length} items]`;
			// Include first item as sample only if it's small
			if (value.length > 0) {
				const sampleStr = JSON.stringify(value[0]);
				if (sampleStr.length < 500) {
					preview[`${key}_sample`] = value[0];
				} else {
					preview[`${key}_sample`] = "[Sample too large - use code_interpreter to read the file]";
				}
			}
		} else {
			const keys = Object.keys(value);
			preview[key] =
				`{Object with ${keys.length} keys: ${keys.slice(0, 5).join(", ")}${keys.length > 5 ? "..." : ""}}`;
		}
	}

	// Final safety check - ensure preview isn't too large
	const previewStr = JSON.stringify(preview);
	if (previewStr.length > MAX_PREVIEW_CHARS) {
		return {
			note: "Preview too large",
			keys: Object.keys(output).slice(0, 20),
			totalKeys: Object.keys(output).length,
		};
	}

	return preview;
}

/**
 * Simple truncation fallback - ensures output never exceeds limit.
 *
 * @param {Object} output - The output to truncate
 * @param {number} maxChars - Maximum characters allowed
 * @returns {Object} Truncated output
 */
export function truncateOutput(output, maxChars) {
	const str = JSON.stringify(output);

	if (str.length <= maxChars) {
		return output;
	}

	const truncated = {
		ok: output?.ok ?? true,
		truncated: true,
		originalSize: str.length,
		message:
			"Output was too large and has been truncated. The data could not be uploaded as a file.",
		preview: createOutputPreview(output),
	};

	// Safety check - if even the truncated version is too big, strip the preview
	const truncatedStr = JSON.stringify(truncated);
	if (truncatedStr.length > HARD_MAX_OUTPUT_CHARS) {
		return {
			ok: output?.ok ?? true,
			truncated: true,
			originalSize: str.length,
			message:
				"Output was too large and has been truncated. The data could not be uploaded as a file.",
			hint: "Request more specific data to reduce response size.",
		};
	}

	return truncated;
}

/**
 * Handles large tool outputs by uploading them as JSON files.
 *
 * @param {Object} output - The tool output
 * @param {string} toolName - Name of the tool
 * @param {Object} openai - OpenAI client instance
 * @param {Object} fileTracking - Object to track uploaded files
 * @returns {Promise<{output: Object}>} Processed output
 */
export async function handleLargeToolOutput(output, toolName, openai, fileTracking = {}) {
	const outputStr = JSON.stringify(output, null, 2);
	const outputLen = outputStr.length;

	if (outputLen <= MAX_INLINE_OUTPUT_CHARS) {
		// Output is small enough, return inline
		return { output: ensureSafeOutput(output, toolName, outputLen) };
	}

	console.log(
		`[OUTPUT_HANDLER] Output for ${toolName} is large (${outputLen} chars), uploading as JSON file...`
	);

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
		const uploaded = await openai.files.create({
			file: fs.createReadStream(tmpPath),
			purpose: "user_data",
		});

		console.log(
			`[OUTPUT_HANDLER] Uploaded ${toolName} output as file ${uploaded.id} (${outputLen} chars)`
		);

		// Track the uploaded file
		if (fileTracking.uploadedFiles) {
			fileTracking.uploadedFiles.push({
				tool_output: toolName,
				openai_file_id: uploaded.id,
				size: outputLen,
			});
		}

		// Add to codeFileIds so code_interpreter can access it
		if (fileTracking.codeFileIds) {
			fileTracking.codeFileIds.add(uploaded.id);
		}
		if (fileTracking.codeContainerFiles) {
			fileTracking.codeContainerFiles.set(uploaded.id, fileName);
		}

		// Return a small summary inline with the file reference
		const summaryOutput = {
			ok: output?.ok ?? true,
			dataInFile: true,
			fileId: uploaded.id,
			fileName: fileName,
			originalSize: outputLen,
			hint: `Full ${toolName} output (${outputLen} chars) uploaded as file "${fileName}". Use code_interpreter to read and analyze this JSON file.`,
			preview: createOutputPreview(output),
		};

		// Cleanup temp file (async, don't wait)
		fsp.rm(tmpDir, { recursive: true }).catch(() => {});

		return { output: ensureSafeOutput(summaryOutput, toolName, outputLen) };
	} catch (e) {
		console.error(`[OUTPUT_HANDLER] Failed to upload ${toolName} output as file:`, e);
		// Fallback: hard truncate the output to ensure it fits
		console.log(`[OUTPUT_HANDLER] Falling back to hard truncation for ${toolName}`);
		const truncated = truncateOutput(output, MAX_INLINE_OUTPUT_CHARS);
		return { output: ensureSafeOutput(truncated, toolName, outputLen) };
	}
}
