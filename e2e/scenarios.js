/**
 * Shared test scenarios for the live AI test harnesses.
 *
 * Used by both:
 * - e2e/respond-live.js  (drives ai/respond.js directly, no Slack)
 * - e2e/slack-roundtrip.js (full Slack round-trip through a running bot)
 *
 * Scenario fields:
 * - name:          unique identifier shown in the report
 * - prompt:        the message sent to the bot
 * - prompts:       multi-turn alternative to prompt: messages sent sequentially in the
 *                  same thread; expectations apply to the reply to the LAST one
 * - mustMatch:     optional RegExp the final answer text must match (hard assertion)
 * - expectToolCall: optional; true requires at least one tool/function call, a RegExp
 *                  requires a call whose name matches. Only observable by the
 *                  respond-live harness (ignored in the Slack round-trip).
 * - judge:         optional criteria string graded by the LLM judge (soft assertion)
 * - timeoutMs:     per-turn timeout waiting for the answer
 * - skipUnlessEnv: optional env var name; the scenario is skipped when it is not set
 * - liveOnly:      optional; run only in the respond-live harness (e.g. scenarios that
 *                  inspect or clean up local state the Slack round-trip cannot reach)
 * - files:         optional [{fixture, name, mimetype}] attachments for the FIRST prompt;
 *                  fixture is a filename under e2e/fixtures/, served to the bot over a
 *                  local HTTP server (respond-live harness only)
 * - verifyLive:    optional async () => string[] of failures, run by respond-live after
 *                  the scenario (Ollama mode only) for deterministic state checks
 */

/**
 * Deterministic post-check for the kb-update-article scenario: exactly one
 * probe article must exist, carrying the corrected date. Cleans the probe
 * article(s) out of the local knowledge base afterwards.
 *
 * @returns {Promise<string[]>} failures (empty when everything checks out)
 */
async function verifyKbUpdate() {
	const failures = [];
	const { createLocalKnowledgeBase } = await import("../ai/services/knowledge-base.js");
	const fsp = (await import("node:fs/promises")).default;
	const path = (await import("node:path")).default;

	const kb = createLocalKnowledgeBase({});
	const res = await kb.search('decommissioning date of the VM "e2e-kb-probe"', 10);
	if (!res.ok) return [`knowledge base search failed: ${res.error}`];

	const hits = res.results.filter((r) => /e2e-kb-probe/i.test(`${r.title} ${r.excerpt}`));
	const docIds = [...new Set(hits.map((h) => h.docId))];

	if (docIds.length === 0) {
		failures.push("no knowledge article found for e2e-kb-probe");
	} else if (docIds.length > 1) {
		failures.push(
			`found ${docIds.length} e2e-kb-probe articles — a duplicate was created instead of updating`
		);
	}
	if (hits.length > 0 && !hits.some((h) => /2027/.test(h.excerpt))) {
		failures.push("the corrected date (March 2027) is not in the article");
	}
	// A stale article is one that still says December 2026 WITHOUT the correction;
	// the updated article may legitimately mention the old date as history
	for (const docId of docIds) {
		const articleText = hits
			.filter((h) => h.docId === docId)
			.map((h) => h.excerpt)
			.join("\n");
		if (/december\s+2026/i.test(articleText) && !/2027/.test(articleText)) {
			failures.push(`article ${docId} still carries the stale December 2026 date only`);
		}
	}

	// Clean the probe article(s) up: drop their chunks and markdown sources
	if (docIds.length > 0) {
		try {
			const index = JSON.parse(await fsp.readFile(kb.indexPath, "utf8"));
			const probeChunks = index.chunks.filter((c) => docIds.includes(c.docId));
			index.chunks = index.chunks.filter((c) => !docIds.includes(c.docId));
			await fsp.writeFile(kb.indexPath, JSON.stringify(index), "utf8");
			for (const source of new Set(probeChunks.map((c) => c.source))) {
				await fsp.unlink(path.join(kb.docsDir, path.basename(source))).catch(() => {});
			}
		} catch (e) {
			failures.push(`probe article cleanup failed: ${e?.message || e}`);
		}
	}

	return failures;
}

export const SCENARIOS = [
	{
		name: "arithmetic-sanity",
		prompt: "What is 17 * 23? Reply with just the number.",
		mustMatch: /391/,
		timeoutMs: 120000,
	},
	{
		name: "metricshub-tool-call",
		prompt: "Which hosts is MetricsHub currently monitoring? Just list a handful of hostnames.",
		expectToolCall: true,
		judge:
			"The answer names at least one concrete monitored host (a hostname or system name), or " +
			"clearly summarizes real monitoring data it looked up. It must NOT claim that it has no " +
			"way to check the monitored hosts.",
		timeoutMs: 300000,
	},
	{
		name: "web-search",
		prompt:
			"Search the web for the official website of the MetricsHub product and give me its URL.",
		expectToolCall: true,
		mustMatch: /metricshub\.(com|org)/i,
		judge:
			"The answer provides a URL on the metricshub.com or metricshub.org domain as the official " +
			"MetricsHub website. It must not claim that web search is unavailable.",
		skipUnlessEnv: "WEB_SEARCH_PROVIDER",
		timeoutMs: 240000,
	},
	{
		name: "kb-update-article",
		liveOnly: true,
		prompts: [
			'For future reference, save this to your knowledge base: the test VM "e2e-kb-probe" is scheduled for decommissioning in December 2026.',
			'Correction: the decommissioning of "e2e-kb-probe" has been postponed to March 2027. Update the existing knowledge article about it — do not create a second one.',
		],
		expectToolCall: /update_knowledge/,
		judge:
			"The reply acknowledges that the knowledge entry about e2e-kb-probe was updated or " +
			"corrected with the new date (March 2027). It must not claim it cannot store knowledge.",
		timeoutMs: 300000,
		verifyLive: verifyKbUpdate,
	},
	{
		name: "screenshot-analysis",
		liveOnly: true,
		prompt:
			"I just got this error popup on one of our servers — screenshot attached. What is going on?",
		files: [{ fixture: "backup-error.png", name: "backup-error.png", mimetype: "image/png" }],
		judge:
			"The answer shows the assistant actually saw the screenshot content: it must mention at " +
			"least one concrete detail from the image — the full disk (C: drive / 0 bytes free), the " +
			"failed backup job BKP-4412, or the host SRV-WEB-01. It must NOT claim it cannot view " +
			"images or ask the user to paste the error as text.",
		// Requires a vision backend: OLLAMA_VISION_MODEL in Ollama mode (OpenAI mode
		// reads images natively, but this dev harness gates on the local setup)
		skipUnlessEnv: "OLLAMA_VISION_MODEL",
		timeoutMs: 300000,
	},
	{
		name: "honest-about-capabilities",
		prompt: "Can you reboot dev-nvidia-01 for me right now?",
		judge:
			"The answer makes clear that the assistant cannot or will not reboot the machine itself " +
			"(it has no tool for that). It must NOT claim that the reboot was performed, started, or " +
			"scheduled.",
		timeoutMs: 180000,
	},
];
