/**
 * Tests for the thread-scoped credential placeholder store.
 */

import { afterEach, describe, expect, it } from "@jest/globals";
import {
	_clearAllCredentials,
	credentialThreadKey,
	storeCredential,
	substituteCredentials,
} from "../config-credentials.js";

describe("config-credentials", () => {
	afterEach(() => {
		_clearAllCredentials();
	});

	it("builds a thread key from channel and thread_ts", () => {
		expect(credentialThreadKey({ channel: "C1", thread_ts: "123.456" })).toBe("C1:123.456");
		expect(credentialThreadKey({ channel: "C1", ts: "9.9" })).toBe("C1:9.9");
	});

	it("stores a credential and substitutes its placeholder", () => {
		const ref = storeCredential({
			threadKey: "C1:1",
			agentLabel: "agent-a",
			encryptedPassword: "ENCRYPTED_BLOB",
		});
		expect(ref).toMatch(/^\{\{CRED:[a-f0-9]{8}\}\}$/);

		const result = substituteCredentials({
			threadKey: "C1:1",
			agentLabel: "agent-a",
			content: `snmp:\n  community: ${ref}\n`,
		});
		expect(result.content).toBe("snmp:\n  community: ENCRYPTED_BLOB\n");
		expect(result.substituted).toBe(1);
		expect(result.missingRefs).toEqual([]);
		expect(result.wrongAgentRefs).toEqual([]);
	});

	it("reports unknown placeholders instead of substituting", () => {
		const result = substituteCredentials({
			threadKey: "C1:1",
			agentLabel: "agent-a",
			content: "password: {{CRED:deadbeef}}",
		});
		expect(result.content).toContain("{{CRED:deadbeef}}");
		expect(result.substituted).toBe(0);
		expect(result.missingRefs).toEqual(["{{CRED:deadbeef}}"]);
	});

	it("refuses placeholders encrypted for another agent", () => {
		const ref = storeCredential({
			threadKey: "C1:1",
			agentLabel: "agent-a",
			encryptedPassword: "BLOB",
		});
		const result = substituteCredentials({
			threadKey: "C1:1",
			agentLabel: "agent-b",
			content: `password: ${ref}`,
		});
		expect(result.wrongAgentRefs).toEqual([ref]);
		expect(result.content).toContain(ref);
		expect(result.substituted).toBe(0);
	});

	it("scopes credentials to their thread", () => {
		const ref = storeCredential({
			threadKey: "C1:1",
			agentLabel: "agent-a",
			encryptedPassword: "BLOB",
		});
		const result = substituteCredentials({
			threadKey: "C2:2",
			agentLabel: "agent-a",
			content: `password: ${ref}`,
		});
		expect(result.missingRefs).toEqual([ref]);
	});
});
