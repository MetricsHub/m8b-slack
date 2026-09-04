/**
 * Hosted (OpenAI) mode tests for the respond orchestrator: conversation
 * continuity through previous_response_id, and its invalidation when the
 * system prompt changed since the thread's chain was started (deployment
 * notes, organization name, code upgrade). The model stream and the OpenAI
 * client are mocked.
 */

import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const streamOnceMock = jest.fn();

jest.unstable_mockModule("../services/streaming.js", () => ({
	streamOnce: streamOnceMock,
	buildResponseRequest: jest.fn(),
}));

jest.unstable_mockModule("../services/openai.js", () => ({
	openai: {},
	getVectorStoreIds: () => [],
	createSafetyIdentifier: () => "safety-id",
	pollUntilTerminal: jest.fn(async () => ({ status: "completed", output: [] })),
	continueIfIncomplete: jest.fn(async () => null),
	getTextFromResponse: () => "",
	recoverFromTerminated: jest.fn(async () => null),
}));

jest.unstable_mockModule("../services/citations.js", () => ({
	processCitations: jest.fn(async () => {}),
}));

const fakeOpenAiProvider = {
	name: "openai",
	model: "gpt-test",
	endpoint: "https://api.openai.com/v1",
	client: {},
	capabilities: {
		serverSideState: true,
		hostedFileSearch: true,
		codeInterpreter: true,
		localCodeInterpreter: false,
		hostedWebSearch: true,
		providerFileUploads: true,
		imageDescriptions: false,
		imageInput: false,
		toolNamespaces: true,
	},
	buildRequest: (params) => params,
	healthCheck: async () => ({ ok: true }),
};

jest.unstable_mockModule("../providers/index.js", () => ({
	getProvider: () => fakeOpenAiProvider,
	describeProviderError: () => "Friendly AI error.",
	resetProviderCache: () => {},
}));

const { respond } = await import("../respond.js");
const { buildSystemPrompt, systemPromptVersion } = await import("../config/system-prompt.js");
const { loadDeploymentNotes, resetDeploymentContext } = await import("../config/deployment.js");
const { clearThreadInbox } = await import("../services/thread-inbox.js");

function textResult(text, responseId = "resp_new") {
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

/** A thread: one user question, one bot answer (with metadata), the new question */
function threadWith(botMetadata, threadTs) {
	return [
		{ ts: threadTs, user: "U1", text: "Is SRV-WEB-01 okay?" },
		{ ts: `${threadTs}5`, bot_id: "B1", text: "It is fine. Obviously.", metadata: botMetadata },
		{ ts: `${threadTs}9`, user: "U1", text: "And its disks?" },
	];
}

function makeHarness({ threadTs, threadMessages }) {
	const client = {
		conversations: { replies: jest.fn(async () => ({ messages: threadMessages })) },
		users: {
			info: jest.fn(async () => ({
				ok: true,
				user: { real_name: "Bertrand", tz: "Europe/Paris" },
			})),
		},
		team: { info: jest.fn(async () => ({ ok: true, team: { id: "T1", name: "Acme Corp" } })) },
		reactions: { add: jest.fn(async () => ({ ok: true })) },
		chatStream: jest.fn(() => ({
			append: jest.fn(async () => {}),
			stop: jest.fn(async () => {}),
		})),
	};
	return {
		client,
		logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
		say: jest.fn(async () => {}),
		setTitle: jest.fn(async () => {}),
		setStatus: jest.fn(async () => {}),
		context: { BOT_ID: "B1", BOT_USER_ID: "UBOT", userId: "U1", teamId: "T1" },
		message: {
			text: "And its disks?",
			channel: "C1",
			thread_ts: threadTs,
			ts: `${threadTs}9`,
			user: "U1",
		},
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

function allText(input) {
	return (input || [])
		.flatMap((item) => item?.content || [])
		.map((c) => c?.text || "")
		.join("\n");
}

/** The prompt this deployment currently runs under (Acme Corp, current notes) */
function currentPromptVersion() {
	return systemPromptVersion(
		buildSystemPrompt(fakeOpenAiProvider.capabilities, {
			organizationName: "Acme Corp",
			deploymentNotes: process.env.M8B_PROMPT_EXTRA || "",
		})
	);
}

// Distinct thread per test: respond keeps an in-process threadTs -> response_id cache
let threadCounter = 0;

beforeEach(() => {
	streamOnceMock.mockReset();
	clearThreadInbox();
	resetDeploymentContext();
	delete process.env.M8B_PROMPT_EXTRA;
	delete process.env.M8B_PROMPT_EXTRA_FILE;
	process.env.KNOWLEDGE_BASE_DIR = "data/does-not-exist-for-tests";
	threadCounter += 1;
});

describe("respond in OpenAI mode: system prompt versioning", () => {
	it("continues the chain when the thread was started under the current prompt", async () => {
		streamOnceMock.mockResolvedValueOnce(textResult("Disks are fine."));
		const threadTs = `200.${threadCounter}`;
		const harness = makeHarness({
			threadTs,
			threadMessages: threadWith(
				{
					event_type: "openai_context",
					event_payload: { response_id: "resp_old", prompt_version: currentPromptVersion() },
				},
				threadTs
			),
		});

		await runRespond(harness);

		const [params] = streamOnceMock.mock.calls[0];
		expect(params.previous_response_id).toBe("resp_old");
		const text = allText(params.input);
		expect(text).not.toContain("You are M8B");
		expect(text).not.toContain("Is SRV-WEB-01 okay?");
		expect(text).toContain("And its disks?");
	});

	it("restarts the chain with the full history when the thread predates prompt versioning", async () => {
		streamOnceMock.mockResolvedValueOnce(textResult("Disks are fine."));
		const threadTs = `200.${threadCounter}`;
		const harness = makeHarness({
			threadTs,
			threadMessages: threadWith(
				{ event_type: "openai_context", event_payload: { response_id: "resp_old" } },
				threadTs
			),
		});

		await runRespond(harness);

		const [params] = streamOnceMock.mock.calls[0];
		expect(params.previous_response_id).toBeFalsy();
		const text = allText(params.input);
		// Current prompt, with the organization name resolved from Slack
		expect(text).toContain("You are M8B");
		expect(text).toContain("Acme Corp's IT team");
		// Whole thread replayed, not just what followed the last bot message
		expect(text).toContain("Is SRV-WEB-01 okay?");
		expect(text).toContain("It is fine. Obviously.");
		expect(text).toContain("And its disks?");
		expect(harness.logger.info).toHaveBeenCalledWith(
			expect.stringContaining("restarting the chain with the full thread history")
		);
	});

	it("restarts the chain when the deployment notes changed since the last answer", async () => {
		const staleVersion = currentPromptVersion(); // no notes yet
		process.env.M8B_PROMPT_EXTRA = "Storage alerts go to #storage-ops.";
		loadDeploymentNotes();
		expect(currentPromptVersion()).not.toBe(staleVersion);

		streamOnceMock.mockResolvedValueOnce(textResult("Disks are fine."));
		const threadTs = `200.${threadCounter}`;
		const harness = makeHarness({
			threadTs,
			threadMessages: threadWith(
				{
					event_type: "openai_context",
					event_payload: { response_id: "resp_old", prompt_version: staleVersion },
				},
				threadTs
			),
		});

		await runRespond(harness);

		const [params] = streamOnceMock.mock.calls[0];
		expect(params.previous_response_id).toBeFalsy();
		const text = allText(params.input);
		expect(text).toContain("Storage alerts go to #storage-ops.");
		expect(text).toContain("Is SRV-WEB-01 okay?");
	});

	it("fetches every thread page before replaying a restarted chain", async () => {
		streamOnceMock.mockResolvedValueOnce(textResult("Disks are fine."));
		const threadTs = `200.${threadCounter}`;
		const firstPage = [
			{ ts: threadTs, user: "U1", text: "Is SRV-WEB-01 okay?" },
			{
				ts: `${threadTs}2`,
				bot_id: "B1",
				text: "It is fine. Obviously.",
				metadata: { event_type: "openai_context", event_payload: { response_id: "resp_old" } },
			},
		];
		const secondPage = [
			{ ts: `${threadTs}5`, user: "U1", text: "What about SRV-DB-02?" },
			{
				ts: `${threadTs}7`,
				bot_id: "B1",
				text: "Also fine. Stop asking.",
				metadata: { event_type: "openai_context", event_payload: { response_id: "resp_old2" } },
			},
			{ ts: `${threadTs}9`, user: "U1", text: "And its disks?" },
		];
		const harness = makeHarness({ threadTs, threadMessages: firstPage });
		harness.client.conversations.replies = jest
			.fn()
			.mockResolvedValueOnce({
				messages: firstPage,
				has_more: true,
				response_metadata: { next_cursor: "cursor-2" },
			})
			.mockResolvedValueOnce({ messages: secondPage, has_more: false });

		await runRespond(harness);

		expect(harness.client.conversations.replies).toHaveBeenCalledTimes(2);
		expect(harness.client.conversations.replies).toHaveBeenLastCalledWith(
			expect.objectContaining({ channel: "C1", ts: threadTs, cursor: "cursor-2", limit: 200 })
		);
		const [params] = streamOnceMock.mock.calls[0];
		expect(params.previous_response_id).toBeFalsy();
		const text = allText(params.input);
		expect(text).toContain("Is SRV-WEB-01 okay?");
		expect(text).toContain("It is fine. Obviously.");
		expect(text).toContain("What about SRV-DB-02?");
		expect(text).toContain("Also fine. Stop asking.");
		expect(text).toContain("And its disks?");
	});

	it("does not page through the thread when the chain simply continues", async () => {
		streamOnceMock.mockResolvedValueOnce(textResult("Disks are fine."));
		const threadTs = `200.${threadCounter}`;
		const harness = makeHarness({ threadTs, threadMessages: [] });
		harness.client.conversations.replies = jest.fn().mockResolvedValue({
			messages: threadWith(
				{
					event_type: "openai_context",
					event_payload: { response_id: "resp_old", prompt_version: currentPromptVersion() },
				},
				threadTs
			),
			has_more: true,
			response_metadata: { next_cursor: "cursor-2" },
		});

		await runRespond(harness);

		expect(harness.client.conversations.replies).toHaveBeenCalledTimes(1);
		expect(streamOnceMock.mock.calls[0][0].previous_response_id).toBe("resp_old");
	});

	it("stamps the current prompt version into the reply's Slack metadata", async () => {
		streamOnceMock.mockImplementationOnce(async (_params, { onStreamStart }) => {
			await onStreamStart("resp_new");
			return textResult("Disks are fine.");
		});
		const threadTs = `200.${threadCounter}`;
		const harness = makeHarness({ threadTs, threadMessages: threadWith(undefined, threadTs) });

		await runRespond(harness);

		expect(harness.client.chatStream).toHaveBeenCalledWith(
			expect.objectContaining({
				metadata: expect.objectContaining({
					event_type: "openai_context",
					event_payload: expect.objectContaining({
						response_id: "resp_new",
						prompt_version: currentPromptVersion(),
					}),
				}),
			})
		);
	});
});
