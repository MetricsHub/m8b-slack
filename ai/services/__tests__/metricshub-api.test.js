/**
 * Tests for the MetricsHub Agent REST API client.
 */

import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import {
	_setServerSourceForTests,
	encryptPassword,
	getRestBaseUrl,
	metricsHubApiRequest,
	resolveAgentServer,
} from "../metricshub-api.js";

const AGENT_A = {
	server_label: "agent-a",
	server_url: "https://mh-a:31888/sse",
	token: "tok-a",
	allowSelfSignedCert: false,
};
const AGENT_B = {
	server_label: "agent-b",
	server_url: "http://mh-b:31888/sse",
	token: "tok-b",
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

describe("metricshub-api", () => {
	const savedFetch = global.fetch;

	beforeEach(() => {
		_setServerSourceForTests(() => [AGENT_A, AGENT_B]);
	});

	afterEach(() => {
		global.fetch = savedFetch;
		_setServerSourceForTests(null);
	});

	it("derives the REST base URL from the MCP endpoint", () => {
		expect(getRestBaseUrl(AGENT_A)).toBe("https://mh-a:31888");
		expect(getRestBaseUrl({ server_url: "http://host:1234/some/mcp/path" })).toBe(
			"http://host:1234"
		);
	});

	describe("resolveAgentServer", () => {
		it("resolves by label", () => {
			expect(resolveAgentServer("agent-b")).toEqual({ ok: true, server: AGENT_B });
		});

		it("requires a label when several agents are registered", () => {
			const result = resolveAgentServer();
			expect(result.ok).toBe(false);
			expect(result.error).toContain("agent-a");
			expect(result.error).toContain("agent-b");
		});

		it("defaults to the single registered agent", () => {
			_setServerSourceForTests(() => [AGENT_A]);
			expect(resolveAgentServer()).toEqual({ ok: true, server: AGENT_A });
		});

		it("reports unknown labels and empty registries", () => {
			expect(resolveAgentServer("nope").ok).toBe(false);
			_setServerSourceForTests(() => []);
			expect(resolveAgentServer("agent-a").error).toContain("No MetricsHub agents");
		});
	});

	it("sends the Bearer token and parses JSON responses", async () => {
		global.fetch = jest.fn(async () => makeResponse(200, { hello: "world" }));

		const result = await metricsHubApiRequest(AGENT_B, "/api/status");
		expect(result).toEqual({ ok: true, status: 200, data: { hello: "world" } });

		const [url, options] = global.fetch.mock.calls[0];
		expect(url).toBe("http://mh-b:31888/api/status");
		expect(options.headers.Authorization).toBe("Bearer tok-b");
	});

	it("sends string bodies as text/plain and objects as JSON", async () => {
		global.fetch = jest.fn(async () => makeResponse(200, "ok", "text/plain"));

		await metricsHubApiRequest(AGENT_B, "/api/config-files/x.yaml", {
			method: "PUT",
			body: "a: 1",
		});
		expect(global.fetch.mock.calls[0][1].headers["Content-Type"]).toContain("text/plain");
		expect(global.fetch.mock.calls[0][1].body).toBe("a: 1");

		await metricsHubApiRequest(AGENT_B, "/api/security/encrypt-password", {
			method: "POST",
			body: { passwordBase64: "eA==" },
		});
		expect(global.fetch.mock.calls[1][1].headers["Content-Type"]).toBe("application/json");
		expect(global.fetch.mock.calls[1][1].body).toBe('{"passwordBase64":"eA=="}');
	});

	it("reports HTTP errors without throwing", async () => {
		global.fetch = jest.fn(async () => makeResponse(404, "not found", "text/plain"));
		const result = await metricsHubApiRequest(AGENT_B, "/api/config-files/x.yaml");
		expect(result.ok).toBe(false);
		expect(result.status).toBe(404);
		expect(result.error).toContain("404");
	});

	it("reports network failures without throwing", async () => {
		global.fetch = jest.fn(async () => {
			throw new Error("ECONNREFUSED");
		});
		const result = await metricsHubApiRequest(AGENT_B, "/api/status");
		expect(result.ok).toBe(false);
		expect(result.error).toContain("ECONNREFUSED");
	});

	describe("encryptPassword", () => {
		it("base64-encodes the password and returns the ciphertext", async () => {
			global.fetch = jest.fn(async () => makeResponse(200, { encryptedPassword: "CIPHER" }));

			const result = await encryptPassword(AGENT_B, "s3cr€t!");
			expect(result).toEqual({ ok: true, encryptedPassword: "CIPHER" });

			const sent = JSON.parse(global.fetch.mock.calls[0][1].body);
			expect(Buffer.from(sent.passwordBase64, "base64").toString("utf8")).toBe("s3cr€t!");
		});

		it("fails when the agent returns no ciphertext", async () => {
			global.fetch = jest.fn(async () => makeResponse(200, {}));
			const result = await encryptPassword(AGENT_B, "x");
			expect(result.ok).toBe(false);
			expect(result.error).toContain("no encryptedPassword");
		});
	});
});
