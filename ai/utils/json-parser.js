/**
 * JSON parsing utilities for handling MCP tool responses.
 */

/**
 * Try to parse a value that might be a JSON string.
 * Some MCP tools return JSON as a string, so we need to recursively parse.
 *
 * @param {*} value - The value to potentially parse
 * @returns {*} The parsed value, or the original if not JSON
 */
export function tryParseJsonString(value) {
	if (typeof value === "string") {
		const trimmed = value.trim();

		// Check if it looks like JSON (starts with { or [)
		if (
			(trimmed.startsWith("{") && trimmed.endsWith("}")) ||
			(trimmed.startsWith("[") && trimmed.endsWith("]"))
		) {
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

	if (value && typeof value === "object") {
		const result = {};
		for (const [k, v] of Object.entries(value)) {
			result[k] = tryParseJsonString(v);
		}
		return result;
	}

	return value;
}
