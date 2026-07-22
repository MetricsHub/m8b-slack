/**
 * Tests for OpenAI streaming request configuration.
 */

import { MODEL_CONFIG } from "../../config/system-prompt.js";
import { buildResponseRequest } from "../streaming.js";

describe("buildResponseRequest", () => {
	it("uses the GPT-5.6 Sol Responses API configuration", () => {
		const request = buildResponseRequest({
			input: [{ role: "user", content: "status" }],
			tools: [],
			previous_response_id: "resp_previous",
			safety_identifier: "a".repeat(64),
		});

		expect(request).toMatchObject({
			model: "gpt-5.6-sol",
			reasoning: { effort: "medium", summary: "auto", context: "auto" },
			previous_response_id: "resp_previous",
			safety_identifier: "a".repeat(64),
			max_output_tokens: 8000,
			tool_choice: "auto",
			parallel_tool_calls: true,
			text: { format: { type: "text" }, verbosity: "low" },
			stream: true,
		});
		expect(request.model).toBe(MODEL_CONFIG.model);
	});
});
