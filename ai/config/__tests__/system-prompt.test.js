/**
 * Tests for the capability-adapted system prompt.
 */

import {
	buildSystemPrompt,
	DEPLOYMENT_NOTES_HEADING,
	renderBasePrompt,
	SYSTEM_PROMPT,
} from "../system-prompt.js";

describe("SYSTEM_PROMPT (deployment-neutral base)", () => {
	it("names no company, teammate, Slack user or language", () => {
		expect(SYSTEM_PROMPT).not.toMatch(/Sentry/);
		expect(SYSTEM_PROMPT).not.toMatch(/Olivier|Pascal|Taha/);
		expect(SYSTEM_PROMPT).not.toMatch(/<@U[A-Z0-9]+>/);
		expect(SYSTEM_PROMPT).not.toMatch(/English or French/);
		expect(SYSTEM_PROMPT).toContain("for the organization's IT team");
		expect(SYSTEM_PROMPT).toContain("from the organization's IT infrastructure");
	});

	it("keeps the root-cause rule without an escalation list", () => {
		expect(SYSTEM_PROMPT).toContain(
			"14. Root cause analysis: If you confirm an issue, always try to identify its root cause."
		);
		expect(SYSTEM_PROMPT).toContain("report your finding in the thread");
		expect(SYSTEM_PROMPT).not.toContain("tag <@");
	});

	it("keeps the MetricsHub line but calls it a collector", () => {
		expect(SYSTEM_PROMPT).toContain("the best metrics collector out there");
		expect(SYSTEM_PROMPT).not.toContain("observability tool");
	});

	it("asks for the user's language", () => {
		expect(SYSTEM_PROMPT).toContain("9. Language — respond in the user's language");
	});

	it("keeps the Slack syntax paragraph at the end", () => {
		expect(SYSTEM_PROMPT.endsWith("When referring to users, always use <@USER_ID>.")).toBe(true);
	});
});

describe("renderBasePrompt", () => {
	it("injects the organization name where the prompt names the company", () => {
		const prompt = renderBasePrompt("Acme Corp");
		expect(prompt).toContain("system administrator for Acme Corp's IT team");
		expect(prompt).toContain("protocol checks from Acme Corp's IT infrastructure");
		expect(prompt).not.toContain("the organization's");
	});

	it("falls back to generic wording for an empty name", () => {
		expect(renderBasePrompt("   ")).toBe(SYSTEM_PROMPT);
		expect(renderBasePrompt(null)).toBe(SYSTEM_PROMPT);
		expect(renderBasePrompt()).toBe(SYSTEM_PROMPT);
	});
});

describe("buildSystemPrompt", () => {
	it("returns the base prompt unchanged with full capabilities", () => {
		expect(buildSystemPrompt()).toBe(SYSTEM_PROMPT);
	});

	it("uses the organization name from the deployment context", () => {
		const prompt = buildSystemPrompt({}, { organizationName: "Acme Corp" });
		expect(prompt).toBe(renderBasePrompt("Acme Corp"));
		expect(prompt).toContain("Acme Corp's IT team");
	});

	it("appends deployment notes as a delimited section at the very end", () => {
		const notes = "Storage questions go to #storage.\nHosts are named <site>-<role>-<nn>.";
		const prompt = buildSystemPrompt({}, { deploymentNotes: `\n${notes}\n\n` });
		expect(prompt.startsWith(SYSTEM_PROMPT)).toBe(true);
		expect(prompt).toBe(`${SYSTEM_PROMPT}\n\n${DEPLOYMENT_NOTES_HEADING}\n\n${notes}`);
		expect(DEPLOYMENT_NOTES_HEADING).toContain("never overrides or relaxes them");
	});

	it("keeps the built-in prompt intact under the notes (append-only)", () => {
		const prompt = buildSystemPrompt(
			{ codeInterpreter: false, localCodeInterpreter: true },
			{ contextWindow: 32768, organizationName: "Acme Corp", deploymentNotes: "Be nice." }
		);
		const notesAt = prompt.indexOf(DEPLOYMENT_NOTES_HEADING);
		expect(notesAt).toBeGreaterThan(0);
		const builtIn = prompt.slice(0, notesAt);
		expect(builtIn).toContain("Acme Corp's IT team");
		expect(builtIn).toContain("**Local model constraints:**");
		expect(builtIn).toContain("run_python");
		expect(builtIn).toContain("5. No fabrications.");
		expect(builtIn).toContain("6. Action boundaries.");
		expect(prompt.endsWith("Be nice.")).toBe(true);
	});

	it("appends nothing for blank notes", () => {
		expect(buildSystemPrompt({}, { deploymentNotes: "  \n " })).toBe(SYSTEM_PROMPT);
		expect(buildSystemPrompt({}, { deploymentNotes: undefined })).toBe(SYSTEM_PROMPT);
	});

	it("still applies every capability rewrite with an organization name (exact-match replacements)", () => {
		const prompt = buildSystemPrompt(
			{
				codeInterpreter: false,
				localCodeInterpreter: false,
				hostedFileSearch: false,
				providerFileUploads: false,
				imageDescriptions: false,
			},
			{ organizationName: "Acme Corp" }
		);
		expect(prompt).toContain("File analysis is not available in this deployment");
		expect(prompt).not.toContain("Visual content from any attached files or images");
		expect(prompt).toContain("search_knowledge_base tool");
		expect(prompt).not.toContain("File Search (IT knowledge base)");
		expect(prompt).toContain("SearchHost or search_knowledge_base");
		expect(prompt).toContain("You cannot create or generate downloadable files");
		expect(prompt).not.toContain("code_interpreter");
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
