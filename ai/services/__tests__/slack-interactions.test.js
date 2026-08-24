/**
 * Tests for the pending Slack interaction registry.
 */

import { afterEach, describe, expect, it, jest } from "@jest/globals";
import {
	_clearAllInteractions,
	completePendingInteraction,
	createPendingInteraction,
	decodeInteractionValue,
	encodeInteractionValue,
	getPendingInteraction,
	INTERACTION_INSTANCE_ID,
	updateInteractionData,
} from "../slack-interactions.js";

describe("slack-interactions", () => {
	afterEach(() => {
		_clearAllInteractions();
		jest.useRealTimers();
	});

	it("resolves when completed", async () => {
		const { id, promise } = createPendingInteraction({
			kind: "credentials",
			requesterUserId: "U1",
			timeoutMs: 60000,
		});

		expect(getPendingInteraction(id)).toMatchObject({
			kind: "credentials",
			requesterUserId: "U1",
		});
		expect(completePendingInteraction(id, { values: { a: 1 } })).toBe(true);

		await expect(promise).resolves.toEqual({ ok: true, value: { values: { a: 1 } } });
		expect(getPendingInteraction(id)).toBeNull();
	});

	it("cannot be completed twice", () => {
		const { id } = createPendingInteraction({
			kind: "config-approval",
			requesterUserId: "U1",
			timeoutMs: 60000,
		});
		expect(completePendingInteraction(id, { approved: true })).toBe(true);
		expect(completePendingInteraction(id, { approved: false })).toBe(false);
	});

	it("returns false for unknown ids", () => {
		expect(completePendingInteraction("nope", {})).toBe(false);
		expect(getPendingInteraction("nope")).toBeNull();
		expect(updateInteractionData("nope", {})).toBe(false);
	});

	it("merges extra data into a pending interaction", () => {
		const { id } = createPendingInteraction({
			kind: "credentials",
			requesterUserId: "U1",
			data: { agentLabel: "a" },
			timeoutMs: 60000,
		});
		expect(updateInteractionData(id, { messageTs: "1.2" })).toBe(true);
		expect(getPendingInteraction(id).data).toEqual({ agentLabel: "a", messageTs: "1.2" });
	});

	it("round-trips interaction values through encode/decode", () => {
		const encoded = encodeInteractionValue("abc-123");
		expect(encoded).toBe(`${INTERACTION_INSTANCE_ID}.abc-123`);
		expect(decodeInteractionValue(encoded)).toEqual({
			instanceId: INTERACTION_INSTANCE_ID,
			id: "abc-123",
			foreign: false,
		});
	});

	it("flags values from another bot instance as foreign", () => {
		expect(decodeInteractionValue("deadbeef.abc-123")).toEqual({
			instanceId: "deadbeef",
			id: "abc-123",
			foreign: true,
		});
		// Legacy/plain values (no instance prefix) are treated as foreign too
		expect(decodeInteractionValue("abc-123")).toMatchObject({ foreign: true });
		expect(decodeInteractionValue(undefined)).toMatchObject({ foreign: true, id: "" });
	});

	it("times out with {ok: false, timedOut: true}", async () => {
		jest.useFakeTimers();
		const { id, promise } = createPendingInteraction({
			kind: "credentials",
			requesterUserId: "U1",
			timeoutMs: 1000,
		});

		jest.advanceTimersByTime(1001);

		await expect(promise).resolves.toEqual({ ok: false, timedOut: true });
		expect(completePendingInteraction(id, {})).toBe(false);
	});
});
