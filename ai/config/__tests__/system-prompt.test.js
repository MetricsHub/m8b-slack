/**
 * Tests for the capability-adapted system prompt.
 */

import { buildSystemPrompt, SYSTEM_PROMPT } from "../system-prompt.js";

describe("buildSystemPrompt", () => {
	it("returns the base prompt unchanged with full capabilities", () => {
		expect(buildSystemPrompt()).toBe(SYSTEM_PROMPT);
	});

	it("tells the model attachments are unreadable without file uploads or vision", () => {
		const prompt = buildSystemPrompt({ providerFileUploads: false, imageDescriptions: false });
		expect(prompt).toContain("File analysis is not available in this deployment");
		expect(prompt).not.toContain("Visual content from any attached files or images");
	});

	it("explains vision-model descriptions when image descriptions are enabled", () => {
		const prompt = buildSystemPrompt({ providerFileUploads: false, imageDescriptions: true });
		expect(prompt).toContain("bracketed text description produced by a vision model");
		expect(prompt).toContain("Vision-model descriptions of images attached by the user");
		expect(prompt).not.toContain("File analysis is not available in this deployment");
	});
});
