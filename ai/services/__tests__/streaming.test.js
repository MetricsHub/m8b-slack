/**
 * Tests for OpenAI streaming request configuration and stream handling.
 */

import { jest } from "@jest/globals";
import { MODEL_CONFIG } from "../../config/system-prompt.js";
import { buildResponseRequest, streamOnce } from "../streaming.js";

describe("buildResponseRequest", () => {
	it("uses the GPT-5.6 Sol Responses API configuration", () => {
		const request = buildResponseRequest({
			input: [{ role: "user", content: "status" }],
			tools: [],
			previous_response_id: "resp_previous",
			safety_identifier: "a".repeat(64),
		});

		expect(request).toMatchObject({
			model: "gpt-5.6-sol",
			reasoning: { effort: "medium", summary: "auto", context: "auto" },
			previous_response_id: "resp_previous",
			safety_identifier: "a".repeat(64),
			max_output_tokens: 8000,
			tool_choice: "auto",
			parallel_tool_calls: true,
			text: { format: { type: "text" }, verbosity: "low" },
			stream: true,
		});
		expect(request.model).toBe(MODEL_CONFIG.model);
	});
});

describe("streamOnce timing metrics", () => {
	function makeProvider(events) {
		return {
			name: "vllm",
			model: "test-model",
			client: {
				responses: {
					create: async () => ({
						async *[Symbol.asyncIterator]() {
							for (const evt of events) {
								if (evt === "DELAY") {
									await new Promise((resolve) => setTimeout(resolve, 25));
									continue;
								}
								yield evt;
							}
						},
					}),
				},
			},
			buildRequest: (params) => ({ model: "test-model", input: params.input, stream: true }),
		};
	}

	function makeCallbacks() {
		return {
			setStatus: jest.fn(async () => {}),
			onTextChunk: jest.fn(async () => {}),
			logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
		};
	}

	it("measures duration, time to first token, and generation rate", async () => {
		const provider = makeProvider([
			{ type: "response.created", response: { id: "resp_t" } },
			"DELAY", // queue + prompt processing before the first token
			{ type: "response.output_text.delta", delta: "Hello" },
			"DELAY", // generation time
			{
				type: "response.completed",
				response: {
					id: "resp_t",
					usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
				},
			},
		]);
		const callbacks = makeCallbacks();

		const result = await streamOnce({ input: [], tools: [], provider }, callbacks);

		expect(result.usage.outputTokens).toBe(50);
		expect(result.timing.durationMs).toBeGreaterThanOrEqual(40);
		expect(result.timing.timeToFirstTokenMs).toBeGreaterThanOrEqual(20);
		expect(result.timing.timeToFirstTokenMs).toBeLessThanOrEqual(result.timing.durationMs);
		expect(result.timing.tokensPerSecond).toBeGreaterThan(0);

		// The turn summary log carries the timing block
		const completeLog = callbacks.logger.info.mock.calls.find(
			([msg]) => msg === "[STREAM_COMPLETE] Turn finished"
		);
		expect(completeLog[1].timing).toEqual(result.timing);
	});

	it("reports null timing fields when the stream produces nothing", async () => {
		const provider = makeProvider([{ type: "response.created", response: { id: "resp_e" } }]);

		const result = await streamOnce({ input: [], tools: [], provider }, makeCallbacks());

		expect(result.timing.timeToFirstTokenMs).toBeNull();
		expect(result.timing.tokensPerSecond).toBeNull();
		expect(result.timing.durationMs).toBeGreaterThanOrEqual(0);
	});
});

describe("streamOnce no-reply placeholder suppression", () => {
	function makeProvider(events) {
		return {
			name: "vllm",
			model: "test-model",
			client: {
				responses: {
					create: async () => ({
						async *[Symbol.asyncIterator]() {
							for (const evt of events) yield evt;
						},
					}),
				},
			},
			buildRequest: (params) => ({ model: "test-model", input: params.input, stream: true }),
		};
	}

	function makeCallbacks() {
		return {
			setStatus: jest.fn(async () => {}),
			onTextChunk: jest.fn(async () => {}),
			onStreamStart: jest.fn(async () => ({ append: jest.fn(), stop: jest.fn() })),
			logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
		};
	}

	const completed = {
		type: "response.completed",
		response: { id: "resp_s", usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } },
	};

	it("suppresses a pure placeholder without ever opening the Slack stream", async () => {
		const provider = makeProvider([
			{ type: "response.created", response: { id: "resp_s" } },
			{ type: "response.output_text.delta", delta: "\n\n[No response" },
			{ type: "response.output_text.delta", delta: " needed]" },
			completed,
		]);
		const callbacks = makeCallbacks();

		const result = await streamOnce({ input: [], tools: [], provider }, callbacks);

		expect(callbacks.onTextChunk).not.toHaveBeenCalled();
		expect(callbacks.onStreamStart).not.toHaveBeenCalled();
		// Suppressed text must look like "no output" to the agent loop
		expect(result.hadText).toBe(false);
		expect(result.fullResponseText).toBe("");
	});

	it.each([
		"[No response needed]",
		"No further response required.",
		"(no reply necessary)",
		"no output needed",
	])("suppresses the placeholder variant %p", async (placeholder) => {
		const provider = makeProvider([
			{ type: "response.output_text.delta", delta: placeholder },
			completed,
		]);
		const callbacks = makeCallbacks();

		const result = await streamOnce({ input: [], tools: [], provider }, callbacks);

		expect(callbacks.onTextChunk).not.toHaveBeenCalled();
		expect(result.hadText).toBe(false);
	});

	it("delivers short real answers (single emoji, snark) at stream end", async () => {
		const provider = makeProvider([{ type: "response.output_text.delta", delta: "🙄" }, completed]);
		const callbacks = makeCallbacks();

		const result = await streamOnce({ input: [], tools: [], provider }, callbacks);

		expect(callbacks.onStreamStart).toHaveBeenCalledTimes(1);
		expect(callbacks.onTextChunk).toHaveBeenCalledWith("🙄", expect.anything());
		expect(result.hadText).toBe(true);
		expect(result.fullResponseText).toBe("🙄");
	});

	it('never suppresses answers that merely resemble the phrase ("No action needed.")', async () => {
		const provider = makeProvider([
			{ type: "response.output_text.delta", delta: "No action needed." },
			completed,
		]);
		const callbacks = makeCallbacks();

		const result = await streamOnce({ input: [], tools: [], provider }, callbacks);

		expect(callbacks.onTextChunk).toHaveBeenCalledWith("No action needed.", expect.anything());
		expect(result.hadText).toBe(true);
	});

	it("flushes and streams normally once the text outgrows the holdback window", async () => {
		const long = "Here is the detailed status of every server you asked about, one by one: ";
		const provider = makeProvider([
			{ type: "response.output_text.delta", delta: long },
			{ type: "response.output_text.delta", delta: "srv-web-01 is fine." },
			completed,
		]);
		const callbacks = makeCallbacks();

		const result = await streamOnce({ input: [], tools: [], provider }, callbacks);

		// First call carries the flushed holdback (trailing space deferred),
		// the deferred space rejoins the second chunk
		expect(callbacks.onTextChunk).toHaveBeenNthCalledWith(1, long.trimEnd(), expect.anything());
		expect(callbacks.onTextChunk).toHaveBeenNthCalledWith(
			2,
			" srv-web-01 is fine.",
			expect.anything()
		);
		expect(result.fullResponseText).toBe(`${long}srv-web-01 is fine.`);
		expect(result.hadText).toBe(true);
	});

	it("never opens a Slack stream on a tool-call-only turn (no empty messages)", async () => {
		const provider = makeProvider([
			{ type: "response.created", response: { id: "resp_s" } },
			{
				type: "response.output_item.added",
				output_index: 0,
				item: { type: "function_call", call_id: "c1", name: "ping", arguments: "" },
			},
			{
				type: "response.output_item.done",
				output_index: 0,
				item: { type: "function_call", call_id: "c1", name: "ping", arguments: "{}" },
			},
			completed,
		]);
		const callbacks = makeCallbacks();

		const result = await streamOnce({ input: [], tools: [], provider }, callbacks);

		expect(callbacks.onStreamStart).not.toHaveBeenCalled();
		expect(callbacks.onTextChunk).not.toHaveBeenCalled();
		expect(result.functionCalls).toHaveLength(1);
		expect(result.hadText).toBe(false);
	});

	it("never opens a Slack stream for whitespace-only text output", async () => {
		const provider = makeProvider([
			{ type: "response.output_text.delta", delta: "\n\n" },
			{ type: "response.output_text.delta", delta: "\n" },
			completed,
		]);
		const callbacks = makeCallbacks();

		const result = await streamOnce({ input: [], tools: [], provider }, callbacks);

		expect(callbacks.onStreamStart).not.toHaveBeenCalled();
		expect(callbacks.onTextChunk).not.toHaveBeenCalled();
		expect(result.hadText).toBe(false);
		expect(result.fullResponseText).toBe("");
	});

	it("trims the model's leading/trailing newline padding around tool calls", async () => {
		// 70+ chars so the holdback flushes mid-stream, then trailing padding
		const text =
			"Found three: purem-san, pure-san, purex-san. Pulling cached metrics, don't get comfy.";
		const provider = makeProvider([
			{ type: "response.output_text.delta", delta: `\n\n${text.slice(0, 70)}` },
			{ type: "response.output_text.delta", delta: text.slice(70) },
			{ type: "response.output_text.delta", delta: "\n\n\n" },
			completed,
		]);
		const callbacks = makeCallbacks();

		const result = await streamOnce({ input: [], tools: [], provider }, callbacks);

		const streamed = callbacks.onTextChunk.mock.calls.map(([chunk]) => chunk).join("");
		expect(streamed).toBe(text); // no leading blank lines, no trailing newlines
		expect(result.fullResponseText).toBe(text); // persisted text is clean too
		expect(result.hadText).toBe(true);
	});
});
