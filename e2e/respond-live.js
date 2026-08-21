/**
 * Live AI behavior tests at the respond() seam.
 *
 * Drives ai/respond.js with a fake Slack client but the REAL AI provider and
 * REAL MCP servers. No Slack connection is needed. This answers "does the LLM,
 * with its tools, still behave as intended" without the Slack round-trip.
 *
 * Requires the dev environment (same variables the bot itself needs):
 *   cmd /c "call .env.dev.cmd && npm run test:live"
 *
 * Exit codes: 0 all scenarios passed, 1 failures, 2 environment not usable.
 */

import "dotenv/config";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { initializeMcpRegistry } from "../ai/mcp_registry.js";
import { getProvider } from "../ai/providers/index.js";
import { respond } from "../ai/respond.js";
import {
	createTestLogger,
	evaluateScenario,
	fakeSlackTs,
	printResults,
	selectScenarios,
	timeoutAfter,
} from "./harness.js";
import { SCENARIOS } from "./scenarios.js";

const FAKE_TEAM_ID = "T_E2E_LIVE";
const FAKE_CHANNEL = "C_E2E_LIVE";
const FAKE_USER_ID = "U_E2E_TESTER";
const FAKE_BOT_USER_ID = "U_E2E_BOT";
const FAKE_BOT_ID = "B_E2E_BOT";

/**
 * Build a minimal fake Slack WebClient covering every method respond() and the
 * Slack-side tools touch. Intentionally has no chatStream so streaming falls
 * back to say(), which we capture.
 *
 * @param {Object} message - The fake incoming Slack message
 * @param {Array} uploads - Collector for filesUploadV2 calls (generated files)
 */
function createFakeSlackClient(message, uploads) {
	return {
		conversations: {
			replies: async () => ({ messages: [message] }),
		},
		users: {
			info: async () => ({
				ok: true,
				user: { real_name: "E2E Tester", tz: "Europe/Paris" },
			}),
		},
		reactions: {
			add: async () => ({ ok: true }),
		},
		filesUploadV2: async (params) => {
			uploads.push(params);
			return { files: [{ files: [{ id: `F_E2E_UP_${uploads.length}` }] }] };
		},
		assistant: {
			threads: {
				setStatus: async () => ({ ok: true }),
				setTitle: async () => ({ ok: true }),
			},
		},
	};
}

/**
 * Serve scenario fixture files (e2e/fixtures/) over a throwaway local HTTP
 * server so respond()'s Slack-file download path has a real URL to fetch.
 * Returns fake Slack file objects plus a close() for the server.
 *
 * @param {Array<{fixture: string, name: string, mimetype: string}>} files
 * @returns {Promise<{slackFiles: Object[], close: Function}>}
 */
async function serveScenarioFiles(files) {
	const server = createServer(async (req, res) => {
		const fixture = files.find((f) => req.url === `/${f.fixture}`);
		if (!fixture) {
			res.writeHead(404).end();
			return;
		}
		const bytes = await readFile(
			fileURLToPath(new URL(`./fixtures/${fixture.fixture}`, import.meta.url))
		);
		res.writeHead(200, { "Content-Type": fixture.mimetype });
		res.end(bytes);
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address();

	const slackFiles = files.map((f, i) => ({
		id: `F_E2E_${i}`,
		name: f.name,
		mimetype: f.mimetype,
		url_private_download: `http://127.0.0.1:${port}/${f.fixture}`,
	}));

	return { slackFiles, close: () => server.close() };
}

/**
 * Run one scenario through respond() and collect the answer + tool calls.
 * Multi-turn scenarios (prompts array) share one thread; the returned answer
 * is the reply to the last prompt. Scenario `files` are attached to the first
 * prompt's message, served from e2e/fixtures/ over a local HTTP server.
 *
 * @param {Object} scenario
 * @returns {Promise<{answer: string, toolCalls: string[]}>}
 */
async function runScenario(scenario) {
	const prompts = scenario.prompts || [scenario.prompt];
	const threadTs = fakeSlackTs();
	const toolCalls = [];
	const uploads = [];
	let answer = "";

	const served = scenario.files?.length ? await serveScenarioFiles(scenario.files) : null;

	const logger = createTestLogger({
		onEntry: (_level, msg, meta) => {
			if (msg === "Executed function call" && meta?.name) {
				toolCalls.push(meta.name);
			}
		},
	});

	try {
		for (const [turn, prompt] of prompts.entries()) {
			if (prompts.length > 1) console.log(`  turn ${turn + 1}: ${prompt}`);
			const said = [];

			const message = {
				channel: FAKE_CHANNEL,
				thread_ts: threadTs,
				ts: turn === 0 ? threadTs : fakeSlackTs(),
				text: prompt,
				user: FAKE_USER_ID,
				...(turn === 0 && served ? { files: served.slackFiles } : {}),
			};

			const say = async (value) => {
				const text = typeof value === "string" ? value : value?.text || value?.markdown_text || "";
				if (text) said.push(text);
			};

			await Promise.race([
				respond({
					client: createFakeSlackClient(message, uploads),
					context: {
						BOT_USER_ID: FAKE_BOT_USER_ID,
						BOT_ID: FAKE_BOT_ID,
						teamId: FAKE_TEAM_ID,
						userId: FAKE_USER_ID,
					},
					logger,
					message,
					body: {},
					payload: {},
					say,
					setTitle: async () => {},
					setStatus: async () => {},
				}),
				timeoutAfter(scenario.timeoutMs || 180000),
			]);

			answer = said.join("");
		}
	} finally {
		served?.close();
	}

	return { answer, toolCalls, uploads };
}

async function main() {
	const logger = createTestLogger();
	const provider = getProvider();
	console.log(`Provider: ${provider.name} (${provider.model}) @ ${provider.endpoint}`);

	const health = await provider.healthCheck();
	if (!health.ok) {
		console.error(`AI backend health check FAILED: ${health.error}`);
		process.exit(2);
	}
	console.log(`AI backend healthy (${health.detail || "ok"})`);

	try {
		await initializeMcpRegistry(logger);
	} catch (e) {
		console.warn(`MCP registry initialization failed (tool scenarios may fail): ${e}`);
	}

	const results = [];
	for (const scenario of selectScenarios(SCENARIOS)) {
		if (scenario.onlyProvider && scenario.onlyProvider !== provider.name) {
			console.log(`Skipping ${scenario.name} (provider is ${provider.name})`);
			continue;
		}
		console.log(`\n--- ${scenario.name}: ${(scenario.prompts || [scenario.prompt])[0]}`);
		const started = Date.now();
		let answer = "";
		let toolCalls = [];
		let uploads = [];
		let failures = [];
		let verdict = null;
		try {
			({ answer, toolCalls, uploads } = await runScenario(scenario));
			({ failures, verdict } = await evaluateScenario({ scenario, answer, toolCalls }));

			// Deterministic state checks (local-KB providers only; hosted state
			// like OpenAI vector stores is not inspectable from here)
			if (scenario.verifyLive && !provider.capabilities.hostedFileSearch) {
				failures.push(...(await scenario.verifyLive({ uploads })));
			}
		} catch (e) {
			failures = [`harness error: ${e?.message || e}`];
		}
		if (verdict) console.log(`  judge verdict: ${verdict}`);
		results.push({ name: scenario.name, failures, ms: Date.now() - started, answer, toolCalls });
	}

	// MCP clients keep sockets open; exit explicitly with the aggregate status
	process.exit(printResults(results));
}

main().catch((e) => {
	console.error("test:live crashed", e);
	process.exit(2);
});
