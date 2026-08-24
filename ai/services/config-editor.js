/**
 * MetricsHub configuration editing tools.
 *
 * Implements the app-side handlers for the config-editing function tools:
 * listing/reading configuration files, collecting credentials from the user
 * through a Slack modal (the model never sees plaintext OR ciphertext — only
 * an opaque placeholder), and saving changes behind validation, a backup, and
 * an explicit Approve/Reject button click in Slack.
 *
 * Authorization is enforced programmatically: only the Slack users listed in
 * METRICSHUB_CONFIG_ADMINS may request configuration changes.
 */

import { refreshHostsForServer } from "../mcp_registry.js";
import { credentialThreadKey, substituteCredentials } from "./config-credentials.js";
import {
	getConfigFileContent,
	listConfigFiles,
	resolveAgentServer,
	saveBackupFile,
	saveConfigFile,
	validateConfigFile,
} from "./metricshub-api.js";
import {
	createPendingInteraction,
	encodeInteractionValue,
	updateInteractionData,
} from "./slack-interactions.js";
import {
	dedentBlock,
	extractLineRange,
	findResourceEntries,
	findResourceSection,
	indentBlock,
	insertLinesAfter,
	replaceLineRange,
} from "./yaml-resources.js";

/**
 * How long to wait for the user to provide credentials or approve a change.
 * Override with METRICSHUB_INTERACTION_TIMEOUT_MS.
 *
 * @returns {number} Timeout in milliseconds
 */
export function getInteractionTimeoutMs() {
	const fromEnv = Number.parseInt(process.env.METRICSHUB_INTERACTION_TIMEOUT_MS || "", 10);
	return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 15 * 60 * 1000;
}

/** Block Kit action ids handled by listeners/actions/config-interactions.js */
export const ACTION_IDS = {
	credentialsOpen: "m8b_credentials_open",
	configApprove: "m8b_config_approve",
	configReject: "m8b_config_reject",
};

/** Modal callback id handled by listeners/views/credentials-modal.js */
export const CREDENTIALS_MODAL_CALLBACK_ID = "m8b_credentials_modal";

/** Upper bound on a config file we are willing to push. */
const MAX_CONFIG_CONTENT_CHARS = 512 * 1024;

/** Cap for the diff rendered in the Slack approval message (mrkdwn limit is 3000). */
const MAX_DIFF_CHARS = 2400;

/**
 * Parse METRICSHUB_CONFIG_ADMINS into a list of Slack user IDs.
 *
 * @returns {string[]} Authorized Slack user IDs (empty = nobody)
 */
export function getConfigAdmins() {
	return String(process.env.METRICSHUB_CONFIG_ADMINS || "")
		.split(/[\s,;]+/)
		.map((s) => s.trim())
		.filter(Boolean);
}

/**
 * Whether a Slack user may request MetricsHub configuration changes.
 *
 * @param {string} userId - Slack user ID
 * @returns {boolean}
 */
export function isConfigAdmin(userId) {
	return Boolean(userId) && getConfigAdmins().includes(userId);
}

function _unauthorizedResult(userId) {
	const admins = getConfigAdmins();
	return {
		ok: false,
		error: `User <@${userId}> is not authorized to change MetricsHub configuration.`,
		hint:
			admins.length === 0
				? "No authorized users are configured (METRICSHUB_CONFIG_ADMINS is empty). Tell the user configuration editing is disabled on this bot."
				: "Tell the user they are not on the list of authorized users for configuration changes. Do NOT retry.",
	};
}

/**
 * Validate a configuration file name (no paths, no traversal).
 *
 * @param {string} fileName - Candidate file name
 * @returns {boolean}
 */
export function isSafeConfigFileName(fileName) {
	return (
		typeof fileName === "string" &&
		/^[A-Za-z0-9][A-Za-z0-9._ -]*$/.test(fileName) &&
		!fileName.includes("..")
	);
}

/**
 * Render a compact line diff for the Slack approval message: common
 * prefix/suffix lines are folded away, the changed region is shown with
 * -/+ markers and two lines of context.
 *
 * @param {string} oldText - Current file content ("" for a new file)
 * @param {string} newText - Proposed file content
 * @param {number} [maxChars] - Truncation cap
 * @returns {string} Human-readable diff
 */
export function renderConfigDiff(oldText, newText, maxChars = MAX_DIFF_CHARS) {
	const regions = _computeDiffRegions(oldText, newText);
	if (!regions) return "(no changes)";

	const lines = [];
	if (regions.foldedBefore > 0) lines.push(`  ... ${regions.foldedBefore} unchanged line(s) ...`);
	for (const line of regions.contextBefore) lines.push(`  ${line}`);
	for (const line of regions.removed) lines.push(`- ${line}`);
	for (const line of regions.added) lines.push(`+ ${line}`);
	for (const line of regions.contextAfter) lines.push(`  ${line}`);
	if (regions.foldedAfter > 0) lines.push(`  ... ${regions.foldedAfter} unchanged line(s) ...`);

	let out = lines.join("\n");
	if (out.length > maxChars) out = `${out.slice(0, maxChars)}\n... (diff truncated)`;
	return out;
}

/**
 * Compute the changed region between two file versions: common prefix/suffix
 * lines are folded away, keeping two context lines on each side.
 *
 * @returns {null | {foldedBefore: number, contextBefore: string[], removed: string[],
 *   added: string[], contextAfter: string[], foldedAfter: number}} null when identical
 */
function _computeDiffRegions(oldText, newText) {
	const oldLines = String(oldText).split(/\r?\n/);
	const newLines = String(newText).split(/\r?\n/);

	let start = 0;
	while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start])
		start++;

	let endOld = oldLines.length;
	let endNew = newLines.length;
	while (endOld > start && endNew > start && oldLines[endOld - 1] === newLines[endNew - 1]) {
		endOld--;
		endNew--;
	}

	if (start === endOld && start === endNew) return null;

	const context = 2;
	const ctxStart = Math.max(0, start - context);
	const tailEnd = Math.min(oldLines.length, endOld + context);

	return {
		foldedBefore: ctxStart,
		contextBefore: oldLines.slice(ctxStart, start),
		removed: oldLines.slice(start, endOld),
		added: newLines.slice(start, endNew),
		contextAfter: oldLines.slice(endOld, tailEnd),
		foldedAfter: oldLines.length - tailEnd,
	};
}

/** Slack side-bar colors for the diff attachments (GitHub-ish red/green). */
const DIFF_COLORS = { removed: "#E01E5A", added: "#2EB67D", context: "#B6B6B6" };

/** Per-attachment cap; a Slack section's mrkdwn text tops out at 3000 chars. */
const MAX_DIFF_ATTACHMENT_CHARS = 2400;

function _diffAttachment(color, fallback, lines) {
	let text = lines.join("\n");
	if (text.length > MAX_DIFF_ATTACHMENT_CHARS) {
		text = `${text.slice(0, MAX_DIFF_ATTACHMENT_CHARS)}\n... (truncated)`;
	}
	return {
		color,
		fallback,
		blocks: [{ type: "section", text: { type: "mrkdwn", text: `\`\`\`${text}\`\`\`` } }],
	};
}

/**
 * Render the change as Slack attachments with colored side bars — the closest
 * Block Kit gets to a red/green diff (mrkdwn has no text colors or
 * backgrounds). Removed lines get a red bar, added lines a green bar,
 * context a gray one.
 *
 * @param {string} oldText - Current file content ("" for a new file)
 * @param {string} newText - Proposed file content
 * @returns {Array<Object>} Slack message attachments (empty when identical)
 */
export function renderDiffAttachments(oldText, newText) {
	const regions = _computeDiffRegions(oldText, newText);
	if (!regions) return [];

	const attachments = [];

	const before = [...regions.contextBefore];
	if (regions.foldedBefore > 0) before.unshift(`... ${regions.foldedBefore} unchanged line(s) ...`);
	if (before.length > 0) {
		attachments.push(_diffAttachment(DIFF_COLORS.context, "Unchanged context", before));
	}

	// A hunk that is a single empty line is a phantom (e.g. the "old" side of
	// a brand-new file); rendering it would show an empty colored block
	const isPhantom = (lines) => lines.length === 1 && lines[0] === "";
	if (regions.removed.length > 0 && !isPhantom(regions.removed)) {
		attachments.push(_diffAttachment(DIFF_COLORS.removed, "Removed lines", regions.removed));
	}
	if (regions.added.length > 0 && !isPhantom(regions.added)) {
		attachments.push(_diffAttachment(DIFF_COLORS.added, "Added lines", regions.added));
	}

	const after = [...regions.contextAfter];
	if (regions.foldedAfter > 0) after.push(`... ${regions.foldedAfter} unchanged line(s) ...`);
	if (after.length > 0) {
		attachments.push(_diffAttachment(DIFF_COLORS.context, "Unchanged context", after));
	}

	return attachments;
}

/**
 * Handle the list_config_files tool.
 *
 * @param {Object} args - {agent}
 * @param {Object} ctx - {userId, logger}
 */
export async function handleListConfigFiles(args, { userId, logger } = {}) {
	if (!isConfigAdmin(userId)) return _unauthorizedResult(userId);

	const resolved = resolveAgentServer(args?.agent);
	if (!resolved.ok) return resolved;

	const result = await listConfigFiles(resolved.server, logger);
	if (!result.ok) return { ok: false, error: result.error };
	return { ok: true, agent: resolved.server.server_label, files: result.data };
}

/**
 * Handle the get_config_file tool.
 *
 * @param {Object} args - {agent, fileName}
 * @param {Object} ctx - {userId, logger}
 */
export async function handleGetConfigFile(args, { userId, logger } = {}) {
	if (!isConfigAdmin(userId)) return _unauthorizedResult(userId);

	const fileName = String(args?.fileName || "").trim();
	if (!isSafeConfigFileName(fileName)) {
		return { ok: false, error: `Invalid configuration file name: "${fileName}"` };
	}

	const resolved = resolveAgentServer(args?.agent);
	if (!resolved.ok) return resolved;

	const result = await getConfigFileContent(resolved.server, fileName, logger);
	if (!result.ok) {
		if (result.status === 404) {
			return {
				ok: false,
				error: `File "${fileName}" not found on agent ${resolved.server.server_label}`,
			};
		}
		return { ok: false, error: result.error };
	}

	return {
		ok: true,
		agent: resolved.server.server_label,
		fileName,
		content: result.data,
		note: "When editing, call save_config_file with the `edits` parameter (small find/replace operations copied EXACTLY from this content) — never retype the whole file. Save back to this SAME agent (unless the user explicitly asked to move the configuration). Preserve existing encrypted password values verbatim.",
	};
}

/**
 * Normalize the fields argument of request_credentials into
 * [{name, label, secret}] with sensible defaults.
 *
 * @param {Array<string|Object>} [fields] - Model-provided field list
 * @returns {Array<{name: string, label: string, secret: boolean}>}
 */
export function normalizeCredentialFields(fields) {
	const looksSecret = (name) => /pass|secret|token|community|key/i.test(name);

	const list = Array.isArray(fields) && fields.length > 0 ? fields : ["username", "password"];
	const normalized = [];
	const seen = new Set();
	for (const field of list.slice(0, 6)) {
		const raw =
			typeof field === "string"
				? { name: field }
				: field && typeof field === "object"
					? field
					: null;
		if (!raw) continue;
		const name = String(raw.name || "")
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9_-]/g, "");
		if (!name || seen.has(name)) continue;
		seen.add(name);
		normalized.push({
			name,
			label: String(raw.label || name).slice(0, 75),
			secret: typeof raw.secret === "boolean" ? raw.secret : looksSecret(name),
		});
	}
	return normalized;
}

/** Bounds for save_config_file edits (each edit is a find/replace pair). */
const MAX_CONFIG_EDITS = 20;
const MAX_EDIT_CHARS = 20000;

/**
 * Apply find/replace edits to configuration content. Each "find" string must
 * match the (progressively edited) content exactly once — this forces the
 * model to copy real, unique excerpts instead of retyping the whole file,
 * which local models cannot fit in their output budget.
 *
 * @param {string} baseContent - Current file content
 * @param {Array<{find: string, replace: string}>} edits - Ordered edits
 * @returns {{ok: true, content: string} | {ok: false, error: string}}
 */
export function applyConfigEdits(baseContent, edits) {
	if (!Array.isArray(edits) || edits.length === 0) {
		return { ok: false, error: "No edits provided" };
	}
	if (edits.length > MAX_CONFIG_EDITS) {
		return { ok: false, error: `Too many edits (${edits.length}; max ${MAX_CONFIG_EDITS})` };
	}

	let content = String(baseContent);
	for (let i = 0; i < edits.length; i++) {
		const find = typeof edits[i]?.find === "string" ? edits[i].find : "";
		const replace = typeof edits[i]?.replace === "string" ? edits[i].replace : "";
		if (!find) {
			return { ok: false, error: `Edit ${i + 1}: "find" must be a non-empty string` };
		}
		if (find.length > MAX_EDIT_CHARS || replace.length > MAX_EDIT_CHARS) {
			return { ok: false, error: `Edit ${i + 1}: find/replace exceeds ${MAX_EDIT_CHARS} chars` };
		}

		const occurrences = content.split(find).length - 1;
		if (occurrences === 0) {
			return {
				ok: false,
				error: `Edit ${i + 1}: the "find" text was not found in the file. Copy it EXACTLY (including whitespace and indentation) from the get_config_file output.`,
			};
		}
		if (occurrences > 1) {
			return {
				ok: false,
				error: `Edit ${i + 1}: the "find" text appears ${occurrences} times in the file. Extend it with surrounding lines so it matches exactly once.`,
			};
		}

		// Replacer function: a plain string would expand $-patterns ($&, $1, ...)
		content = content.replace(find, () => replace);
	}

	return { ok: true, content };
}

/**
 * Handle the request_credentials tool: post a button in the Slack thread,
 * wait for the user to fill the credential modal, and return the collected
 * values. Secret values come back as {{CRED:...}} placeholders bound to the
 * target agent; plaintext never enters the model context.
 *
 * @param {Object} args - {agent, purpose, fields}
 * @param {Object} ctx - {client, message, say, userId, logger}
 */
export async function handleRequestCredentials(args, { client, message, say, userId, logger }) {
	if (!isConfigAdmin(userId)) return _unauthorizedResult(userId);

	const resolved = resolveAgentServer(args?.agent);
	if (!resolved.ok) return resolved;
	const agentLabel = resolved.server.server_label;

	const purpose = String(args?.purpose || "MetricsHub configuration").slice(0, 200);
	const fields = normalizeCredentialFields(args?.fields);
	if (fields.length === 0) {
		return { ok: false, error: "No valid credential fields requested" };
	}

	const timeoutMs = getInteractionTimeoutMs();
	const validityNote = `Valid for ${Math.round(timeoutMs / 60000)} minutes.`;

	const { id, promise } = createPendingInteraction({
		kind: "credentials",
		requesterUserId: userId,
		timeoutMs,
		data: {
			agentLabel,
			purpose,
			fields,
			threadKey: credentialThreadKey(message),
		},
	});

	const posted = await say({
		text: `Credentials needed: ${purpose}`,
		blocks: [
			{
				type: "section",
				text: {
					type: "mrkdwn",
					text: `:lock: *Credentials needed* — ${purpose}\n<@${userId}>, click below to provide them. Secret values are encrypted with the \`${agentLabel}\` keystore; neither the AI nor anyone in this thread ever sees them. ${validityNote}`,
				},
			},
			{
				type: "actions",
				elements: [
					{
						type: "button",
						style: "primary",
						text: { type: "plain_text", text: "Provide credentials" },
						action_id: ACTION_IDS.credentialsOpen,
						value: encodeInteractionValue(id),
					},
				],
			},
		],
	});
	updateInteractionData(id, { messageChannel: posted?.channel, messageTs: posted?.ts });

	logger?.info?.("[CONFIG] Waiting for credentials via Slack modal", { agentLabel, purpose });
	const outcome = await promise;

	if (!outcome.ok) {
		await _disableInteractionMessage(
			client,
			posted,
			`:hourglass: <@${userId}> the credential request expired after ${Math.round(timeoutMs / 60000)} minutes (${purpose}). Ask me again when you're ready.`,
			logger
		);
		return {
			ok: false,
			timedOut: true,
			error:
				"The user did not provide credentials in time. Do NOT retry on your own; ask the user if they want to try again.",
		};
	}

	if (outcome.value?.error) {
		return { ok: false, error: outcome.value.error };
	}

	return {
		ok: true,
		agent: agentLabel,
		values: outcome.value.values,
		note: "Secret values are opaque placeholders. Copy them EXACTLY as-is into the YAML (e.g. password: {{CRED:xxxxxxxx}}); the real encrypted secret is substituted when the file is saved with save_config_file on this same agent. Never modify, re-encode, or move a placeholder to another agent.",
	};
}

/**
 * Handle the save_config_file tool: substitute credential placeholders,
 * validate the content on the agent, ask the requesting user to approve the
 * change (with a diff) via Slack buttons, back up the current file, then save.
 * The agent applies the change live — no restart involved.
 *
 * @param {Object} args - {agent, fileName, content?, edits?, changeSummary}
 * @param {Object} ctx - {client, message, say, userId, threadAuthorIds, logger}
 */
export async function handleSaveConfigFile(
	args,
	{ client, message, say, userId, threadAuthorIds, logger }
) {
	if (!isConfigAdmin(userId)) return _unauthorizedResult(userId);

	const fileName = String(args?.fileName || "").trim();
	if (!isSafeConfigFileName(fileName)) {
		return { ok: false, error: `Invalid configuration file name: "${fileName}"` };
	}

	const hasContent = typeof args?.content === "string" && args.content.trim().length > 0;
	const edits = Array.isArray(args?.edits) && args.edits.length > 0 ? args.edits : null;
	if (hasContent && edits) {
		return { ok: false, error: 'Provide either "content" or "edits", not both.' };
	}
	if (!hasContent && !edits) {
		return {
			ok: false,
			error:
				'Provide "edits" (find/replace operations, for an existing file) or "content" (complete file, for a new file).',
		};
	}

	const resolved = resolveAgentServer(args?.agent);
	if (!resolved.ok) return resolved;
	const server = resolved.server;
	const agentLabel = server.server_label;

	// Fetch the current content (edit base, diff, and backup); 404 = new file
	let currentContent = "";
	let fileExists = false;
	const current = await getConfigFileContent(server, fileName, logger);
	if (current.ok) {
		currentContent = typeof current.data === "string" ? current.data : "";
		fileExists = true;
	} else if (current.status !== 404) {
		return { ok: false, error: `Could not read current file: ${current.error}` };
	}

	// Assemble the new content (still with {{CRED:...}} placeholders)
	let rawContent;
	if (edits) {
		if (!fileExists) {
			return {
				ok: false,
				error: `File "${fileName}" does not exist on agent ${agentLabel}; edits need an existing file. Use "content" to create a new file.`,
			};
		}
		const applied = applyConfigEdits(currentContent, edits);
		if (!applied.ok) return applied;
		rawContent = applied.content;
	} else {
		rawContent = String(args.content);
	}

	return _reviewAndSaveFile({
		server,
		fileName,
		fileExists,
		currentContent,
		rawContent,
		changeSummary: args?.changeSummary,
		client,
		message,
		say,
		userId,
		threadAuthorIds,
		logger,
	});
}

/**
 * Shared write pipeline for every config-changing tool: substitute credential
 * placeholders, validate on the agent, ask the requesting user to approve the
 * diff via Slack buttons, back up the current file, then save. The agent
 * applies the change live — no restart involved.
 *
 * @param {Object} params - {server, fileName, fileExists, currentContent,
 *   rawContent, changeSummary, client, message, say, userId, threadAuthorIds, logger}
 * @returns {Promise<Object>} Model-facing result
 */
async function _reviewAndSaveFile({
	server,
	fileName,
	fileExists,
	currentContent,
	rawContent,
	changeSummary,
	client,
	message,
	say,
	userId,
	threadAuthorIds,
	logger,
}) {
	const agentLabel = server.server_label;

	if (!rawContent.trim()) {
		return { ok: false, error: "Refusing to save an empty configuration file" };
	}
	if (rawContent.length > MAX_CONFIG_CONTENT_CHARS) {
		return { ok: false, error: `Content too large (${rawContent.length} chars)` };
	}

	// Replace {{CRED:...}} placeholders with the keystore ciphertext
	const substitution = substituteCredentials({
		threadKey: credentialThreadKey(message),
		agentLabel,
		content: rawContent,
	});
	if (substitution.missingRefs.length > 0) {
		return {
			ok: false,
			error: `Unknown credential placeholder(s): ${substitution.missingRefs.join(", ")}. Use request_credentials to obtain valid placeholders first (they expire after a few hours).`,
		};
	}
	if (substitution.wrongAgentRefs.length > 0) {
		return {
			ok: false,
			error: `Credential placeholder(s) ${substitution.wrongAgentRefs.join(", ")} were encrypted for a different agent and cannot be used on ${agentLabel}. Encryption is keystore-specific: call request_credentials again for this agent.`,
		};
	}
	const content = substitution.content;

	if (fileExists && currentContent === content) {
		return {
			ok: false,
			error: "The new content is identical to the current file; nothing to save.",
		};
	}

	// Validate on the agent before bothering the user
	const validation = await validateConfigFile(server, fileName, content, logger);
	if (!validation.ok && validation.status !== 400) {
		return { ok: false, error: `Validation request failed: ${validation.error}` };
	}
	const validationData = validation.data;
	if (validationData && validationData.valid === false) {
		return {
			ok: false,
			error: "The configuration is invalid; fix it and try again.",
			validationErrors: validationData.errors || [],
		};
	}

	// Ask the requesting user to approve the change (diff on the SUBSTITUTED
	// content would leak ciphertext length only — show the raw content diff
	// instead so placeholders stay visible and reviewable)
	const diffAttachments = renderDiffAttachments(fileExists ? currentContent : "", rawContent);
	const summary = String(changeSummary || "(no summary provided)").slice(0, 500);

	// Confused-deputy guard: when other people wrote in this thread, their
	// messages may have steered the model — tell the approving admin to trust
	// the diff, not the conversation
	const otherAuthors = [...(threadAuthorIds || [])].filter((id) => id && id !== userId);
	const multiAuthorWarning =
		otherAuthors.length > 0
			? [
					{
						type: "context",
						elements: [
							{
								type: "mrkdwn",
								text: `:warning: Other people participated in this thread (${otherAuthors
									.map((id) => `<@${id}>`)
									.join(
										", "
									)}) and may have influenced this change. Review the diff carefully — approve ONLY what YOU asked for.`,
							},
						],
					},
				]
			: [];

	const timeoutMs = getInteractionTimeoutMs();

	const { id, promise } = createPendingInteraction({
		kind: "config-approval",
		requesterUserId: userId,
		timeoutMs,
		data: { agentLabel, fileName },
	});

	// Layout note: top-level blocks always render ABOVE attachments, so the
	// header and warning are blocks, while the colored diff hunks and the
	// buttons (which must sit below the diff) live in attachments.
	const posted = await say({
		text: `Approve configuration change to ${fileName} on ${agentLabel}?`,
		blocks: [
			{
				type: "section",
				text: {
					type: "mrkdwn",
					text: `:pencil: *Configuration change pending approval*\n*Agent:* \`${agentLabel}\` — *File:* \`${fileName}\`${fileExists ? "" : " _(new file)_"}\n*Change:* ${summary}\n_Valid for ${Math.round(timeoutMs / 60000)} minutes._`,
				},
			},
			...multiAuthorWarning,
		],
		attachments: [
			...diffAttachments,
			{
				fallback: "Approve or reject the configuration change",
				blocks: [
					{
						type: "actions",
						elements: [
							{
								type: "button",
								style: "primary",
								text: { type: "plain_text", text: "Approve & save" },
								action_id: ACTION_IDS.configApprove,
								value: encodeInteractionValue(id),
							},
							{
								type: "button",
								style: "danger",
								text: { type: "plain_text", text: "Reject" },
								action_id: ACTION_IDS.configReject,
								value: encodeInteractionValue(id),
							},
						],
					},
				],
			},
		],
	});
	updateInteractionData(id, { messageChannel: posted?.channel, messageTs: posted?.ts });

	logger?.info?.("[CONFIG] Waiting for change approval", { agentLabel, fileName });
	const outcome = await promise;

	if (!outcome.ok) {
		await _disableInteractionMessage(
			client,
			posted,
			`:hourglass: <@${userId}> the approval request expired — \`${fileName}\` on \`${agentLabel}\` was NOT changed. Ask me again when you're ready.`,
			logger
		);
		return {
			ok: false,
			timedOut: true,
			error:
				"The user did not approve the change in time. The file was NOT modified. Ask the user if they want to try again.",
		};
	}
	if (outcome.value?.approved !== true) {
		return {
			ok: false,
			rejected: true,
			error:
				"The user REJECTED the change. The file was NOT modified. Ask what they want to adjust.",
		};
	}

	// Back up the current content before overwriting
	let backupCreated = false;
	if (fileExists) {
		const backup = await saveBackupFile(server, fileName, currentContent, logger);
		if (!backup.ok) {
			return { ok: false, error: `Backup failed, aborting the save: ${backup.error}` };
		}
		backupCreated = true;
	}

	const saved = await saveConfigFile(server, fileName, content, logger);
	if (!saved.ok) {
		if (saved.status === 400) {
			return {
				ok: false,
				error: "The agent rejected the file at save time (validation failed).",
				details: saved.data,
			};
		}
		return { ok: false, error: `Save failed: ${saved.error}` };
	}

	logger?.info?.("[CONFIG] Configuration file saved", { agentLabel, fileName, backupCreated });

	// The consolidated host map (ListHosts/SearchHost) is stale now. Refresh it
	// in the background: once immediately, and again after 30s because the
	// agent applies the change live but its reload may lag a few seconds.
	void refreshHostsForServer(agentLabel, logger);
	const delayedRefresh = setTimeout(() => {
		void refreshHostsForServer(agentLabel, logger);
	}, 30000);
	delayedRefresh.unref?.();

	return {
		ok: true,
		agent: agentLabel,
		fileName,
		backupCreated,
		credentialsSubstituted: substitution.substituted,
		note: "Saved. MetricsHub applies configuration changes live — no restart needed. Tell the user the change is active.",
	};
}

// ---------------------------------------------------------------------------
// Resource-level tools: operate on ONE resource (host) entry inside the YAML
// files, so the model reads and writes a few hundred bytes instead of a whole
// file. Location is structural (resources.<id> / resourceGroups.<g>.resources.<id>);
// everything outside the entry's block stays byte-identical.
// ---------------------------------------------------------------------------

function _escapeRegExp(text) {
	return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Read every YAML config file of an agent and locate its resource entries.
 *
 * @param {Object} server - Registry server entry
 * @param {Object} [logger] - Logger instance
 * @returns {Promise<{ok: true, files: Array<{name: string, content: string, entries: Array}>}
 *   | {ok: false, error: string}>}
 */
async function _scanAgentResources(server, logger) {
	const list = await listConfigFiles(server, logger);
	if (!list.ok) return { ok: false, error: `Could not list config files: ${list.error}` };

	const yamlFileNames = (Array.isArray(list.data) ? list.data : [])
		.map((f) => f?.name)
		.filter((name) => typeof name === "string" && /\.ya?ml$/i.test(name));

	const files = [];
	for (const name of yamlFileNames) {
		const res = await getConfigFileContent(server, name, logger);
		if (!res.ok) return { ok: false, error: `Could not read "${name}": ${res.error}` };
		const content = typeof res.data === "string" ? res.data : "";
		files.push({ name, content, entries: findResourceEntries(content) });
	}
	return { ok: true, files };
}

function _findResourceMatches(files, resourceId) {
	const matches = [];
	for (const file of files) {
		for (const entry of file.entries) {
			if (entry.resourceId === resourceId) matches.push({ file, entry });
		}
	}
	return matches;
}

function _multipleDefinitionsError(resourceId, matches) {
	const locations = matches.map((m) => `${m.file.name} (${m.entry.pathLabel})`).join(", ");
	return {
		ok: false,
		error: `Your MetricsHub config defines "${resourceId}" multiple times, which is a bad practice: ${locations}. Tell the user to clean this up first (the duplicates can be edited with the file-level tools); the resource-level tools refuse to guess which definition wins.`,
	};
}

/**
 * Suggest resource IDs for a query that did not match exactly: by id
 * substring, or by the query appearing inside the entry's YAML (host.name,
 * IP address, ...).
 */
function _resourceSuggestions(files, query) {
	const q = String(query).toLowerCase();
	if (!q) return [];
	const suggestions = new Set();
	for (const file of files) {
		for (const entry of file.entries) {
			if (
				entry.resourceId.toLowerCase().includes(q) ||
				extractLineRange(file.content, entry.startLine, entry.endLine).toLowerCase().includes(q)
			) {
				suggestions.add(entry.resourceId);
			}
		}
	}
	return [...suggestions].slice(0, 5);
}

function _resourceNotFoundError(files, resourceId, agentLabel, extra = "") {
	const suggestions = _resourceSuggestions(files, resourceId);
	const suggestionText =
		suggestions.length > 0 ? ` Close matches (by id or content): ${suggestions.join(", ")}.` : "";
	return {
		ok: false,
		error: `Resource "${resourceId}" is not defined in any configuration file on ${agentLabel}.${suggestionText} Use SearchHost to map a hostname to its resource ID.${extra}`,
	};
}

/**
 * Handle the get_resource_config tool: return the YAML block of one resource
 * and where it lives. Fails with a warning when the resource is defined more
 * than once.
 *
 * @param {Object} args - {agent, resourceId}
 * @param {Object} ctx - {userId, logger}
 */
export async function handleGetResourceConfig(args, { userId, logger } = {}) {
	if (!isConfigAdmin(userId)) return _unauthorizedResult(userId);

	const resourceId = String(args?.resourceId || "").trim();
	if (!resourceId) return { ok: false, error: "resourceId is required" };

	const resolved = resolveAgentServer(args?.agent);
	if (!resolved.ok) return resolved;

	const scan = await _scanAgentResources(resolved.server, logger);
	if (!scan.ok) return scan;

	const matches = _findResourceMatches(scan.files, resourceId);
	if (matches.length === 0) {
		return _resourceNotFoundError(scan.files, resourceId, resolved.server.server_label);
	}
	if (matches.length > 1) return _multipleDefinitionsError(resourceId, matches);

	const { file, entry } = matches[0];
	return {
		ok: true,
		agent: resolved.server.server_label,
		resourceId,
		file: file.name,
		resourceGroup: entry.group,
		yaml: dedentBlock(extractLineRange(file.content, entry.startLine, entry.endLine), entry.indent),
		note: `To change this resource, call modify_resource_config with the COMPLETE updated entry: first line "${resourceId}:" at column 0, body indented beneath. Preserve existing encrypted password values verbatim. Stay on this same agent.`,
	};
}

/**
 * Validate the resourceYaml argument: the complete entry, first line
 * "<resourceId>:" at column 0.
 */
function _validateResourceYaml(resourceId, resourceYaml) {
	const yaml = String(resourceYaml || "")
		.replace(/\r\n/g, "\n")
		.trimEnd();
	if (!yaml.trim()) {
		return { ok: false, error: "resourceYaml is required (the complete resource entry)" };
	}

	const firstLine = yaml.split("\n").find((line) => line.trim());
	const escaped = _escapeRegExp(resourceId);
	const keyRe = new RegExp(`^(?:"${escaped}"|'${escaped}'|${escaped}):\\s*(#.*)?$`);
	if (!firstLine || !keyRe.test(firstLine)) {
		return {
			ok: false,
			error: `resourceYaml must be the complete entry, starting with "${resourceId}:" on the first line at column 0 (body indented beneath). To rename a resource, delete it and create the new one instead.`,
		};
	}
	return { ok: true, yaml };
}

/**
 * Handle the modify_resource_config tool: replace one resource's YAML entry,
 * or create it when it does not exist yet (requires "file", optionally
 * "resourceGroup"). Runs the shared validate → diff → approve → backup →
 * save pipeline on the single affected file.
 *
 * @param {Object} args - {agent, resourceId, resourceYaml, changeSummary, file?, resourceGroup?}
 * @param {Object} ctx - {client, message, say, userId, threadAuthorIds, logger}
 */
export async function handleModifyResourceConfig(args, ctx) {
	const { client, message, say, userId, threadAuthorIds, logger } = ctx;
	if (!isConfigAdmin(userId)) return _unauthorizedResult(userId);

	const resourceId = String(args?.resourceId || "").trim();
	if (!resourceId) return { ok: false, error: "resourceId is required" };

	const validated = _validateResourceYaml(resourceId, args?.resourceYaml);
	if (!validated.ok) return validated;
	const resourceYaml = validated.yaml;

	const resolved = resolveAgentServer(args?.agent);
	if (!resolved.ok) return resolved;
	const server = resolved.server;
	const agentLabel = server.server_label;

	const scan = await _scanAgentResources(server, logger);
	if (!scan.ok) return scan;

	const matches = _findResourceMatches(scan.files, resourceId);
	if (matches.length > 1) return _multipleDefinitionsError(resourceId, matches);

	let fileName;
	let currentContent;
	let newContent;
	let defaultSummary;

	if (matches.length === 1) {
		// Replace the existing entry in place
		const { file, entry } = matches[0];
		fileName = file.name;
		currentContent = file.content;
		newContent = replaceLineRange(
			file.content,
			entry.startLine,
			entry.endLine,
			indentBlock(resourceYaml, entry.indent)
		);
		defaultSummary = `Update resource "${resourceId}" (${fileName})`;
	} else {
		// Create the entry: an explicit target file is required
		fileName = String(args?.file || "").trim();
		const fileList = scan.files.map((f) => f.name).join(", ") || "(none)";
		if (!fileName) {
			return _resourceNotFoundError(
				scan.files,
				resourceId,
				agentLabel,
				` To CREATE it, call modify_resource_config again with "file" (one of: ${fileList}) and optionally "resourceGroup".`
			);
		}
		const target = scan.files.find((f) => f.name === fileName);
		if (!target) {
			return {
				ok: false,
				error: `File "${fileName}" not found on ${agentLabel}. Available: ${fileList}. To start a brand-new file, use save_config_file with "content".`,
			};
		}

		const group = args?.resourceGroup ? String(args.resourceGroup).trim() : null;
		const section = findResourceSection(target.content, group);
		currentContent = target.content;

		if (section.found) {
			newContent = insertLinesAfter(
				target.content,
				section.insertAfterLine,
				indentBlock(resourceYaml, section.childIndent)
			);
		} else if (group) {
			return {
				ok: false,
				error: section.groupExists
					? `Resource group "${group}" in "${fileName}" has no "resources:" section yet; add one with save_config_file first.`
					: `Resource group "${group}" not found in "${fileName}". Available groups: ${section.groups.join(", ") || "(none)"}.`,
			};
		} else {
			// No top-level resources: section — append one at the end of the file
			const base = target.content.trimEnd();
			newContent = `${base ? `${base}\n\n` : ""}resources:\n${indentBlock(resourceYaml, 2)}\n`;
		}
		defaultSummary = `Add resource "${resourceId}" to ${fileName}${group ? ` (group ${group})` : ""}`;
	}

	const result = await _reviewAndSaveFile({
		server,
		fileName,
		fileExists: true,
		currentContent,
		rawContent: newContent,
		changeSummary: args?.changeSummary || defaultSummary,
		client,
		message,
		say,
		userId,
		threadAuthorIds,
		logger,
	});
	return result.ok ? { ...result, resourceId } : result;
}

/**
 * Handle the delete_resource_config tool: remove one resource's YAML entry
 * (after user approval of the diff).
 *
 * @param {Object} args - {agent, resourceId, changeSummary}
 * @param {Object} ctx - {client, message, say, userId, threadAuthorIds, logger}
 */
export async function handleDeleteResourceConfig(args, ctx) {
	const { client, message, say, userId, threadAuthorIds, logger } = ctx;
	if (!isConfigAdmin(userId)) return _unauthorizedResult(userId);

	const resourceId = String(args?.resourceId || "").trim();
	if (!resourceId) return { ok: false, error: "resourceId is required" };

	const resolved = resolveAgentServer(args?.agent);
	if (!resolved.ok) return resolved;

	const scan = await _scanAgentResources(resolved.server, logger);
	if (!scan.ok) return scan;

	const matches = _findResourceMatches(scan.files, resourceId);
	if (matches.length === 0) {
		return _resourceNotFoundError(scan.files, resourceId, resolved.server.server_label);
	}
	if (matches.length > 1) return _multipleDefinitionsError(resourceId, matches);

	const { file, entry } = matches[0];
	const result = await _reviewAndSaveFile({
		server: resolved.server,
		fileName: file.name,
		fileExists: true,
		currentContent: file.content,
		rawContent: replaceLineRange(file.content, entry.startLine, entry.endLine, null),
		changeSummary: args?.changeSummary || `Delete resource "${resourceId}" from ${file.name}`,
		client,
		message,
		say,
		userId,
		threadAuthorIds,
		logger,
	});
	return result.ok ? { ...result, resourceId } : result;
}

/**
 * Replace an interactive message's buttons with a final status line.
 */
async function _disableInteractionMessage(client, posted, text, logger) {
	if (!client || !posted?.channel || !posted?.ts) return;
	try {
		await client.chat.update({
			channel: posted.channel,
			ts: posted.ts,
			text,
			blocks: [{ type: "section", text: { type: "mrkdwn", text } }],
			// chat.update keeps attachments unless explicitly replaced — clear
			// them so no stale diff or buttons survive the expiry
			attachments: [],
		});
	} catch (e) {
		logger?.debug?.("Failed to update expired interaction message", { e: String(e) });
	}
}
