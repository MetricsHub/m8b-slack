/**
 * Tests for the AI provider abstraction (OpenAI, Ollama, vLLM, generic OpenAI-compatible).
 */

import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import {
	getAiProviderName,
	getEmbeddingBackendConfig,
	getOllamaConfig,
	getOpenAiCompatibleConfig,
	getVllmConfig,
} from "../../config/providers.js";
import { describeProviderError, getProvider, resetProviderCache } from "../index.js";

const ENV_KEYS = [
	"AI_PROVIDER",
	"OLLAMA_BASE_URL",
	"OLLAMA_MODEL",
	"OLLAMA_API_KEY",
	"OLLAMA_CONTEXT_LENGTH",
	"OLLAMA_CONTEXT_WINDOW",
	"OLLAMA_MAX_OUTPUT_TOKENS",
	"OLLAMA_VISION_MODEL",
	"OLLAMA_VISION_MAX_OUTPUT_TOKENS",
	"CODE_SANDBOX_ENABLED",
	"VLLM_BASE_URL",
	"VLLM_MODEL",
	"VLLM_API_KEY",
	"VLLM_CONTEXT_LENGTH",
	"VLLM_MAX_OUTPUT_TOKENS",
	"VLLM_MAX_TOOL_OUTPUT_CHARS",
	"VLLM_EMBEDDING_BASE_URL",
	"VLLM_EMBEDDING_MODEL",
	"VLLM_EMBEDDING_API_KEY",
	"M8B_MEDIA_BASE_URL",
	"AI_BASE_URL",
	"AI_API_KEY",
	"AI_MODEL",
	"AI_CONTEXT_LENGTH",
	"AI_MAX_OUTPUT_TOKENS",
	"AI_MAX_TOOL_OUTPUT_CHARS",
	"AI_IMAGE_INPUT",
	"AI_STRICT_INPUT",
	"AI_EMBEDDING_BASE_URL",
	"AI_EMBEDDING_MODEL",
	"AI_EMBEDDING_API_KEY",
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
			localCodeInterpreter: true,
			hostedWebSearch: false,
			providerFileUploads: false,
			imageDescriptions: false,
			toolNamespaces: false,
		});
	});

	it("disables the local code sandbox with CODE_SANDBOX_ENABLED=false", () => {
		process.env.AI_PROVIDER = "ollama";
		process.env.CODE_SANDBOX_ENABLED = "false";
		resetProviderCache();

		expect(getProvider().capabilities.localCodeInterpreter).toBe(false);
	});

	it("never enables the local sandbox on the hosted OpenAI provider", () => {
		expect(getProvider().capabilities.localCodeInterpreter).toBe(false);
	});

	it("enables image descriptions when a vision model is configured", () => {
		process.env.AI_PROVIDER = "ollama";
		process.env.OLLAMA_VISION_MODEL = "qwen3-vl:8b-instruct-8k";

		const provider = getProvider();
		expect(provider.capabilities.imageDescriptions).toBe(true);
		expect(getOllamaConfig().visionModel).toBe("qwen3-vl:8b-instruct-8k");
		expect(getOllamaConfig().visionMaxOutputTokens).toBe(600);
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
		// 32K: 40% of the usable budget, at the measured payload density
		// (PAYLOAD_CHARS_PER_TOKEN = 2.5 chars/token)
		const at32k = getOllamaConfig().maxToolOutputChars;
		expect(at32k).toBe(Math.floor((32768 - 4000 - 1500) * 2.5 * 0.4));

		process.env.OLLAMA_CONTEXT_LENGTH = "65536";
		const at64k = getOllamaConfig().maxToolOutputChars;
		expect(at64k).toBe(Math.floor((65536 - 4000 - 1500) * 2.5 * 0.4));
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

describe("Ollama vision model", () => {
	const savedFetch = global.fetch;
	const savedEnv = {};

	beforeEach(() => {
		for (const key of ENV_KEYS) {
			savedEnv[key] = process.env[key];
			delete process.env[key];
		}
		process.env.AI_PROVIDER = "ollama";
		process.env.OLLAMA_MODEL = "qwen3.8:27b";
		process.env.OLLAMA_VISION_MODEL = "qwen3-vl:8b-instruct-8k";
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

	function mockModelsEndpoint(models) {
		global.fetch = jest.fn(async (url) => {
			const target = String(url);
			if (target.endsWith("/v1/models")) {
				return { ok: true, json: async () => ({ data: models.map((id) => ({ id })) }) };
			}
			if (target.endsWith("/api/generate") || target.endsWith("/api/ps")) {
				return { ok: true, json: async () => ({ models: [] }) };
			}
			if (target.endsWith("/api/show")) {
				return { ok: true, json: async () => ({ parameters: "" }) };
			}
			throw new Error(`Unexpected fetch: ${target}`);
		});
	}

	it("describes an image through /v1/chat/completions with the vision model", async () => {
		const provider = getProvider();
		const create = jest.fn(async () => ({
			choices: [{ message: { content: "  A red error dialog: DISK FULL on SRV-01.  " } }],
		}));
		provider.client.chat = { completions: { create } };

		const description = await provider.describeImage({
			buffer: Buffer.from("fake-png-bytes"),
			mimetype: "image/png",
			fileName: "error.png",
			contextText: "user: my backup job failed tonight",
		});

		expect(description).toBe("A red error dialog: DISK FULL on SRV-01.");
		expect(create).toHaveBeenCalledTimes(1);
		const request = create.mock.calls[0][0];
		expect(request.model).toBe("qwen3-vl:8b-instruct-8k");
		expect(request.max_tokens).toBe(600);
		expect(request.stream).toBeUndefined();

		const userContent = request.messages.find((m) => m.role === "user").content;
		expect(userContent.find((c) => c.type === "text").text).toContain("my backup job failed");
		expect(userContent.find((c) => c.type === "image_url").image_url.url).toBe(
			`data:image/png;base64,${Buffer.from("fake-png-bytes").toString("base64")}`
		);
	});

	it("throws when the vision model returns no description", async () => {
		const provider = getProvider();
		provider.client.chat = {
			completions: { create: jest.fn(async () => ({ choices: [{ message: { content: "" } }] })) },
		};

		await expect(
			provider.describeImage({
				buffer: Buffer.from("x"),
				mimetype: "image/png",
				fileName: "blank.png",
			})
		).rejects.toThrow(/no description/);
	});

	it("health check reports the vision model and warns when it is missing", async () => {
		mockModelsEndpoint(["qwen3.8:27b", "qwen3-vl:8b-instruct-8k"]);
		let health = await getProvider().healthCheck();
		expect(health.ok).toBe(true);
		expect(health.detail).toContain('vision model "qwen3-vl:8b-instruct-8k" available');
		expect(health.warning).toBeUndefined();

		resetProviderCache();
		mockModelsEndpoint(["qwen3.8:27b"]);
		health = await getProvider().healthCheck();
		expect(health.ok).toBe(true);
		expect(health.warning).toContain("OLLAMA_VISION_MODEL");
	});
});

describe("vLLM provider", () => {
	const savedFetch = global.fetch;
	const savedEnv = {};

	function mockModelsEndpoint({
		models = [{ id: "qwen3.8-27b-int8", max_model_len: 65536 }],
	} = {}) {
		global.fetch = jest.fn(async (url) => {
			const target = String(url);
			if (target.endsWith("/models")) {
				return { ok: true, json: async () => ({ data: models }) };
			}
			throw new Error(`Unexpected fetch: ${target}`);
		});
	}

	beforeEach(() => {
		for (const key of ENV_KEYS) {
			savedEnv[key] = process.env[key];
			delete process.env[key];
		}
		process.env.AI_PROVIDER = "vllm";
		process.env.VLLM_BASE_URL = "http://dev-nvidia-01:8000/v1";
		process.env.VLLM_MODEL = "qwen3.8-27b-int8";
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

	it("selects vLLM with environment configuration", () => {
		expect(getAiProviderName()).toBe("vllm");

		const provider = getProvider();
		expect(provider.name).toBe("vllm");
		expect(provider.isLocal).toBe(true);
		expect(provider.model).toBe("qwen3.8-27b-int8");
		expect(provider.endpoint).toBe("http://dev-nvidia-01:8000/v1");
		expect(provider.contextWindow).toBe(32768);
		expect(provider.capabilities).toMatchObject({
			serverSideState: false,
			hostedFileSearch: false,
			codeInterpreter: false,
			localCodeInterpreter: true,
			hostedWebSearch: false,
			providerFileUploads: false,
			imageDescriptions: false,
			imageInput: true,
			toolNamespaces: false,
		});
	});

	it("uses a dummy API key by default", () => {
		expect(getVllmConfig().apiKey).toBe("vllm");
	});

	it("only sends fields supported by vLLM's /v1/responses", () => {
		process.env.VLLM_MAX_OUTPUT_TOKENS = "4000";
		resetProviderCache();

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
			model: "qwen3.8-27b-int8",
			input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
			max_output_tokens: 4000,
			stream: true,
			tools,
		});
		expect(request).not.toHaveProperty("previous_response_id");
		expect(request).not.toHaveProperty("safety_identifier");
		expect(request).not.toHaveProperty("reasoning");
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

	it("merges leading system items and re-roles mid-conversation ones (single-system Qwen template)", () => {
		const provider = getProvider();
		const input = [
			{ role: "system", content: [{ type: "input_text", text: "base prompt" }] },
			{ role: "system", content: [{ type: "input_text", text: "second leading system" }] },
			{ role: "user", content: [{ type: "input_text", text: "hello" }] },
			{ role: "system", content: [{ type: "input_text", text: "user context note" }] },
			{ role: "user", content: [{ type: "input_text", text: "current question" }] },
			{ type: "function_call", call_id: "c1", name: "ping", arguments: "{}" },
			{ type: "function_call_output", call_id: "c1", output: "{}" },
			{ role: "system", content: [{ type: "input_text", text: "do not repeat yourself" }] },
		];

		const request = provider.buildRequest({ input, tools: [] });

		// The leading system block collapses into ONE system message
		expect(request.input[0]).toEqual({
			role: "system",
			content: [{ type: "input_text", text: "base prompt\n\nsecond leading system" }],
		});
		expect(request.input.filter((item) => item?.role === "system")).toHaveLength(1);
		// Mid-conversation system items become labeled user notes
		expect(request.input[2].role).toBe("user");
		expect(request.input[2].content[0].text).toBe("[System note] user context note");
		expect(request.input[6].role).toBe("user");
		expect(request.input[6].content[0].text).toBe("[System note] do not repeat yourself");
		// Non-system items are untouched (same references)
		expect(request.input[1]).toBe(input[2]);
		expect(request.input[4]).toBe(input[5]);
	});

	it("leaves a single-leading-system input untouched", () => {
		const provider = getProvider();
		const input = [
			{ role: "system", content: [{ type: "input_text", text: "base prompt" }] },
			{ role: "user", content: [{ type: "input_text", text: "hi" }] },
		];

		expect(provider.buildRequest({ input, tools: [] }).input).toBe(input);
	});

	it("flattens replayed assistant output_text content to a string (vLLM schema)", () => {
		const provider = getProvider();
		const input = [
			{ role: "system", content: [{ type: "input_text", text: "base prompt" }] },
			{ role: "user", content: [{ type: "input_text", text: "Hey:" }] },
			{
				role: "assistant",
				content: [{ type: "output_text", text: "\n\nHey yourself. What broke today?" }],
			},
			{
				role: "assistant",
				phase: "final_answer",
				content: [
					{ type: "output_text", text: "part one. " },
					{ type: "output_text", text: "part two." },
				],
			},
			{ role: "user", content: [{ type: "input_text", text: "the network is down" }] },
		];

		const request = provider.buildRequest({ input, tools: [] });

		expect(request.input[2]).toEqual({
			role: "assistant",
			content: "\n\nHey yourself. What broke today?",
		});
		// Multiple parts are joined; other fields (phase) survive
		expect(request.input[3]).toEqual({
			role: "assistant",
			phase: "final_answer",
			content: "part one. part two.",
		});
		// Non-assistant items are untouched (same references)
		expect(request.input[1]).toBe(input[1]);
		expect(request.input[4]).toBe(input[4]);
	});

	it("adopts the served context length from /v1/models max_model_len", async () => {
		mockModelsEndpoint();

		const provider = getProvider();
		expect(provider.contextWindow).toBe(32768); // default before detection

		const health = await provider.healthCheck();
		expect(health.ok).toBe(true);
		expect(provider.contextWindow).toBe(65536);
		expect(health.detail).toContain("max_model_len");
	});

	it("caps an over-configured context length with a warning", async () => {
		process.env.VLLM_CONTEXT_LENGTH = "131072";
		resetProviderCache();
		mockModelsEndpoint();

		const provider = getProvider();
		const health = await provider.healthCheck();

		expect(provider.contextWindow).toBe(65536);
		expect(health.warning).toContain("max_model_len");
	});

	it("keeps a deliberately tighter configured context length", async () => {
		process.env.VLLM_CONTEXT_LENGTH = "16384";
		resetProviderCache();
		mockModelsEndpoint();

		const provider = getProvider();
		const health = await provider.healthCheck();

		expect(provider.contextWindow).toBe(16384);
		expect(health.detail).toContain("server allows 65536");
	});

	it("adopts the single served model when VLLM_MODEL is unset", async () => {
		delete process.env.VLLM_MODEL;
		resetProviderCache();
		mockModelsEndpoint();

		const provider = getProvider();
		expect(provider.model).toBe("");

		const health = await provider.healthCheck();
		expect(health.ok).toBe(true);
		expect(provider.model).toBe("qwen3.8-27b-int8");
		expect(provider.buildRequest({ input: [] }).model).toBe("qwen3.8-27b-int8");
	});

	it("fails the health check when the configured model is not served", async () => {
		mockModelsEndpoint({ models: [{ id: "some-other-model", max_model_len: 4096 }] });

		const health = await getProvider().healthCheck();
		expect(health.ok).toBe(false);
		expect(health.error).toContain("qwen3.8-27b-int8");
		expect(health.error).toContain("some-other-model");
	});

	it("warns when the media store is not configured (base64 fallback)", async () => {
		mockModelsEndpoint();

		const health = await getProvider().healthCheck();
		expect(health.ok).toBe(true);
		expect(health.warning).toContain("M8B_MEDIA_BASE_URL");

		process.env.M8B_MEDIA_BASE_URL = "https://bm-linux-slack.internal.example.net/m8b-media";
		resetProviderCache();
		mockModelsEndpoint();
		const healthy = await getProvider().healthCheck();
		expect(healthy.warning).toBeUndefined();
		expect(healthy.detail).toContain("media store");
	});

	it("uses the friendly local-backend error messages", () => {
		const provider = getProvider();
		expect(describeProviderError(new Error("fetch failed"), provider)).toContain(
			"local AI backend"
		);
	});

	it("requires a dedicated embedding endpoint for the knowledge base", () => {
		expect(getEmbeddingBackendConfig()).toBeNull();

		process.env.VLLM_EMBEDDING_BASE_URL = "http://dev-nvidia-01:8001/v1/";
		process.env.VLLM_EMBEDDING_MODEL = "qwen3-embedding-0.6b";
		expect(getEmbeddingBackendConfig()).toEqual({
			baseUrl: "http://dev-nvidia-01:8001/v1",
			apiKey: "vllm",
			model: "qwen3-embedding-0.6b",
		});

		// The chat API key is reused unless a dedicated one is set
		process.env.VLLM_API_KEY = "chat-key";
		expect(getEmbeddingBackendConfig().apiKey).toBe("chat-key");
		process.env.VLLM_EMBEDDING_API_KEY = "embed-key";
		expect(getEmbeddingBackendConfig().apiKey).toBe("embed-key");
	});

	it("resolves the Ollama embedding backend from the Ollama config", () => {
		process.env.AI_PROVIDER = "ollama";
		expect(getEmbeddingBackendConfig()).toMatchObject({ model: "nomic-embed-text" });
	});

	it("has no embedding backend in OpenAI mode (hosted file_search)", () => {
		process.env.AI_PROVIDER = "openai";
		expect(getEmbeddingBackendConfig()).toBeNull();
	});
});

describe("openai-compatible provider (generic)", () => {
	const savedFetch = global.fetch;
	const savedEnv = {};

	function mockModelsEndpoint({ models, status = 200, embeddings = null } = {}) {
		global.fetch = jest.fn(async (url) => {
			const target = String(url);
			if (target.endsWith("/models")) {
				if (status !== 200) return { ok: false, status, json: async () => ({}) };
				return { ok: true, json: async () => ({ data: models }) };
			}
			if (target.endsWith("/embeddings") && embeddings) {
				if (embeddings === "fail") return { ok: false, status: 502, json: async () => ({}) };
				return { ok: true, json: async () => ({ data: [{ embedding: [0.1, 0.2, 0.3] }] }) };
			}
			throw new Error(`Unexpected fetch: ${target}`);
		});
	}

	const GATEWAY_MODELS = [
		{ id: "nemotron-super" },
		{ id: "llama-3.3-70b", context_length: 131072 },
		{ id: "embed-qa-4" },
	];

	beforeEach(() => {
		for (const key of ENV_KEYS) {
			savedEnv[key] = process.env[key];
			delete process.env[key];
		}
		process.env.AI_PROVIDER = "openai-compatible";
		process.env.AI_BASE_URL = "https://inference.example.com/v1/";
		process.env.AI_API_KEY = "gateway-token";
		process.env.AI_MODEL = "llama-3.3-70b";
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

	it("selects the generic provider with AI_* configuration", () => {
		expect(getAiProviderName()).toBe("openai-compatible");

		const provider = getProvider();
		expect(provider.name).toBe("openai-compatible");
		expect(provider.isLocal).toBe(true);
		expect(provider.model).toBe("llama-3.3-70b");
		expect(provider.endpoint).toBe("https://inference.example.com/v1");
		expect(provider.contextWindow).toBe(32768);
		expect(provider.maxOutputTokens).toBe(4000);
		expect(provider.capabilities).toEqual({
			serverSideState: false,
			hostedFileSearch: false,
			codeInterpreter: false,
			localCodeInterpreter: true,
			hostedWebSearch: false,
			providerFileUploads: false,
			imageDescriptions: false,
			imageInput: false,
			toolNamespaces: false,
		});
	});

	it("uses a dummy API key when none is configured", () => {
		delete process.env.AI_API_KEY;
		expect(getOpenAiCompatibleConfig().apiKey).toBe("none");
	});

	it("opts into native image input with AI_IMAGE_INPUT", () => {
		process.env.AI_IMAGE_INPUT = "true";
		resetProviderCache();
		expect(getProvider().capabilities.imageInput).toBe(true);

		process.env.AI_IMAGE_INPUT = "1";
		resetProviderCache();
		expect(getProvider().capabilities.imageInput).toBe(true);

		process.env.AI_IMAGE_INPUT = "no";
		resetProviderCache();
		expect(getProvider().capabilities.imageInput).toBe(false);
	});

	it("only sends universally supported /v1/responses fields", () => {
		const provider = getProvider();
		const tools = [{ type: "function", name: "ListHosts", parameters: {} }];
		const input = [{ role: "user", content: [{ type: "input_text", text: "hi" }] }];
		const request = provider.buildRequest({
			input,
			tools,
			previous_response_id: "resp_should_not_be_sent",
			safety_identifier: "hash_should_not_be_sent",
		});

		expect(request).toEqual({
			model: "llama-3.3-70b",
			input,
			max_output_tokens: 4000,
			stream: true,
			tools,
		});
		expect(request).not.toHaveProperty("previous_response_id");
		expect(request).not.toHaveProperty("safety_identifier");
		expect(request).not.toHaveProperty("reasoning");
		expect(request).not.toHaveProperty("text");
	});

	it("passes the input through untouched by default (no strict conforming)", () => {
		const provider = getProvider();
		const input = [
			{ role: "system", content: [{ type: "input_text", text: "base prompt" }] },
			{ role: "system", content: [{ type: "input_text", text: "attachment guidance" }] },
			{ role: "user", content: [{ type: "input_text", text: "hello" }] },
			{ role: "system", content: [{ type: "input_text", text: "mid-conversation note" }] },
			{ role: "assistant", content: [{ type: "output_text", text: "replayed answer" }] },
		];

		expect(provider.buildRequest({ input, tools: [] }).input).toBe(input);
	});

	it("applies the strict chat-template conforming with AI_STRICT_INPUT=true", () => {
		process.env.AI_STRICT_INPUT = "true";
		resetProviderCache();

		const provider = getProvider();
		const input = [
			{ role: "system", content: [{ type: "input_text", text: "base prompt" }] },
			{ role: "system", content: [{ type: "input_text", text: "attachment guidance" }] },
			{ role: "user", content: [{ type: "input_text", text: "hello" }] },
			{ role: "system", content: [{ type: "input_text", text: "mid-conversation note" }] },
			{ role: "assistant", content: [{ type: "output_text", text: "replayed answer" }] },
		];

		const conformed = provider.buildRequest({ input, tools: [] }).input;
		expect(conformed.filter((item) => item?.role === "system")).toHaveLength(1);
		expect(conformed[0].content[0].text).toBe("base prompt\n\nattachment guidance");
		expect(conformed[2]).toMatchObject({ role: "user" });
		expect(conformed[2].content[0].text).toBe("[System note] mid-conversation note");
		expect(conformed[3]).toEqual({ role: "assistant", content: "replayed answer" });
	});

	it("passes the health check when the configured model is served among many", async () => {
		mockModelsEndpoint({ models: GATEWAY_MODELS });

		const provider = getProvider();
		const health = await provider.healthCheck();

		expect(health.ok).toBe(true);
		expect(health.detail).toContain('model "llama-3.3-70b" available');
		// context_length is honored as an alternative to vLLM's max_model_len
		expect(provider.contextWindow).toBe(131072);
		expect(health.detail).toContain("context_length");
		// No image input: no media-store nagging
		expect(health.warning).toBeUndefined();
		expect(health.detail).not.toContain("media store");
		expect(global.fetch.mock.calls[0][1].headers.Authorization).toBe("Bearer gateway-token");
	});

	it("warns when the context length is neither reported nor configured", async () => {
		mockModelsEndpoint({ models: [{ id: "llama-3.3-70b" }] });

		const provider = getProvider();
		const health = await provider.healthCheck();

		expect(health.ok).toBe(true);
		expect(provider.contextWindow).toBe(32768);
		expect(health.detail).toContain("DEFAULT");
		expect(health.warning).toContain("AI_CONTEXT_LENGTH");
	});

	it("trusts an explicit AI_CONTEXT_LENGTH when the server reports none", async () => {
		process.env.AI_CONTEXT_LENGTH = "131072";
		resetProviderCache();
		mockModelsEndpoint({ models: [{ id: "llama-3.3-70b" }] });

		const provider = getProvider();
		const health = await provider.healthCheck();

		expect(health.ok).toBe(true);
		expect(provider.contextWindow).toBe(131072);
		expect(health.detail).toContain("server value not reported");
		expect(health.warning).toBeUndefined();
	});

	it("probes the embedding endpoint and only warns when it fails", async () => {
		process.env.AI_EMBEDDING_MODEL = "embed-qa-4";
		resetProviderCache();
		mockModelsEndpoint({ models: GATEWAY_MODELS, embeddings: "ok" });

		let health = await getProvider().healthCheck();
		expect(health.ok).toBe(true);
		expect(health.detail).toContain('embeddings "embed-qa-4" ok');
		expect(health.warning).toBeUndefined();
		const probe = global.fetch.mock.calls.find(([url]) => String(url).endsWith("/embeddings"));
		expect(probe[0]).toBe("https://inference.example.com/v1/embeddings");
		expect(JSON.parse(probe[1].body)).toMatchObject({ model: "embed-qa-4" });

		resetProviderCache();
		mockModelsEndpoint({ models: GATEWAY_MODELS, embeddings: "fail" });
		health = await getProvider().healthCheck();
		expect(health.ok).toBe(true);
		expect(health.detail).toContain("FAILING");
		expect(health.warning).toContain("HTTP 502");
		expect(health.warning).toContain("knowledge base");
	});

	it("caps an over-configured AI_CONTEXT_LENGTH with a warning naming the variable", async () => {
		process.env.AI_CONTEXT_LENGTH = "1000000";
		resetProviderCache();
		mockModelsEndpoint({ models: GATEWAY_MODELS });

		const provider = getProvider();
		const health = await provider.healthCheck();

		expect(provider.contextWindow).toBe(131072);
		expect(health.warning).toContain("AI_CONTEXT_LENGTH");
	});

	it("fails the health check when the configured model is not served", async () => {
		process.env.AI_MODEL = "gpt-oss-120b";
		resetProviderCache();
		mockModelsEndpoint({ models: GATEWAY_MODELS });

		const health = await getProvider().healthCheck();
		expect(health.ok).toBe(false);
		expect(health.error).toContain("gpt-oss-120b");
		expect(health.error).toContain("nemotron-super");
	});

	it("never guesses the model: AI_MODEL is required even when one model is served", async () => {
		delete process.env.AI_MODEL;
		resetProviderCache();
		mockModelsEndpoint({ models: [{ id: "only-one" }] });

		const provider = getProvider();
		const health = await provider.healthCheck();

		expect(health.ok).toBe(false);
		expect(health.error).toContain("AI_MODEL");
		expect(provider.model).toBe("");
	});

	it("degrades to an unverified health check when /v1/models is unavailable", async () => {
		mockModelsEndpoint({ status: 404 });

		const health = await getProvider().healthCheck();
		expect(health.ok).toBe(true);
		expect(health.detail).toContain("unverified");
		expect(health.warning).toContain("HTTP 404");

		delete process.env.AI_MODEL;
		resetProviderCache();
		const noModel = await getProvider().healthCheck();
		expect(noModel.ok).toBe(false);
		expect(noModel.error).toContain("AI_MODEL");
	});

	it("warns about the media store only when image input is enabled", async () => {
		process.env.AI_IMAGE_INPUT = "true";
		resetProviderCache();
		mockModelsEndpoint({ models: GATEWAY_MODELS });

		const health = await getProvider().healthCheck();
		expect(health.ok).toBe(true);
		expect(health.warning).toContain("M8B_MEDIA_BASE_URL");
	});

	it("reports the backend as unreachable on transport errors", async () => {
		global.fetch = jest.fn(async () => {
			throw new Error("connect ECONNREFUSED");
		});

		const provider = getProvider();
		const health = await provider.healthCheck();
		expect(health.ok).toBe(false);
		expect(health.error).toContain("unreachable");
		expect(describeProviderError(new Error("fetch failed"), provider)).toContain(
			"local AI backend"
		);
	});

	it("enables the knowledge base only with AI_EMBEDDING_MODEL, defaulting to the chat endpoint", () => {
		expect(getEmbeddingBackendConfig()).toBeNull();

		process.env.AI_EMBEDDING_MODEL = "embed-qa-4";
		expect(getEmbeddingBackendConfig()).toEqual({
			baseUrl: "https://inference.example.com/v1",
			apiKey: "gateway-token",
			model: "embed-qa-4",
		});

		process.env.AI_EMBEDDING_BASE_URL = "http://embeddings.internal:8001/v1/";
		process.env.AI_EMBEDDING_API_KEY = "embed-token";
		expect(getEmbeddingBackendConfig()).toEqual({
			baseUrl: "http://embeddings.internal:8001/v1",
			apiKey: "embed-token",
			model: "embed-qa-4",
		});
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
