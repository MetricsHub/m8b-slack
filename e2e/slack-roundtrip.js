/**
 * Full Slack round-trip E2E tests.
 *
 * Starts the bot (node app.js), sends each scenario prompt as a real user DM
 * to the bot, waits for the threaded reply, and evaluates it. This exercises
 * the whole chain: Socket Mode -> listeners -> respond() -> provider/MCP ->
 * Slack reply.
 *
 * Required environment (on top of the bot's own .env.dev.cmd variables):
 * - SLACK_TEST_USER_TOKEN: a user token (xoxp-...) used to send the DMs.
 *   See e2e/README.md for how to create it.
 *
 * Optional:
 * - E2E_ATTACH=1        do not spawn the bot; test against an already-running instance
 * - E2E_DM_CHANNEL=D…   use this DM channel instead of opening one automatically
 *
 * Run:  cmd /c "call .env.dev.cmd && npm run test:e2e"
 * Exit codes: 0 all passed, 1 failures, 2 environment not usable.
 */

import "dotenv/config";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { WebClient } from "@slack/web-api";
import { evaluateScenario, printResults, selectScenarios } from "./harness.js";
import { SCENARIOS } from "./scenarios.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const POLL_INTERVAL_MS = 2000;
const STABLE_POLLS = 2; // reply text unchanged for N polls => streaming finished
const BOT_START_TIMEOUT_MS = 180000;

/**
 * Spawn the bot and resolve once its ready line appears on stdout/stderr.
 *
 * @returns {Promise<import("node:child_process").ChildProcess>}
 */
function startBot() {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ["app.js"], {
			cwd: REPO_ROOT,
			env: process.env,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let buffer = "";
		let settled = false;
		const timer = setTimeout(() => {
			if (!settled) {
				settled = true;
				child.kill();
				reject(new Error(`bot did not become ready within ${BOT_START_TIMEOUT_MS}ms`));
			}
		}, BOT_START_TIMEOUT_MS);

		const onData = (chunk) => {
			buffer += chunk.toString();
			if (process.env.E2E_VERBOSE) process.stdout.write(chunk);
			if (!settled && buffer.includes("M8B is running")) {
				settled = true;
				clearTimeout(timer);
				resolve(child);
			}
		};
		child.stdout.on("data", onData);
		child.stderr.on("data", onData);
		child.on("exit", (code) => {
			if (!settled) {
				settled = true;
				clearTimeout(timer);
				reject(
					new Error(`bot exited before becoming ready (code ${code})\n${buffer.slice(-2000)}`)
				);
			}
		});
	});
}

/**
 * Poll a DM thread until the bot's reply text is stable (streaming finished).
 *
 * @param {WebClient} botClient - Client used for reading (bot token)
 * @param {string} channel - DM channel ID
 * @param {string} rootTs - ts of the thread root message
 * @param {string} botUserId
 * @param {number} timeoutMs
 * @param {string} [sinceTs] - Only consider bot messages newer than this ts
 *   (for multi-turn scenarios: the ts of the latest prompt)
 * @returns {Promise<string>} concatenated bot reply text
 */
async function waitForBotReply(botClient, channel, rootTs, botUserId, timeoutMs, sinceTs = rootTs) {
	const deadline = Date.now() + timeoutMs;
	let lastText = "";
	let stableCount = 0;

	while (Date.now() < deadline) {
		await sleep(POLL_INTERVAL_MS);
		const res = await botClient.conversations.replies({ channel, ts: rootTs, limit: 50 });
		const botMessages = (res.messages || []).filter(
			(m) =>
				Number.parseFloat(m.ts) > Number.parseFloat(sinceTs) && (m.user === botUserId || m.bot_id)
		);
		const text = botMessages
			.map((m) => m.text || "")
			.join("\n")
			.trim();

		if (text) {
			if (text === lastText) {
				stableCount += 1;
				if (stableCount >= STABLE_POLLS) return text;
			} else {
				lastText = text;
				stableCount = 0;
			}
		}
	}

	if (lastText) {
		console.warn("  reply still changing at timeout; evaluating the latest text");
		return lastText;
	}
	throw new Error(`no bot reply within ${timeoutMs}ms`);
}

async function main() {
	const botToken = process.env.SLACK_BOT_TOKEN;
	const userToken = process.env.SLACK_TEST_USER_TOKEN;
	if (!botToken) {
		console.error("SLACK_BOT_TOKEN is not set (load the dev environment first)");
		process.exit(2);
	}
	if (!userToken) {
		console.error("SLACK_TEST_USER_TOKEN is not set — see e2e/README.md to create one");
		process.exit(2);
	}

	const botClient = new WebClient(botToken);
	const userClient = new WebClient(userToken);

	const botAuth = await botClient.auth.test();
	const userAuth = await userClient.auth.test();
	const botUserId = String(botAuth.user_id);
	console.log(`Bot: ${botAuth.user} (${botUserId}) — test user: ${userAuth.user}`);

	let dmChannel = process.env.E2E_DM_CHANNEL;
	if (!dmChannel) {
		const dm = await userClient.conversations.open({ users: botUserId });
		dmChannel = dm.channel?.id;
	}
	if (!dmChannel) {
		console.error("Could not resolve the DM channel with the bot");
		process.exit(2);
	}
	console.log(`DM channel: ${dmChannel}`);

	let bot = null;
	if (process.env.E2E_ATTACH !== "1") {
		console.log("Starting the bot...");
		bot = await startBot();
		console.log("Bot is ready.");
	} else {
		console.log("E2E_ATTACH=1 — assuming the bot is already running.");
	}

	const results = [];
	try {
		for (const scenario of selectScenarios(SCENARIOS)) {
			if (scenario.liveOnly) {
				console.log(`Skipping ${scenario.name} (live-only scenario, run it with test:live)`);
				continue;
			}
			const prompts = scenario.prompts || [scenario.prompt];
			console.log(`\n--- ${scenario.name}: ${prompts[0]}`);
			const started = Date.now();
			let answer = "";
			let failures = [];
			let verdict = null;
			try {
				let rootTs = null;
				for (const [turn, prompt] of prompts.entries()) {
					if (turn > 0) console.log(`  turn ${turn + 1}: ${prompt}`);
					const posted = await userClient.chat.postMessage({
						channel: dmChannel,
						text: prompt,
						...(rootTs ? { thread_ts: rootTs } : {}),
					});
					rootTs = rootTs || String(posted.ts);
					answer = await waitForBotReply(
						botClient,
						dmChannel,
						rootTs,
						botUserId,
						scenario.timeoutMs || 180000,
						String(posted.ts)
					);
				}
				// expectToolCall is only observable at the respond() seam; skip it here
				({ failures, verdict } = await evaluateScenario({ scenario, answer }));
			} catch (e) {
				failures = [`harness error: ${e?.message || e}`];
			}
			if (verdict) console.log(`  judge verdict: ${verdict}`);
			results.push({ name: scenario.name, failures, ms: Date.now() - started, answer });
		}
	} finally {
		if (bot) {
			bot.kill();
			console.log("\nBot stopped.");
		}
	}

	process.exit(printResults(results));
}

main().catch((e) => {
	console.error("test:e2e crashed", e);
	process.exit(2);
});
