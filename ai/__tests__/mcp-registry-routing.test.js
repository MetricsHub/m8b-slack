/**
 * Tests for per-server schema compatibility when routing MCP tool calls.
 */

import { afterEach, describe, expect, it } from "@jest/globals";
import {
	_setServersForTests,
	executeMcpFunctionCall,
	refreshHostsForServer,
} from "../mcp_registry.js";

/**
 * A fake agent: `hosts` is what its ListHosts returns, `tools` its exported
 * tool definitions. Every tool call is recorded in `calls`.
 */
function fakeServer(label, hosts, tools) {
	const calls = [];
	return {
		server_label: label,
		server_url: `http://${label}:31888/sse`,
		token: "tok",
		allowSelfSignedCert: false,
		tools: new Map(Object.entries({ ListHosts: { name: "ListHosts" }, ...tools })),
		client: {
			ping: async () => {},
			callTool: async ({ name, arguments: args }) => {
				calls.push({ name, args });
				const text =
					name === "ListHosts" ? JSON.stringify(hosts) : JSON.stringify({ ok: true, agent: label });
				return { content: [{ type: "text", text }] };
			},
		},
		calls,
	};
}

const host = (name) => ({ attributes: { "host.name": `${name}.example.com` }, protocols: [] });

const URL_ONLY = {
	description: "Old reader.",
	inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
};
const HOST_ROUTED = {
	description: "Host-routed reader.",
	inputSchema: {
		type: "object",
		properties: { url: { type: "string" }, hosts: { type: "array" } },
		required: ["url", "hosts"],
	},
};

describe("executeMcpFunctionCall schema compatibility", () => {
	afterEach(() => {
		_setServersForTests([]);
	});

	it("sends the call only to servers whose own definition accepts it", async () => {
		const old = fakeServer("old", { "web-01": host("web-01") }, { fetch_url: URL_ONLY });
		const recent = fakeServer("new", { "db-01": host("db-01") }, { fetch_url: HOST_ROUTED });
		_setServersForTests([old, recent]);
		await refreshHostsForServer("old");
		await refreshHostsForServer("new");

		const out = await executeMcpFunctionCall("fetch_url", {
			url: "https://example.com/",
			hosts: ["web-01", "db-01"],
		});
		expect(out.ok).toBe(true);
		const byServer = Object.fromEntries(out.results.map((r) => [r.server_label, r]));
		// The old agent's URL-only version cannot take the routed call: refused with a reason
		expect(byServer.old.ok).toBe(false);
		expect(byServer.old.error).toContain("cannot be routed by host");
		expect(old.calls.filter((c) => c.name === "fetch_url")).toHaveLength(0);
		// The host-routed agent gets the call, with its own hosts only
		expect(byServer.new).toMatchObject({ ok: true, result: { ok: true, agent: "new" } });
		const sent = recent.calls.filter((c) => c.name === "fetch_url");
		expect(sent).toHaveLength(1);
		expect(sent[0].args).toEqual({ url: "https://example.com/", hosts: ["db-01"] });
	});

	it("refuses servers that lack the tool or require arguments the call does not have", async () => {
		const without = fakeServer("without", { "a-01": host("a-01") }, {});
		const stricter = fakeServer(
			"stricter",
			{ "b-01": host("b-01") },
			{
				fetch_url: {
					description: "Needs a mode.",
					inputSchema: {
						type: "object",
						properties: { url: {}, mode: {}, hostname: {} },
						required: ["url", "mode", "hostname"],
					},
				},
			}
		);
		_setServersForTests([without, stricter]);
		await refreshHostsForServer("without");
		await refreshHostsForServer("stricter");

		const out = await executeMcpFunctionCall("fetch_url", {
			url: "https://example.com/",
			hosts: ["a-01", "b-01"],
		});
		const byServer = Object.fromEntries(out.results.map((r) => [r.server_label, r]));
		expect(byServer.without.ok).toBe(false);
		expect(byServer.without.error).toContain("does not provide the tool fetch_url");
		// "hostname" is a routing field the router fills in: only "mode" is missing
		expect(byServer.stricter.ok).toBe(false);
		expect(byServer.stricter.error).toContain("requires mode");
		expect(byServer.stricter.error).not.toContain("hostname");
		expect(without.calls.filter((c) => c.name === "fetch_url")).toHaveLength(0);
		expect(stricter.calls.filter((c) => c.name === "fetch_url")).toHaveLength(0);

		// With the required argument present the stricter server is called normally
		const ok = await executeMcpFunctionCall("fetch_url", {
			url: "https://example.com/",
			mode: "text",
			hosts: ["b-01"],
		});
		expect(ok.results[0]).toMatchObject({ server_label: "stricter", ok: true });
	});
});
