/**
 * Ollama-mode tests for the respond orchestrator: basic response, multi-turn
 * application-side conversation state, the function-calling agent loop, and
 * the loop iteration cap. The model stream is mocked; no Ollama server needed.
 */

import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const streamOnceMock = jest.fn();

// Note: mock specifiers resolve from the project root (jest.setup.js location)
// and are extension-less because jest's moduleNameMapper strips ".js"
jest.unstable_mockModule("./ai/services/streaming", () => ({
	streamOnce: streamOnceMock,
	buildResponseRequest: jest.fn(),
}));

const fakeOllamaProvider = {
	name: "ollama",
	model: "qwen3.8:27b",
	endpoint: "http://dev-nvidia-01:11434/v1",
	client: {},
	contextWindow: 32768,
	maxOutputTokens: 4000,
	capabilities: {
		serverSideState: false,
		hostedFileSearch: false,
		codeInterpreter: false,
		hostedWebSearch: false,
		providerFileUploads: false,
		toolNamespaces: false,
	},
	buildRequest: (params) => params,
	healthCheck: async () => ({ ok: true }),
};

jest.unstable_mockModule("./ai/providers/index", () => ({
	getProvider: () => fakeOllamaProvider,
	describeProviderError: () => "Friendly local AI error.",
	resetProviderCache: () => {},
}));

const { respond } = await import("../respond.js");
const conversationStore = await import("../services/conversation-store.js");
const { clearConversationStore, conversationKey, getConversation } = conversationStore;

function textResult(text, responseId = "resp_1") {
	return {
		functionCalls: [],
		outputFiles: [],
		responseId,
		hadText: true,
		incompleteReason: null,
		sawCompleted: true,
		fullResponseText: text,
		streamController: null,
		debug: {},
	};
}

function functionCallResult(calls, responseId = "resp_fc") {
	return {
		functionCalls: calls,
		outputFiles: [],
		responseId,
		hadText: false,
		incompleteReason: null,
		sawCompleted: true,
		fullResponseText: "",
		streamController: null,
		debug: {},
	};
}

function makeHarness({ text = "What is my name?", ts = "100.2", threadMessages = [] } = {}) {
	const client = {
		conversations: { replies: jest.fn(async () => ({ messages: threadMessages })) },
		users: {
			info: jest.fn(async () => ({
				ok: true,
				user: { real_name: "Bertrand", tz: "Europe/Paris" },
			})),
		},
		reactions: { add: jest.fn(async () => ({ ok: true })) },
		chatStream: jest.fn(() => ({
			append: jest.fn(async () => {}),
			stop: jest.fn(async () => {}),
		})),
	};

	const logger = {
		info: jest.fn(),
		warn: jest.fn(),
		error: jest.fn(),
		debug: jest.fn(),
	};

	return {
		client,
		logger,
		say: jest.fn(async () => {}),
		setTitle: jest.fn(async () => {}),
		setStatus: jest.fn(async () => {}),
		context: { BOT_ID: "B1", BOT_USER_ID: "UBOT", userId: "U1", teamId: "T1" },
		message: { text, channel: "C1", thread_ts: "100.1", ts, user: "U1" },
		body: {},
	};
}

async function runRespond(harness) {
	await respond({
		client: harness.client,
		context: harness.context,
		logger: harness.logger,
		message: harness.message,
		body: harness.body,
		say: harness.say,
		setTitle: harness.setTitle,
		setStatus: harness.setStatus,
	});
}

/** Flatten every input_text/output_text in a streamOnce input for assertions */
function allText(input) {
	return (input || [])
		.flatMap((item) => item?.content || [])
		.map((c) => c?.text || "")
		.join("\n");
}

beforeEach(() => {
	streamOnceMock.mockReset();
	clearConversationStore();
	process.env.KNOWLEDGE_BASE_DIR = "data/does-not-exist-for-tests";
});

describe("respond in Ollama mode", () => {
	it("answers a basic message without server-side state fields", async () => {
		streamOnceMock.mockResolvedValueOnce(textResult("Working. Obviously."));

		const harness = makeHarness({ text: "Is the server up?" });
		await runRespond(harness);

		expect(streamOnceMock).toHaveBeenCalledTimes(1);
		const [params] = streamOnceMock.mock.calls[0];

		// Stateless: no previous_response_id, provider passed through
		expect(params.previous_response_id).toBeFalsy();
		expect(params.provider).toBe(fakeOllamaProvider);

		// System prompt and the user's message are in the input
		expect(params.input[0].role).toBe("system");
		expect(allText(params.input)).toContain("Is the server up?");

		// The local-mode prompt rule about truncated tool outputs is included
		expect(params.input[0].content[0].text).toContain("ONE host per call");

		// Only function tools are offered
		for (const tool of params.tools) {
			expect(tool.type).toBe("function");
		}
	});

	it("keeps multi-turn context in the same Slack thread without previous_response_id", async () => {
		streamOnceMock.mockResolvedValueOnce(textResult("Noted, Bertrand. What do you want?"));

		const first = makeHarness({ text: "My name is Bertrand.", ts: "100.2" });
		await runRespond(first);

		// Conversation was persisted under the natural Slack key
		const key = conversationKey({ teamId: "T1", channel: "C1", threadTs: "100.1" });
		const stored = getConversation(key);
		expect(allText(stored)).toContain("My name is Bertrand.");
		expect(allText(stored)).toContain("Noted, Bertrand. What do you want?");

		streamOnceMock.mockResolvedValueOnce(textResult("Bertrand. You just told me. 🙄"));

		const second = makeHarness({ text: "What is my name?", ts: "100.3" });
		await runRespond(second);

		expect(streamOnceMock).toHaveBeenCalledTimes(2);
		const [params] = streamOnceMock.mock.calls[1];

		// The second request replays the first exchange in `input`
		const inputText = allText(params.input);
		expect(inputText).toContain("My name is Bertrand.");
		expect(inputText).toContain("Noted, Bertrand. What do you want?");
		expect(inputText).toContain("What is my name?");
		expect(params.previous_response_id).toBeFalsy();
	});

	it("runs the full agent loop: function call -> execution -> result -> final answer", async () => {
		streamOnceMock
			.mockResolvedValueOnce(
				functionCallResult([
					{
						type: "function_call",
						call_id: "call_1",
						name: "slack_add_reaction",
						arguments: '{"emoji":"eyes"}',
					},
				])
			)
			.mockResolvedValueOnce(textResult("Done. Reaction added."));

		const harness = makeHarness({ text: "React to this." });
		await runRespond(harness);

		// The application executed the tool
		expect(harness.client.reactions.add).toHaveBeenCalledWith({
			channel: "C1",
			name: "eyes",
			timestamp: "100.2",
		});

		// The second model call replays the function_call and its output
		expect(streamOnceMock).toHaveBeenCalledTimes(2);
		const [secondParams] = streamOnceMock.mock.calls[1];
		const callItem = secondParams.input.find((i) => i?.type === "function_call");
		const outputItem = secondParams.input.find((i) => i?.type === "function_call_output");
		expect(callItem).toMatchObject({ call_id: "call_1", name: "slack_add_reaction" });
		expect(outputItem).toMatchObject({ call_id: "call_1" });
		expect(JSON.parse(outputItem.output)).toEqual({ ok: true });

		// Tool-call detail is persisted for the next turn
		const key = conversationKey({ teamId: "T1", channel: "C1", threadTs: "100.1" });
		const stored = getConversation(key);
		expect(stored.some((i) => i?.type === "function_call")).toBe(true);
		expect(stored.some((i) => i?.type === "function_call_output")).toBe(true);
	});

	it("supports multiple tool calls in a single turn", async () => {
		streamOnceMock
			.mockResolvedValueOnce(
				functionCallResult([
					{
						type: "function_call",
						call_id: "call_1",
						name: "slack_add_reaction",
						arguments: '{"emoji":"eyes"}',
					},
					{
						type: "function_call",
						call_id: "call_2",
						name: "slack_add_reaction",
						arguments: '{"emoji":"fire"}',
					},
				])
			)
			.mockResolvedValueOnce(textResult("Both done."));

		const harness = makeHarness();
		await runRespond(harness);

		expect(harness.client.reactions.add).toHaveBeenCalledTimes(2);
		const [secondParams] = streamOnceMock.mock.calls[1];
		const outputs = secondParams.input.filter((i) => i?.type === "function_call_output");
		expect(outputs.map((o) => o.call_id).sort()).toEqual(["call_1", "call_2"]);
	});

	it("does not run an extra model turn when text was streamed and only side-effect tools ran", async () => {
		// Qwen commonly answers AND reacts in the same turn; the answer is already
		// in Slack, so a follow-up turn would just repeat it as a duplicate message
		streamOnceMock.mockResolvedValueOnce({
			...textResult("153 hosts. Obviously."),
			functionCalls: [
				{
					type: "function_call",
					call_id: "call_1",
					name: "slack_add_reaction",
					arguments: '{"emoji":"thumbsup"}',
				},
			],
		});

		const harness = makeHarness({ text: "How many hosts?" });
		await runRespond(harness);

		// The reaction was executed, but NO second model turn happened
		expect(harness.client.reactions.add).toHaveBeenCalledTimes(1);
		expect(streamOnceMock).toHaveBeenCalledTimes(1);

		// The tool exchange is still persisted for future turns
		const key = conversationKey({ teamId: "T1", channel: "C1", threadTs: "100.1" });
		const stored = getConversation(key);
		expect(stored.some((i) => i?.type === "function_call_output")).toBe(true);
		// And the answer is stored exactly once
		const answers = stored.filter((i) => allText([i]).includes("153 hosts. Obviously."));
		expect(answers).toHaveLength(1);
	});

	it("treats a successful slack_add_reply as the delivered answer (no extra model turn)", async () => {
		// Regression: the model answered via slack_add_reply (no assistant text);
		// the loop used to run one more turn that streamed meta-commentary about
		// its own tool calls into the thread
		streamOnceMock.mockResolvedValueOnce(
			functionCallResult([
				{
					type: "function_call",
					call_id: "call_1",
					name: "slack_add_reply",
					arguments: '{"text":"I have no idea. Ask the platform team."}',
				},
			])
		);

		const harness = makeHarness({ text: "Which LLM model are you running on?" });
		await runRespond(harness);

		// The reply went out through say(), and no extra model turn ran
		expect(harness.say).toHaveBeenCalledWith({
			markdown_text: "I have no idea. Ask the platform team.",
		});
		expect(streamOnceMock).toHaveBeenCalledTimes(1);

		// No "I've got nothing" fallback: the reply WAS the answer
		const saidTexts = harness.say.mock.calls.map(([arg]) => arg?.text || "");
		expect(saidTexts.join("\n")).not.toContain("I've got nothing");
	});

	it("continues the loop after a failed reaction without treating it as an answer", async () => {
		// A failed slack_add_reaction (invalid emoji) must not end the turn:
		// the model still owes the user an answer
		streamOnceMock
			.mockResolvedValueOnce(
				functionCallResult([
					{
						type: "function_call",
						call_id: "call_1",
						name: "slack_add_reaction",
						arguments: '{"emoji":"not_a_real_emoji_xyz"}',
					},
				])
			)
			.mockResolvedValueOnce(textResult("Here is the actual answer."));

		const harness = makeHarness();
		const error = new Error("An API error occurred: invalid_name");
		// @ts-ignore - mimic Slack WebAPIPlatformError shape
		error.data = { ok: false, error: "invalid_name" };
		harness.client.reactions.add.mockRejectedValueOnce(error);

		await runRespond(harness);

		expect(streamOnceMock).toHaveBeenCalledTimes(2);
		const [secondParams] = streamOnceMock.mock.calls[1];
		const outputItem = secondParams.input.find((i) => i?.type === "function_call_output");
		const output = JSON.parse(outputItem.output);
		expect(output.ok).toBe(false);
		expect(output.hint).toContain("shortcode");
	});

	it("nudges the model not to repeat already-streamed text when a data call continues the turn", async () => {
		// Text + a data-fetching call in the same turn: the loop must continue to
		// deliver the result, with a one-shot anti-repeat instruction
		streamOnceMock
			.mockResolvedValueOnce({
				...textResult("Let me check."),
				functionCalls: [
					{ type: "function_call", call_id: "call_1", name: "ListHosts", arguments: "{}" },
				],
			})
			.mockResolvedValueOnce(textResult("153 hosts."));

		const harness = makeHarness({ text: "How many hosts?" });
		await runRespond(harness);

		expect(streamOnceMock).toHaveBeenCalledTimes(2);
		const [secondParams] = streamOnceMock.mock.calls[1];
		expect(allText(secondParams.input)).toContain("Do NOT repeat");

		// The nudge is transient: it is not persisted in the conversation store
		const key = conversationKey({ teamId: "T1", channel: "C1", threadTs: "100.1" });
		expect(allText(getConversation(key))).not.toContain("Do NOT repeat");
	});

	it("stops a runaway tool loop at the iteration cap", async () => {
		// The model keeps calling tools forever
		streamOnceMock.mockImplementation(async () =>
			functionCallResult([
				{
					type: "function_call",
					call_id: `call_${streamOnceMock.mock.calls.length}`,
					name: "slack_add_reaction",
					arguments: '{"emoji":"eyes"}',
				},
			])
		);

		const harness = makeHarness();
		await runRespond(harness);

		// Capped at MAX_AGENT_ITERATIONS (default 10), then a friendly message
		expect(streamOnceMock.mock.calls.length).toBeLessThanOrEqual(10);
		expect(harness.say).toHaveBeenCalledWith(
			expect.objectContaining({ text: expect.stringContaining("circles") })
		);
	});

	it("reports errors with a short friendly message", async () => {
		streamOnceMock.mockRejectedValueOnce(new Error("connect ECONNREFUSED 10.0.0.5:11434"));

		const harness = makeHarness();
		await runRespond(harness);

		expect(harness.say).toHaveBeenCalledWith({ text: "Friendly local AI error." });
	});

	it("rebuilds history from the Slack thread after a restart", async () => {
		streamOnceMock.mockResolvedValueOnce(textResult("Bertrand, as you said."));

		// Store is empty (restart); the Slack thread already contains the earlier exchange
		const threadMessages = [
			{ ts: "100.1", user: "U1", text: "My name is Bertrand." },
			{ ts: "100.15", bot_id: "B1", text: "Noted." },
		];

		const harness = makeHarness({ text: "What is my name?", ts: "100.3", threadMessages });
		await runRespond(harness);

		const [params] = streamOnceMock.mock.calls[0];
		const inputText = allText(params.input);
		expect(inputText).toContain("My name is Bertrand.");
		expect(inputText).toContain("Noted.");
	});

	it("keeps a deliberately long conversation under the context budget", async () => {
		streamOnceMock.mockResolvedValueOnce(textResult("Trimmed and answered."));

		// Preload a huge stored conversation for this thread
		const key = conversationKey({ teamId: "T1", channel: "C1", threadTs: "100.1" });
		const { setConversation } = await import("../services/conversation-store.js");
		const bigHistory = [];
		for (let i = 0; i < 150; i++) {
			bigHistory.push({
				role: "user",
				content: [{ type: "input_text", text: `question ${i} ${"x".repeat(3000)}` }],
			});
			bigHistory.push({
				role: "assistant",
				content: [{ type: "output_text", text: `answer ${i} ${"y".repeat(3000)}` }],
			});
		}
		setConversation(key, bigHistory);

		const harness = makeHarness({ text: "Final question", ts: "999.9" });
		await runRespond(harness);

		const [params] = streamOnceMock.mock.calls[0];
		const { estimateTokenCount } = await import("../utils/tokens.js");
		expect(estimateTokenCount(params.input)).toBeLessThanOrEqual(32768 - 4000);

		// The system prompt and the newest message survive trimming
		expect(params.input[0].role).toBe("system");
		expect(allText(params.input)).toContain("Final question");
	});
});
