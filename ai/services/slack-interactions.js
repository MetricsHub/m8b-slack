/**
 * Registry of pending human interactions in Slack.
 *
 * Some tool calls cannot complete without a human: providing credentials
 * through a modal, or approving a configuration change with a button. The tool
 * handler registers a pending interaction here and awaits its promise; the
 * Bolt action/view listeners look the interaction up by id and complete it.
 * The promise never rejects — timeouts resolve with {ok: false, timedOut: true}
 * so the model gets a clean tool result either way.
 *
 * Single-process only (Socket Mode bot): the map lives in memory.
 */

import crypto from "node:crypto";

/**
 * Identifies THIS bot process. Embedded in every button value / modal
 * private_metadata so a click routed to a different process (bot restarted,
 * or several instances running — e.g. the Slack CLI's file-watch restart
 * leaks instances on Windows) is detected and reported as such, instead of
 * being mistaken for an expired request.
 */
export const INTERACTION_INSTANCE_ID = crypto.randomBytes(4).toString("hex");

/** id -> {kind, requesterUserId, data, resolve, timer} */
const pending = new Map();

/**
 * Encode an interaction id for a Block Kit value / modal private_metadata.
 *
 * @param {string} id - Interaction id
 * @returns {string} "<instanceId>.<interactionId>"
 */
export function encodeInteractionValue(id) {
	return `${INTERACTION_INSTANCE_ID}.${id}`;
}

/**
 * Decode a Block Kit value / modal private_metadata produced by
 * encodeInteractionValue.
 *
 * @param {string} value - Encoded value from the Slack payload
 * @returns {{instanceId: string|null, id: string, foreign: boolean}} foreign =
 *   the value was created by a different bot process than this one
 */
export function decodeInteractionValue(value) {
	const str = String(value || "");
	const dot = str.indexOf(".");
	if (dot === -1) return { instanceId: null, id: str, foreign: true };
	const instanceId = str.slice(0, dot);
	return { instanceId, id: str.slice(dot + 1), foreign: instanceId !== INTERACTION_INSTANCE_ID };
}

/**
 * Register a pending interaction.
 *
 * @param {Object} params
 * @param {string} params.kind - Interaction kind (e.g. "credentials", "config-approval")
 * @param {string} params.requesterUserId - Slack user allowed to complete it
 * @param {Object} [params.data] - Arbitrary context for the listeners (agent label, fields, ...)
 * @param {number} params.timeoutMs - How long to wait before giving up
 * @returns {{id: string, promise: Promise<{ok: boolean, value?: any, timedOut?: boolean}>}}
 */
export function createPendingInteraction({ kind, requesterUserId, data = {}, timeoutMs }) {
	const id = crypto.randomUUID();

	let resolve;
	const promise = new Promise((res) => {
		resolve = res;
	});

	const timer = setTimeout(() => {
		if (pending.delete(id)) {
			resolve({ ok: false, timedOut: true });
		}
	}, timeoutMs);
	// Never keep the process alive just for a pending button click
	timer.unref?.();

	pending.set(id, { kind, requesterUserId, data, resolve, timer });
	return { id, promise };
}

/**
 * Look up a pending interaction (without completing it).
 *
 * @param {string} id - Interaction id
 * @returns {{kind: string, requesterUserId: string, data: Object} | null}
 */
export function getPendingInteraction(id) {
	const entry = pending.get(id);
	if (!entry) return null;
	return { kind: entry.kind, requesterUserId: entry.requesterUserId, data: entry.data };
}

/**
 * Merge extra context into a pending interaction (e.g. the ts of the Slack
 * message carrying its button, so it can be updated later).
 *
 * @param {string} id - Interaction id
 * @param {Object} patch - Fields to merge into data
 * @returns {boolean} False when the interaction is unknown or already completed
 */
export function updateInteractionData(id, patch) {
	const entry = pending.get(id);
	if (!entry) return false;
	Object.assign(entry.data, patch);
	return true;
}

/**
 * Complete a pending interaction: the awaiting tool handler resumes with
 * {ok: true, value}.
 *
 * @param {string} id - Interaction id
 * @param {any} value - Result handed to the awaiting tool handler
 * @returns {boolean} False when the interaction is unknown, expired, or already completed
 */
export function completePendingInteraction(id, value) {
	const entry = pending.get(id);
	if (!entry) return false;
	pending.delete(id);
	clearTimeout(entry.timer);
	entry.resolve({ ok: true, value });
	return true;
}

/**
 * Drop every pending interaction, resolving them as timed out (tests only).
 */
export function _clearAllInteractions() {
	for (const [id, entry] of pending) {
		pending.delete(id);
		clearTimeout(entry.timer);
		entry.resolve({ ok: false, timedOut: true });
	}
}
