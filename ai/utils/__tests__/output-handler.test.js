/**
 * Tests for output handler utilities (pagination-based).
 */

import {
	applyPagination,
	createOutputPreview,
	DEFAULT_MAX_RESULTS,
	ensureSafeOutput,
	findPrimaryDataArray,
	HARD_MAX_OUTPUT_CHARS,
	handleToolOutput,
	paginateArray,
	paginateObject,
} from "../output-handler.js";

describe("findPrimaryDataArray", () => {
	it("should return null for non-objects", () => {
		expect(findPrimaryDataArray(null)).toBe(null);
		expect(findPrimaryDataArray("string")).toBe(null);
		expect(findPrimaryDataArray(123)).toBe(null);
	});

	it("should find common array fields", () => {
		const output = { ok: true, items: [1, 2, 3] };
		const result = findPrimaryDataArray(output);

		expect(result).not.toBe(null);
		expect(result.key).toBe("items");
		expect(result.data).toEqual([1, 2, 3]);
		expect(result.isObject).toBe(false);
	});

	it("should find object maps like hosts", () => {
		const output = { ok: true, hosts: { host1: { name: "a" }, host2: { name: "b" } } };
		const result = findPrimaryDataArray(output);

		expect(result).not.toBe(null);
		expect(result.key).toBe("hosts");
		expect(result.isObject).toBe(true);
	});

	it("should prioritize known field names", () => {
		const output = { items: [1], results: [2, 3], randomArray: [4, 5, 6, 7, 8, 9] };
		const result = findPrimaryDataArray(output);

		expect(result.key).toBe("items");
	});

	it("should fall back to any large array", () => {
		const output = { ok: true, myCustomData: [1, 2, 3, 4, 5, 6, 7, 8] };
		const result = findPrimaryDataArray(output);

		expect(result).not.toBe(null);
		expect(result.key).toBe("myCustomData");
	});

	it("should return null when no arrays found", () => {
		const output = { ok: true, message: "success" };
		expect(findPrimaryDataArray(output)).toBe(null);
	});
});

describe("paginateArray", () => {
	it("should return all items when array is small", () => {
		const arr = [1, 2, 3, 4, 5];
		const result = paginateArray(arr, 0, 50);

		expect(result.items).toEqual([1, 2, 3, 4, 5]);
		expect(result.pagination.total).toBe(5);
		expect(result.pagination.hasMore).toBe(false);
		expect(result.pagination.remaining).toBe(0);
	});

	it("should paginate large arrays", () => {
		const arr = Array.from({ length: 100 }, (_, i) => i);
		const result = paginateArray(arr, 0, 10);

		expect(result.items).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
		expect(result.pagination.total).toBe(100);
		expect(result.pagination.hasMore).toBe(true);
		expect(result.pagination.remaining).toBe(90);
		expect(result.pagination.nextOffset).toBe(10);
	});

	it("should handle offset correctly", () => {
		const arr = Array.from({ length: 100 }, (_, i) => i);
		const result = paginateArray(arr, 50, 10);

		expect(result.items).toEqual([50, 51, 52, 53, 54, 55, 56, 57, 58, 59]);
		expect(result.pagination.offset).toBe(50);
		expect(result.pagination.remaining).toBe(40);
	});

	it("should handle last page correctly", () => {
		const arr = Array.from({ length: 25 }, (_, i) => i);
		const result = paginateArray(arr, 20, 10);

		expect(result.items).toEqual([20, 21, 22, 23, 24]);
		expect(result.pagination.hasMore).toBe(false);
		expect(result.pagination.remaining).toBe(0);
		expect(result.pagination.nextOffset).toBe(null);
	});

	it("should handle non-array input", () => {
		const result = paginateArray("not an array", 0, 10);
		expect(result.items).toBe("not an array");
		expect(result.pagination).toBe(null);
	});
});

describe("paginateObject", () => {
	it("should paginate object keys", () => {
		const obj = { a: 1, b: 2, c: 3, d: 4, e: 5 };
		const result = paginateObject(obj, 0, 3);

		expect(Object.keys(result.entries).length).toBe(3);
		expect(result.pagination.total).toBe(5);
		expect(result.pagination.hasMore).toBe(true);
		expect(result.pagination.remaining).toBe(2);
	});

	it("should handle offset for objects", () => {
		const obj = { a: 1, b: 2, c: 3, d: 4, e: 5 };
		const result = paginateObject(obj, 2, 2);

		expect(Object.keys(result.entries).length).toBe(2);
		expect(result.pagination.offset).toBe(2);
	});

	it("should handle non-object input", () => {
		const result = paginateObject([1, 2, 3], 0, 10);
		expect(result.entries).toEqual([1, 2, 3]);
		expect(result.pagination).toBe(null);
	});
});

describe("applyPagination", () => {
	it("should not modify small outputs", () => {
		const output = { ok: true, items: [1, 2, 3] };
		const result = applyPagination(output, { maxResults: 50, offset: 0 });

		expect(result.items).toEqual([1, 2, 3]);
		expect(result._pagination).toBeUndefined();
	});

	it("should paginate large arrays", () => {
		const output = {
			ok: true,
			items: Array.from({ length: 100 }, (_, i) => ({ id: i })),
		};
		const result = applyPagination(output, { maxResults: 10, offset: 0 });

		expect(result.items.length).toBe(10);
		expect(result._pagination).toBeDefined();
		expect(result._pagination.total).toBe(100);
		expect(result._pagination.hasMore).toBe(true);
		expect(result._pagination.hint).toContain("offset=10");
	});

	it("should paginate object maps", () => {
		const hosts = {};
		for (let i = 0; i < 100; i++) {
			hosts[`host-${i}`] = { name: `Host ${i}` };
		}
		const output = { ok: true, hosts };
		const result = applyPagination(output, { maxResults: 10, offset: 0 });

		expect(Object.keys(result.hosts).length).toBe(10);
		expect(result._pagination.total).toBe(100);
	});

	it("should handle pagination offset", () => {
		const output = {
			ok: true,
			items: Array.from({ length: 100 }, (_, i) => ({ id: i })),
		};
		const result = applyPagination(output, { maxResults: 10, offset: 50 });

		expect(result.items[0].id).toBe(50);
		expect(result._pagination.offset).toBe(50);
	});

	it("should use default maxResults", () => {
		const output = {
			ok: true,
			items: Array.from({ length: 100 }, (_, i) => ({ id: i })),
		};
		const result = applyPagination(output);

		expect(result.items.length).toBe(DEFAULT_MAX_RESULTS);
	});

	it("should preserve upstream _pagination metadata from MCP", () => {
		// Simulate MCP output with 25 hosts already paginated, but total is 150
		const output = {
			ok: true,
			hosts: Object.fromEntries(
				Array.from({ length: 25 }, (_, i) => [`host-${i}`, { name: `Host ${i}` }])
			),
			_pagination: {
				total: 150,
				hasMore: true,
				nextOffset: 25,
			},
		};
		const result = applyPagination(output, { maxResults: 25, offset: 0 });

		// Should preserve the MCP's total of 150, not compute 25 from local data
		expect(result._pagination.total).toBe(150);
		expect(result._pagination.hasMore).toBe(true);
		expect(result._pagination.nextOffset).toBe(25);
		expect(result._pagination.hint).toContain("150");
	});

	it("should preserve upstream total when further reducing page size", () => {
		// Simulate MCP output with too much data that needs further reduction
		const output = {
			ok: true,
			hosts: Object.fromEntries(
				Array.from({ length: 50 }, (_, i) => [`host-${i}`, { name: `Host ${i}` }])
			),
			_pagination: {
				total: 150,
				hasMore: true,
				nextOffset: 50,
			},
		};
		const result = applyPagination(output, { maxResults: 25, offset: 0 });

		// When reducing from 50 to 25, should still show total of 150
		expect(result._pagination.total).toBe(150);
		expect(Object.keys(result.hosts).length).toBe(25);
		expect(result._pagination.hint).toContain("150");
	});
});

describe("ensureSafeOutput", () => {
	it("should return output unchanged if under limit", () => {
		const output = { ok: true, data: "small" };
		expect(ensureSafeOutput(output, "test", 100)).toEqual(output);
	});

	it("should return error object if output exceeds limit", () => {
		const largeData = "x".repeat(HARD_MAX_OUTPUT_CHARS + 1000);
		const output = { data: largeData };

		const result = ensureSafeOutput(output, "test_tool", HARD_MAX_OUTPUT_CHARS + 1000);

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
});

describe("handleToolOutput", () => {
	it("should return small outputs unchanged", () => {
		const output = { ok: true, items: [1, 2, 3] };
		const { output: result } = handleToolOutput(output, "test");

		expect(result.items).toEqual([1, 2, 3]);
	});

	it("should apply pagination to large outputs", () => {
		const output = {
			ok: true,
			items: Array.from({ length: 100 }, (_, i) => ({ id: i, data: "x".repeat(100) })),
		};
		const { output: result } = handleToolOutput(output, "test", { maxResults: 10 });

		expect(result.items.length).toBe(10);
		expect(result._pagination).toBeDefined();
		expect(result._pagination.hasMore).toBe(true);
	});

	it("should respect offset parameter", () => {
		const output = {
			ok: true,
			items: Array.from({ length: 100 }, (_, i) => ({ id: i })),
		};
		const { output: result } = handleToolOutput(output, "test", { maxResults: 10, offset: 20 });

		expect(result.items[0].id).toBe(20);
		expect(result._pagination.offset).toBe(20);
	});

	it("should auto-reduce page size if still too large", () => {
		const output = {
			ok: true,
			items: Array.from({ length: 100 }, (_, i) => ({
				id: i,
				data: "x".repeat(5000),
			})),
		};
		const { output: result } = handleToolOutput(output, "test", { maxResults: 50 });

		// Should have reduced the page size automatically
		expect(result.items.length).toBeLessThan(50);
		if (result._pagination?.autoReduced) {
			expect(result._pagination.actualLimit).toBeLessThan(result._pagination.requestedLimit);
		}
	});
});
