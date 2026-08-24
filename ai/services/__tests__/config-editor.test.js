/**
 * Tests for the MetricsHub config-editing tool handlers.
 */

import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { _clearAllCredentials, storeCredential } from "../config-credentials.js";
import {
	applyConfigEdits,
	getConfigAdmins,
	handleDeleteResourceConfig,
	handleGetConfigFile,
	handleGetResourceConfig,
	handleModifyResourceConfig,
	handleSaveConfigFile,
	isConfigAdmin,
	isSafeConfigFileName,
	normalizeCredentialFields,
	renderConfigDiff,
} from "../config-editor.js";
import { _setServerSourceForTests } from "../metricshub-api.js";
import {
	_clearAllInteractions,
	completePendingInteraction,
	decodeInteractionValue,
} from "../slack-interactions.js";

const AGENT = {
	server_label: "agent-a",
	server_url: "http://mh:31888/sse",
	token: "tok",
	allowSelfSignedCert: false,
};

function makeResponse(status, body, contentType = "application/json") {
	return {
		ok: status >= 200 && status < 300,
		status,
		headers: { get: (name) => (name.toLowerCase() === "content-type" ? contentType : null) },
		json: async () => body,
		text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
	};
}

async function waitFor(predicate, attempts = 100) {
	for (let i = 0; i < attempts; i++) {
		if (predicate()) return;
		await new Promise((resolve) => setImmediate(resolve));
	}
	throw new Error("waitFor: condition never became true");
}

function extractInteractionId(sayMock) {
	const blocks = sayMock.mock.calls[0][0].blocks;
	const actions = blocks.find((block) => block.type === "actions");
	const decoded = decodeInteractionValue(actions.elements[0].value);
	expect(decoded.foreign).toBe(false);
	return decoded.id;
}

describe("config-editor", () => {
	const savedAdmins = process.env.METRICSHUB_CONFIG_ADMINS;
	const savedFetch = global.fetch;

	beforeEach(() => {
		process.env.METRICSHUB_CONFIG_ADMINS = "U1, U2";
		_setServerSourceForTests(() => [AGENT]);
	});

	afterEach(() => {
		if (savedAdmins === undefined) delete process.env.METRICSHUB_CONFIG_ADMINS;
		else process.env.METRICSHUB_CONFIG_ADMINS = savedAdmins;
		global.fetch = savedFetch;
		_setServerSourceForTests(null);
		_clearAllCredentials();
		_clearAllInteractions();
	});

	describe("authorization", () => {
		it("parses METRICSHUB_CONFIG_ADMINS", () => {
			expect(getConfigAdmins()).toEqual(["U1", "U2"]);
			expect(isConfigAdmin("U1")).toBe(true);
			expect(isConfigAdmin("U3")).toBe(false);
			expect(isConfigAdmin(undefined)).toBe(false);
		});

		it("denies everyone when unset", () => {
			process.env.METRICSHUB_CONFIG_ADMINS = "";
			expect(getConfigAdmins()).toEqual([]);
			expect(isConfigAdmin("U1")).toBe(false);
		});

		it("blocks save_config_file for unauthorized users without touching the agent", async () => {
			global.fetch = jest.fn();
			const result = await handleSaveConfigFile(
				{ fileName: "metricshub.yaml", content: "a: 1", changeSummary: "test" },
				{ message: { channel: "C1", thread_ts: "1.1" }, say: jest.fn(), userId: "U3" }
			);
			expect(result.ok).toBe(false);
			expect(result.error).toContain("not authorized");
			expect(global.fetch).not.toHaveBeenCalled();
		});
	});

	describe("file name validation", () => {
		it("accepts plain file names and rejects paths", () => {
			expect(isSafeConfigFileName("metricshub.yaml")).toBe(true);
			expect(isSafeConfigFileName("linux-hosts.vm")).toBe(true);
			expect(isSafeConfigFileName("../secrets.yaml")).toBe(false);
			expect(isSafeConfigFileName("dir/file.yaml")).toBe(false);
			expect(isSafeConfigFileName("")).toBe(false);
		});
	});

	describe("renderConfigDiff", () => {
		it("shows only the changed region with context", () => {
			const oldText = ["a: 1", "b: 2", "c: 3", "d: 4", "e: 5", "f: 6"].join("\n");
			const newText = ["a: 1", "b: 2", "c: 3", "d: 42", "e: 5", "f: 6"].join("\n");
			const diff = renderConfigDiff(oldText, newText);
			expect(diff).toContain("- d: 4");
			expect(diff).toContain("+ d: 42");
			expect(diff).toContain("... 1 unchanged line(s) ...");
			expect(diff).not.toContain("- a: 1");
		});

		it("handles new files and no-op edits", () => {
			expect(renderConfigDiff("", "a: 1")).toContain("+ a: 1");
			expect(renderConfigDiff("same", "same")).toBe("(no changes)");
		});
	});

	describe("normalizeCredentialFields", () => {
		it("defaults to username + password", () => {
			expect(normalizeCredentialFields(undefined)).toEqual([
				{ name: "username", label: "username", secret: false },
				{ name: "password", label: "password", secret: true },
			]);
		});

		it("infers secrecy from field names and accepts strings", () => {
			expect(normalizeCredentialFields(["community"])).toEqual([
				{ name: "community", label: "community", secret: true },
			]);
			expect(normalizeCredentialFields([{ name: "username", secret: true }])).toEqual([
				{ name: "username", label: "username", secret: true },
			]);
		});
	});

	describe("applyConfigEdits", () => {
		it("applies edits in order, each seeing the previous result", () => {
			const result = applyConfigEdits("a: 1\nb: 2\n", [
				{ find: "b: 2", replace: "b: 3" },
				{ find: "b: 3", replace: "b: 4" },
			]);
			expect(result).toEqual({ ok: true, content: "a: 1\nb: 4\n" });
		});

		it("rejects a find that does not match", () => {
			const result = applyConfigEdits("a: 1\n", [{ find: "z: 9", replace: "z: 0" }]);
			expect(result.ok).toBe(false);
			expect(result.error).toContain("not found");
		});

		it("rejects an ambiguous find", () => {
			const result = applyConfigEdits("x: 1\nx: 1\n", [{ find: "x: 1", replace: "x: 2" }]);
			expect(result.ok).toBe(false);
			expect(result.error).toContain("appears 2 times");
		});

		it("does not expand $-patterns in the replacement", () => {
			const result = applyConfigEdits("pw: OLD\n", [{ find: "OLD", replace: "a$&b$1c" }]);
			expect(result).toEqual({ ok: true, content: "pw: a$&b$1c\n" });
		});

		it("caps the number of edits", () => {
			const edits = Array.from({ length: 21 }, (_, i) => ({ find: `k${i}`, replace: "v" }));
			const result = applyConfigEdits("base", edits);
			expect(result.ok).toBe(false);
			expect(result.error).toContain("Too many edits");
		});
	});

	describe("handleGetConfigFile", () => {
		it("returns the file content with the agent label", async () => {
			global.fetch = jest.fn(async () => makeResponse(200, "resources: {}", "text/plain"));
			const result = await handleGetConfigFile({ fileName: "metricshub.yaml" }, { userId: "U1" });
			expect(result.ok).toBe(true);
			expect(result.agent).toBe("agent-a");
			expect(result.content).toBe("resources: {}");
		});

		it("denies reads to non-admins without touching the agent", async () => {
			global.fetch = jest.fn();
			const result = await handleGetConfigFile({ fileName: "metricshub.yaml" }, { userId: "U3" });
			expect(result.ok).toBe(false);
			expect(result.error).toContain("not authorized");
			expect(global.fetch).not.toHaveBeenCalled();
		});
	});

	describe("handleSaveConfigFile", () => {
		const message = { channel: "C1", thread_ts: "1.1" };
		const client = { chat: { update: jest.fn() } };

		function mockAgentApi({ current = "a: 1\n", valid = true, calls }) {
			global.fetch = jest.fn(async (url, options = {}) => {
				const method = options.method || "GET";
				calls.push({ url: String(url), method, body: options.body });
				if (method === "GET") {
					return current === null
						? makeResponse(404, "not found", "text/plain")
						: makeResponse(200, current, "text/plain");
				}
				if (method === "POST") {
					return valid
						? makeResponse(200, { fileName: "metricshub.yaml", valid: true, errors: [] })
						: makeResponse(400, {
								fileName: "metricshub.yaml",
								valid: false,
								errors: [{ message: "bad indent", line: 2, column: 1 }],
							});
				}
				return makeResponse(200, { name: "metricshub.yaml" });
			});
		}

		it("returns validation errors without asking for approval", async () => {
			const calls = [];
			mockAgentApi({ valid: false, calls });
			const say = jest.fn();

			const result = await handleSaveConfigFile(
				{ fileName: "metricshub.yaml", content: "a: 2\n", changeSummary: "tweak" },
				{ client, message, say, userId: "U1" }
			);

			expect(result.ok).toBe(false);
			expect(result.validationErrors).toEqual([{ message: "bad indent", line: 2, column: 1 }]);
			expect(say).not.toHaveBeenCalled();
			expect(calls.filter((c) => c.method === "PUT")).toHaveLength(0);
		});

		it("fails on unknown credential placeholders without validating or saving", async () => {
			const calls = [];
			mockAgentApi({ current: "a: 1\n", calls });
			const result = await handleSaveConfigFile(
				{
					fileName: "metricshub.yaml",
					content: "password: {{CRED:deadbeef}}\n",
					changeSummary: "creds",
				},
				{ client, message, say: jest.fn(), userId: "U1" }
			);
			expect(result.ok).toBe(false);
			expect(result.error).toContain("{{CRED:deadbeef}}");
			expect(calls.filter((c) => c.method !== "GET")).toHaveLength(0);
		});

		it("requires exactly one of content and edits", async () => {
			global.fetch = jest.fn();
			const ctx = { client, message, say: jest.fn(), userId: "U1" };
			const both = await handleSaveConfigFile(
				{
					fileName: "metricshub.yaml",
					content: "a: 1",
					edits: [{ find: "a", replace: "b" }],
					changeSummary: "x",
				},
				ctx
			);
			expect(both.ok).toBe(false);
			expect(both.error).toContain("not both");

			const neither = await handleSaveConfigFile(
				{ fileName: "metricshub.yaml", changeSummary: "x" },
				ctx
			);
			expect(neither.ok).toBe(false);
			expect(neither.error).toContain('"edits"');
			expect(global.fetch).not.toHaveBeenCalled();
		});

		it("rejects edits against a file that does not exist", async () => {
			const calls = [];
			mockAgentApi({ current: null, calls });
			const result = await handleSaveConfigFile(
				{
					fileName: "new-file.yaml",
					edits: [{ find: "a", replace: "b" }],
					changeSummary: "x",
				},
				{ client, message, say: jest.fn(), userId: "U1" }
			);
			expect(result.ok).toBe(false);
			expect(result.error).toContain("does not exist");
		});

		it("applies edits to the current file and saves the result after approval", async () => {
			const calls = [];
			mockAgentApi({ current: "a: 1\nb: 2\nc: 3\n", calls });
			const say = jest.fn(async () => ({ channel: "C1", ts: "9.9" }));

			const pending = handleSaveConfigFile(
				{
					fileName: "metricshub.yaml",
					edits: [{ find: "b: 2\n", replace: "b: 42\nb2: extra\n" }],
					changeSummary: "bump b",
				},
				{ client, message, say, userId: "U1" }
			);

			await waitFor(() => say.mock.calls.length > 0);
			completePendingInteraction(extractInteractionId(say), { approved: true, userId: "U1" });
			const result = await pending;

			expect(result.ok).toBe(true);
			const puts = calls.filter((c) => c.method === "PUT");
			expect(puts[1].body).toBe("a: 1\nb: 42\nb2: extra\nc: 3\n");
		});

		it("saves after approval: validates, backs up, substitutes credentials", async () => {
			const calls = [];
			mockAgentApi({ current: "a: 1\n", calls });
			const ref = storeCredential({
				threadKey: "C1:1.1",
				agentLabel: "agent-a",
				encryptedPassword: "CIPHERTEXT",
			});
			const say = jest.fn(async () => ({ channel: "C1", ts: "9.9" }));

			const pending = handleSaveConfigFile(
				{
					fileName: "metricshub.yaml",
					content: `a: 1\npassword: ${ref}\n`,
					changeSummary: "add password",
				},
				{ client, message, say, userId: "U1" }
			);

			await waitFor(() => say.mock.calls.length > 0);
			// The approval message shows the placeholder, never the ciphertext
			const approvalText = JSON.stringify(say.mock.calls[0][0]);
			expect(approvalText).toContain(ref.slice(2, -2));
			expect(approvalText).not.toContain("CIPHERTEXT");

			completePendingInteraction(extractInteractionId(say), { approved: true, userId: "U1" });
			const result = await pending;

			expect(result.ok).toBe(true);
			expect(result.backupCreated).toBe(true);
			expect(result.credentialsSubstituted).toBe(1);

			const puts = calls.filter((c) => c.method === "PUT");
			expect(puts).toHaveLength(2);
			expect(puts[0].url).toContain("/api/config-files/backup/metricshub.yaml");
			expect(puts[0].body).toBe("a: 1\n");
			expect(puts[1].url).toContain("/api/config-files/metricshub.yaml");
			expect(puts[1].body).toBe("a: 1\npassword: CIPHERTEXT\n");
		});

		it("does not save when the user rejects", async () => {
			const calls = [];
			mockAgentApi({ current: "a: 1\n", calls });
			const say = jest.fn(async () => ({ channel: "C1", ts: "9.9" }));

			const pending = handleSaveConfigFile(
				{ fileName: "metricshub.yaml", content: "a: 2\n", changeSummary: "tweak" },
				{ client, message, say, userId: "U1" }
			);

			await waitFor(() => say.mock.calls.length > 0);
			completePendingInteraction(extractInteractionId(say), { approved: false, userId: "U1" });
			const result = await pending;

			expect(result.ok).toBe(false);
			expect(result.rejected).toBe(true);
			expect(calls.filter((c) => c.method === "PUT")).toHaveLength(0);
		});

		it("warns the approver when other people participated in the thread", async () => {
			const calls = [];
			mockAgentApi({ current: "a: 1\n", calls });
			const say = jest.fn(async () => ({ channel: "C1", ts: "9.9" }));

			const pending = handleSaveConfigFile(
				{ fileName: "metricshub.yaml", content: "a: 2\n", changeSummary: "tweak" },
				{ client, message, say, userId: "U1", threadAuthorIds: new Set(["U1", "U9"]) }
			);

			await waitFor(() => say.mock.calls.length > 0);
			const approvalText = JSON.stringify(say.mock.calls[0][0]);
			expect(approvalText).toContain("Other people participated");
			expect(approvalText).toContain("<@U9>");
			expect(approvalText).not.toContain("<@U1>,");

			completePendingInteraction(extractInteractionId(say), { approved: true, userId: "U1" });
			await pending;
		});

		it("does not warn when the requester is the only participant", async () => {
			const calls = [];
			mockAgentApi({ current: "a: 1\n", calls });
			const say = jest.fn(async () => ({ channel: "C1", ts: "9.9" }));

			const pending = handleSaveConfigFile(
				{ fileName: "metricshub.yaml", content: "a: 2\n", changeSummary: "tweak" },
				{ client, message, say, userId: "U1", threadAuthorIds: new Set(["U1"]) }
			);

			await waitFor(() => say.mock.calls.length > 0);
			expect(JSON.stringify(say.mock.calls[0][0])).not.toContain("Other people participated");

			completePendingInteraction(extractInteractionId(say), { approved: true, userId: "U1" });
			await pending;
		});

		it("rejects identical content without asking for approval", async () => {
			const calls = [];
			mockAgentApi({ current: "a: 1\n", calls });
			const say = jest.fn();

			const result = await handleSaveConfigFile(
				{ fileName: "metricshub.yaml", content: "a: 1\n", changeSummary: "noop" },
				{ client, message, say, userId: "U1" }
			);

			expect(result.ok).toBe(false);
			expect(result.error).toContain("identical");
			expect(say).not.toHaveBeenCalled();
		});
	});

	describe("resource-level tools", () => {
		const message = { channel: "C1", thread_ts: "1.1" };
		const client = { chat: { update: jest.fn() } };

		const SERVERS_YAML = [
			"resources:",
			"  web-01:",
			"    attributes:",
			"      host.name: web-01.example.com",
			"    protocols:",
			"      ssh:",
			"        password: OLDBLOB==",
			"resourceGroups:",
			"  paris:",
			"    resources:",
			"      paris-fs-01:",
			"        attributes:",
			"          host.name: paris-fs-01",
			"",
		].join("\n");
		const APPS_YAML = "resources:\n  app-01:\n    attributes:\n      host.name: apps.example.com\n";

		function mockResourceApi({ files, calls }) {
			global.fetch = jest.fn(async (url, options = {}) => {
				const method = options.method || "GET";
				const u = String(url);
				calls.push({ url: u, method, body: options.body });
				if (method === "GET" && u.endsWith("/api/config-files")) {
					return makeResponse(
						200,
						Object.keys(files).map((name) => ({ name, size: files[name].length }))
					);
				}
				if (method === "GET") {
					const name = decodeURIComponent(u.split("/").pop());
					return files[name] !== undefined
						? makeResponse(200, files[name], "text/plain")
						: makeResponse(404, "not found", "text/plain");
				}
				if (method === "POST") {
					return makeResponse(200, { valid: true, errors: [] });
				}
				return makeResponse(200, { name: "saved" });
			});
		}

		it("get_resource_config returns the entry with its file and group", async () => {
			const calls = [];
			mockResourceApi({ files: { "servers.yaml": SERVERS_YAML, "apps.yaml": APPS_YAML }, calls });

			const result = await handleGetResourceConfig({ resourceId: "paris-fs-01" }, { userId: "U1" });

			expect(result.ok).toBe(true);
			expect(result.file).toBe("servers.yaml");
			expect(result.resourceGroup).toBe("paris");
			expect(result.yaml).toBe("paris-fs-01:\n  attributes:\n    host.name: paris-fs-01");
		});

		it("denies resource reads to non-admins", async () => {
			global.fetch = jest.fn();
			const result = await handleGetResourceConfig({ resourceId: "web-01" }, { userId: "U3" });
			expect(result.ok).toBe(false);
			expect(result.error).toContain("not authorized");
			expect(global.fetch).not.toHaveBeenCalled();
		});

		it("fails with a bad-practice warning when a resource is defined twice", async () => {
			const calls = [];
			mockResourceApi({
				files: {
					"servers.yaml": SERVERS_YAML,
					"dup.yaml": "resources:\n  web-01:\n    attributes:\n      host.name: dup\n",
				},
				calls,
			});

			const result = await handleGetResourceConfig({ resourceId: "web-01" }, { userId: "U1" });
			expect(result.ok).toBe(false);
			expect(result.error).toContain("multiple times, which is a bad practice");
			expect(result.error).toContain("servers.yaml (resources.web-01)");
			expect(result.error).toContain("dup.yaml (resources.web-01)");
		});

		it("suggests resources matching a hostname when the id misses", async () => {
			const calls = [];
			mockResourceApi({ files: { "servers.yaml": SERVERS_YAML, "apps.yaml": APPS_YAML }, calls });

			const result = await handleGetResourceConfig(
				{ resourceId: "apps.example.com" },
				{ userId: "U1" }
			);
			expect(result.ok).toBe(false);
			expect(result.error).toContain("Close matches");
			expect(result.error).toContain("app-01");
		});

		it("modify_resource_config replaces one entry and leaves the rest untouched", async () => {
			const calls = [];
			mockResourceApi({ files: { "servers.yaml": SERVERS_YAML, "apps.yaml": APPS_YAML }, calls });
			const say = jest.fn(async () => ({ channel: "C1", ts: "9.9" }));

			const pending = handleModifyResourceConfig(
				{
					resourceId: "web-01",
					resourceYaml:
						"web-01:\n  attributes:\n    host.name: web-01.example.com\n  protocols:\n    ssh:\n      password: OLDBLOB==\n    ipmi:\n      username: admin",
					changeSummary: "add IPMI",
				},
				{ client, message, say, userId: "U1" }
			);

			await waitFor(() => say.mock.calls.length > 0);
			completePendingInteraction(extractInteractionId(say), { approved: true, userId: "U1" });
			const result = await pending;

			expect(result.ok).toBe(true);
			expect(result.resourceId).toBe("web-01");
			const save = calls.find(
				(c) => c.method === "PUT" && c.url.includes("/api/config-files/servers.yaml")
			);
			expect(save.body).toContain("      ipmi:\n        username: admin");
			expect(save.body).toContain("paris-fs-01:");
			expect(save.body).toContain("password: OLDBLOB==");
		});

		it("modify_resource_config rejects a resourceYaml that does not start with the id", async () => {
			global.fetch = jest.fn();
			const result = await handleModifyResourceConfig(
				{
					resourceId: "web-01",
					resourceYaml: "  attributes:\n    host.name: x",
					changeSummary: "x",
				},
				{ client, message, say: jest.fn(), userId: "U1" }
			);
			expect(result.ok).toBe(false);
			expect(result.error).toContain('starting with "web-01:"');
			expect(global.fetch).not.toHaveBeenCalled();
		});

		it("modify_resource_config requires a target file to create a new resource", async () => {
			const calls = [];
			mockResourceApi({ files: { "servers.yaml": SERVERS_YAML }, calls });

			const result = await handleModifyResourceConfig(
				{
					resourceId: "brand-new",
					resourceYaml: "brand-new:\n  attributes:\n    host.name: brand-new",
					changeSummary: "add",
				},
				{ client, message, say: jest.fn(), userId: "U1" }
			);
			expect(result.ok).toBe(false);
			expect(result.error).toContain('"file"');
			expect(result.error).toContain("servers.yaml");
		});

		it("modify_resource_config creates a new resource inside a group", async () => {
			const calls = [];
			mockResourceApi({ files: { "servers.yaml": SERVERS_YAML }, calls });
			const say = jest.fn(async () => ({ channel: "C1", ts: "9.9" }));

			const pending = handleModifyResourceConfig(
				{
					resourceId: "paris-db-01",
					resourceYaml: "paris-db-01:\n  attributes:\n    host.name: paris-db-01",
					changeSummary: "add db",
					file: "servers.yaml",
					resourceGroup: "paris",
				},
				{ client, message, say, userId: "U1" }
			);

			await waitFor(() => say.mock.calls.length > 0);
			completePendingInteraction(extractInteractionId(say), { approved: true, userId: "U1" });
			const result = await pending;

			expect(result.ok).toBe(true);
			const save = calls.find(
				(c) => c.method === "PUT" && c.url.includes("servers.yaml") && !c.url.includes("/backup/")
			);
			expect(save.body).toContain(
				"      paris-db-01:\n        attributes:\n          host.name: paris-db-01"
			);
		});

		it("delete_resource_config removes the entry after approval", async () => {
			const calls = [];
			mockResourceApi({ files: { "servers.yaml": SERVERS_YAML }, calls });
			const say = jest.fn(async () => ({ channel: "C1", ts: "9.9" }));

			const pending = handleDeleteResourceConfig(
				{ resourceId: "web-01" },
				{ client, message, say, userId: "U1" }
			);

			await waitFor(() => say.mock.calls.length > 0);
			completePendingInteraction(extractInteractionId(say), { approved: true, userId: "U1" });
			const result = await pending;

			expect(result.ok).toBe(true);
			expect(result.resourceId).toBe("web-01");
			const save = calls.find(
				(c) => c.method === "PUT" && c.url.includes("/api/config-files/servers.yaml")
			);
			expect(save.body).not.toContain("web-01:");
			expect(save.body).toContain("paris-fs-01:");
		});
	});
});
