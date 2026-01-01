/**
 * Tests for output handler utilities.
 */

import {
	createOutputPreview,
	ensureSafeOutput,
	HARD_MAX_OUTPUT_CHARS,
	truncateOutput,
} from "../output-handler.js";

describe("ensureSafeOutput", () => {
	it("should return output unchanged if under limit", () => {
		const output = { ok: true, data: "small" };
		expect(ensureSafeOutput(output, "test", 100)).toEqual(output);
	});

	it("should return error object if output exceeds limit", () => {
		// Create an output larger than HARD_MAX_OUTPUT_CHARS
		const largeData = "x".repeat(HARD_MAX_OUTPUT_CHARS + 1000);
		const output = { data: largeData };

		const result = ensureSafeOutput(output, "test_tool", HARD_MAX_OUTPUT_CHARS + 1000);

		expect(result.ok).toBe(false);
		expect(result.error).toContain("too large");
		expect(result.hint).toBeDefined();
	});
});

describe("createOutputPreview", () => {
	it("should return non-objects unchanged", () => {
		expect(createOutputPreview(null)).toBe(null);
		expect(createOutputPreview("string")).toBe("string");
		expect(createOutputPreview(123)).toBe(123);
	});

	it("should preserve simple fields", () => {
		const output = { ok: true, message: "success", count: 42 };
		const preview = createOutputPreview(output);

		expect(preview.ok).toBe(true);
		expect(preview.message).toBe("success");
		expect(preview.count).toBe(42);
	});

	it("should summarize arrays", () => {
		const output = { items: [1, 2, 3, 4, 5] };
		const preview = createOutputPreview(output);

		expect(preview.items).toBe("[Array with 5 items]");
		expect(preview.items_sample).toBe(1);
	});

	it("should summarize nested objects", () => {
		const output = { nested: { a: 1, b: 2, c: 3 } };
		const preview = createOutputPreview(output);

		expect(preview.nested).toContain("Object with 3 keys");
		expect(preview.nested).toContain("a, b, c");
	});

	it("should handle empty arrays", () => {
		const output = { items: [] };
		const preview = createOutputPreview(output);

		expect(preview.items).toBe("[Array with 0 items]");
		expect(preview.items_sample).toBeUndefined();
	});
});

describe("truncateOutput", () => {
	it("should return output unchanged if under limit", () => {
		const output = { data: "small" };
		expect(truncateOutput(output, 1000)).toEqual(output);
	});

	it("should truncate large output", () => {
		const largeData = "x".repeat(10000);
		const output = { data: largeData };

		const result = truncateOutput(output, 100);

		expect(result.truncated).toBe(true);
		expect(result.originalSize).toBeGreaterThan(100);
		expect(result.message).toContain("truncated");
	});
});
