/**
 * Shared helpers for the live test harnesses (scenario evaluation + reporting).
 */

import { judgeAnswer } from "./judge.js";

let tsCounter = 0;

/**
 * Generate a unique Slack-style message timestamp ("1234567890.000001").
 * @returns {string}
 */
export function fakeSlackTs() {
	tsCounter += 1;
	return `${Math.floor(Date.now() / 1000)}.${String(tsCounter).padStart(6, "0")}`;
}

/**
 * Create a logger that records every entry and optionally forwards them.
 * Warnings/errors always print; other levels print with E2E_VERBOSE=1.
 *
 * @param {Object} [options]
 * @param {(level: string, msg: any, meta: any) => void} [options.onEntry]
 */
export function createTestLogger({ onEntry } = {}) {
	const entries = [];
	const make = (level) => {
		return (msg, meta) => {
			entries.push({ level, msg, meta });
			onEntry?.(level, msg, meta);
			if (level === "error" || level === "warn") {
				console.error(`[bot:${level}]`, msg, meta ?? "");
			} else if (process.env.E2E_VERBOSE) {
				console.log(`[bot:${level}]`, msg, meta ?? "");
			}
		};
	};
	return {
		debug: make("debug"),
		info: make("info"),
		warn: make("warn"),
		error: make("error"),
		entries,
		getLevel: () => "info",
		setLevel: () => {},
		setName: () => {},
	};
}

/**
 * Evaluate one scenario result against its expectations.
 *
 * @param {Object} params
 * @param {Object} params.scenario - Scenario definition (see e2e/scenarios.js)
 * @param {string} params.answer - Final answer text collected from the bot
 * @param {string[]} [params.toolCalls] - Names of executed tool calls (respond-live only)
 * @returns {Promise<{failures: string[], verdict: string|null}>}
 */
export async function evaluateScenario({ scenario, answer, toolCalls }) {
	const failures = [];

	if (!answer || !answer.trim()) {
		failures.push("no answer text received");
	}
	if (scenario.mustMatch && !scenario.mustMatch.test(answer || "")) {
		failures.push(`answer does not match ${scenario.mustMatch}`);
	}
	if (scenario.expectToolCall && Array.isArray(toolCalls)) {
		const matched =
			scenario.expectToolCall instanceof RegExp
				? toolCalls.some((name) => scenario.expectToolCall.test(name))
				: toolCalls.length > 0;
		if (!matched) {
			failures.push(
				scenario.expectToolCall instanceof RegExp
					? `expected a tool call matching ${scenario.expectToolCall}, saw: ${toolCalls.join(", ") || "none"}`
					: "expected at least one tool call, saw none"
			);
		}
	}

	let verdict = null;
	if (scenario.judge && answer?.trim()) {
		try {
			const graded = await judgeAnswer({
				prompt: scenario.prompt,
				answer,
				criteria: scenario.judge,
			});
			verdict = graded.verdict;
			if (!graded.pass) {
				failures.push(`judge: ${graded.verdict}`);
			}
		} catch (e) {
			failures.push(`judge errored: ${e?.message || e}`);
		}
	}

	return { failures, verdict };
}

/**
 * Print a summary of all scenario results and return the process exit code.
 *
 * @param {Array<{name: string, failures: string[], ms: number, answer: string, toolCalls?: string[]}>} results
 * @returns {number} 0 when everything passed, 1 otherwise
 */
export function printResults(results) {
	console.log("\n========== RESULTS ==========");
	let failed = 0;
	for (const r of results) {
		const status = r.failures.length === 0 ? "PASS" : "FAIL";
		if (r.failures.length > 0) failed += 1;
		const seconds = (r.ms / 1000).toFixed(1);
		console.log(`\n[${status}] ${r.name} (${seconds}s)`);
		if (r.toolCalls?.length) {
			console.log(`  tools: ${r.toolCalls.join(", ")}`);
		}
		const preview = (r.answer || "").replace(/\s+/g, " ").slice(0, 200);
		console.log(`  answer: ${preview}${(r.answer || "").length > 200 ? "…" : ""}`);
		for (const f of r.failures) {
			console.log(`  ✗ ${f}`);
		}
	}
	console.log(`\n${results.length - failed}/${results.length} scenarios passed`);
	return failed === 0 ? 0 : 1;
}

/**
 * Select the scenarios to run: applies the optional `--only <name>` CLI filter
 * and drops scenarios whose `skipUnlessEnv` variable is not set (with a note).
 *
 * @param {Array<Object>} scenarios
 * @param {string[]} [argv] - defaults to process.argv
 * @returns {Array<Object>}
 */
export function selectScenarios(scenarios, argv = process.argv) {
	let selected = scenarios;

	const onlyIndex = argv.indexOf("--only");
	if (onlyIndex !== -1) {
		const name = argv[onlyIndex + 1];
		selected = selected.filter((s) => s.name === name);
		if (selected.length === 0) {
			console.error(
				`No scenario named "${name}" (available: ${scenarios.map((s) => s.name).join(", ")})`
			);
		}
	}

	return selected.filter((s) => {
		if (s.skipUnlessEnv && !process.env[s.skipUnlessEnv]) {
			console.log(`Skipping ${s.name} (${s.skipUnlessEnv} is not set)`);
			return false;
		}
		return true;
	});
}

/**
 * Reject after the given delay; race against a scenario run.
 *
 * @param {number} ms
 * @returns {Promise<never>}
 */
export function timeoutAfter(ms) {
	return new Promise((_, reject) => {
		const t = setTimeout(() => reject(new Error(`scenario timed out after ${ms}ms`)), ms);
		// Do not keep the event loop alive just for the timeout
		t.unref?.();
	});
}
