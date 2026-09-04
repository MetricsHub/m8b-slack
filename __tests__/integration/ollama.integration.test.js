/**
 * Opt-in integration test against a real Ollama server.
 *
 * Skipped unless AI_PROVIDER=ollama and both the endpoint and the model are set
 * (AI_BASE_URL / AI_MODEL, or their OLLAMA_* aliases), e.g.:
 *
 *   AI_PROVIDER=ollama AI_BASE_URL=http://dev-nvidia-01:11434/v1 AI_MODEL=qwen3.8:27b npm test
 *
 * Not part of the normal suite; it requires the GPU box.
 */

import { describe, expect, it, jest } from "@jest/globals";
import { getAiProviderName, readAiSetting } from "../../ai/config/providers.js";
import { createOllamaProvider } from "../../ai/providers/ollama-provider.js";
import { streamOnce } from "../../ai/services/streaming.js";

const enabled =
	getAiProviderName() === "ollama" &&
	Boolean(readAiSetting("ollama", "BASE_URL").value && readAiSetting("ollama", "MODEL").value);
const maybeDescribe = enabled ? describe : describe.skip;

maybeDescribe("Ollama integration (live)", () => {
	jest.setTimeout(120000);

	it("passes the health check", async () => {
		const provider = createOllamaProvider();
		const health = await provider.healthCheck();
		expect(health.ok).toBe(true);
	});

	it("streams a basic response through /v1/responses", async () => {
		const provider = createOllamaProvider();
		const chunks = [];

		const result = await streamOnce(
			{
				input: [
					{
						role: "system",
						content: [{ type: "input_text", text: "Answer with a single short sentence." }],
					},
					{ role: "user", content: [{ type: "input_text", text: "Say hello." }] },
				],
				tools: [],
				provider,
			},
			{
				setStatus: async () => {},
				onStreamStart: async () => null,
				onTextChunk: async (chunk) => {
					chunks.push(chunk);
				},
				logger: console,
			}
		);

		expect(result.hadText).toBe(true);
		expect(result.fullResponseText.length).toBeGreaterThan(0);
		expect(chunks.join("").length).toBeGreaterThan(0);
	});

	it("emits function calls for a forced tool scenario", async () => {
		const provider = createOllamaProvider();

		const result = await streamOnce(
			{
				input: [
					{
						role: "system",
						content: [
							{
								type: "input_text",
								text: "You MUST call the get_time function to answer. Do not answer directly.",
							},
						],
					},
					{ role: "user", content: [{ type: "input_text", text: "What time is it?" }] },
				],
				tools: [
					{
						type: "function",
						name: "get_time",
						description: "Get the current time.",
						parameters: { type: "object", properties: {}, additionalProperties: false },
					},
				],
				provider,
			},
			{
				setStatus: async () => {},
				onStreamStart: async () => null,
				onTextChunk: async () => {},
				logger: console,
			}
		);

		// Qwen should emit a function call; if it answered in text instead, surface
		// that clearly so compatibility regressions are visible.
		expect(result.functionCalls.length + (result.hadText ? 1 : 0)).toBeGreaterThan(0);
		expect(result.functionCalls.length).toBeGreaterThan(0);
	});
});
