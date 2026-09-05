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

	it("fills the routing field each destination declares, one call per single-valued host", async () => {
		const byName = fakeServer(
			"byname",
			{ "h-01": host("h-01"), "h-02": host("h-02") },
			{
				fetch_url: {
					description: "Routes by hostname, one at a time.",
					inputSchema: {
						type: "object",
						properties: { url: { type: "string" }, hostname: { type: "string" } },
						required: ["url", "hostname"],
						additionalProperties: false,
					},
				},
			}
		);
		const byList = fakeServer(
			"bylist",
			{ "l-01": host("l-01"), "l-02": host("l-02") },
			{
				fetch_url: {
					description: "Routes by a list of host names.",
					inputSchema: {
						type: "object",
						properties: { url: { type: "string" }, hostnames: { type: "array" } },
						required: ["url", "hostnames"],
						additionalProperties: false,
					},
				},
			}
		);
		_setServersForTests([byName, byList]);
		await refreshHostsForServer("byname");
		await refreshHostsForServer("bylist");

		const out = await executeMcpFunctionCall("fetch_url", {
			url: "https://example.com/",
			hosts: ["h-01", "h-02", "l-01", "l-02"],
		});
		expect(out.results.every((r) => r.ok)).toBe(true);
		// hostname is single-valued: two calls, "hosts" (undeclared) dropped
		const named = byName.calls.filter((c) => c.name === "fetch_url").map((c) => c.args);
		expect(named).toEqual([
			{ url: "https://example.com/", hostname: "h-01" },
			{ url: "https://example.com/", hostname: "h-02" },
		]);
		// hostnames takes the whole bucket in one call
		const listed = byList.calls.filter((c) => c.name === "fetch_url").map((c) => c.args);
		expect(listed).toEqual([{ url: "https://example.com/", hostnames: ["l-01", "l-02"] }]);

		// A hostname the model supplied itself is kept for a single-host bucket (it
		// may be an alias the agent knows)...
		await executeMcpFunctionCall("fetch_url", {
			url: "https://example.com/",
			hostname: "h-01.example.com",
			hosts: ["h-01"],
		});
		expect(byName.calls.filter((c) => c.name === "fetch_url").at(-1).args).toEqual({
			url: "https://example.com/",
			hostname: "h-01.example.com",
		});
		// ...but one value cannot cover several selected machines: rebuilt per host
		const before = byName.calls.filter((c) => c.name === "fetch_url").length;
		const multi = await executeMcpFunctionCall("fetch_url", {
			url: "https://example.com/",
			hostname: "h-01.example.com",
			hosts: ["h-01", "h-02"],
		});
		expect(multi.results.filter((r) => r.ok)).toHaveLength(2);
		expect(
			byName.calls
				.filter((c) => c.name === "fetch_url")
				.slice(before)
				.map((c) => c.args.hostname)
		).toEqual(["h-01", "h-02"]);
	});

	it("validates every constraint of the destination schema (enum, items, nested)", async () => {
		const constrained = fakeServer(
			"constrained",
			{ "c-01": host("c-01") },
			{
				fetch_url: {
					description: "Summary only.",
					inputSchema: {
						$schema: "https://json-schema.org/draft/2020-12/schema",
						type: "object",
						properties: {
							url: { type: "string" },
							mode: { type: "string", enum: ["summary"] },
							tags: { type: "array", items: { type: "string" } },
							options: {
								type: "object",
								properties: { depth: { type: "integer" } },
								required: ["depth"],
							},
							hosts: { type: "array", items: { type: "string" } },
						},
						required: ["url", "hosts"],
					},
				},
			}
		);
		_setServersForTests([constrained]);
		await refreshHostsForServer("constrained");
		const call = (extra) =>
			executeMcpFunctionCall("fetch_url", {
				url: "https://example.com/",
				hosts: ["c-01"],
				...extra,
			});

		const enumViolation = await call({ mode: "full" });
		expect(enumViolation.results[0].ok).toBe(false);
		expect(enumViolation.results[0].error).toContain("mode");
		expect(enumViolation.results[0].error).toContain("summary");
		const itemsViolation = await call({ tags: ["a", 2] });
		expect(itemsViolation.results[0].ok).toBe(false);
		expect(itemsViolation.results[0].error).toContain("tags");
		const nestedViolation = await call({ options: {} });
		expect(nestedViolation.results[0].ok).toBe(false);
		expect(nestedViolation.results[0].error).toContain("depth");
		expect(constrained.calls.filter((c) => c.name === "fetch_url")).toHaveLength(0);

		const fits = await call({ mode: "summary", tags: ["a"], options: { depth: 1 } });
		expect(fits.results[0]).toMatchObject({ server_label: "constrained", ok: true });
		expect(constrained.calls.filter((c) => c.name === "fetch_url")).toHaveLength(1);
	});

	it("refuses servers whose definition rejects or retypes a supplied argument", async () => {
		const strict = fakeServer(
			"strict",
			{ "s-01": host("s-01") },
			{
				fetch_url: {
					description: "No mode here.",
					inputSchema: {
						type: "object",
						properties: { url: { type: "string" }, hosts: { type: "array" } },
						required: ["url", "hosts"],
						additionalProperties: false,
					},
				},
			}
		);
		const retyped = fakeServer(
			"retyped",
			{ "r-01": host("r-01") },
			{
				fetch_url: {
					description: "Typed differently.",
					inputSchema: {
						type: "object",
						properties: { url: { type: "string" }, limit: { type: "integer" }, hosts: {} },
					},
				},
			}
		);
		_setServersForTests([strict, retyped]);
		await refreshHostsForServer("strict");
		await refreshHostsForServer("retyped");

		// An optional "mode" the advertised schema has is unknown to the strict agent
		const out = await executeMcpFunctionCall("fetch_url", {
			url: "https://example.com/",
			mode: "text",
			limit: 2.5,
			hosts: ["s-01", "r-01"],
		});
		const byServer = Object.fromEntries(out.results.map((r) => [r.server_label, r]));
		expect(byServer.strict.ok).toBe(false);
		expect(byServer.strict.error).toContain("rejects the call");
		expect(byServer.strict.error).toContain("mode");
		// The other agent takes unknown properties but types "limit" as an integer
		expect(byServer.retyped.ok).toBe(false);
		expect(byServer.retyped.error).toContain("rejects the call");
		expect(byServer.retyped.error).toContain("limit");
		expect(strict.calls.filter((c) => c.name === "fetch_url")).toHaveLength(0);
		expect(retyped.calls.filter((c) => c.name === "fetch_url")).toHaveLength(0);

		// Arguments that fit go through; app-side fields (monitorTypes) are never judged
		const ok = await executeMcpFunctionCall("fetch_url", {
			url: "https://example.com/",
			monitorTypes: ["cpu"],
			hosts: ["s-01", "r-01"],
		});
		expect(ok.results.every((r) => r.ok)).toBe(true);
		const integer = await executeMcpFunctionCall("fetch_url", {
			url: "https://example.com/",
			limit: 2,
			hosts: ["r-01"],
		});
		expect(integer.results[0]).toMatchObject({ server_label: "retyped", ok: true });
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
		expect(byServer.stricter.error).toContain("rejects the call");
		expect(byServer.stricter.error).toContain("mode");
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
