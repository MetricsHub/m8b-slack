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
 * @returns {Array} Summary objects with role, types, and text preview
 */
export function summarizeInputItems(items) {
	try {
		return (items || []).map((item) => {
			const content = Array.isArray(item?.content) ? item.content : [];
			const types = content.map((c) => c?.type).filter(Boolean);
			if (types.length === 0 && item?.type) types.push(item.type);
			const textContent = content.filter(
				(c) => c?.type === "input_text" || c?.type === "output_text"
			);
			const topLevelText = typeof item?.output === "string" ? item.output : "";

			// Get text preview from first text content
			const firstText = textContent[0]?.text || topLevelText;
			const textPreview = firstText
				? firstText.slice(0, 80).replace(/\n/g, " ") + (firstText.length > 80 ? "..." : "")
				: null;

			const totalText =
				textContent.reduce((sum, c) => sum + (c.text || "").length, 0) + topLevelText.length;

			// Build compact summary string
			const typeSummary = types.join(",") || "empty";
			const summary = {
				role: item?.role || "?",
				types: typeSummary,
				chars: totalText,
			};

			if (textPreview) {
				summary.preview = textPreview;
			}

			return summary;
		});
	} catch {
		return [];
	}
}
