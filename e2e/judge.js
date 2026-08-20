/**
 * LLM-as-judge for the live test harnesses.
 *
 * Reuses the project's own provider abstraction and streaming plumbing, so the
 * judge runs against whatever backend the bot itself is configured with
 * (OpenAI or Ollama) — no extra configuration needed.
 */

import { getProvider } from "../ai/providers/index.js";
import { streamOnce } from "../ai/services/streaming.js";

const JUDGE_SYSTEM_PROMPT =
	"You are a strict automated test judge. You are given a QUESTION that was sent to a Slack " +
	"assistant, the assistant's ANSWER, and CRITERIA the answer must satisfy. Decide whether the " +
	"answer satisfies the criteria. Respond with exactly one line: PASS if it satisfies the " +
	"criteria, or FAIL: <short reason> if it does not. No other text.";

const silentLogger = {
	debug: () => {},
	info: () => {},
	warn: (...args) => console.warn("[judge]", ...args),
	error: (...args) => console.error("[judge]", ...args),
};

/**
 * Grade an answer against free-form criteria using the configured AI provider.
 *
 * @param {Object} params
 * @param {string} params.prompt - The question that was sent to the bot
 * @param {string} params.answer - The bot's final answer text
 * @param {string} params.criteria - What the answer must satisfy
 * @returns {Promise<{pass: boolean, verdict: string}>}
 */
export async function judgeAnswer({ prompt, answer, criteria }) {
	const provider = getProvider();

	const input = [
		{ role: "system", content: [{ type: "input_text", text: JUDGE_SYSTEM_PROMPT }] },
		{
			role: "user",
			content: [
				{
					type: "input_text",
					text: `QUESTION:\n${prompt}\n\nANSWER:\n${answer}\n\nCRITERIA:\n${criteria}`,
				},
			],
		},
	];

	const result = await streamOnce(
		{ input, tools: [], tool_choice: "none", provider },
		{
			setStatus: async () => {},
			onTextChunk: async () => {},
			logger: silentLogger,
		}
	);

	const verdict = (result?.fullResponseText || "").trim();
	if (/\bFAIL\b/i.test(verdict)) return { pass: false, verdict };
	if (/\bPASS\b/i.test(verdict)) return { pass: true, verdict };
	return { pass: false, verdict: `unparseable judge verdict: "${verdict}"` };
}
