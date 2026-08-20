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
import { initializeMcpRegistry } from "../ai/mcp_registry.js";
import { getProvider } from "../ai/providers/index.js";
import { respond } from "../ai/respond.js";
import {
	createTestLogger,
	evaluateScenario,
	fakeSlackTs,
	printResults,
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
 */
function createFakeSlackClient(message) {
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
		assistant: {
			threads: {
				setStatus: async () => ({ ok: true }),
				setTitle: async () => ({ ok: true }),
			},
		},
	};
}

/**
 * Run one scenario through respond() and collect the answer + tool calls.
 *
 * @param {Object} scenario
 * @returns {Promise<{answer: string, toolCalls: string[]}>}
 */
async function runScenario(scenario) {
	const ts = fakeSlackTs();
	const toolCalls = [];
	const said = [];

	const logger = createTestLogger({
		onEntry: (_level, msg, meta) => {
			if (msg === "Executed function call" && meta?.name) {
				toolCalls.push(meta.name);
			}
		},
	});

	const message = {
		channel: FAKE_CHANNEL,
		thread_ts: ts,
		ts,
		text: scenario.prompt,
		user: FAKE_USER_ID,
	};

	const say = async (value) => {
		const text = typeof value === "string" ? value : value?.text || value?.markdown_text || "";
		if (text) said.push(text);
	};

	await Promise.race([
		respond({
			client: createFakeSlackClient(message),
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

	return { answer: said.join(""), toolCalls };
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
	for (const scenario of SCENARIOS) {
		console.log(`\n--- ${scenario.name}: ${scenario.prompt}`);
		const started = Date.now();
		let answer = "";
		let toolCalls = [];
		let failures = [];
		let verdict = null;
		try {
			({ answer, toolCalls } = await runScenario(scenario));
			({ failures, verdict } = await evaluateScenario({ scenario, answer, toolCalls }));
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
