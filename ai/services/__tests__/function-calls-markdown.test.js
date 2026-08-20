/**
 * End-to-end tests for telemetry Markdown rendering through processFunctionCall:
 * MetricsHub telemetry outputs must reach function_call_output.output as raw
 * Markdown (not JSON-escaped), for providers with and without inline caps.
 */

import { describe, expect, it, jest } from "@jest/globals";

function makeTelemetryResult() {
	return {
		ok: true,
		results: [
			{
				server_label: "m8b-agent-01",
				ok: true,
				result: {
					hosts: [
						{
							hostname: "ecs1-01",
							response: {
								telemetry: {
									monitors: {
										file_system: [
											{
												attributes: {
													entityName: "Linux_file_system_/dev/sda1(/boot)",
													"system.filesystem.mountpoint": "/boot",
												},
												metrics: {
													'system.filesystem.utilization{system.filesystem.state="used"}': 0.42,
												},
											},
										],
									},
								},
							},
						},
					],
				},
			},
		],
	};
}

// Note: mock specifiers resolve from the project root (jest.setup.js location)
// and are extension-less because jest's moduleNameMapper strips ".js"
jest.unstable_mockModule("./ai/mcp_registry", () => ({
	getOpenAiFunctionTools: () => [{ name: "GetMetricsFromCacheForHost" }],
	executeMcpFunctionCall: jest.fn(async () => makeTelemetryResult()),
}));

const { processFunctionCall } = await import("../function-calls.js");

const ollamaProvider = {
	name: "ollama",
	capabilities: {
		serverSideState: false,
		hostedFileSearch: false,
		codeInterpreter: false,
		hostedWebSearch: false,
		providerFileUploads: false,
		toolNamespaces: false,
	},
};

function makeContext(overrides = {}) {
	return {
		client: {},
		message: { channel: "C1", ts: "1.0" },
		say: jest.fn(async () => {}),
		vectorStoreIds: [],
		fileTracking: { uploadedFiles: [], codeFileIds: new Set(), codeContainerFiles: new Map() },
		provider: ollamaProvider,
		knowledgeBase: null,
		logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
		...overrides,
	};
}

describe("processFunctionCall (telemetry Markdown output)", () => {
	it("emits telemetry as raw Markdown, not JSON", async () => {
		const context = makeContext();
		const items = await processFunctionCall(
			{
				name: "GetMetricsFromCacheForHost",
				call_id: "call_1",
				arguments: '{"hostname":"ecs1-01"}',
			},
			context
		);

		expect(items).toHaveLength(1);
		expect(items[0].type).toBe("function_call_output");
		expect(items[0].output).toContain("# Host: ecs1-01 (agent: m8b-agent-01)");
		expect(items[0].output).toContain("## file_system (1)");
		expect(items[0].output).toContain("0.42");
		// Raw Markdown, not a JSON-escaped string
		expect(items[0].output.startsWith("#")).toBe(true);
		expect(() => JSON.parse(items[0].output)).toThrow();

		// The result summary log stays on one line despite the multiline output
		const summaryLog = context.logger.info.mock.calls
			.map((call) => call[0])
			.find(
				(msg) => typeof msg === "string" && msg.includes("[FUNCTION] GetMetricsFromCacheForHost →")
			);
		expect(summaryLog).toContain("markdown");
		expect(summaryLog).toContain("chars");
		expect(summaryLog).not.toContain("\n");
	});

	it("still applies the provider inline cap, truncating Markdown as plain text", async () => {
		const items = await processFunctionCall(
			{
				name: "GetMetricsFromCacheForHost",
				call_id: "call_2",
				arguments: '{"hostname":"ecs1-01","padding":"x"}',
			},
			makeContext({ provider: { ...ollamaProvider, maxToolOutputChars: 200 } })
		);

		// No JSON wrapper: the surviving tables stay readable and unescaped
		const output = items[0].output;
		expect(output.startsWith("# Host: ecs1-01")).toBe(true);
		expect(output).toContain("[TRUNCATED: showing");
		expect(output).toContain("Do NOT guess");
		expect(() => JSON.parse(output)).toThrow();
	});
});
