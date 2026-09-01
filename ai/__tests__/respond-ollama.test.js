/**
 * Ollama-mode tests for the respond orchestrator: basic response, multi-turn
 * application-side conversation state, the function-calling agent loop, and
 * the loop iteration cap. The model stream is mocked; no Ollama server needed.
 */

import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const streamOnceMock = jest.fn();

jest.unstable_mockModule("../services/streaming.js", () => ({
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

jest.unstable_mockModule("../providers/index.js", () => ({
	getProvider: () => fakeOllamaProvider,
	describeProviderError: () => "Friendly local AI error.",
	resetProviderCache: () => {},
}));

const { respond } = await import("../respond.js");
const { MAX_AGENT_ITERATIONS } = await import("../config/providers.js");
const conversationStore = await import("../services/conversation-store.js");
const { clearConversationStore, conversationKey, getConversation } = conversationStore;
const { getTokenCalibration, resetTokenCalibration } = await import("../utils/tokens.js");
const { clearThreadInbox } = await import("../services/thread-inbox.js");

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
	clearThreadInbox();
	resetTokenCalibration();
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

	it("processes a bare attachment sent without any message text", async () => {
		streamOnceMock.mockResolvedValueOnce(textResult("Nice screenshot. Now what?"));

		const harness = makeHarness({ text: "" });
		harness.message.files = [{ id: "F1", name: "error.png", mimetype: "image/png" }];
		await runRespond(harness);

		expect(streamOnceMock).toHaveBeenCalledTimes(1);
		const [params] = streamOnceMock.mock.calls[0];

		// The user message reached the model, carrying the attachment (as a
		// note on this capability-less fake provider), with no empty text item
		const userItems = params.input.filter((item) => item?.role === "user");
		expect(userItems.length).toBeGreaterThan(0);
		const lastUser = userItems[userItems.length - 1];
		expect(lastUser.content.length).toBeGreaterThan(0);
		expect(lastUser.content.every((c) => c.text !== "")).toBe(true);
		expect(allText(params.input)).toContain("error.png");
	});

	it("still ignores a message with neither text nor files", async () => {
		const harness = makeHarness({ text: "" });
		await runRespond(harness);

		expect(streamOnceMock).not.toHaveBeenCalled();
		expect(harness.say).not.toHaveBeenCalled();
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

	it("records prompt-token calibration from the server's reported usage", async () => {
		streamOnceMock.mockResolvedValueOnce({
			...textResult("Fine."),
			usage: { inputTokens: 5000, outputTokens: 40, totalTokens: 5040 },
		});

		await runRespond(makeHarness({ text: "Is the server up?" }));

		const calibration = getTokenCalibration();
		expect(calibration.samples).toBe(1);
		expect(calibration.ema).toBeGreaterThan(0);
	});

	it("does not record calibration when the server reports no usage", async () => {
		streamOnceMock.mockResolvedValueOnce(textResult("Fine."));

		await runRespond(makeHarness({ text: "Is the server up?" }));

		expect(getTokenCalibration().samples).toBe(0);
	});

	it("persists the user-context note and never duplicates it (prefix-cache stability)", async () => {
		const countContextNotes = (items) =>
			items.filter(
				(item) =>
					item?.role === "system" &&
					item?.content?.[0]?.type === "input_text" &&
					item.content[0].text.includes("User's Slack ID:")
			).length;

		streamOnceMock.mockResolvedValueOnce(textResult("Fine."));
		await runRespond(makeHarness({ text: "First message.", ts: "100.2" }));

		// The note is persisted with the conversation, right before the message
		const key = conversationKey({ teamId: "T1", channel: "C1", threadTs: "100.1" });
		const storedAfterTurn1 = getConversation(key);
		expect(countContextNotes(storedAfterTurn1)).toBe(1);
		expect(storedAfterTurn1[0].content[0].text).toContain("User's Slack ID:");
		expect(allText([storedAfterTurn1[1]])).toContain("First message.");

		streamOnceMock.mockResolvedValueOnce(textResult("Still fine."));
		await runRespond(makeHarness({ text: "Second message.", ts: "100.3" }));

		// Same user, same context: the note appears exactly once in the request,
		// at its original (replayed) position — the token prefix is unchanged
		const [params] = streamOnceMock.mock.calls[1];
		expect(countContextNotes(params.input)).toBe(1);
		const noteIndex = params.input.findIndex(
			(item) => item?.role === "system" && item?.content?.[0]?.text?.includes("User's Slack ID:")
		);
		const firstMessageIndex = params.input.findIndex((item) =>
			allText([item]).includes("First message.")
		);
		expect(noteIndex).toBeLessThan(firstMessageIndex);

		// And the store still carries exactly one
		expect(countContextNotes(getConversation(key))).toBe(1);
	});

	it("appends a fresh user-context note when a different user joins the thread", async () => {
		streamOnceMock.mockResolvedValueOnce(textResult("Hello U1."));
		await runRespond(makeHarness({ text: "Hi from U1.", ts: "100.2" }));

		streamOnceMock.mockResolvedValueOnce(textResult("Hello U2."));
		const other = makeHarness({ text: "Hi from U2.", ts: "100.3" });
		other.context = { ...other.context, userId: "U2" };
		other.message.user = "U2";
		await runRespond(other);

		const [params] = streamOnceMock.mock.calls[1];
		const notes = params.input.filter(
			(item) => item?.role === "system" && item?.content?.[0]?.text?.includes("User's Slack ID:")
		);
		expect(notes).toHaveLength(2);
		expect(notes[0].content[0].text).toContain("<@U1>");
		expect(notes[1].content[0].text).toContain("<@U2>");
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

	it("delivers streamed text via say() when the client has no chatStream", async () => {
		// Regression: the say() fallback in executeStreamWithRetry used to read the
		// still-uninitialized streamOnce result (TDZ crash) for the response ID
		streamOnceMock.mockImplementationOnce(async (_params, callbacks) => {
			const streamController = await callbacks.onStreamStart("resp_fallback");
			expect(streamController).toBeNull();
			await callbacks.onTextChunk("Hello from the fallback.", streamController);
			return textResult("Hello from the fallback.", "resp_fallback");
		});

		const harness = makeHarness({ text: "Anyone home?" });
		delete harness.client.chatStream;
		await runRespond(harness);

		expect(harness.say).toHaveBeenCalledWith(
			expect.objectContaining({
				text: "Hello from the fallback.",
				metadata: expect.objectContaining({
					event_payload: expect.objectContaining({ response_id: "resp_fallback" }),
				}),
			})
		);
		// No error fallback message was posted
		const saidTexts = harness.say.mock.calls.map(([arg]) => arg?.text || "");
		expect(saidTexts.join("\n")).not.toContain("Friendly local AI error.");
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

	it("continues after a streamed preamble + data call, without repeating the preamble", async () => {
		// Rule 13 without slack_add_reply: the model streams a short interim
		// note in the SAME turn as its data tool call, then answers next turn
		streamOnceMock
			.mockResolvedValueOnce({
				...textResult("On it. Grabbing the CPU numbers."),
				functionCalls: [
					{
						type: "function_call",
						call_id: "call_1",
						name: "search_knowledge_base",
						arguments: '{"query":"cpu"}',
					},
				],
			})
			.mockResolvedValueOnce(textResult("Average CPU: 42%. You're welcome."));

		const harness = makeHarness({ text: "Show me the average cpu utilization" });
		await runRespond(harness);

		// The loop continued past the preamble turn, telling the model its
		// message is already posted
		expect(streamOnceMock).toHaveBeenCalledTimes(2);
		const [secondParams] = streamOnceMock.mock.calls[1];
		expect(allText(secondParams.input)).toContain("Do NOT repeat it");

		// Both the preamble and the final answer are persisted; the nudge is not
		const key = conversationKey({ teamId: "T1", channel: "C1", threadTs: "100.1" });
		const storedText = allText(getConversation(key));
		expect(storedText).toContain("On it. Grabbing the CPU numbers.");
		expect(storedText).toContain("Average CPU: 42%. You're welcome.");
		expect(storedText).not.toContain("Do NOT repeat it");

		// No fallback message was posted
		const saidTexts = harness.say.mock.calls.map(([arg]) => arg?.text || "");
		expect(saidTexts.join("\n")).not.toContain("I've got nothing");
	});

	it("accepts a reaction-only response without posting the got-nothing fallback", async () => {
		// Rule 11: a greeting may be answered with just an emoji reaction. The
		// follow-up turn produces no output; that must not look like a failure.
		streamOnceMock
			.mockResolvedValueOnce(
				functionCallResult([
					{
						type: "function_call",
						call_id: "call_1",
						name: "slack_add_reaction",
						arguments: '{"emoji":"wave"}',
					},
				])
			)
			.mockResolvedValueOnce(functionCallResult([], "resp_silent"));

		const harness = makeHarness({ text: "Hey!" });
		await runRespond(harness);

		expect(harness.client.reactions.add).toHaveBeenCalledWith(
			expect.objectContaining({ name: "wave" })
		);
		const saidTexts = harness.say.mock.calls.map(([arg]) => arg?.text || "");
		expect(saidTexts.join("\n")).not.toContain("I've got nothing");
	});

	it("still posts the got-nothing fallback when a turn delivers neither text nor reaction", async () => {
		streamOnceMock.mockResolvedValueOnce(functionCallResult([], "resp_empty"));

		const harness = makeHarness({ text: "Diagnose the flux capacitor." });
		await runRespond(harness);

		const saidTexts = harness.say.mock.calls.map(([arg]) => arg?.text || "");
		expect(saidTexts.join("\n")).toContain("I've got nothing");
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
		// @ts-expect-error - mimic Slack WebAPIPlatformError shape
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
		// The model keeps calling tools forever — even on the forced
		// text-only wrap-up turn (a provider that ignores tool_choice)
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

		// Capped at MAX_AGENT_ITERATIONS, then a friendly message
		expect(streamOnceMock.mock.calls.length).toBeLessThanOrEqual(MAX_AGENT_ITERATIONS);
		// The final permitted iteration attempted a text-only wrap-up
		const finalParams = streamOnceMock.mock.calls[MAX_AGENT_ITERATIONS - 1][0];
		expect(finalParams.tool_choice).toBe("none");
		expect(allText(finalParams.input)).toContain("Tool-call limit reached");
		expect(harness.say).toHaveBeenCalledWith(
			expect.objectContaining({ text: expect.stringContaining("circles") })
		);
	});

	it("forces a final text-only answer at the iteration cap instead of dropping the data", async () => {
		// The model keeps fetching data until the harness forces the wrap-up turn
		streamOnceMock.mockImplementation(async (params) => {
			if (params.tool_choice === "none") {
				return textResult("Summary from the data gathered so far.");
			}
			return functionCallResult([
				{
					type: "function_call",
					call_id: `call_${streamOnceMock.mock.calls.length}`,
					name: "search_knowledge_base",
					arguments: '{"query":"ecs"}',
				},
			]);
		});

		const harness = makeHarness();
		await runRespond(harness);

		// (cap - 1) tool turns + 1 forced text-only wrap-up = the cap, not the cap + apology
		expect(streamOnceMock.mock.calls.length).toBe(MAX_AGENT_ITERATIONS);
		const finalParams = streamOnceMock.mock.calls[MAX_AGENT_ITERATIONS - 1][0];
		expect(finalParams.tool_choice).toBe("none");
		expect(allText(finalParams.input)).toContain("Tool-call limit reached");
		// The wrap-up answer stands; no "running in circles" apology
		expect(harness.say).not.toHaveBeenCalledWith(
			expect.objectContaining({ text: expect.stringContaining("circles") })
		);
		// The answer is persisted as the turn's assistant message
		const key = conversationKey({ teamId: "T1", channel: "C1", threadTs: "100.1" });
		expect(allText(getConversation(key))).toContain("Summary from the data gathered so far.");
		// The wrap-up nudge is transient: never persisted
		expect(allText(getConversation(key))).not.toContain("Tool-call limit reached");
	});

	it("still answers when setting the assistant title/status fails", async () => {
		streamOnceMock.mockResolvedValueOnce(textResult("Answered anyway."));

		const harness = makeHarness({ text: "Is the server up?" });
		const slackError = new Error("An API error occurred: fatal_error");
		// @ts-expect-error - mimic Slack WebAPIPlatformError shape
		slackError.code = "slack_webapi_platform_error";
		// @ts-expect-error
		slackError.data = { ok: false, error: "fatal_error" };
		harness.setTitle.mockRejectedValueOnce(slackError);

		await runRespond(harness);

		// The cosmetic failure was logged and the turn completed normally
		expect(harness.logger.warn).toHaveBeenCalledWith(
			"Failed to set assistant title/status; continuing",
			expect.objectContaining({ message: expect.stringContaining("fatal_error") })
		);
		expect(streamOnceMock).toHaveBeenCalledTimes(1);
	});

	it("retries conversations.replies once on a transient Slack platform error", async () => {
		streamOnceMock.mockResolvedValueOnce(textResult("Answered after retry."));

		const harness = makeHarness({ text: "Is the server up?" });
		const slackError = new Error("An API error occurred: fatal_error");
		// @ts-expect-error - mimic Slack WebAPIPlatformError shape
		slackError.code = "slack_webapi_platform_error";
		// @ts-expect-error
		slackError.data = { ok: false, error: "fatal_error" };
		harness.client.conversations.replies.mockRejectedValueOnce(slackError);

		await runRespond(harness);

		expect(harness.client.conversations.replies).toHaveBeenCalledTimes(2);
		expect(streamOnceMock).toHaveBeenCalledTimes(1);
		// No error message reached the user
		const saidTexts = harness.say.mock.calls.map(([arg]) => arg?.text || "");
		expect(saidTexts.join("\n")).not.toContain("Slack hiccuped");
		expect(saidTexts.join("\n")).not.toContain("Friendly local AI error.");
	});

	it("reports a persistent Slack API failure as a Slack problem, not an AI problem", async () => {
		const harness = makeHarness({ text: "Is the server up?" });
		const slackError = new Error("An API error occurred: fatal_error");
		// @ts-expect-error - mimic Slack WebAPIPlatformError shape
		slackError.code = "slack_webapi_platform_error";
		// @ts-expect-error
		slackError.data = { ok: false, error: "fatal_error" };
		harness.client.conversations.replies.mockRejectedValue(slackError);

		await runRespond(harness);

		// The AI provider was never called
		expect(streamOnceMock).not.toHaveBeenCalled();
		// Logged as a Slack error with the platform error code
		expect(harness.logger.error).toHaveBeenCalledWith(
			"Slack API error during response handling",
			expect.objectContaining({
				code: "slack_webapi_platform_error",
				slackError: "fatal_error",
			})
		);
		// The user message blames Slack, not the local AI backend
		expect(harness.say).toHaveBeenCalledWith(
			expect.objectContaining({ text: expect.stringContaining("Slack hiccuped") })
		);
		const saidTexts = harness.say.mock.calls.map(([arg]) => arg?.text || "");
		expect(saidTexts.join("\n")).not.toContain("Friendly local AI error.");
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

	it("injects a message that arrives while a tool turn is running", async () => {
		const harness = makeHarness({ text: "Check the CPU.", ts: "100.2" });
		const late = makeHarness({ text: "Also check the disk!", ts: "100.4" });

		streamOnceMock
			.mockImplementationOnce(async () => {
				// A second message from the same user lands mid-turn: it must be
				// queued (no concurrent run) and injected before the next model call
				await runRespond(late);
				return functionCallResult([
					{
						type: "function_call",
						call_id: "call_1",
						name: "search_knowledge_base",
						arguments: '{"query":"cpu"}',
					},
				]);
			})
			.mockResolvedValueOnce(textResult("CPU fine. Disk fine too."));

		await runRespond(harness);

		// The late message did NOT start its own run
		expect(streamOnceMock).toHaveBeenCalledTimes(2);

		// It was acknowledged with a reaction while queued
		expect(late.client.reactions.add).toHaveBeenCalledWith({
			channel: "C1",
			timestamp: "100.4",
			name: "eyes",
		});

		// The second model call sees the tool output AND the injected message,
		// preceded by the injection note
		const [secondParams] = streamOnceMock.mock.calls[1];
		const secondText = allText(secondParams.input);
		expect(secondText).toContain("Also check the disk!");
		expect(secondText).toContain("additional message(s)");
		expect(secondParams.input.some((i) => i?.type === "function_call_output")).toBe(true);

		// Both user messages and the single final answer are persisted, in order
		const key = conversationKey({ teamId: "T1", channel: "C1", threadTs: "100.1" });
		const storedText = allText(getConversation(key));
		expect(storedText).toContain("Check the CPU.");
		expect(storedText).toContain("Also check the disk!");
		expect(storedText).toContain("CPU fine. Disk fine too.");
		expect(storedText.indexOf("Check the CPU.")).toBeLessThan(
			storedText.indexOf("Also check the disk!")
		);

		// Same user, same context: the user-context note still appears only once
		const stored = getConversation(key);
		const notes = stored.filter(
			(i) => i?.role === "system" && i?.content?.[0]?.text?.includes("User's Slack ID:")
		);
		expect(notes).toHaveLength(1);
	});

	it("keeps the run alive for a message that arrives during the final answer", async () => {
		const harness = makeHarness({ text: "Is the server up?", ts: "100.2" });
		const late = makeHarness({ text: "And the database?", ts: "100.5" });

		streamOnceMock
			.mockImplementationOnce(async () => {
				// The follow-up lands while the final answer is streaming: no tool
				// calls remain, but the loop must pick the message up anyway
				await runRespond(late);
				return textResult("Server is up.");
			})
			.mockResolvedValueOnce(textResult("Database too."));

		await runRespond(harness);

		expect(streamOnceMock).toHaveBeenCalledTimes(2);

		// The second call carries the already-delivered answer and the follow-up
		const [secondParams] = streamOnceMock.mock.calls[1];
		const secondText = allText(secondParams.input);
		expect(secondText).toContain("Server is up.");
		expect(secondText).toContain("And the database?");

		const key = conversationKey({ teamId: "T1", channel: "C1", threadTs: "100.1" });
		const storedText = allText(getConversation(key));
		expect(storedText).toContain("And the database?");
		expect(storedText).toContain("Database too.");
	});

	it("re-dispatches a mid-run message from a different user as its own run", async () => {
		const harness = makeHarness({ text: "Hi from U1.", ts: "100.2" });
		const other = makeHarness({ text: "Hi from U2.", ts: "100.4" });
		other.context = { ...other.context, userId: "U2" };
		other.message.user = "U2";

		streamOnceMock
			.mockImplementationOnce(async () => {
				// Another user chimes in mid-run: per-user gating differs, so their
				// message must NOT be injected into U1's run
				await runRespond(other);
				return textResult("Answer for U1.");
			})
			.mockResolvedValueOnce(textResult("Answer for U2."));

		await runRespond(harness);

		expect(streamOnceMock).toHaveBeenCalledTimes(2);

		// U1's turn never saw U2's message
		const [firstParams] = streamOnceMock.mock.calls[0];
		expect(allText(firstParams.input)).not.toContain("Hi from U2.");

		// U2's message ran afterwards as its own run, with its own context note
		const [secondParams] = streamOnceMock.mock.calls[1];
		const secondText = allText(secondParams.input);
		expect(secondText).toContain("Hi from U2.");
		expect(secondText).toContain("<@U2>");
		expect(secondText).not.toContain("additional message(s)");

		// Both exchanges are persisted in the shared thread conversation
		const key = conversationKey({ teamId: "T1", channel: "C1", threadTs: "100.1" });
		const storedText = allText(getConversation(key));
		expect(storedText).toContain("Answer for U1.");
		expect(storedText).toContain("Answer for U2.");
	});

	it("resets the iteration budget when a message is injected mid-run", async () => {
		// The first message burns most of the tool budget; the injected message
		// must get a fresh budget instead of hitting the forced wrap-up early
		const harness = makeHarness({ text: "Deep dive please.", ts: "100.2" });
		const late = makeHarness({ text: "One more thing!", ts: "100.6" });

		let calls = 0;
		streamOnceMock.mockImplementation(async () => {
			calls += 1;
			if (calls === MAX_AGENT_ITERATIONS - 1) {
				// Just before the cap, the user sends a follow-up
				await runRespond(late);
			}
			if (calls <= MAX_AGENT_ITERATIONS) {
				return functionCallResult([
					{
						type: "function_call",
						call_id: `call_${calls}`,
						name: "search_knowledge_base",
						arguments: '{"query":"ecs"}',
					},
				]);
			}
			return textResult("Everything, including the one more thing.");
		});

		await runRespond(harness);

		// The run went past the original cap (fresh budget) and finished normally
		expect(streamOnceMock.mock.calls.length).toBe(MAX_AGENT_ITERATIONS + 1);
		expect(harness.say).not.toHaveBeenCalledWith(
			expect.objectContaining({ text: expect.stringContaining("circles") })
		);
		const key = conversationKey({ teamId: "T1", channel: "C1", threadTs: "100.1" });
		expect(allText(getConversation(key))).toContain("One more thing!");
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
