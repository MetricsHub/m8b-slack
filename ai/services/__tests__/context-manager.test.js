/**
 * Tests for context manager service.
 */

import {
	buildConversationInput,
	buildVisionContext,
	findLastBotMessage,
} from "../context-manager.js";

describe("buildVisionContext", () => {
	const current = { ts: "5", text: "Here is the screenshot of the error" };

	it("joins the last few messages with the current one", () => {
		const messages = [
			{ ts: "1", text: "old message" },
			{ ts: "2", text: "my backup failed" },
			{ ts: "5", text: "Here is the screenshot of the error" }, // current, deduped by ts
		];

		const snippet = buildVisionContext(messages, current);

		expect(snippet).toBe("old message\nmy backup failed\nHere is the screenshot of the error");
	});

	it("keeps only the most recent messages and caps the length from the start", () => {
		const messages = Array.from({ length: 10 }, (_, i) => ({
			ts: String(i),
			text: `message number ${i} ${"x".repeat(300)}`,
		}));

		const snippet = buildVisionContext(messages, current, { maxMessages: 4, maxChars: 200 });

		expect(snippet.length).toBeLessThanOrEqual(201); // cap + leading ellipsis
		expect(snippet.startsWith("…")).toBe(true);
		expect(snippet).toContain("screenshot of the error"); // current message survives
	});

	it("handles empty threads", () => {
		expect(buildVisionContext([], { ts: "1", text: "hello" })).toBe("hello");
		expect(buildVisionContext([], {})).toBe("");
	});
});

describe("findLastBotMessage", () => {
	const mockContext = {
		BOT_ID: "B12345",
		BOT_USER_ID: "U12345",
	};

	it("should return -1 when no bot messages exist", () => {
		const messages = [
			{ ts: "1", user: "U99999", text: "Hello" },
			{ ts: "2", user: "U99999", text: "World" },
		];

		const result = findLastBotMessage(messages, mockContext);

		expect(result.index).toBe(-1);
		expect(result.message).toBeNull();
		expect(result.responseId).toBeNull();
	});

	it("should find bot message with openai_context metadata", () => {
		const messages = [
			{ ts: "1", user: "U99999", text: "Hello" },
			{
				ts: "2",
				bot_id: "B12345",
				text: "Response",
				metadata: {
					event_type: "openai_context",
					event_payload: { response_id: "resp_123" },
				},
			},
			{ ts: "3", user: "U99999", text: "Thanks" },
		];

		const result = findLastBotMessage(messages, mockContext);

		expect(result.index).toBe(1);
		expect(result.message.ts).toBe("2");
		expect(result.responseId).toBe("resp_123");
	});

	it("should return most recent bot message", () => {
		const messages = [
			{
				ts: "1",
				bot_id: "B12345",
				text: "First response",
				metadata: {
					event_type: "openai_context",
					event_payload: { response_id: "resp_1" },
				},
			},
			{ ts: "2", user: "U99999", text: "Another question" },
			{
				ts: "3",
				bot_id: "B12345",
				text: "Second response",
				metadata: {
					event_type: "openai_context",
					event_payload: { response_id: "resp_2" },
				},
			},
		];

		const result = findLastBotMessage(messages, mockContext);

		expect(result.index).toBe(2);
		expect(result.responseId).toBe("resp_2");
	});

	it("should match bot by user ID", () => {
		const messages = [
			{
				ts: "1",
				user: "U12345", // Bot's user ID
				text: "Response",
				metadata: {
					event_type: "openai_context",
					event_payload: { response_id: "resp_123" },
				},
			},
		];

		const result = findLastBotMessage(messages, mockContext);

		expect(result.index).toBe(0);
		expect(result.responseId).toBe("resp_123");
	});

	it("should ignore messages without proper metadata", () => {
		const messages = [
			{
				ts: "1",
				bot_id: "B12345",
				text: "Response without metadata",
			},
			{
				ts: "2",
				bot_id: "B12345",
				text: "Response with wrong metadata",
				metadata: { event_type: "other_event" },
			},
		];

		const result = findLastBotMessage(messages, mockContext);

		expect(result.index).toBe(-1);
	});
});

describe("buildConversationInput", () => {
	it("marks replayed bot messages as final answers", async () => {
		const messages = [
			{ ts: "1", bot_id: "B12345", text: "Completed answer" },
			{ ts: "2", user: "U99999", text: "Follow-up" },
			{ ts: "3", user: "U99999", text: "Current message" },
		];

		const result = await buildConversationInput(
			messages,
			-1,
			"3",
			{ BOT_ID: "B12345", userId: "U99999" },
			async () => null
		);

		expect(result[0]).toEqual({
			role: "assistant",
			phase: "final_answer",
			content: [{ type: "output_text", text: "Completed answer" }],
		});
	});

	it("skips Slack's synthetic Assistant thread root", async () => {
		const messages = [
			{
				ts: "1",
				thread_ts: "1",
				bot_id: "B12345",
				subtype: "assistant_app_thread",
				text: "Current question",
				assistant_app_thread: { title: "Current question" },
			},
			{ ts: "2", bot_id: "B12345", text: "Hi, how can I help?" },
			{ ts: "3", user: "U99999", text: "Current question" },
		];

		const result = await buildConversationInput(
			messages,
			-1,
			"3",
			{ BOT_ID: "B12345", userId: "U99999" },
			async () => null
		);

		expect(result).toEqual([
			{
				role: "assistant",
				phase: "final_answer",
				content: [{ type: "output_text", text: "Hi, how can I help?" }],
			},
		]);
	});
});
