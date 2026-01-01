/**
 * Token estimation and context window utilities.
 */

/**
 * Estimate rough token count for input items.
 * Uses the heuristic that ~4 characters ≈ 1 token.
 *
 * @param {Array} inputItems - Array of input items with content
 * @returns {number} Estimated token count
 */
export function estimateTokenCount(inputItems) {
	let chars = 0;

	for (const item of inputItems || []) {
		const content = item?.content || [];
		for (const c of content) {
			if (c?.text) {
				chars += String(c.text).length;
			}
			// Files/images count as ~1000 tokens each roughly
			if (c?.type === "input_image" || c?.type === "input_file") {
				chars += 4000;
			}
		}
	}

	return Math.ceil(chars / 4);
}

/**
 * Check if an error is a context window overflow error.
 *
 * @param {Error} error - The error to check
 * @returns {boolean} True if this is a context window error
 */
export function isContextWindowError(error) {
	const msg = String(error?.message || "").toLowerCase();
	const type = String(error?.type || "").toLowerCase();

	return (
		msg.includes("context window") ||
		msg.includes("exceeds") ||
		msg.includes("too many tokens") ||
		(type === "invalid_request_error" && error?.param === "input")
	);
}

/**
 * Create a summary of input items for debugging.
 *
 * @param {Array} items - Input items to summarize
 * @returns {Array} Summary objects with role, types, and text length
 */
export function summarizeInputItems(items) {
	try {
		return (items || []).map((item, idx) => {
			const types = Array.isArray(item?.content)
				? item.content.map((c) => c?.type).filter(Boolean)
				: [];

			const textLens = Array.isArray(item?.content)
				? item.content.filter((c) => c?.type === "input_text").map((c) => (c.text || "").length)
				: [];

			const totalText = textLens.reduce((a, b) => a + b, 0);

			return { idx, role: item?.role, types, totalText };
		});
	} catch {
		return [];
	}
}
