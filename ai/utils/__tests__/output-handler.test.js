/**
 * Tests for output handler utilities.
 * These utilities handle safety limits and output previews.
 */

import { createOutputPreview, ensureSafeOutput, HARD_MAX_OUTPUT_CHARS } from "../output-handler.js";

describe("ensureSafeOutput", () => {
	it("should return output unchanged if under limit", () => {
		const output = { ok: true, data: "small" };
		expect(ensureSafeOutput(output, "test")).toEqual(output);
	});

	it("should return error object if output exceeds hard limit", () => {
		const largeData = "x".repeat(HARD_MAX_OUTPUT_CHARS + 1000);
		const output = { data: largeData };

		const result = ensureSafeOutput(output, "test_tool");

		expect(result.ok).toBe(false);
		expect(result.error).toContain("too large");
		expect(result.hint).toContain("maxResults");
	});
});

describe("createOutputPreview", () => {
	it("should return non-objects unchanged", () => {
		expect(createOutputPreview(null)).toBe(null);
		expect(createOutputPreview("string")).toBe("string");
		expect(createOutputPreview(123)).toBe(123);
	});

	it("should preserve simple fields", () => {
		const output = { ok: true, count: 5, message: "done" };
		const preview = createOutputPreview(output);

		expect(preview.ok).toBe(true);
		expect(preview.count).toBe(5);
		expect(preview.message).toBe("done");
	});

	it("should summarize arrays", () => {
		const output = { items: [1, 2, 3, 4, 5] };
		const preview = createOutputPreview(output);

		expect(preview.items).toBe("[Array: 5 items]");
		expect(preview.items_sample).toBe(1);
	});

	it("should summarize nested objects", () => {
		const output = { nested: { a: 1, b: 2, c: 3 } };
		const preview = createOutputPreview(output);

		expect(preview.nested).toBe("{Object: 3 keys}");
	});

	it("should handle empty arrays", () => {
		const output = { items: [] };
		const preview = createOutputPreview(output);

		expect(preview.items).toBe("[Array: 0 items]");
	});

	it("should handle deeply nested structures", () => {
		const output = {
			level1: {
				level2: {
					level3: [1, 2, 3],
				},
			},
		};
		const preview = createOutputPreview(output);

		expect(preview.level1).toBe("{Object: 1 keys}");
	});
});
