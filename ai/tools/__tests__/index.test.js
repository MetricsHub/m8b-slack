/**
 * Tests for GPT tool construction helpers.
 */

import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { _setServersForTests, isHostRoutedMcpTool } from "../../mcp_registry.js";
import { buildFunctionNamespaces, buildToolsArray, KNOWLEDGE_TOOL } from "../index.js";

function makeTool(name) {
	return {
		type: "function",
		name,
		description: `Run ${name}.`,
		parameters: { type: "object", properties: {}, additionalProperties: false },
	};
}

describe("buildFunctionNamespaces", () => {
	it("keeps namespaces below ten tools and defers non-core schemas", () => {
		const functionTools = Array.from({ length: 16 }, (_, index) =>
			makeTool(index === 0 ? "ListHosts" : `Tool${index}`)
		);

		const namespaces = buildFunctionNamespaces({
			name: "metricshub",
			description: "MetricsHub tools.",
			functionTools,
			immediateToolNames: new Set(["ListHosts"]),
		});

		expect(namespaces).toHaveLength(2);
		expect(namespaces.map((namespace) => namespace.name)).toEqual(["metricshub_1", "metricshub_2"]);
		expect(namespaces.every((namespace) => namespace.tools.length < 10)).toBe(true);
		expect(namespaces[0].tools[0].defer_loading).toBe(false);
		expect(namespaces[0].tools[1].defer_loading).toBe(true);
		expect(namespaces[0].description).toContain("ListHosts");
	});

	it("uses the base namespace name for a single chunk", () => {
		const [namespace] = buildFunctionNamespaces({
			name: "knowledge_base",
			description: "Knowledge tools.",
			functionTools: [makeTool("update_knowledge")],
		});

		expect(namespace.name).toBe("knowledge_base");
		expect(namespace.tools[0].defer_loading).toBe(true);
	});
});

describe("buildToolsArray", () => {
	const HOSTED_TYPES = new Set([
		"file_search",
		"code_interpreter",
		"web_search_preview",
		"web_search",
		"tool_search",
		"namespace",
	]);

	const openAiProvider = {
		name: "openai",
		capabilities: { toolNamespaces: true },
	};

	const ollamaProvider = {
		name: "ollama",
		capabilities: { toolNamespaces: false, localCodeInterpreter: true },
	};

	const savedEnv = {};

	beforeEach(() => {
		for (const key of ["WEB_SEARCH_PROVIDER", "SEARXNG_URL"]) {
			savedEnv[key] = process.env[key];
			delete process.env[key];
		}
	});

	afterEach(() => {
		for (const key of ["WEB_SEARCH_PROVIDER", "SEARXNG_URL"]) {
			if (savedEnv[key] === undefined) delete process.env[key];
			else process.env[key] = savedEnv[key];
		}
	});

	it("keeps hosted tools for the OpenAI provider", () => {
		const tools = buildToolsArray({
			vectorStoreIds: ["vs_123"],
			codeFileIds: new Set(),
			provider: openAiProvider,
		});

		const types = tools.map((t) => t.type);
		expect(types).toContain("file_search");
		expect(types).toContain("code_interpreter");
		expect(types).toContain("web_search_preview");
	});

	it("emits only plain function tools for the Ollama provider", () => {
		const tools = buildToolsArray({
			vectorStoreIds: [],
			codeFileIds: new Set(),
			provider: ollamaProvider,
			knowledgeBaseAvailable: true,
		});

		expect(tools.length).toBeGreaterThan(0);
		for (const tool of tools) {
			expect(tool.type).toBe("function");
			expect(HOSTED_TYPES.has(tool.type)).toBe(false);
			expect(tool).not.toHaveProperty("defer_loading");
		}

		const names = tools.map((t) => t.name);
		expect(names).toContain("search_knowledge_base");
		expect(names).toContain("update_knowledge");
		expect(names).toContain("slack_add_reaction");
		// Interim notes are streamed text now (system-prompt rule 13), not a tool
		expect(names).not.toContain("slack_add_reply");
		expect(names).toContain("ListHosts");
		expect(names).toContain("run_python");
	});

	it("omits run_python when the local code sandbox is disabled", () => {
		const tools = buildToolsArray({
			provider: { name: "ollama", capabilities: { toolNamespaces: false } },
		});

		expect(tools.map((t) => t.name)).not.toContain("run_python");
	});

	it("adapts update_knowledge to the local KB update flow for Ollama", () => {
		const tools = buildToolsArray({
			provider: ollamaProvider,
			knowledgeBaseAvailable: true,
		});

		const updateKnowledge = tools.find((t) => t.name === "update_knowledge");
		expect(updateKnowledge.description).toContain("search_knowledge_base");
		expect(updateKnowledge.description).not.toContain("file_search");
		expect(updateKnowledge.parameters.properties.fileId.description).toContain("docId");

		// The hosted (OpenAI) definition keeps its file_search wording
		expect(KNOWLEDGE_TOOL.description).toContain("file_search");
		expect(KNOWLEDGE_TOOL.parameters.properties.fileId.description).toContain("file_search");
	});

	it("omits knowledge search when the local knowledge base is unavailable", () => {
		const tools = buildToolsArray({
			provider: ollamaProvider,
			knowledgeBaseAvailable: false,
		});

		expect(tools.map((t) => t.name)).not.toContain("search_knowledge_base");
		// Writable defaults to available: no embedding backend, no writes either
		expect(tools.map((t) => t.name)).not.toContain("update_knowledge");
	});

	it("offers knowledge writes on an empty but writable knowledge base", () => {
		const names = buildToolsArray({
			provider: ollamaProvider,
			knowledgeBaseAvailable: false,
			knowledgeBaseWritable: true,
		}).map((t) => t.name);

		expect(names).not.toContain("search_knowledge_base");
		expect(names).toContain("update_knowledge");
	});

	it("hides knowledge writes when no embedding backend is configured", () => {
		const names = buildToolsArray({
			provider: ollamaProvider,
			knowledgeBaseAvailable: false,
			knowledgeBaseWritable: false,
		}).map((t) => t.name);

		expect(names).not.toContain("update_knowledge");
	});

	it("exposes fetch_url to function-only providers unless disabled, never to OpenAI", () => {
		const saved = process.env.FETCH_URL_ENABLED;
		delete process.env.FETCH_URL_ENABLED;
		try {
			const local = buildToolsArray({ vectorStoreIds: [], provider: ollamaProvider });
			const fetchUrl = local.find((t) => t.name === "fetch_url");
			expect(fetchUrl).toMatchObject({ type: "function", name: "fetch_url" });
			expect(fetchUrl.parameters.required).toEqual(["url"]);

			const hosted = buildToolsArray({ vectorStoreIds: [], provider: openAiProvider });
			expect(hosted.map((t) => t.name)).not.toContain("fetch_url");

			process.env.FETCH_URL_ENABLED = "false";
			const disabled = buildToolsArray({ vectorStoreIds: [], provider: ollamaProvider });
			expect(disabled.map((t) => t.name)).not.toContain("fetch_url");
		} finally {
			if (saved === undefined) delete process.env.FETCH_URL_ENABLED;
			else process.env.FETCH_URL_ENABLED = saved;
		}
	});

	it("lets an MCP server's own fetch_url win over the built-in reader", () => {
		const saved = process.env.FETCH_URL_ENABLED;
		delete process.env.FETCH_URL_ENABLED;
		_setServersForTests([
			{
				server_label: "a1",
				server_url: "https://a1.example",
				token: "",
				tools: new Map([
					[
						"fetch_url",
						{
							description: "Agent-side page reader with internal access.",
							// Host-routed like every MCP tool here: it CAN be driven through the bot
							inputSchema: {
								type: "object",
								properties: { url: { type: "string" }, hosts: { type: "array" } },
								required: ["url", "hosts"],
							},
						},
					],
				]),
			},
		]);
		try {
			const tools = buildToolsArray({ vectorStoreIds: [], provider: ollamaProvider });
			const readers = tools.filter((t) => t.name === "fetch_url");
			expect(readers).toHaveLength(1);
			expect(readers[0].description).toContain("Agent-side page reader");
		} finally {
			_setServersForTests([]);
			if (saved === undefined) delete process.env.FETCH_URL_ENABLED;
			else process.env.FETCH_URL_ENABLED = saved;
		}
	});

	it("keeps the built-in reader when an MCP fetch_url is URL-only (not host-routed)", () => {
		// Every MCP call is routed to an agent by host key: a reader without a host
		// argument cannot be driven through this bot, so it must not shadow the built-in
		const saved = process.env.FETCH_URL_ENABLED;
		delete process.env.FETCH_URL_ENABLED;
		_setServersForTests([
			{
				server_label: "a1",
				server_url: "https://a1.example",
				token: "",
				tools: new Map([
					[
						"fetch_url",
						{
							description: "URL-only reader.",
							inputSchema: {
								type: "object",
								properties: { url: { type: "string" } },
								required: ["url"],
							},
						},
					],
				]),
			},
		]);
		try {
			const readers = buildToolsArray({ vectorStoreIds: [], provider: ollamaProvider }).filter(
				(t) => t.name === "fetch_url"
			);
			expect(readers).toHaveLength(1);
			expect(readers[0].description).not.toContain("URL-only reader");
			expect(readers[0].parameters.required).toEqual(["url"]);
		} finally {
			_setServersForTests([]);
			if (saved === undefined) delete process.env.FETCH_URL_ENABLED;
			else process.env.FETCH_URL_ENABLED = saved;
		}
	});

	it("does not advertise a URL-only MCP fetch_url in the hosted namespaces", () => {
		// It cannot be driven through the host router, so a call would go elsewhere
		const saved = process.env.FETCH_URL_ENABLED;
		delete process.env.FETCH_URL_ENABLED;
		_setServersForTests([
			{
				server_label: "a1",
				server_url: "https://a1.example",
				token: "",
				tools: new Map([
					[
						"fetch_url",
						{
							description: "URL-only reader.",
							inputSchema: { type: "object", properties: { url: { type: "string" } } },
						},
					],
					["OtherTool", { description: "Kept.", inputSchema: { type: "object" } }],
				]),
			},
		]);
		try {
			const hosted = buildToolsArray({ vectorStoreIds: [], provider: openAiProvider });
			const namespaced = hosted
				.filter((t) => t.type === "namespace")
				.flatMap((namespace) => namespace.tools.map((t) => t.name));
			expect(namespaced).not.toContain("fetch_url");
			expect(namespaced).toContain("OtherTool");
		} finally {
			_setServersForTests([]);
			if (saved === undefined) delete process.env.FETCH_URL_ENABLED;
			else process.env.FETCH_URL_ENABLED = saved;
		}
	});

	it("does not advertise a disabled MCP fetch_url in the hosted namespaces either", () => {
		const saved = process.env.FETCH_URL_ENABLED;
		process.env.FETCH_URL_ENABLED = "false";
		_setServersForTests([
			{
				server_label: "a1",
				server_url: "https://a1.example",
				token: "",
				tools: new Map([
					[
						"fetch_url",
						{ description: "Agent-side page reader.", inputSchema: { type: "object" } },
					],
					["OtherTool", { description: "Kept.", inputSchema: { type: "object" } }],
				]),
			},
		]);
		try {
			const hosted = buildToolsArray({ vectorStoreIds: [], provider: openAiProvider });
			const namespaced = hosted
				.filter((t) => t.type === "namespace")
				.flatMap((namespace) => namespace.tools.map((t) => t.name));
			expect(namespaced).not.toContain("fetch_url");
			expect(namespaced).toContain("OtherTool");
		} finally {
			_setServersForTests([]);
			if (saved === undefined) delete process.env.FETCH_URL_ENABLED;
			else process.env.FETCH_URL_ENABLED = saved;
		}
	});

	it("finds a host-routed MCP fetch_url on a later server (mixed agent versions)", () => {
		const saved = process.env.FETCH_URL_ENABLED;
		delete process.env.FETCH_URL_ENABLED;
		_setServersForTests([
			{
				server_label: "old",
				server_url: "https://old.example",
				token: "",
				tools: new Map([
					[
						"fetch_url",
						{ description: "URL-only.", inputSchema: { type: "object", properties: { url: {} } } },
					],
				]),
			},
			{
				server_label: "new",
				server_url: "https://new.example",
				token: "",
				tools: new Map([
					[
						"fetch_url",
						{
							description: "Host-routed reader.",
							inputSchema: { type: "object", properties: { url: {}, hosts: { type: "array" } } },
						},
					],
				]),
			},
		]);
		try {
			expect(isHostRoutedMcpTool("fetch_url")).toBe(true);
			const readers = buildToolsArray({ vectorStoreIds: [], provider: ollamaProvider }).filter(
				(t) => t.name === "fetch_url"
			);
			// The MCP reader wins (one definition), the built-in is not added alongside
			expect(readers).toHaveLength(1);
			expect(readers[0].parameters.properties).toHaveProperty("hosts");
		} finally {
			_setServersForTests([]);
			if (saved === undefined) delete process.env.FETCH_URL_ENABLED;
			else process.env.FETCH_URL_ENABLED = saved;
		}
	});

	it("removes an MCP-provided fetch_url too when the switch is off", () => {
		const saved = process.env.FETCH_URL_ENABLED;
		process.env.FETCH_URL_ENABLED = "false";
		_setServersForTests([
			{
				server_label: "a1",
				server_url: "https://a1.example",
				token: "",
				tools: new Map([
					[
						"fetch_url",
						{ description: "Agent-side page reader.", inputSchema: { type: "object" } },
					],
					["OtherTool", { description: "Kept.", inputSchema: { type: "object" } }],
				]),
			},
		]);
		try {
			const names = buildToolsArray({ vectorStoreIds: [], provider: ollamaProvider }).map(
				(t) => t.name
			);
			expect(names).not.toContain("fetch_url");
			expect(names).toContain("OtherTool");
		} finally {
			_setServersForTests([]);
			if (saved === undefined) delete process.env.FETCH_URL_ENABLED;
			else process.env.FETCH_URL_ENABLED = saved;
		}
	});

	it("exposes web_search as a function tool only when a backend is configured", () => {
		const withoutSearch = buildToolsArray({ provider: ollamaProvider });
		expect(withoutSearch.map((t) => t.name)).not.toContain("web_search");

		process.env.WEB_SEARCH_PROVIDER = "searxng";
		process.env.SEARXNG_URL = "http://searxng.internal:8080";

		const withSearch = buildToolsArray({ provider: ollamaProvider });
		const webSearch = withSearch.find((t) => t.name === "web_search");
		expect(webSearch).toMatchObject({ type: "function", name: "web_search" });
	});
});
