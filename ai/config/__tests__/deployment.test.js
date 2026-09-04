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
			team: { info: jest.fn().mockResolvedValue({ ok: true, team: { name: "Acme Corp" } }) },
			auth: { test: jest.fn() },
		};
		const logger = { warn: jest.fn() };
		await expect(resolveOrganizationName(client, logger)).resolves.toBe("Acme Corp");
		expect(getOrganizationName()).toBe("Acme Corp");
		expect(client.auth.test).not.toHaveBeenCalled();
		expect(logger.warn).not.toHaveBeenCalled();
	});

	it("falls back to auth.test when team.info lacks the scope", async () => {
		const missingScope = Object.assign(new Error("An API error occurred: missing_scope"), {
			data: { ok: false, error: "missing_scope" },
		});
		const client = {
			team: { info: jest.fn().mockRejectedValue(missingScope) },
			auth: { test: jest.fn().mockResolvedValue({ ok: true, team: "Acme (auth)" }) },
		};
		const logger = { warn: jest.fn() };
		await expect(resolveOrganizationName(client, logger)).resolves.toBe("Acme (auth)");
		expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("missing_scope"));
		expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("team:read"));
	});

	it("leaves the name unknown when Slack cannot tell", async () => {
		const client = {
			team: { info: jest.fn().mockRejectedValue(new Error("boom")) },
			auth: { test: jest.fn().mockRejectedValue(new Error("boom too")) },
		};
		await expect(resolveOrganizationName(client, { warn: jest.fn() })).resolves.toBeNull();
		expect(getOrganizationName()).toBeNull();
	});
});

describe("getDeploymentContext", () => {
	it("bundles the organization name and the notes for buildSystemPrompt", () => {
		setOrganizationName("Acme Corp");
		loadDeploymentNotes({ M8B_PROMPT_EXTRA: "Note." });
		expect(getDeploymentContext()).toEqual({
			organizationName: "Acme Corp",
			deploymentNotes: "Note.",
		});
	});
});
