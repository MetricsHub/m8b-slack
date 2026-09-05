/**
 * Deployment-specific context for the system prompt.
 *
 * The system prompt itself (ai/config/system-prompt.js) ships with the bot and
 * is the same for every organization that installs it: persona, safety rules
 * and tool guidance stay under our control. Everything that varies from one
 * deployment to the next comes from this module:
 *
 * - The organization name, resolved from the Slack workspace (team.info, which
 *   needs the team:read bot scope; falls back to the team name returned by
 *   auth.test, which needs no extra scope). The installing workspace is
 *   resolved at startup; an app installed organization-wide on Enterprise Grid
 *   serves several workspaces, so names are cached per team ID and any other
 *   workspace is resolved on its first message (team.info with the team
 *   parameter), falling back to the startup name.
 * - Optional "deployment notes" that administrators APPEND to the prompt with
 *   M8B_PROMPT_EXTRA_FILE (path to a Markdown/text file) and/or M8B_PROMPT_EXTRA
 *   (inline text). They are append-only: they can add context (team, naming
 *   conventions, escalation habits, house rules) but never replace or remove a
 *   built-in rule.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { estimatePayloadTokens } from "../utils/tokens.js";

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

/**
 * How long a failed workspace-name lookup is remembered before the workspace
 * is asked about again. Long enough that a workspace Slack cannot describe
 * (missing scope, unknown team) is not queried on every message, short enough
 * that a transient Slack error does not pin the wrong name until restart.
 */
export const ORGANIZATION_LOOKUP_RETRY_MS = 10 * 60 * 1000;

/** Name of the workspace the bot is installed in (startup), or null. */
let defaultOrganizationName = null;
/**
 * Workspace names by team ID. A failed lookup is recorded with the time it
 * may be retried (see ORGANIZATION_LOOKUP_RETRY_MS).
 * @type {Map<string, {name: string}|{retryAt: number}>}
 */
const organizationNames = new Map();

/** Deployment notes may use at most this share of the prompt-side token budget. */
export const MAX_PROMPT_EXTRA_BUDGET_SHARE = 0.25;
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
 * Record an organization (Slack workspace) name used in the system prompt.
 *
 * @param {string|null|undefined} name - Workspace name; empty/undefined clears it
 * @param {string} [teamId] - Workspace this name belongs to; without it the
 *   name becomes the default (the installing workspace)
 */
export function setOrganizationName(name, teamId) {
	const normalized = normalizeName(name);
	if (teamId) {
		if (normalized) {
			organizationNames.set(teamId, { name: normalized });
		} else {
			organizationNames.delete(teamId);
		}
	} else {
		defaultOrganizationName = normalized;
	}
}

/**
 * The organization name for a workspace: the name cached for that team ID,
 * else the default resolved at startup, else null (the prompt then speaks of
 * "the organization" generically).
 *
 * @param {string} [teamId]
 * @returns {string|null}
 */
export function getOrganizationName(teamId) {
	const entry = teamId ? organizationNames.get(teamId) : undefined;
	if (entry && "name" in entry) {
		return entry.name;
	}
	return defaultOrganizationName;
}

/**
 * Whether a workspace needs (re)resolving: never seen, or its last lookup
 * failed long enough ago to be worth another try.
 *
 * @param {string} teamId
 * @param {number} [now]
 * @returns {boolean}
 */
function needsResolution(teamId, now = Date.now()) {
	const entry = organizationNames.get(teamId);
	if (!entry) return true;
	if ("name" in entry) return false;
	return entry.retryAt <= now;
}

/**
 * Resolve a workspace name from Slack and record it for the system prompt.
 *
 * Tries team.info first (needs the team:read bot scope; with a teamId, asks
 * for that workspace — required on Enterprise Grid org installs). When the
 * scope is missing (older installations) or the call fails, falls back to the
 * "team" field of auth.test, which every bot token can call but only names
 * the installing workspace — so the fallback is only used for the default.
 *
 * @param {Object} client - Slack WebClient
 * @param {Object} [options]
 * @param {string} [options.teamId] - Workspace to resolve; omitted = the
 *   installing workspace, stored as the default
 * @param {Object} [options.logger]
 * @returns {Promise<string|null>} The resolved name (also stored), or null
 */
export async function resolveOrganizationName(client, { teamId, logger = console } = {}) {
	let name = null;
	let resolvedTeamId = teamId;
	try {
		const info = await client.team.info(teamId ? { team: teamId } : {});
		name = normalizeName(info?.team?.name);
		resolvedTeamId = resolvedTeamId || info?.team?.id;
	} catch (e) {
		const reason = e?.data?.error || e?.message || String(e);
		logger.warn?.(
			`Could not read the workspace name with team.info${teamId ? ` for ${teamId}` : ""} (${reason})${teamId ? "" : "; falling back to auth.test"}. Add the "team:read" bot scope to silence this.`
		);
	}
	if (!name && !teamId) {
		try {
			const auth = await client.auth.test();
			name = normalizeName(auth?.team);
			resolvedTeamId = resolvedTeamId || auth?.team_id;
		} catch (e) {
			logger.warn?.("Could not read the workspace name with auth.test", {
				message: e?.message,
			});
		}
	}

	if (!teamId) {
		setOrganizationName(name);
	}
	if (resolvedTeamId) {
		// Cache per workspace; a failed lookup is remembered for a while so it is
		// neither retried on every message nor pinned until the next restart
		organizationNames.set(
			resolvedTeamId,
			name ? { name } : { retryAt: Date.now() + ORGANIZATION_LOOKUP_RETRY_MS }
		);
	}
	return name;
}

/**
 * The organization name for the workspace a message comes from, resolving
 * workspaces not seen before (and retrying failed lookups after
 * ORGANIZATION_LOOKUP_RETRY_MS). Falls back to the startup default.
 *
 * @param {Object} params
 * @param {Object} [params.client] - Slack WebClient (needed to resolve a new workspace)
 * @param {string} [params.teamId] - Workspace of the incoming message
 * @param {Object} [params.logger]
 * @returns {Promise<string|null>}
 */
export async function resolveOrganizationNameFor({ client, teamId, logger = console }) {
	if (teamId && client && needsResolution(teamId)) {
		await resolveOrganizationName(client, { teamId, logger });
	}
	return getOrganizationName(teamId);
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
 * Check that the deployment notes fit the active provider's context window.
 *
 * The character cap (MAX_PROMPT_EXTRA_CHARS) protects large-context models;
 * a small local context can still be swamped by a note that passes it: the
 * leading system prompt is never trimmed by the context-budget trimmer, so
 * an oversized one makes every request fail. The notes may use at most
 * MAX_PROMPT_EXTRA_BUDGET_SHARE of the prompt-side budget (context window
 * minus the output reservation).
 *
 * @param {Object} params
 * @param {string} params.notes - Deployment notes text
 * @param {number} [params.contextWindow] - Provider context window in tokens (unknown = no check)
 * @param {number} [params.maxOutputTokens] - Output token reservation per turn
 * @returns {string|null} An error message when the notes do not fit, else null
 */
export function checkDeploymentNotesBudget({ notes, contextWindow, maxOutputTokens = 0 }) {
	if (!notes || !Number.isFinite(contextWindow) || contextWindow <= 0) return null;
	const promptBudget = Math.max(contextWindow - (maxOutputTokens || 0), 0);
	const allowance = Math.floor(promptBudget * MAX_PROMPT_EXTRA_BUDGET_SHARE);
	const tokens = estimatePayloadTokens(notes);
	if (tokens <= allowance) return null;
	return `Deployment notes (${PROMPT_EXTRA_VAR}/${PROMPT_EXTRA_FILE_VAR}) are too long for this model: about ${tokens} tokens, but only ${allowance} (${Math.round(MAX_PROMPT_EXTRA_BUDGET_SHARE * 100)}% of the ${promptBudget}-token prompt budget: ${contextWindow} context minus ${maxOutputTokens || 0} output) may go to the notes. Shorten them or use a model with a larger context window.`;
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
	defaultOrganizationName = null;
	organizationNames.clear();
	deploymentNotes = null;
}

/**
 * Everything buildSystemPrompt() needs from this module, for one message.
 *
 * @param {Object} [params]
 * @param {Object} [params.client] - Slack WebClient (to resolve a workspace seen for the first time)
 * @param {string} [params.teamId] - Workspace of the incoming message
 * @param {Object} [params.logger]
 * @returns {Promise<{ organizationName: string|null, deploymentNotes: string }>}
 */
export async function getDeploymentContext({ client, teamId, logger } = {}) {
	return {
		organizationName: await resolveOrganizationNameFor({ client, teamId, logger }),
		deploymentNotes: getDeploymentNotes(),
	};
}
