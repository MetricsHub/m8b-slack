/**
 * Tests for OpenAI service helpers.
 */

import { createSafetyIdentifier } from "../openai.js";

describe("createSafetyIdentifier", () => {
	it("returns a stable 64-character hash", () => {
		const first = createSafetyIdentifier("U123", "T456");
		const second = createSafetyIdentifier("U123", "T456");

		expect(first).toBe(second);
		expect(first).toMatch(/^[a-f0-9]{64}$/);
		expect(first).not.toContain("U123");
	});

	it("scopes the identifier to the Slack workspace", () => {
		expect(createSafetyIdentifier("U123", "T456")).not.toBe(createSafetyIdentifier("U123", "T789"));
	});

	it("returns undefined without an identity", () => {
		expect(createSafetyIdentifier()).toBeUndefined();
	});
});
