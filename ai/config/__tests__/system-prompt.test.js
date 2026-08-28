/**
 * Tests for the capability-adapted system prompt.
 */

import { buildSystemPrompt, SYSTEM_PROMPT } from "../system-prompt.js";

describe("buildSystemPrompt", () => {
	it("returns the base prompt unchanged with full capabilities", () => {
		expect(buildSystemPrompt()).toBe(SYSTEM_PROMPT);
	});

	it("mandates one host per call on small context windows", () => {
		const prompt = buildSystemPrompt({}, { contextWindow: 32768 });
		expect(prompt).toContain("(32768 tokens)");
		expect(prompt).toContain("query ONE host per call");
		expect(prompt).toContain("NEVER guess");
	});

	it("relaxes per-host querying on large context windows, keeping truncation honesty", () => {
		const prompt = buildSystemPrompt({}, { contextWindow: 262144 });
		expect(prompt).toContain("(262144 tokens)");
		expect(prompt).not.toContain("query ONE host per call");
		expect(prompt).toContain("batch a handful of hosts");
		expect(prompt).toContain("monitorTypes");
		expect(prompt).toContain("NEVER guess");
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

	it("tells the model it sees images directly with native image input", () => {
		const prompt = buildSystemPrompt({
			providerFileUploads: false,
			imageInput: true,
			localCodeInterpreter: true,
		});
		expect(prompt).toContain("visible to you directly");
		expect(prompt).toContain("staged for the run_python tool");
		expect(prompt).toContain("Visual content from images attached by the user");
		expect(prompt).not.toContain("bracketed text description produced by a vision model");
		expect(prompt).not.toContain("File analysis is not available in this deployment");
	});

	it("native image input without the sandbox limits reading to images", () => {
		const prompt = buildSystemPrompt({
			providerFileUploads: false,
			imageInput: true,
			localCodeInterpreter: false,
		});
		expect(prompt).toContain("visible to you directly");
		expect(prompt).toContain("Other file types cannot be read in this deployment");
		expect(prompt).not.toContain("run_python");
	});

	it("native image input wins over a leftover imageDescriptions flag", () => {
		const prompt = buildSystemPrompt({
			providerFileUploads: false,
			imageInput: true,
			imageDescriptions: true,
		});
		expect(prompt).toContain("visible to you directly");
		expect(prompt).not.toContain("bracketed text description produced by a vision model");
	});

	it("points file creation at run_python when the local sandbox replaces code_interpreter", () => {
		const prompt = buildSystemPrompt({ codeInterpreter: false, localCodeInterpreter: true });
		expect(prompt).toContain("run_python");
		expect(prompt).toContain("automatically posted to Slack");
		expect(prompt).not.toContain("use code_interpreter to create them");
		expect(prompt).not.toContain("You cannot create or generate downloadable files");
	});

	it("combines vision descriptions with run_python data-file staging", () => {
		const prompt = buildSystemPrompt({
			providerFileUploads: false,
			imageDescriptions: true,
			localCodeInterpreter: true,
		});
		expect(prompt).toContain("bracketed text description produced by a vision model");
		expect(prompt).toContain("staged for the run_python tool");
		expect(prompt).toContain("/data/");
		expect(prompt).not.toContain("Other file types cannot be read in this deployment");
		expect(prompt).toContain("contents of data files attached by the user");
	});

	it("offers run_python data-file staging even without a vision model", () => {
		const prompt = buildSystemPrompt({
			providerFileUploads: false,
			imageDescriptions: false,
			localCodeInterpreter: true,
		});
		expect(prompt).toContain("staged for the run_python tool");
		expect(prompt).toContain("Images cannot be viewed in this deployment");
		expect(prompt).not.toContain("File analysis is not available in this deployment");
		expect(prompt).toContain("Contents of data files attached by the user");
	});

	it("says file creation is unavailable without any code tool", () => {
		const prompt = buildSystemPrompt({ codeInterpreter: false, localCodeInterpreter: false });
		expect(prompt).toContain("You cannot create or generate downloadable files");
		expect(prompt).not.toContain("run_python");
	});
});
