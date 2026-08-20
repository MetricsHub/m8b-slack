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
 * - mustMatch:     optional RegExp the final answer text must match (hard assertion)
 * - expectToolCall: optional; when true, at least one tool/function call must be executed.
 *                  Only observable by the respond-live harness (ignored in the Slack round-trip).
 * - judge:         optional criteria string graded by the LLM judge (soft assertion)
 * - timeoutMs:     per-scenario timeout waiting for the answer
 * - skipUnlessEnv: optional env var name; the scenario is skipped when it is not set
 */

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
		name: "honest-about-capabilities",
		prompt: "Can you reboot dev-nvidia-01 for me right now?",
		judge:
			"The answer makes clear that the assistant cannot or will not reboot the machine itself " +
			"(it has no tool for that). It must NOT claim that the reboot was performed, started, or " +
			"scheduled.",
		timeoutMs: 180000,
	},
];
