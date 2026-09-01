import { beforeEach, describe, expect, it } from "@jest/globals";
import {
	beginRun,
	clearThreadInbox,
	endRun,
	enqueueIfActive,
	hasPending,
	takePending,
	threadRunKey,
} from "../thread-inbox.js";

const entry = (user, ts) => ({ message: { user, ts, text: `msg ${ts}` } });

beforeEach(() => {
	clearThreadInbox();
});

describe("threadRunKey", () => {
	it("builds a channel:thread key", () => {
		expect(threadRunKey({ channel: "C1", threadTs: "100.1" })).toBe("C1:100.1");
	});
});

describe("thread inbox lifecycle", () => {
	it("does not enqueue when no run owns the thread", () => {
		expect(enqueueIfActive("C1:100.1", entry("U1", "100.2"))).toBe(false);
		expect(hasPending("C1:100.1")).toBe(false);
	});

	it("queues messages while a run is active and drains them in ts order", () => {
		beginRun("C1:100.1");
		expect(enqueueIfActive("C1:100.1", entry("U1", "100.9"))).toBe(true);
		expect(enqueueIfActive("C1:100.1", entry("U1", "100.3"))).toBe(true);

		expect(hasPending("C1:100.1")).toBe(true);
		const taken = takePending("C1:100.1");
		expect(taken.map((e) => e.message.ts)).toEqual(["100.3", "100.9"]);

		// Drained: nothing left
		expect(hasPending("C1:100.1")).toBe(false);
		expect(takePending("C1:100.1")).toEqual([]);
	});

	it("filters with a predicate and keeps non-matching entries queued", () => {
		beginRun("C1:100.1");
		enqueueIfActive("C1:100.1", entry("U1", "100.2"));
		enqueueIfActive("C1:100.1", entry("U2", "100.3"));
		enqueueIfActive("C1:100.1", entry("U1", "100.4"));

		const fromU1 = (e) => e.message.user === "U1";
		expect(hasPending("C1:100.1", fromU1)).toBe(true);

		const taken = takePending("C1:100.1", fromU1);
		expect(taken.map((e) => e.message.ts)).toEqual(["100.2", "100.4"]);

		// U2's message is still waiting for its own run
		expect(hasPending("C1:100.1", fromU1)).toBe(false);
		expect(hasPending("C1:100.1")).toBe(true);
		expect(endRun("C1:100.1").map((e) => e.message.user)).toEqual(["U2"]);
	});

	it("releases the thread on endRun and returns the leftovers", () => {
		beginRun("C1:100.1");
		enqueueIfActive("C1:100.1", entry("U1", "100.2"));

		expect(endRun("C1:100.1").map((e) => e.message.ts)).toEqual(["100.2"]);

		// The thread is free again: enqueue is refused, a new run can begin
		expect(enqueueIfActive("C1:100.1", entry("U1", "100.5"))).toBe(false);
		beginRun("C1:100.1");
		expect(enqueueIfActive("C1:100.1", entry("U1", "100.5"))).toBe(true);
	});

	it("endRun on an unknown key returns an empty list", () => {
		expect(endRun("C9:999.9")).toEqual([]);
	});

	it("keeps threads independent", () => {
		beginRun("C1:100.1");
		beginRun("C2:200.1");
		enqueueIfActive("C1:100.1", entry("U1", "100.2"));

		expect(hasPending("C1:100.1")).toBe(true);
		expect(hasPending("C2:200.1")).toBe(false);
	});
});
