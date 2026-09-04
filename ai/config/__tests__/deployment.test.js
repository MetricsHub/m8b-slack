/**
 * Tests for the deployment-specific prompt context (organization name from
 * Slack, append-only deployment notes from the environment).
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import {
	getDeploymentContext,
	getDeploymentNotes,
	getOrganizationName,
	loadDeploymentNotes,
	MAX_PROMPT_EXTRA_CHARS,
	readDeploymentNotes,
	resetDeploymentContext,
	resolveOrganizationName,
	resolveOrganizationNameFor,
	setOrganizationName,
} from "../deployment.js";

const tempDir = mkdtempSync(join(tmpdir(), "m8b-deployment-"));

afterAll(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(() => {
	resetDeploymentContext();
});

afterEach(() => {
	resetDeploymentContext();
});

describe("readDeploymentNotes", () => {
	it("returns an empty string when nothing is configured", () => {
		expect(readDeploymentNotes({})).toBe("");
		expect(readDeploymentNotes({ M8B_PROMPT_EXTRA: "   ", M8B_PROMPT_EXTRA_FILE: "" })).toBe("");
	});

	it("uses the inline variable, trimmed", () => {
		expect(
			readDeploymentNotes({ M8B_PROMPT_EXTRA: "  Escalate storage issues to #storage.\n" })
		).toBe("Escalate storage issues to #storage.");
	});

	it("reads the file variable and strips a UTF-8 BOM", () => {
		const file = join(tempDir, "notes.md");
		writeFileSync(file, "﻿# Local notes\n\nThe boss is on the 3rd floor.\n", "utf8");
		expect(readDeploymentNotes({ M8B_PROMPT_EXTRA_FILE: file })).toBe(
			"# Local notes\n\nThe boss is on the 3rd floor."
		);
	});

	it("puts the file before the inline text when both are set", () => {
		const file = join(tempDir, "both.md");
		writeFileSync(file, "From the file.", "utf8");
		expect(
			readDeploymentNotes({ M8B_PROMPT_EXTRA_FILE: file, M8B_PROMPT_EXTRA: "From the env." })
		).toBe("From the file.\n\nFrom the env.");
	});

	it("throws on an unreadable file instead of running without the overlay", () => {
		expect(() =>
			readDeploymentNotes({ M8B_PROMPT_EXTRA_FILE: join(tempDir, "does-not-exist.md") })
		).toThrow(/Cannot read M8B_PROMPT_EXTRA_FILE/);
	});

	it("refuses overlays that would eat the context window", () => {
		expect(() =>
			readDeploymentNotes({ M8B_PROMPT_EXTRA: "x".repeat(MAX_PROMPT_EXTRA_CHARS + 1) })
		).toThrow(/too long/);
	});
});

describe("loadDeploymentNotes / getDeploymentNotes", () => {
	it("caches what startup loaded", () => {
		expect(loadDeploymentNotes({ M8B_PROMPT_EXTRA: "Cached note." })).toBe("Cached note.");
		expect(getDeploymentNotes()).toBe("Cached note.");
	});

	it("loads lazily from process.env when startup did not", () => {
		const previous = process.env.M8B_PROMPT_EXTRA;
		process.env.M8B_PROMPT_EXTRA = "Lazy note.";
		try {
			expect(getDeploymentNotes()).toBe("Lazy note.");
		} finally {
			if (previous === undefined) delete process.env.M8B_PROMPT_EXTRA;
			else process.env.M8B_PROMPT_EXTRA = previous;
		}
	});
});

describe("organization name", () => {
	it("is null until resolved and trims what it is given", () => {
		expect(getOrganizationName()).toBeNull();
		setOrganizationName("  Acme Corp  ");
		expect(getOrganizationName()).toBe("Acme Corp");
		setOrganizationName("");
		expect(getOrganizationName()).toBeNull();
	});

	it("comes from team.info when the scope is granted", async () => {
		const client = {
			team: {
				info: jest.fn().mockResolvedValue({ ok: true, team: { id: "T1", name: "Acme Corp" } }),
			},
			auth: { test: jest.fn() },
		};
		const logger = { warn: jest.fn() };
		await expect(resolveOrganizationName(client, { logger })).resolves.toBe("Acme Corp");
		expect(client.team.info).toHaveBeenCalledWith({});
		expect(getOrganizationName()).toBe("Acme Corp");
		expect(getOrganizationName("T1")).toBe("Acme Corp");
		expect(client.auth.test).not.toHaveBeenCalled();
		expect(logger.warn).not.toHaveBeenCalled();
	});

	it("falls back to auth.test when team.info lacks the scope", async () => {
		const missingScope = Object.assign(new Error("An API error occurred: missing_scope"), {
			data: { ok: false, error: "missing_scope" },
		});
		const client = {
			team: { info: jest.fn().mockRejectedValue(missingScope) },
			auth: { test: jest.fn().mockResolvedValue({ ok: true, team: "Acme (auth)", team_id: "T1" }) },
		};
		const logger = { warn: jest.fn() };
		await expect(resolveOrganizationName(client, { logger })).resolves.toBe("Acme (auth)");
		expect(getOrganizationName("T1")).toBe("Acme (auth)");
		expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("missing_scope"));
		expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("team:read"));
	});

	it("leaves the name unknown when Slack cannot tell", async () => {
		const client = {
			team: { info: jest.fn().mockRejectedValue(new Error("boom")) },
			auth: { test: jest.fn().mockRejectedValue(new Error("boom too")) },
		};
		await expect(
			resolveOrganizationName(client, { logger: { warn: jest.fn() } })
		).resolves.toBeNull();
		expect(getOrganizationName()).toBeNull();
	});

	it("resolves other workspaces of an org-wide install by team ID, once", async () => {
		setOrganizationName("Acme HQ", "T1");
		setOrganizationName("Acme HQ");
		const client = {
			team: {
				info: jest.fn().mockResolvedValue({ ok: true, team: { id: "T2", name: "Acme Labs" } }),
			},
			auth: { test: jest.fn() },
		};
		await expect(resolveOrganizationNameFor({ client, teamId: "T2" })).resolves.toBe("Acme Labs");
		expect(client.team.info).toHaveBeenCalledWith({ team: "T2" });
		await expect(resolveOrganizationNameFor({ client, teamId: "T2" })).resolves.toBe("Acme Labs");
		expect(client.team.info).toHaveBeenCalledTimes(1);
		// The default (installing workspace) is untouched
		expect(getOrganizationName()).toBe("Acme HQ");
		expect(getOrganizationName("T1")).toBe("Acme HQ");
		expect(client.auth.test).not.toHaveBeenCalled();
	});

	it("falls back to the startup name for a workspace it cannot resolve, without retrying", async () => {
		setOrganizationName("Acme HQ");
		const client = {
			team: { info: jest.fn().mockRejectedValue(new Error("team_not_found")) },
			auth: { test: jest.fn() },
		};
		const logger = { warn: jest.fn() };
		await expect(resolveOrganizationNameFor({ client, teamId: "T9", logger })).resolves.toBe(
			"Acme HQ"
		);
		await expect(resolveOrganizationNameFor({ client, teamId: "T9", logger })).resolves.toBe(
			"Acme HQ"
		);
		expect(client.team.info).toHaveBeenCalledTimes(1);
		// auth.test only names the installing workspace: never used for another team
		expect(client.auth.test).not.toHaveBeenCalled();
	});

	it("uses the startup name when the message carries no team ID or client", async () => {
		setOrganizationName("Acme HQ");
		await expect(resolveOrganizationNameFor({})).resolves.toBe("Acme HQ");
		await expect(resolveOrganizationNameFor({ teamId: "T5" })).resolves.toBe("Acme HQ");
	});
});

describe("getDeploymentContext", () => {
	it("bundles the organization name and the notes for buildSystemPrompt", async () => {
		setOrganizationName("Acme Corp");
		loadDeploymentNotes({ M8B_PROMPT_EXTRA: "Note." });
		await expect(getDeploymentContext()).resolves.toEqual({
			organizationName: "Acme Corp",
			deploymentNotes: "Note.",
		});
	});

	it("picks the name of the workspace the message comes from", async () => {
		setOrganizationName("Acme HQ");
		setOrganizationName("Acme Labs", "T2");
		loadDeploymentNotes({});
		await expect(getDeploymentContext({ teamId: "T2" })).resolves.toEqual({
			organizationName: "Acme Labs",
			deploymentNotes: "",
		});
		await expect(getDeploymentContext({ teamId: "T1" })).resolves.toEqual({
			organizationName: "Acme HQ",
			deploymentNotes: "",
		});
	});
});
