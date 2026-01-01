/**
 * Tests for context manager service.
 */

import { findLastBotMessage } from "../context-manager.js";

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
