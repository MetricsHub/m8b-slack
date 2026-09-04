/**
 * Deployment-specific context for the system prompt.
 *
 * The system prompt itself (ai/config/system-prompt.js) ships with the bot and
 * is the same for every organization that installs it: persona, safety rules
 * and tool guidance stay under our control. Everything that varies from one
 * deployment to the next comes from this module:
 *
 * - The organization name, resolved once at startup from the Slack workspace
 *   (team.info, which needs the team:read bot scope; falls back to the team
 *   name returned by auth.test, which needs no extra scope).
 * - Optional "deployment notes" that administrators APPEND to the prompt with
 *   M8B_PROMPT_EXTRA_FILE (path to a Markdown/text file) and/or M8B_PROMPT_EXTRA
 *   (inline text). They are append-only: they can add context (team, naming
 *   conventions, escalation habits, house rules) but never replace or remove a
 *   built-in rule.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Environment variable holding the path to a prompt overlay file. */
export const PROMPT_EXTRA_FILE_VAR = "M8B_PROMPT_EXTRA_FILE";
/** Environment variable holding an inline prompt overlay. */
export const PROMPT_EXTRA_VAR = "M8B_PROMPT_EXTRA";

/**
 * Upper bound on the overlay length. Deployment notes are meant to be a few
 * paragraphs; anything bigger belongs in the knowledge base, and a runaway
 * file would silently eat the context window of local models.
 */
export const MAX_PROMPT_EXTRA_CHARS = 20000;

/** @type {string|null} */
let organizationName = null;
/** @type {string|null} null = not loaded yet */
let deploymentNotes = null;

/**
 * Normalize an organization name: trimmed, or null when empty/absent.
 *
 * @param {unknown} name
 * @returns {string|null}
 */
function normalizeName(name) {
	const trimmed = typeof name === "string" ? name.trim() : "";
	return trimmed || null;
}

/**
 * Record the organization (Slack workspace) name used in the system prompt.
 *
 * @param {string|null|undefined} name - Workspace name; empty/undefined clears it
 */
export function setOrganizationName(name) {
	organizationName = normalizeName(name);
}

/**
 * The organization name resolved at startup, or null when unknown (the prompt
 * then speaks of "the organization" generically).
 *
 * @returns {string|null}
 */
export function getOrganizationName() {
	return organizationName;
}

/**
 * Resolve the workspace name from Slack and record it for the system prompt.
 *
 * Tries team.info first (needs the team:read bot scope). When that scope is
 * missing (older installations) or the call fails, falls back to the "team"
 * field of auth.test, which every bot token can call.
 *
 * @param {Object} client - Slack WebClient
 * @param {Object} [logger]
 * @returns {Promise<string|null>} The resolved name (also stored), or null
 */
export async function resolveOrganizationName(client, logger = console) {
	let name = null;
	try {
		const info = await client.team.info();
		name = normalizeName(info?.team?.name);
	} catch (e) {
		const reason = e?.data?.error || e?.message || String(e);
		logger.warn?.(
			`Could not read the workspace name with team.info (${reason}); falling back to auth.test. Add the "team:read" bot scope to silence this.`
		);
	}
	if (!name) {
		try {
			const auth = await client.auth.test();
			name = normalizeName(auth?.team);
		} catch (e) {
			logger.warn?.("Could not read the workspace name with auth.test", {
				message: e?.message,
			});
		}
	}
	setOrganizationName(name);
	return name;
}

/**
 * Read the deployment notes from the environment (no caching).
 *
 * M8B_PROMPT_EXTRA_FILE is read as UTF-8 text (relative paths resolve against
 * the working directory); M8B_PROMPT_EXTRA is used verbatim. When both are
 * set the file comes first. An unreadable file is an error: a deployment that
 * asked for an overlay must not run silently without it.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string} The overlay text, "" when none is configured
 */
export function readDeploymentNotes(env = process.env) {
	const parts = [];

	const filePath = (env[PROMPT_EXTRA_FILE_VAR] || "").trim();
	if (filePath) {
		let text;
		try {
			text = readFileSync(resolve(filePath), "utf8");
		} catch (e) {
			throw new Error(
				`Cannot read ${PROMPT_EXTRA_FILE_VAR}="${filePath}": ${e?.message || String(e)}`
			);
		}
		if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // strip a UTF-8 BOM
		parts.push(text.trim());
	}

	const inline = (env[PROMPT_EXTRA_VAR] || "").trim();
	if (inline) parts.push(inline);

	const notes = parts.filter(Boolean).join("\n\n");
	if (notes.length > MAX_PROMPT_EXTRA_CHARS) {
		throw new Error(
			`Deployment notes are too long (${notes.length} chars, max ${MAX_PROMPT_EXTRA_CHARS}): keep ${PROMPT_EXTRA_VAR}/${PROMPT_EXTRA_FILE_VAR} to a few paragraphs and put reference material in the knowledge base instead.`
		);
	}
	return notes;
}

/**
 * Load (and cache) the deployment notes. Called once at startup so a broken
 * configuration is reported before the bot connects to Slack; later callers
 * get the cached text.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function loadDeploymentNotes(env = process.env) {
	deploymentNotes = readDeploymentNotes(env);
	return deploymentNotes;
}

/**
 * The cached deployment notes ("" when none are configured), loading them on
 * first use when startup did not.
 *
 * @returns {string}
 */
export function getDeploymentNotes() {
	if (deploymentNotes === null) {
		deploymentNotes = readDeploymentNotes();
	}
	return deploymentNotes;
}

/**
 * Forget the cached state (tests).
 */
export function resetDeploymentContext() {
	organizationName = null;
	deploymentNotes = null;
}

/**
 * Everything buildSystemPrompt() needs from this module, in one object.
 *
 * @returns {{ organizationName: string|null, deploymentNotes: string }}
 */
export function getDeploymentContext() {
	return { organizationName: getOrganizationName(), deploymentNotes: getDeploymentNotes() };
}
