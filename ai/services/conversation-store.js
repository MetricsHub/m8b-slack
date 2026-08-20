/**
 * Application-side conversation store for stateless providers (Ollama).
 *
 * Ollama's /v1/responses API does not support previous_response_id, so the
 * structured conversation items (user/assistant messages, function_call and
 * function_call_output items) are kept here, keyed by the natural Slack
 * conversation identifier: team + channel + thread_ts.
 *
 * The store is in-memory, mirroring the existing threadResponseCache used for
 * OpenAI response IDs. Durability comes from Slack itself: after a restart the
 * text history is rebuilt from the Slack thread (same as the OpenAI cold-start
 * path), losing only intermediate tool-call detail from earlier turns.
 */

/** Maximum tracked conversations before the oldest are evicted */
const MAX_CONVERSATIONS = 200;

/** Conversations idle longer than this are evicted lazily */
const CONVERSATION_TTL_MS = 24 * 60 * 60 * 1000;

/** Cap on stored items per conversation (oldest dropped first) */
const MAX_ITEMS_PER_CONVERSATION = 400;

const conversations = new Map(); // key -> { items: Array, updatedAt: number }

/**
 * Build the canonical store key for a Slack conversation.
 *
 * @param {Object} params
 * @param {string} [params.teamId] - Slack workspace/team ID
 * @param {string} params.channel - Slack channel ID
 * @param {string} params.threadTs - Slack thread timestamp
 * @returns {string}
 */
export function conversationKey({ teamId, channel, threadTs }) {
	return `${teamId || "unknown-team"}:${channel}:${threadTs}`;
}

function evictStale() {
	const now = Date.now();

	for (const [key, entry] of conversations) {
		if (now - entry.updatedAt > CONVERSATION_TTL_MS) {
			conversations.delete(key);
		}
	}

	if (conversations.size > MAX_CONVERSATIONS) {
		const oldestFirst = [...conversations.entries()].sort(
			(a, b) => a[1].updatedAt - b[1].updatedAt
		);
		for (const [key] of oldestFirst.slice(0, conversations.size - MAX_CONVERSATIONS)) {
			conversations.delete(key);
		}
	}
}

/**
 * Get the stored conversation items for a key.
 *
 * @param {string} key - Conversation key
 * @returns {Array|null} Copy of the stored items, or null when unknown
 */
export function getConversation(key) {
	const entry = conversations.get(key);
	if (!entry) return null;

	if (Date.now() - entry.updatedAt > CONVERSATION_TTL_MS) {
		conversations.delete(key);
		return null;
	}

	return [...entry.items];
}

/**
 * Replace the stored conversation items for a key.
 *
 * @param {string} key - Conversation key
 * @param {Array} items - Structured Responses API input items
 */
export function setConversation(key, items) {
	const bounded =
		items.length > MAX_ITEMS_PER_CONVERSATION ? items.slice(-MAX_ITEMS_PER_CONVERSATION) : items;

	conversations.set(key, { items: [...bounded], updatedAt: Date.now() });
	evictStale();
}

/**
 * Append items to a stored conversation (creates it when missing).
 *
 * @param {string} key - Conversation key
 * @param {Array} items - Items to append
 */
export function appendToConversation(key, items) {
	const existing = getConversation(key) || [];
	setConversation(key, [...existing, ...items]);
}

/**
 * Clear the whole store (used by tests).
 */
export function clearConversationStore() {
	conversations.clear();
}
