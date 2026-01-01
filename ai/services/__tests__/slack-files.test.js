/**
 * Tests for Slack files service.
 */

import { extractPreviousUploads } from "../slack-files.js";

describe("extractPreviousUploads", () => {
	it("should return empty map when no messages have uploads", () => {
		const messages = [
			{ ts: "1", text: "Hello" },
			{ ts: "2", text: "World" },
		];

		const result = extractPreviousUploads(messages);

		expect(result.size).toBe(0);
	});

	it("should extract uploaded file mappings from metadata", () => {
		const messages = [
			{
				ts: "1",
				metadata: {
					event_type: "openai_context",
					event_payload: {
						response_id: "resp_123",
						uploaded_files: [
							{ slack_file_id: "F1", openai_file_id: "file-abc123" },
							{ slack_file_id: "F2", openai_file_id: "file-def456" },
						],
					},
				},
			},
		];

		const result = extractPreviousUploads(messages);

		expect(result.size).toBe(2);
		expect(result.get("F1")).toBe("file-abc123");
		expect(result.get("F2")).toBe("file-def456");
	});

	it("should ignore messages without openai_context event type", () => {
		const messages = [
			{
				ts: "1",
				metadata: {
					event_type: "other_event",
					event_payload: {
						uploaded_files: [{ slack_file_id: "F1", openai_file_id: "file-abc" }],
					},
				},
			},
		];

		const result = extractPreviousUploads(messages);

		expect(result.size).toBe(0);
	});

	it("should handle invalid upload entries gracefully", () => {
		const messages = [
			{
				ts: "1",
				metadata: {
					event_type: "openai_context",
					event_payload: {
						response_id: "resp_123",
						uploaded_files: [
							{ slack_file_id: "F1", openai_file_id: "file-abc" },
							{ slack_file_id: null, openai_file_id: "file-def" }, // Invalid
							{ slack_file_id: "F3" }, // Missing openai_file_id
						],
					},
				},
			},
		];

		const result = extractPreviousUploads(messages);

		expect(result.size).toBe(1);
		expect(result.get("F1")).toBe("file-abc");
	});

	it("should accumulate uploads from multiple messages", () => {
		const messages = [
			{
				ts: "1",
				metadata: {
					event_type: "openai_context",
					event_payload: {
						response_id: "resp_1",
						uploaded_files: [{ slack_file_id: "F1", openai_file_id: "file-1" }],
					},
				},
			},
			{
				ts: "2",
				metadata: {
					event_type: "openai_context",
					event_payload: {
						response_id: "resp_2",
						uploaded_files: [{ slack_file_id: "F2", openai_file_id: "file-2" }],
					},
				},
			},
		];

		const result = extractPreviousUploads(messages);

		expect(result.size).toBe(2);
		expect(result.get("F1")).toBe("file-1");
		expect(result.get("F2")).toBe("file-2");
	});
});
