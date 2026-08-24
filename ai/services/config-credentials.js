/**
 * Per-thread store of encrypted credentials, addressed by opaque placeholders.
 *
 * When a user provides a password through the Slack credential modal, the app
 * encrypts it with the target agent's keystore and stores only the ciphertext
 * here, keyed by a short placeholder such as {{CRED:1a2b3c4d}}. The model only
 * ever sees the placeholder: it writes it into YAML as the password value, and
 * the app substitutes the real ciphertext just before saving the file. This
 * keeps secrets out of the model context AND prevents the model from mangling
 * long ciphertext strings.
 *
 * Ciphertext is keystore-specific: each entry records the agent that encrypted
 * it, and substitution fails if a placeholder is used on a different agent.
 */

import crypto from "node:crypto";

/** Placeholder syntax the model is told to use. */
export const CREDENTIAL_REF_PATTERN = /\{\{CRED:([a-f0-9]{8})\}\}/g;

/** Entries older than this are dropped (the Slack thread has long moved on). */
const CREDENTIAL_TTL_MS = 6 * 60 * 60 * 1000;

/** threadKey -> Map(refId -> {agentLabel, encryptedPassword, createdAt}) */
const store = new Map();

function _prune(now = Date.now()) {
	for (const [threadKey, refs] of store) {
		for (const [refId, entry] of refs) {
			if (now - entry.createdAt > CREDENTIAL_TTL_MS) refs.delete(refId);
		}
		if (refs.size === 0) store.delete(threadKey);
	}
}

/**
 * Build the store key for a Slack thread.
 *
 * @param {Object} message - Slack message ({channel, thread_ts})
 * @returns {string} Thread key
 */
export function credentialThreadKey(message) {
	return `${message?.channel || "?"}:${message?.thread_ts || message?.ts || "?"}`;
}

/**
 * Store an encrypted credential and return its placeholder.
 *
 * @param {Object} params
 * @param {string} params.threadKey - Slack thread key (credentialThreadKey)
 * @param {string} params.agentLabel - Agent whose keystore encrypted the value
 * @param {string} params.encryptedPassword - Keystore ciphertext
 * @returns {string} Placeholder such as "{{CRED:1a2b3c4d}}"
 */
export function storeCredential({ threadKey, agentLabel, encryptedPassword }) {
	_prune();
	const refId = crypto.randomBytes(4).toString("hex");
	if (!store.has(threadKey)) store.set(threadKey, new Map());
	store.get(threadKey).set(refId, {
		agentLabel,
		encryptedPassword,
		createdAt: Date.now(),
	});
	return `{{CRED:${refId}}}`;
}

/**
 * Replace credential placeholders in configuration content with the stored
 * ciphertext. Placeholders that are unknown for this thread, or that were
 * encrypted for a different agent, are reported instead of substituted.
 *
 * @param {Object} params
 * @param {string} params.threadKey - Slack thread key
 * @param {string} params.agentLabel - Agent the content will be saved on
 * @param {string} params.content - Configuration content containing placeholders
 * @returns {{content: string, substituted: number, missingRefs: string[], wrongAgentRefs: string[]}}
 */
export function substituteCredentials({ threadKey, agentLabel, content }) {
	_prune();
	const refs = store.get(threadKey) || new Map();
	const missingRefs = [];
	const wrongAgentRefs = [];
	let substituted = 0;

	const result = String(content).replace(CREDENTIAL_REF_PATTERN, (placeholder, refId) => {
		const entry = refs.get(refId);
		if (!entry) {
			missingRefs.push(placeholder);
			return placeholder;
		}
		if (entry.agentLabel !== agentLabel) {
			wrongAgentRefs.push(placeholder);
			return placeholder;
		}
		substituted += 1;
		return entry.encryptedPassword;
	});

	return { content: result, substituted, missingRefs, wrongAgentRefs };
}

/**
 * Drop every stored credential (tests only).
 */
export function _clearAllCredentials() {
	store.clear();
}
