/**
 * Tests for the host-map refresh in the MCP registry.
 */

import { afterEach, describe, expect, it, jest } from "@jest/globals";
import {
	_setServersForTests,
	getAggregatedHosts,
	refreshAllHosts,
	refreshHostsForServer,
	startHostsRefreshScheduler,
	stopHostsRefreshScheduler,
} from "../mcp_registry.js";

function fakeClient(hostsData) {
	return {
		ping: async () => {},
		callTool: async () => ({ content: [{ type: "text", text: JSON.stringify(hostsData) }] }),
	};
}

function fakeServer(label, hostsData) {
	return {
		server_label: label,
		server_url: `http://${label}:31888/sse`,
		token: "tok",
		allowSelfSignedCert: false,
		tools: new Map([["ListHosts", { name: "ListHosts" }]]),
		client: fakeClient(hostsData),
	};
}

const HOSTS_V1 = {
	"web-01": { attributes: { "host.name": "web-01.example.com" }, protocols: [] },
	"db-01": { attributes: { "host.name": "db-01.example.com" }, protocols: [] },
};

const HOSTS_V2 = {
	"web-01": { attributes: { "host.name": "web-01.example.com" }, protocols: [] },
	"new-01": { attributes: { "host.name": "new-01.example.com" }, protocols: [] },
};

describe("host map refresh", () => {
	const savedInterval = process.env.MCP_HOSTS_REFRESH_INTERVAL_MS;

	afterEach(() => {
		if (savedInterval === undefined) delete process.env.MCP_HOSTS_REFRESH_INTERVAL_MS;
		else process.env.MCP_HOSTS_REFRESH_INTERVAL_MS = savedInterval;
		stopHostsRefreshScheduler();
		_setServersForTests([]);
		jest.useRealTimers();
	});

	it("indexes hosts and their host.name aliases", async () => {
		_setServersForTests([fakeServer("a1", HOSTS_V1)]);

		const result = await refreshHostsForServer("a1");
		expect(result.ok).toBe(true);

		const hosts = getAggregatedHosts();
		expect(hosts["web-01"]).toBeDefined();
		expect(hosts["web-01.example.com"]).toBeDefined();
		expect(hosts["db-01"]).toBeDefined();
	});

	it("drops hosts that disappeared from the agent", async () => {
		const server = fakeServer("a1", HOSTS_V1);
		_setServersForTests([server]);
		await refreshHostsForServer("a1");

		server.client = fakeClient(HOSTS_V2);
		const result = await refreshHostsForServer("a1");
		expect(result.ok).toBe(true);
		expect(result.hostCount).toBeGreaterThan(0);

		const hosts = getAggregatedHosts();
		expect(hosts["new-01"]).toBeDefined();
		expect(hosts["db-01"]).toBeUndefined();
		expect(hosts["db-01.example.com"]).toBeUndefined();
		expect(hosts["web-01"]).toBeDefined();
	});

	it("only touches the refreshed server's entries", async () => {
		const a1 = fakeServer("a1", { "web-01": { attributes: {}, protocols: [] } });
		const a2 = fakeServer("a2", { "other-01": { attributes: {}, protocols: [] } });
		_setServersForTests([a1, a2]);
		await refreshAllHosts();

		a1.client = fakeClient({});
		await refreshHostsForServer("a1");

		const hosts = getAggregatedHosts();
		expect(hosts["web-01"]).toBeUndefined();
		expect(hosts["other-01"]).toBeDefined();
	});

	it("reports unknown servers without throwing", async () => {
		_setServersForTests([]);
		const result = await refreshHostsForServer("nope");
		expect(result.ok).toBe(false);
		expect(result.error).toContain("nope");
	});

	it("periodically refreshes all hosts on the configured interval", async () => {
		_setServersForTests([fakeServer("a1", HOSTS_V1)]);
		process.env.MCP_HOSTS_REFRESH_INTERVAL_MS = "1000";

		jest.useFakeTimers();
		startHostsRefreshScheduler();
		jest.advanceTimersByTime(1001);
		jest.useRealTimers();

		// Let the async refresh triggered by the interval settle
		await new Promise((resolve) => setImmediate(resolve));
		await new Promise((resolve) => setImmediate(resolve));

		expect(getAggregatedHosts()["web-01"]).toBeDefined();
	});

	it("can be disabled with MCP_HOSTS_REFRESH_INTERVAL_MS=0", async () => {
		_setServersForTests([fakeServer("a1", HOSTS_V1)]);
		process.env.MCP_HOSTS_REFRESH_INTERVAL_MS = "0";

		jest.useFakeTimers();
		startHostsRefreshScheduler();
		jest.advanceTimersByTime(10_000_000);
		jest.useRealTimers();
		await new Promise((resolve) => setImmediate(resolve));

		expect(getAggregatedHosts()["web-01"]).toBeUndefined();
	});
});
