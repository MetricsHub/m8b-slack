/**
 * Output safety utilities.
 *
 * Simple utilities for ensuring tool outputs don't exceed size limits.
 * Pagination and caching are handled by tool-middleware.js.
 */

/** Hard limit (1MB, well under OpenAI's 10MB limit) */
export const HARD_MAX_OUTPUT_CHARS = 1000000;

/**
 * Ensures output is under the hard character limit.
 *
 * @param {Object} output - The output to check
 * @param {string} toolName - Name of the tool (for error messages)
 * @param {Object} logger - Logger instance
 * @returns {Object} Safe output under the limit
 */
export function ensureSafeOutput(output, toolName, logger = null) {
	const outputStr = JSON.stringify(output);

	if (outputStr.length <= HARD_MAX_OUTPUT_CHARS) {
		return output;
	}

	logger?.warn?.(
		`[OUTPUT] Output for ${toolName} too large (${outputStr.length} chars), returning error`
	);

	return {
		ok: false,
		error: `Output too large (${outputStr.length} chars)`,
		hint: "Use smaller maxResults (e.g., 10-50) or more specific query parameters.",
	};
}

/**
 * Creates a small preview of the output structure.
 *
 * @param {Object} output - The output to preview
 * @returns {Object} A small preview of the structure
 */
export function createOutputPreview(output) {
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
				if (sampleStr.length < 300) {
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
