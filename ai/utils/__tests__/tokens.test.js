/**
 * Tests for token utility functions.
 */

import {
	estimatePayloadTokens,
	estimateTokenCount,
	getTokenCalibration,
	getTokenCalibrationFactor,
	isContextWindowError,
	recordTokenCalibration,
	resetTokenCalibration,
	summarizeInputItems,
} from "../tokens.js";

describe("token calibration", () => {
	beforeEach(() => resetTokenCalibration());
	afterEach(() => resetTokenCalibration());

	it("is neutral (factor 1) until a sample is recorded", () => {
		expect(getTokenCalibrationFactor()).toBe(1);
		expect(getTokenCalibration()).toEqual({ factor: 1, ema: null, samples: 0 });
	});

	it("ignores invalid samples", () => {
		recordTokenCalibration({ estimatedTokens: 0, actualTokens: 100 });
		recordTokenCalibration({ estimatedTokens: 100, actualTokens: 0 });
		recordTokenCalibration({ estimatedTokens: -5, actualTokens: -5 });
		expect(getTokenCalibration().samples).toBe(0);
	});

	it("tracks over-estimation with a safety margin, never expanding past 1", () => {
		// Estimates run 20% high: actual/estimated = 0.8
		recordTokenCalibration({ estimatedTokens: 10000, actualTokens: 8000 });
		// 0.8 * 1.05 margin = 0.84
		expect(getTokenCalibrationFactor()).toBeCloseTo(0.84, 5);

		// A ratio just under 1 must not be pushed above 1 by the margin
		resetTokenCalibration();
		recordTokenCalibration({ estimatedTokens: 10000, actualTokens: 9900 });
		expect(getTokenCalibrationFactor()).toBeLessThanOrEqual(1);
	});

	it("tracks under-estimation without any margin (tighter budgets apply fully)", () => {
		recordTokenCalibration({ estimatedTokens: 10000, actualTokens: 12000 });
		expect(getTokenCalibrationFactor()).toBeCloseTo(1.2, 5);
	});

	it("clamps extreme ratios", () => {
		recordTokenCalibration({ estimatedTokens: 10000, actualTokens: 1000 });
		expect(getTokenCalibrationFactor()).toBeCloseTo(0.75 * 1.05, 5);

		resetTokenCalibration();
		recordTokenCalibration({ estimatedTokens: 1000, actualTokens: 10000 });
		expect(getTokenCalibrationFactor()).toBe(1.5);
	});

	it("moves as an exponential average, not a last-value jump", () => {
		recordTokenCalibration({ estimatedTokens: 100, actualTokens: 100 }); // ema 1.0
		recordTokenCalibration({ estimatedTokens: 100, actualTokens: 200 }); // ema 0.7*1 + 0.3*2 = 1.3
		expect(getTokenCalibration().ema).toBeCloseTo(1.3, 5);
		expect(getTokenCalibration().samples).toBe(2);
	});
});

describe("estimateTokenCount", () => {
	it("should return 0 for empty input", () => {
		expect(estimateTokenCount([])).toBe(0);
		expect(estimateTokenCount(null)).toBe(0);
		expect(estimateTokenCount(undefined)).toBe(0);
	});

	it("should estimate tokens based on text length", () => {
		const input = [
			{
				role: "user",
				content: [{ type: "input_text", text: "Hello world!" }], // 12 chars
			},
		];
		// 12 chars / 4 = 3 tokens
		expect(estimateTokenCount(input)).toBe(3);
	});

	it("should add extra tokens for images and files", () => {
		const input = [
			{
				role: "user",
				content: [
					{ type: "input_text", text: "test" }, // 4 chars = 1 token
					{ type: "input_image" }, // ~1000 tokens (4000 chars)
				],
			},
		];
		// (4 + 4000) / 4 = 1001 tokens
		expect(estimateTokenCount(input)).toBe(1001);
	});

	it("should handle multiple items", () => {
		const input = [
			{ role: "system", content: [{ type: "input_text", text: "System prompt" }] },
			{ role: "user", content: [{ type: "input_text", text: "User message" }] },
			{ role: "assistant", content: [{ type: "output_text", text: "Response" }] },
		];
		// 13 + 12 + 8 = 33 chars / 4 = 9 tokens (rounded up)
		expect(estimateTokenCount(input)).toBe(9);
	});

	it("weighs tool payloads with the content-aware estimator", () => {
		const args = "x".repeat(500); // pure letters: ~3.9 chars/token
		const output = "9".repeat(3000); // pure digits: worst-case ~1.48 chars/token
		const input = [
			{ type: "function_call", call_id: "c1", arguments: args },
			{ type: "function_call_output", call_id: "c1", output },
		];

		// ceil(500/3.9) + ceil(3000/1.48) = 129 + 2028
		expect(estimateTokenCount(input)).toBe(
			estimatePayloadTokens(args) + estimatePayloadTokens(output)
		);
		expect(estimateTokenCount(input)).toBe(129 + 2028);
	});
});

describe("estimatePayloadTokens", () => {
	it("returns 0 for empty input", () => {
		expect(estimatePayloadTokens("")).toBe(0);
		expect(estimatePayloadTokens(null)).toBe(0);
		expect(estimatePayloadTokens(undefined)).toBe(0);
	});

	it("estimates prose-like payloads at ~3.9 chars/token", () => {
		const text = "the quick brown fox jumps over the lazy dog ".repeat(20);
		expect(estimatePayloadTokens(text)).toBe(Math.ceil(text.length / 3.9));
	});

	it("estimates digit- and punctuation-heavy tables at the worst-case density", () => {
		// Modeled on the VMAX volume rows that measured 1.49 chars/token live
		const text = "| 000297800620-00A1F | 5864777842688 | 1019200000000 |\n".repeat(50);
		expect(estimatePayloadTokens(text)).toBe(Math.ceil(text.length / 1.48));
	});

	it("is monotone: structurally denser content costs more tokens at equal length", () => {
		const prose = "monitoring status report ".repeat(40);
		const table = '| 4892830000000 | {"avg":0.84} |'.repeat(31);
		expect(table.length).toBeLessThanOrEqual(prose.length);
		expect(estimatePayloadTokens(table)).toBeGreaterThan(estimatePayloadTokens(prose));
	});
});

describe("isContextWindowError", () => {
	it("should return true for context window errors", () => {
		expect(isContextWindowError({ message: "context window exceeded" })).toBe(true);
		expect(isContextWindowError({ message: "Request exceeds limit" })).toBe(true);
		expect(isContextWindowError({ message: "too many tokens" })).toBe(true);
		expect(isContextWindowError({ type: "invalid_request_error", param: "input" })).toBe(true);
		// Ollama's overflow symptom: prompt front-truncated, user message lost
		expect(isContextWindowError({ message: "500 no user query found in messages" })).toBe(true);
	});

	it("should return false for other errors", () => {
		expect(isContextWindowError({ message: "Rate limit exceeded" })).toBe(false);
		expect(isContextWindowError({ message: "Authentication failed" })).toBe(false);
		expect(isContextWindowError({ type: "invalid_request_error", param: "model" })).toBe(false);
		expect(isContextWindowError(null)).toBe(false);
		expect(isContextWindowError(undefined)).toBe(false);
	});

	it("never matches vLLM schema-validation errors, which echo the submitted input", () => {
		// vLLM 400s dump the whole request into the message; the system prompt
		// contains phrases like "context window" that would substring-match
		const echoed = {
			message:
				"400 240 validation errors:\n {'type': 'string_type', 'loc': ('body','input','str'), " +
				"'input': [{'text': 'Your context window is limited (65536 tokens) and exceeds ...'}]}",
			status: 400,
			param: "body.input",
			type: "Bad Request",
		};
		expect(isContextWindowError(echoed)).toBe(false);
	});
});

describe("summarizeInputItems", () => {
	it("should return empty array for invalid input", () => {
		expect(summarizeInputItems(null)).toEqual([]);
		expect(summarizeInputItems(undefined)).toEqual([]);
		expect(summarizeInputItems([])).toEqual([]);
	});

	it("should summarize input items correctly", () => {
		const input = [
			{
				role: "system",
				content: [{ type: "input_text", text: "Hello" }],
			},
			{
				role: "user",
				content: [{ type: "input_text", text: "World" }, { type: "input_image" }],
			},
		];

		const summary = summarizeInputItems(input);

		expect(summary).toHaveLength(2);
		expect(summary[0]).toEqual({
			role: "system",
			types: "input_text",
			chars: 5,
			preview: "Hello",
		});
		expect(summary[1]).toEqual({
			role: "user",
			types: "input_text,input_image",
			chars: 5,
			preview: "World",
		});
	});

	it("should summarize assistant output and function output items", () => {
		const summary = summarizeInputItems([
			{
				role: "assistant",
				content: [{ type: "output_text", text: "Previous answer" }],
			},
			{
				type: "function_call_output",
				call_id: "call_123",
				output: '{"ok":true}',
			},
		]);

		expect(summary).toEqual([
			{
				role: "assistant",
				types: "output_text",
				chars: 15,
				preview: "Previous answer",
			},
			{
				role: "?",
				types: "function_call_output",
				chars: 11,
				preview: '{"ok":true}',
			},
		]);
	});
});
