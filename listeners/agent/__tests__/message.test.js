import { describe, expect, it, jest } from "@jest/globals";
import { createAgentThreadUtilities, normalizeAgentMessage } from "../message.js";

const baseMessage = {
	type: "message",
	channel_type: "im",
	channel: "D123",
	user: "U123",
	text: "How are the systems?",
	ts: "1234.5678",
	event_ts: "1234.5678",
};

describe("normalizeAgentMessage", () => {
	it("uses a root Agent View message as its own thread root", () => {
		expect(normalizeAgentMessage(baseMessage)).toMatchObject({
			thread_ts: "1234.5678",
			text: "How are the systems?",
		});
	});

	it("preserves the thread timestamp on a reply", () => {
		expect(
			normalizeAgentMessage({ ...baseMessage, ts: "1234.9999", thread_ts: "1234.5678" })
		).toMatchObject({
			ts: "1234.9999",
			thread_ts: "1234.5678",
		});
	});

	it("accepts a user message that shares a file", () => {
		expect(
			normalizeAgentMessage({
				...baseMessage,
				subtype: "file_share",
				files: [{ id: "F123" }],
			})
		).toMatchObject({
			thread_ts: "1234.5678",
			files: [{ id: "F123" }],
		});
	});

	it.each([
		[{ ...baseMessage, channel_type: "channel" }, "non-DM messages"],
		[{ ...baseMessage, subtype: "bot_message", bot_id: "B123" }, "bot messages"],
		[{ ...baseMessage, text: "" }, "empty messages"],
	])("ignores %s", (message) => {
		expect(normalizeAgentMessage(message)).toBeNull();
	});
});

describe("createAgentThreadUtilities", () => {
	it("targets the Agent View thread for messages, titles, and status", async () => {
		const client = {
			chat: { postMessage: jest.fn() },
			assistant: {
				threads: {
					setTitle: jest.fn(),
					setStatus: jest.fn(),
				},
			},
		};
		const { say, setTitle, setStatus } = createAgentThreadUtilities({
			client,
			channel: "D123",
			threadTs: "1234.5678",
		});

		await say({ text: "Done", metadata: { event_type: "openai_context" } });
		await setTitle("System status");
		await setStatus({ status: "thinking..." });

		expect(client.chat.postMessage).toHaveBeenCalledWith({
			channel: "D123",
			thread_ts: "1234.5678",
			text: "Done",
			metadata: { event_type: "openai_context" },
		});
		expect(client.assistant.threads.setTitle).toHaveBeenCalledWith({
			channel_id: "D123",
			thread_ts: "1234.5678",
			title: "System status",
		});
		expect(client.assistant.threads.setStatus).toHaveBeenCalledWith({
			channel_id: "D123",
			thread_ts: "1234.5678",
			status: "thinking...",
		});
	});
});
