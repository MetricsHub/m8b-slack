/**
 * Tests for citation service.
 */

import { extractCitations, hasFileCiteTokens, stripFileCiteTokens } from "../citations.js";

describe("extractCitations", () => {
	it("should return empty map for null/undefined response", () => {
		expect(extractCitations(null).size).toBe(0);
		expect(extractCitations(undefined).size).toBe(0);
	});

	it("should return empty map when no output", () => {
		expect(extractCitations({}).size).toBe(0);
		expect(extractCitations({ output: [] }).size).toBe(0);
	});

	it("should extract citations from output_text items", () => {
		const response = {
			output: [
				{
					type: "output_text",
					text: "Some response",
					annotations: [
						{ type: "file_citation", file_id: "file-123", filename: "doc.pdf" },
						{ type: "file_citation", file_id: "file-456", filename: "notes.md" },
					],
				},
			],
		};

		const citations = extractCitations(response);

		expect(citations.size).toBe(2);
		expect(citations.get("file-123")).toBe("doc.pdf");
		expect(citations.get("file-456")).toBe("notes.md");
	});

	it("should extract citations from message items", () => {
		const response = {
			output: [
				{
					type: "message",
					content: [
						{
							text: "Some text",
							annotations: [{ type: "file_citation", file_id: "file-789", filename: "report.pdf" }],
						},
					],
				},
			],
		};

		const citations = extractCitations(response);

		expect(citations.size).toBe(1);
		expect(citations.get("file-789")).toBe("report.pdf");
	});

	it("should use file_id as fallback filename", () => {
		const response = {
			output: [
				{
					type: "output_text",
					annotations: [{ type: "file_citation", file_id: "file-abc" }],
				},
			],
		};

		const citations = extractCitations(response);

		expect(citations.get("file-abc")).toBe("file-abc");
	});

	it("should ignore non-file_citation annotations", () => {
		const response = {
			output: [
				{
					type: "output_text",
					annotations: [
						{ type: "url_citation", url: "https://example.com" },
						{ type: "file_citation", file_id: "file-only" },
					],
				},
			],
		};

		const citations = extractCitations(response);

		expect(citations.size).toBe(1);
		expect(citations.has("file-only")).toBe(true);
	});
});

describe("hasFileCiteTokens", () => {
	it("should return true when filecite tokens present", () => {
		expect(hasFileCiteTokens("Text \ue200filecite:abc123 more text")).toBe(true);
	});

	it("should return false when no filecite tokens", () => {
		expect(hasFileCiteTokens("Regular text without tokens")).toBe(false);
		expect(hasFileCiteTokens("")).toBe(false);
	});
});

describe("stripFileCiteTokens", () => {
	it("should remove filecite tokens", () => {
		const input = "Text \ue200filecite:abc123 more \ue200filecite:def456 text";
		const expected = "Text  more  text";

		expect(stripFileCiteTokens(input)).toBe(expected);
	});

	it("should return unchanged text when no tokens", () => {
		const input = "Regular text without tokens";
		expect(stripFileCiteTokens(input)).toBe(input);
	});
});
