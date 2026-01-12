/**
 * Tests for token utility functions.
 */

import { estimateTokenCount, isContextWindowError, summarizeInputItems } from "../tokens.js";

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
});

describe("isContextWindowError", () => {
	it("should return true for context window errors", () => {
		expect(isContextWindowError({ message: "context window exceeded" })).toBe(true);
		expect(isContextWindowError({ message: "Request exceeds limit" })).toBe(true);
		expect(isContextWindowError({ message: "too many tokens" })).toBe(true);
		expect(isContextWindowError({ type: "invalid_request_error", param: "input" })).toBe(true);
	});

	it("should return false for other errors", () => {
		expect(isContextWindowError({ message: "Rate limit exceeded" })).toBe(false);
		expect(isContextWindowError({ message: "Authentication failed" })).toBe(false);
		expect(isContextWindowError({ type: "invalid_request_error", param: "model" })).toBe(false);
		expect(isContextWindowError(null)).toBe(false);
		expect(isContextWindowError(undefined)).toBe(false);
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
});
