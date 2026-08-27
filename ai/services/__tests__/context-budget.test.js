/**
 * Tests for deterministic context-budget trimming (Ollama mode).
 */

import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import {
	estimateTokenCount,
	recordTokenCalibration,
	resetTokenCalibration,
} from "../../utils/tokens.js";
import { trimToContextBudget } from "../context-budget.js";

beforeEach(() => resetTokenCalibration());
afterEach(() => resetTokenCalibration());

function systemItem(text) {
	return { role: "system", content: [{ type: "input_text", text }] };
}

function userItem(text) {
	return { role: "user", content: [{ type: "input_text", text }] };
}

function assistantItem(text) {
	return { role: "assistant", content: [{ type: "output_text", text }] };
}

describe("trimToContextBudget", () => {
	it("returns items unchanged when under budget", () => {
		const items = [systemItem("prompt"), userItem("hello")];
		const result = trimToContextBudget(items, { contextWindow: 32768, maxOutputTokens: 4000 });
		expect(result).toBe(items);
	});

	it("returns items unchanged without a context window", () => {
		const items = [userItem("x".repeat(100000))];
		expect(trimToContextBudget(items, {})).toBe(items);
	});

	it("trims a deliberately long conversation without crashing and keeps the system prompt", () => {
		const items = [systemItem("SYSTEM PROMPT")];
		for (let i = 0; i < 200; i++) {
			items.push(userItem(`question ${i} ${"x".repeat(2000)}`));
			items.push(assistantItem(`answer ${i} ${"y".repeat(2000)}`));
		}

		const contextWindow = 32768;
		const maxOutputTokens = 4000;
		const result = trimToContextBudget(items, { contextWindow, maxOutputTokens });

		// System prompt is always retained
		expect(result[0].content[0].text).toBe("SYSTEM PROMPT");
		// A trim notice is inserted
		expect(result[1].content[0].text).toContain("removed to fit");
		// The most recent turn survives
		expect(result[result.length - 1].content[0].text).toContain("answer 199");
		// The estimate fits the budget
		expect(estimateTokenCount(result)).toBeLessThanOrEqual(contextWindow - maxOutputTokens - 1500);
	});

	it("keeps more history when calibration says estimates run high", () => {
		// A conversation whose ESTIMATE slightly exceeds the raw budget
		const items = [systemItem("SYSTEM")];
		for (let i = 0; i < 12; i++) {
			items.push(userItem(`question ${i} ${"x".repeat(2000)}`));
			items.push(assistantItem(`answer ${i} ${"y".repeat(2000)}`));
		}
		// ~12k estimated tokens vs an 11.5k raw budget (15000 - 2000 - 1500)
		const options = { contextWindow: 15000, maxOutputTokens: 2000 };

		// Without calibration: over budget, older turns are dropped
		const uncalibrated = trimToContextBudget(items, options);
		expect(uncalibrated).not.toBe(items);
		expect(uncalibrated.length).toBeLessThan(items.length + 1);

		// With measured 30%-high estimates, the effective budget grows and the
		// same conversation fits untouched
		recordTokenCalibration({ estimatedTokens: 13000, actualTokens: 9100 });
		expect(trimToContextBudget(items, options)).toBe(items);
	});

	it("trims earlier when calibration says estimates run low", () => {
		const items = [systemItem("SYSTEM")];
		for (let i = 0; i < 12; i++) {
			items.push(userItem(`question ${i} ${"x".repeat(2000)}`));
			items.push(assistantItem(`answer ${i} ${"y".repeat(2000)}`));
		}
		// ~12k estimated tokens vs a 14.5k raw budget: fits with neutral calibration
		const options = { contextWindow: 18000, maxOutputTokens: 2000 };
		expect(trimToContextBudget(items, options)).toBe(items);

		// The server reported 40% MORE tokens than estimated: budget shrinks
		recordTokenCalibration({ estimatedTokens: 10000, actualTokens: 14000 });
		const calibrated = trimToContextBudget(items, options);
		expect(calibrated).not.toBe(items);
		expect(calibrated[1].content[0].text).toContain("removed to fit");
	});

	it("never splits a function_call from its function_call_output", () => {
		const bigText = "z".repeat(4000);
		const items = [
			systemItem("SYSTEM"),
			userItem(bigText),
			{ type: "function_call", call_id: "call_1", name: "ListHosts", arguments: "{}" },
			{ type: "function_call_output", call_id: "call_1", output: bigText },
			userItem(bigText),
			{
				type: "function_call",
				call_id: "call_2",
				name: "SearchHost",
				arguments: '{"pattern":"a"}',
			},
			{ type: "function_call_output", call_id: "call_2", output: bigText },
			assistantItem("final answer"),
		];

		// Budget forcing some groups to drop
		const result = trimToContextBudget(items, { contextWindow: 4000, maxOutputTokens: 500 });

		const callIds = result.filter((i) => i?.type === "function_call").map((i) => i.call_id);
		const outputIds = result
			.filter((i) => i?.type === "function_call_output")
			.map((i) => i.call_id);
		expect(callIds.sort()).toEqual(outputIds.sort());
	});

	it("truncates a giant tool output instead of dropping the user message", () => {
		// Regression: a single 170K-char function_call_output used to exceed the
		// whole budget on its own; the trimmer dropped everything else (including
		// the current question) and Ollama rejected the request with
		// "no user query found in messages"
		const items = [
			systemItem("SYSTEM PROMPT"),
			userItem("Is there anything wrong on our nvidia system?"),
			{
				type: "function_call",
				call_id: "call_1",
				name: "GetMetricsFromCacheForHost",
				arguments: "{}",
			},
			{
				type: "function_call_output",
				call_id: "call_1",
				output: `{"ok":true,${"x".repeat(170000)}}`,
			},
		];

		const contextWindow = 32768;
		const maxOutputTokens = 4000;
		const result = trimToContextBudget(items, { contextWindow, maxOutputTokens });

		// The current user message MUST survive
		const userItems = result.filter((i) => i?.role === "user");
		expect(userItems).toHaveLength(1);
		expect(userItems[0].content[0].text).toContain("nvidia system");

		// The tool call/result pair survives, but the output is truncated to a
		// budget-relative cap (a quarter of the budget, in chars)
		const output = result.find((i) => i?.type === "function_call_output");
		expect(output).toBeDefined();
		const expectedCap = Math.floor((contextWindow - maxOutputTokens - 1500) * 4 * 0.25);
		expect(output.output.length).toBeLessThanOrEqual(expectedCap + 100);
		expect(output.output).toContain("truncated");

		// And the whole request fits the budget
		expect(estimateTokenCount(result)).toBeLessThanOrEqual(contextWindow - maxOutputTokens - 1500);
	});

	it("keeps older history when a truncated tool output makes room for it", () => {
		const items = [
			systemItem("SYSTEM"),
			userItem("earlier question"),
			assistantItem("earlier answer"),
			userItem("current question"),
			{ type: "function_call", call_id: "call_1", name: "ListHosts", arguments: "{}" },
			{ type: "function_call_output", call_id: "call_1", output: "y".repeat(120000) },
		];

		const result = trimToContextBudget(items, { contextWindow: 32768, maxOutputTokens: 4000 });

		// Truncating the giant output leaves plenty of room: nothing else dropped
		const texts = result.flatMap((i) => i?.content || []).map((c) => c?.text || "");
		expect(texts.join("\n")).toContain("earlier question");
		expect(texts.join("\n")).toContain("earlier answer");
		expect(texts.join("\n")).toContain("current question");
	});
});
