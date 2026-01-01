/**
 * Tests for JSON parser utilities.
 */

import { tryParseJsonString } from "../json-parser.js";

describe("tryParseJsonString", () => {
	it("should return non-string values unchanged", () => {
		expect(tryParseJsonString(123)).toBe(123);
		expect(tryParseJsonString(null)).toBe(null);
		expect(tryParseJsonString(undefined)).toBe(undefined);
		expect(tryParseJsonString(true)).toBe(true);
	});

	it("should return non-JSON strings unchanged", () => {
		expect(tryParseJsonString("hello")).toBe("hello");
		expect(tryParseJsonString("not json")).toBe("not json");
		expect(tryParseJsonString("")).toBe("");
	});

	it("should parse valid JSON objects", () => {
		const input = '{"key": "value", "num": 42}';
		expect(tryParseJsonString(input)).toEqual({ key: "value", num: 42 });
	});

	it("should parse valid JSON arrays", () => {
		const input = "[1, 2, 3]";
		expect(tryParseJsonString(input)).toEqual([1, 2, 3]);
	});

	it("should handle nested stringified JSON", () => {
		const inner = JSON.stringify({ nested: true });
		const outer = JSON.stringify({ data: inner });
		expect(tryParseJsonString(outer)).toEqual({ data: { nested: true } });
	});

	it("should recursively parse arrays with JSON strings", () => {
		const input = ['{"a": 1}', '{"b": 2}'];
		expect(tryParseJsonString(input)).toEqual([{ a: 1 }, { b: 2 }]);
	});

	it("should recursively parse objects with JSON string values", () => {
		const input = { result: '{"inner": "value"}' };
		expect(tryParseJsonString(input)).toEqual({ result: { inner: "value" } });
	});

	it("should return invalid JSON strings unchanged", () => {
		expect(tryParseJsonString("{invalid json}")).toBe("{invalid json}");
		expect(tryParseJsonString("[1, 2, 3")).toBe("[1, 2, 3");
	});

	it("should handle whitespace around JSON", () => {
		expect(tryParseJsonString('  {"key": "value"}  ')).toEqual({ key: "value" });
		expect(tryParseJsonString("\n[1, 2]\n")).toEqual([1, 2]);
	});
});
