/**
 * Token estimation and context window utilities.
 */

/**
 * Chars per token for prose (the classic ~4 chars ≈ 1 token heuristic).
 */
export const PROSE_CHARS_PER_TOKEN = 4;

/**
 * Nominal chars per token for tool payloads, used to convert token budgets
 * into character caps (context-budget truncation, the provider inline cap,
 * the tool-schema reserve). Actual token ESTIMATION is content-aware — see
 * estimatePayloadTokens — because real density varies from ~1.5 chars/token
 * (tables of long numbers) to ~4 (prose), measured live on qwen3.8:27b.
 */
export const PAYLOAD_CHARS_PER_TOKEN = 2.5;

/**
 * Content-aware token estimate for a tool payload string.
 *
 * Density tracks the share of "structural" characters (digits and
 * punctuation/symbols vs letters and spaces). Piecewise-linear curve
 * calibrated against real qwen3.8:27b prompt token counts (2026-08-20):
 *
 *   sample            structural ratio  real chars/token  estimate error
 *   English prose     0.15              3.95              +1.3%
 *   tool-schema JSON  0.19              4.28              +9.7%
 *   ECS telemetry MD  0.35              2.22              +1.5%
 *   summarized MD     0.42              2.01              +2.4%
 *   VMAX volume MD    0.55              1.49              +0.4%
 *
 * All errors are on the conservative side (estimate >= real): an
 * underestimate lets an oversized request through to the model, where the
 * server silently drops prompt from the front ("no user query found in
 * messages").
 *
 * @param {string} text - The payload string
 * @returns {number} Estimated token count
 */
export function estimatePayloadTokens(text) {
	if (!text) return 0;
	const str = String(text);

	let structural = 0;
	for (let i = 0; i < str.length; i++) {
		const c = str.charCodeAt(i);
		const isLetterOrSpace = (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 32;
		if (!isLetterOrSpace) structural++;
	}
	const ratio = structural / str.length;

	let density;
	if (ratio <= 0.2) {
		density = 3.9;
	} else if (ratio <= 0.35) {
		density = 3.9 + ((2.2 - 3.9) * (ratio - 0.2)) / 0.15;
	} else if (ratio <= 0.55) {
		density = 2.2 + ((1.48 - 2.2) * (ratio - 0.35)) / 0.2;
	} else {
		density = 1.48;
	}

	return Math.ceil(str.length / density);
}

/**
 * Estimate rough token count for input items.
 * Prose text is weighted at PROSE_CHARS_PER_TOKEN; tool payloads get the
 * content-aware estimate (see estimatePayloadTokens).
 *
 * @param {Array} inputItems - Array of input items with content
 * @returns {number} Estimated token count
 */
export function estimateTokenCount(inputItems) {
	let chars = 0;
	let payloadTokens = 0;

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

		// Tool-call items carry their payload at the top level
		if (typeof item?.arguments === "string") {
			payloadTokens += estimatePayloadTokens(item.arguments);
		}
		if (typeof item?.output === "string") {
			payloadTokens += estimatePayloadTokens(item.output);
		}
	}

	return Math.ceil(chars / PROSE_CHARS_PER_TOKEN) + payloadTokens;
}

/**
 * Prompt-token calibration: the estimates above are deliberately conservative,
 * so on a real conversation they typically over-count. Stateless providers
 * report the EXACT prompt size of every request (usage.input_tokens); an
 * exponential moving average of actual/estimated feeds a correction factor
 * back into the context budget, recovering headroom the raw estimates waste —
 * and tightening the budget if estimates ever under-count.
 *
 * The factor is safe by construction: clamped to [0.75, 1.5], and when it
 * would EXPAND the budget (ratio < 1) it is pulled 5% back toward 1 so a
 * shift in content mix cannot immediately push a prompt over the window.
 * State is in-memory (per process) and resets on restart.
 */
const CALIBRATION_EMA_ALPHA = 0.3;
const CALIBRATION_MIN_FACTOR = 0.75;
const CALIBRATION_MAX_FACTOR = 1.5;
const CALIBRATION_EXPANSION_MARGIN = 1.05;

let calibrationEma = null;
let calibrationSamples = 0;

/**
 * Record one (estimated, actual) prompt-token pair from a completed request.
 *
 * @param {Object} params
 * @param {number} params.estimatedTokens - Pre-flight estimate for the request (items + reserve)
 * @param {number} params.actualTokens - usage.input_tokens reported by the server
 */
export function recordTokenCalibration({ estimatedTokens, actualTokens }) {
	if (!(estimatedTokens > 0) || !(actualTokens > 0)) return;

	const ratio = actualTokens / estimatedTokens;
	calibrationEma =
		calibrationEma === null
			? ratio
			: CALIBRATION_EMA_ALPHA * ratio + (1 - CALIBRATION_EMA_ALPHA) * calibrationEma;
	calibrationSamples += 1;
}

/**
 * Current correction factor to apply to estimated prompt sizes
 * (estimate * factor ≈ actual). 1 until a sample has been recorded.
 *
 * @returns {number}
 */
export function getTokenCalibrationFactor() {
	if (calibrationEma === null) return 1;

	let factor = Math.min(Math.max(calibrationEma, CALIBRATION_MIN_FACTOR), CALIBRATION_MAX_FACTOR);
	if (factor < 1) {
		// Only partially trust over-estimation: keep a safety margin
		factor = Math.min(factor * CALIBRATION_EXPANSION_MARGIN, 1);
	}
	return factor;
}

/**
 * Calibration state snapshot (for logs and tests).
 *
 * @returns {{factor: number, ema: number|null, samples: number}}
 */
export function getTokenCalibration() {
	return { factor: getTokenCalibrationFactor(), ema: calibrationEma, samples: calibrationSamples };
}

/**
 * Reset the calibration state (used by tests).
 */
export function resetTokenCalibration() {
	calibrationEma = null;
	calibrationSamples = 0;
}

/**
 * Check if an error is a context window overflow error.
 *
 * @param {Error & {type?: string, param?: string}} error - The error to check
 * @returns {boolean} True if this is a context window error
 */
export function isContextWindowError(error) {
	const msg = String(error?.message || "").toLowerCase();
	const type = String(error?.type || "").toLowerCase();

	// vLLM schema-validation 400s echo the ENTIRE submitted input in the error
	// message, so any conversation containing phrases like "context window"
	// (the system prompt does) would substring-match below. A validation error
	// is a malformed request, never an overflow.
	if (msg.includes("validation error")) {
		return false;
	}

	return (
		msg.includes("context window") ||
		msg.includes("exceeds") ||
		msg.includes("too many tokens") ||
		// Ollama's overflow symptom: it front-truncates an oversized prompt,
		// the user message falls out of the window, and the request is
		// rejected with this message instead of a context-length error
		msg.includes("no user query found") ||
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
