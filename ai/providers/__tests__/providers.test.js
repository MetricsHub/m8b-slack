/**
 * Tests for the AI provider abstraction (OpenAI vs Ollama).
 */

import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { getAiProviderName, getOllamaConfig } from "../../config/providers.js";
import { getProvider, resetProviderCache } from "../index.js";

const ENV_KEYS = [
	"AI_PROVIDER",
	"OLLAMA_BASE_URL",
	"OLLAMA_MODEL",
	"OLLAMA_API_KEY",
	"OLLAMA_CONTEXT_LENGTH",
	"OLLAMA_CONTEXT_WINDOW",
	"OLLAMA_MAX_OUTPUT_TOKENS",
];

describe("provider selection", () => {
	const savedEnv = {};

	beforeEach(() => {
		for (const key of ENV_KEYS) {
			savedEnv[key] = process.env[key];
			delete process.env[key];
		}
		resetProviderCache();
	});

	afterEach(() => {
		for (const key of ENV_KEYS) {
			if (savedEnv[key] === undefined) delete process.env[key];
			else process.env[key] = savedEnv[key];
		}
		resetProviderCache();
	});

	it("defaults to OpenAI", () => {
		expect(getAiProviderName()).toBe("openai");

		const provider = getProvider();
		expect(provider.name).toBe("openai");
		expect(provider.capabilities.serverSideState).toBe(true);
		expect(provider.capabilities.codeInterpreter).toBe(true);
		expect(provider.capabilities.hostedFileSearch).toBe(true);
	});

	it("falls back to OpenAI for unknown provider names", () => {
		process.env.AI_PROVIDER = "banana";
		expect(getAiProviderName()).toBe("openai");
	});

	it("selects Ollama with environment configuration", () => {
		process.env.AI_PROVIDER = "ollama";
		process.env.OLLAMA_BASE_URL = "http://dev-nvidia-01:11434/v1";
		process.env.OLLAMA_MODEL = "qwen3.8:27b";

		const provider = getProvider();
		expect(provider.name).toBe("ollama");
		expect(provider.model).toBe("qwen3.8:27b");
		expect(provider.endpoint).toBe("http://dev-nvidia-01:11434/v1");
		expect(provider.contextWindow).toBe(32768);
		expect(provider.capabilities).toMatchObject({
			serverSideState: false,
			hostedFileSearch: false,
			codeInterpreter: false,
			hostedWebSearch: false,
			providerFileUploads: false,
			toolNamespaces: false,
		});
	});

	it("uses a dummy API key for Ollama by default", () => {
		process.env.AI_PROVIDER = "ollama";
		expect(getOllamaConfig().apiKey).toBe("ollama");
	});

	it("reads the context length from OLLAMA_CONTEXT_LENGTH (same name as Ollama's own variable)", () => {
		process.env.OLLAMA_CONTEXT_LENGTH = "65536";
		expect(getOllamaConfig().contextWindow).toBe(65536);
	});

	it("still honors the deprecated OLLAMA_CONTEXT_WINDOW name", () => {
		process.env.OLLAMA_CONTEXT_WINDOW = "16384";
		expect(getOllamaConfig().contextWindow).toBe(16384);

		// The new name wins when both are set
		process.env.OLLAMA_CONTEXT_LENGTH = "65536";
		expect(getOllamaConfig().contextWindow).toBe(65536);
	});

	it("scales the default tool-output cap with the context window", () => {
		// 32K: (32768 - 4000 - 1500) * 4 chars * 0.4
		const at32k = getOllamaConfig().maxToolOutputChars;
		expect(at32k).toBe(Math.floor((32768 - 4000 - 1500) * 4 * 0.4));

		process.env.OLLAMA_CONTEXT_LENGTH = "65536";
		const at64k = getOllamaConfig().maxToolOutputChars;
		expect(at64k).toBe(Math.floor((65536 - 4000 - 1500) * 4 * 0.4));
		expect(at64k).toBeGreaterThan(at32k * 2 * 0.9);

		// Explicit override always wins
		process.env.OLLAMA_MAX_TOOL_OUTPUT_CHARS = "12345";
		expect(getOllamaConfig().maxToolOutputChars).toBe(12345);
		delete process.env.OLLAMA_MAX_TOOL_OUTPUT_CHARS;
	});
});

describe("Ollama request builder", () => {
	beforeEach(() => {
		process.env.AI_PROVIDER = "ollama";
		process.env.OLLAMA_MODEL = "qwen3.8:27b";
		process.env.OLLAMA_MAX_OUTPUT_TOKENS = "4000";
		resetProviderCache();
	});

	afterEach(() => {
		delete process.env.AI_PROVIDER;
		delete process.env.OLLAMA_MODEL;
		delete process.env.OLLAMA_MAX_OUTPUT_TOKENS;
		resetProviderCache();
	});

	it("only sends fields supported by Ollama's /v1/responses", () => {
		const provider = getProvider();
		const tools = [{ type: "function", name: "web_search", parameters: {} }];
		const request = provider.buildRequest({
			input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
			tools,
			tool_choice: undefined,
			previous_response_id: "resp_should_not_be_sent",
			safety_identifier: "hash_should_not_be_sent",
		});

		expect(request).toEqual({
			model: "qwen3.8:27b",
			input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
			max_output_tokens: 4000,
			stream: true,
			tools,
		});
		expect(request).not.toHaveProperty("previous_response_id");
		expect(request).not.toHaveProperty("safety_identifier");
		expect(request).not.toHaveProperty("reasoning");
		expect(request).not.toHaveProperty("text");
		expect(request).not.toHaveProperty("parallel_tool_calls");
	});

	it("emulates tool_choice 'none' by omitting tools", () => {
		const provider = getProvider();
		const request = provider.buildRequest({
			input: [],
			tools: [{ type: "function", name: "anything", parameters: {} }],
			tool_choice: "none",
		});

		expect(request).not.toHaveProperty("tools");
	});
});

describe("Ollama context-length detection", () => {
	const savedFetch = global.fetch;
	const savedEnv = {};

	/**
	 * Mock the three endpoints healthCheck may hit: /v1/models, /api/ps, /api/show.
	 */
	function mockOllamaApi({ psContext = null, showNumCtx = null, psFails = false } = {}) {
		global.fetch = jest.fn(async (url) => {
			const target = String(url);
			if (target.endsWith("/v1/models")) {
				return { ok: true, json: async () => ({ data: [{ id: "qwen3.8:27b" }] }) };
			}
			if (target.endsWith("/api/generate")) {
				// Warm-up load request (no prompt): pretend the model loads fine
				return { ok: true, json: async () => ({ done: true, done_reason: "load" }) };
			}
			if (target.endsWith("/api/ps")) {
				if (psFails) throw new Error("connect ECONNREFUSED");
				return {
					ok: true,
					json: async () => ({
						models: psContext
							? [{ name: "qwen3.8:27b", model: "qwen3.8:27b", context_length: psContext }]
							: [],
					}),
				};
			}
			if (target.endsWith("/api/show")) {
				return {
					ok: true,
					json: async () => ({
						parameters: showNumCtx
							? `temperature 1\nnum_ctx ${showNumCtx}\ntop_k 20`
							: "temperature 1",
					}),
				};
			}
			throw new Error(`Unexpected fetch: ${target}`);
		});
	}

	beforeEach(() => {
		for (const key of ENV_KEYS) {
			savedEnv[key] = process.env[key];
			delete process.env[key];
		}
		process.env.AI_PROVIDER = "ollama";
		process.env.OLLAMA_MODEL = "qwen3.8:27b";
		resetProviderCache();
	});

	afterEach(() => {
		for (const key of ENV_KEYS) {
			if (savedEnv[key] === undefined) delete process.env[key];
			else process.env[key] = savedEnv[key];
		}
		global.fetch = savedFetch;
		resetProviderCache();
	});

	it("adopts the loaded model's effective context when none is configured", async () => {
		mockOllamaApi({ psContext: 65536 });

		const provider = getProvider();
		expect(provider.contextWindow).toBe(32768); // default before detection

		const health = await provider.healthCheck();
		expect(health.ok).toBe(true);
		expect(provider.contextWindow).toBe(65536);
		expect(health.detail).toContain("detected");
	});

	it("force-loads the model during the health check", async () => {
		mockOllamaApi({ psContext: 65536 });

		const provider = getProvider();
		const health = await provider.healthCheck();

		const loadCall = global.fetch.mock.calls.find(([url]) => String(url).endsWith("/api/generate"));
		expect(loadCall).toBeDefined();
		expect(JSON.parse(loadCall[1].body)).toEqual({ model: "qwen3.8:27b" });
		expect(health.detail).toContain("loaded");
	});

	it("caps an over-configured value to the server's effective context, with a warning", async () => {
		process.env.OLLAMA_CONTEXT_LENGTH = "131072";
		resetProviderCache();
		mockOllamaApi({ psContext: 32768 });

		const provider = getProvider();
		const health = await provider.healthCheck();

		expect(provider.contextWindow).toBe(32768);
		expect(health.warning).toContain("exceeds the server's effective context");
	});

	it("keeps a deliberately tighter configured value", async () => {
		process.env.OLLAMA_CONTEXT_LENGTH = "16384";
		resetProviderCache();
		mockOllamaApi({ psContext: 32768 });

		const provider = getProvider();
		const health = await provider.healthCheck();

		expect(provider.contextWindow).toBe(16384);
		expect(health.warning).toBeUndefined();
		expect(health.detail).toContain("server allows 32768");
	});

	it("falls back to a Modelfile num_ctx when the model is not loaded", async () => {
		mockOllamaApi({ psContext: null, showNumCtx: 40960 });

		const provider = getProvider();
		await provider.healthCheck();

		expect(provider.contextWindow).toBe(40960);
	});

	it("keeps the configured value when detection is unavailable", async () => {
		mockOllamaApi({ psFails: true, showNumCtx: null });

		const provider = getProvider();
		const health = await provider.healthCheck();

		expect(health.ok).toBe(true);
		expect(provider.contextWindow).toBe(32768);
		expect(health.detail).toContain("configured");
	});
});

describe("OpenAI request builder", () => {
	it("preserves the existing hosted Responses API request shape", () => {
		resetProviderCache();
		delete process.env.AI_PROVIDER;

		const provider = getProvider();
		const request = provider.buildRequest({
			input: [],
			tools: [],
			previous_response_id: "resp_prev",
			safety_identifier: "a".repeat(64),
		});

		expect(request).toMatchObject({
			model: provider.model,
			previous_response_id: "resp_prev",
			safety_identifier: "a".repeat(64),
			tool_choice: "auto",
			parallel_tool_calls: true,
			stream: true,
		});
		expect(request.reasoning).toBeDefined();
	});
});
