/**
 * Tests for provider-aware function call processing.
 */

import { afterAll, describe, expect, it, jest } from "@jest/globals";
import { shutdownCodeSandbox } from "../code-sandbox.js";
import { processFunctionCall } from "../function-calls.js";

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
		client: { reactions: { add: jest.fn(async () => ({ ok: true })) } },
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

afterAll(async () => {
	await shutdownCodeSandbox();
});

function parseOutput(items) {
	expect(items).toHaveLength(1);
	expect(items[0].type).toBe("function_call_output");
	return JSON.parse(items[0].output);
}

describe("processFunctionCall (provider-aware)", () => {
	it("returns a structured error for unknown function names", async () => {
		const items = await processFunctionCall(
			{ name: "definitely_not_a_tool", call_id: "call_1", arguments: "{}" },
			makeContext()
		);

		const output = parseOutput(items);
		expect(output.ok).toBe(false);
		expect(output.error).toContain("Unknown function");
	});

	it("returns a structured error for malformed JSON arguments", async () => {
		const items = await processFunctionCall(
			{ name: "slack_add_reaction", call_id: "call_1", arguments: "{not json" },
			makeContext()
		);

		const output = parseOutput(items);
		expect(output.ok).toBe(false);
	});

	it("routes web_search to the application-side implementation", async () => {
		// No backend configured: the tool must answer with a clean error, and
		// never call out to OpenAI
		const items = await processFunctionCall(
			{ name: "web_search", call_id: "call_1", arguments: '{"query":"metricshub"}' },
			makeContext()
		);

		const output = parseOutput(items);
		expect(output.ok).toBe(false);
		expect(output.error).toContain("not available");
	});

	it("routes fetch_url to the application-side page reader", async () => {
		// A loopback target is refused before any network access: deterministic
		// proof that the call reached the reader and its address policy
		const items = await processFunctionCall(
			{ name: "fetch_url", call_id: "call_1", arguments: '{"url":"http://127.0.0.1:8080/"}' },
			makeContext()
		);

		const output = parseOutput(items);
		expect(output.ok).toBe(false);
		expect(output.error).toContain("Refused");
	});

	it("routes search_knowledge_base to the local knowledge base", async () => {
		const knowledgeBase = {
			search: jest.fn(async () => ({
				ok: true,
				results: [{ title: "Doc", source: "docs/doc.md", excerpt: "chunk", score: 0.9 }],
			})),
		};

		const items = await processFunctionCall(
			{
				name: "search_knowledge_base",
				call_id: "call_1",
				arguments: '{"query":"docker","topK":3}',
			},
			makeContext({ knowledgeBase })
		);

		expect(knowledgeBase.search).toHaveBeenCalledWith("docker", 3);
		const output = parseOutput(items);
		expect(output.ok).toBe(true);
		expect(output.results[0].title).toBe("Doc");
	});

	it("routes update_knowledge to the local knowledge base in Ollama mode", async () => {
		const knowledgeBase = {
			addDocument: jest.fn(async () => ({ ok: true, docId: "doc-1", file: "doc-1.md" })),
		};
		const context = makeContext({ knowledgeBase });

		const items = await processFunctionCall(
			{
				name: "update_knowledge",
				call_id: "call_1",
				arguments: '{"title":"Fix X","content":"Do Y."}',
			},
			context
		);

		expect(knowledgeBase.addDocument).toHaveBeenCalledWith({
			title: "Fix X",
			content: "Do Y.",
			replaceDocId: undefined,
		});
		expect(context.say).toHaveBeenCalled();
		const output = parseOutput(items);
		expect(output.ok).toBe(true);
	});

	it("truncates tool outputs above the provider's inline cap", async () => {
		const knowledgeBase = {
			search: jest.fn(async () => ({
				ok: true,
				results: [{ title: "Huge", excerpt: "z".repeat(100000) }],
			})),
		};

		const items = await processFunctionCall(
			{ name: "search_knowledge_base", call_id: "call_1", arguments: '{"query":"big"}' },
			makeContext({
				knowledgeBase,
				provider: { ...ollamaProvider, maxToolOutputChars: 30000 },
			})
		);

		expect(items[0].output.length).toBeLessThanOrEqual(31000);
		const output = parseOutput(items);
		expect(output.truncated).toBe(true);
		expect(output.originalChars).toBeGreaterThan(100000);
		expect(output.hint).toContain("TRUNCATED");
	});

	it("keeps the staged-file reference reachable when the inline cap truncates", async () => {
		// The middleware appends _file AFTER the bulky payload: a naive slice of
		// the serialized object would drop the only pointer to the full data
		const knowledgeBase = {
			search: jest.fn(async () => ({
				ok: true,
				content: "z".repeat(100000),
				_file: {
					fileName: "fetch_url_123.json",
					hint: "Full JSON available in the Python sandbox at /data/fetch_url_123.json.",
				},
			})),
		};

		const items = await processFunctionCall(
			{ name: "search_knowledge_base", call_id: "call_1", arguments: '{"query":"big"}' },
			makeContext({
				knowledgeBase,
				provider: { ...ollamaProvider, maxToolOutputChars: 30000 },
			})
		);

		expect(items[0].output.length).toBeLessThanOrEqual(31000);
		const output = parseOutput(items);
		expect(output.truncated).toBe(true);
		expect(output._file).toEqual({
			fileName: "fetch_url_123.json",
			hint: "Full JSON available in the Python sandbox at /data/fetch_url_123.json.",
		});
		expect(output.hint).toContain("/data/fetch_url_123.json");
	});

	it("does not truncate outputs when the provider has no inline cap", async () => {
		const knowledgeBase = {
			search: jest.fn(async () => ({
				ok: true,
				results: [{ title: "Huge", excerpt: "z".repeat(100000) }],
			})),
		};

		const items = await processFunctionCall(
			{ name: "search_knowledge_base", call_id: "call_1", arguments: '{"query":"big"}' },
			makeContext({ knowledgeBase, provider: undefined })
		);

		const output = parseOutput(items);
		expect(output.truncated).toBeUndefined();
		expect(output.results[0].excerpt.length).toBe(100000);
	});

	it("rejects run_python when the provider has no local code sandbox", async () => {
		const items = await processFunctionCall(
			{ name: "run_python", call_id: "call_1", arguments: '{"code":"1+1"}' },
			makeContext() // ollamaProvider without localCodeInterpreter
		);

		const output = parseOutput(items);
		expect(output.ok).toBe(false);
		expect(output.error).toContain("not available");
	});

	it("executes run_python and posts generated files to the Slack thread", async () => {
		const filesUploadV2 = jest.fn(async () => ({
			files: [{ files: [{ id: "F123" }] }],
		}));
		const context = makeContext({
			client: { filesUploadV2 },
			message: { channel: "C1", ts: "1.0", thread_ts: "1.0" },
			provider: {
				...ollamaProvider,
				capabilities: { ...ollamaProvider.capabilities, localCodeInterpreter: true },
			},
		});

		const items = await processFunctionCall(
			{
				name: "run_python",
				call_id: "call_1",
				arguments: JSON.stringify({
					code: "print('sum:', 1 + 2)\nopen('answer.txt', 'w').write('3')",
				}),
			},
			context
		);

		const output = parseOutput(items);
		expect(output.ok).toBe(true);
		expect(output.stdout).toContain("sum: 3");
		expect(output.filesDeliveredToSlack).toEqual(["answer.txt"]);
		expect(output.note).toContain("already posted");

		expect(filesUploadV2).toHaveBeenCalledTimes(1);
		const upload = filesUploadV2.mock.calls[0][0];
		expect(upload.channel_id).toBe("C1");
		expect(upload.thread_ts).toBe("1.0");
		expect(upload.file_uploads[0].filename).toBe("answer.txt");
		expect(upload.file_uploads[0].file.toString("utf8")).toBe("3");
	}, 120000);

	it("still executes shared Slack tools", async () => {
		const context = makeContext();
		const items = await processFunctionCall(
			{ name: "slack_add_reaction", call_id: "call_1", arguments: '{"emoji":"eyes"}' },
			context
		);

		expect(context.client.reactions.add).toHaveBeenCalledWith({
			channel: "C1",
			name: "eyes",
			timestamp: "1.0",
		});
		expect(parseOutput(items).ok).toBe(true);
	});

	it("maps common invalid emoji names to valid Slack shortcodes", async () => {
		const context = makeContext();
		await processFunctionCall(
			{ name: "slack_add_reaction", call_id: "call_1", arguments: '{"emoji":":facepalm:"}' },
			context
		);

		expect(context.client.reactions.add).toHaveBeenCalledWith(
			expect.objectContaining({ name: "person_facepalming" })
		);
	});

	it("returns a hint instead of a stack trace for invalid emoji shortcodes", async () => {
		const context = makeContext();
		const error = new Error("An API error occurred: invalid_name");
		// @ts-expect-error - mimic Slack WebAPIPlatformError shape
		error.data = { ok: false, error: "invalid_name" };
		context.client.reactions.add.mockRejectedValueOnce(error);

		const items = await processFunctionCall(
			{ name: "slack_add_reaction", call_id: "call_1", arguments: '{"emoji":"bogus_emoji"}' },
			context
		);

		const output = parseOutput(items);
		expect(output.ok).toBe(false);
		expect(output.error).toContain("bogus_emoji");
		expect(output.hint).toContain("shortcode");
		expect(output.error).not.toContain("WebAPIPlatformError");
	});
});
