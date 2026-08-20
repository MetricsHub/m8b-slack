/**
 * Tests for the application-side conversation store (Ollama mode).
 */

import { beforeEach, describe, expect, it } from "@jest/globals";
import {
	appendToConversation,
	clearConversationStore,
	conversationKey,
	getConversation,
	setConversation,
} from "../conversation-store.js";

describe("conversationKey", () => {
	it("keys by team, channel, and thread", () => {
		expect(conversationKey({ teamId: "T1", channel: "C1", threadTs: "123.456" })).toBe(
			"T1:C1:123.456"
		);
	});

	it("tolerates a missing team", () => {
		expect(conversationKey({ channel: "C1", threadTs: "123.456" })).toBe("unknown-team:C1:123.456");
	});
});

describe("conversation store", () => {
	beforeEach(() => {
		clearConversationStore();
	});

	it("returns null for unknown conversations", () => {
		expect(getConversation("T1:C1:1")).toBeNull();
	});

	it("stores and retrieves structured items", () => {
		const items = [
			{ role: "user", content: [{ type: "input_text", text: "My name is Bertrand." }] },
			{ role: "assistant", content: [{ type: "output_text", text: "Noted." }] },
		];

		setConversation("T1:C1:1", items);

		const stored = getConversation("T1:C1:1");
		expect(stored).toEqual(items);
		// Returned array is a copy: mutating it must not affect the store
		stored.pop();
		expect(getConversation("T1:C1:1")).toHaveLength(2);
	});

	it("appends items and keeps threads isolated", () => {
		setConversation("T1:C1:1", [
			{ role: "user", content: [{ type: "input_text", text: "My name is Bertrand." }] },
		]);
		appendToConversation("T1:C1:1", [
			{ role: "assistant", content: [{ type: "output_text", text: "Noted." }] },
		]);
		setConversation("T1:C1:2", [
			{ role: "user", content: [{ type: "input_text", text: "Unrelated thread" }] },
		]);

		expect(getConversation("T1:C1:1")).toHaveLength(2);
		expect(getConversation("T1:C1:2")).toHaveLength(1);
	});

	it("preserves tool-call items for replay", () => {
		const items = [
			{
				type: "function_call",
				call_id: "call_1",
				name: "SearchHost",
				arguments: '{"pattern":"x"}',
			},
			{ type: "function_call_output", call_id: "call_1", output: '{"ok":true}' },
		];

		setConversation("T1:C1:1", items);
		expect(getConversation("T1:C1:1")).toEqual(items);
	});

	it("bounds the number of stored items per conversation", () => {
		const many = Array.from({ length: 500 }, (_, i) => ({
			role: "user",
			content: [{ type: "input_text", text: `msg ${i}` }],
		}));

		setConversation("T1:C1:1", many);

		const stored = getConversation("T1:C1:1");
		expect(stored.length).toBeLessThanOrEqual(400);
		// Most recent items are kept
		expect(stored[stored.length - 1].content[0].text).toBe("msg 499");
	});
});
