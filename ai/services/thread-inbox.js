/**
 * Per-thread inbox for Slack messages that arrive while a run is in flight.
 *
 * One respond() run owns a Slack thread at a time. Messages posted to that
 * thread while the run is working are queued here instead of starting a
 * concurrent run (which would interleave streamed answers in Slack and race
 * on the conversation store / thread response cache). The active run drains
 * the queue between model turns and injects the messages into the ongoing
 * conversation; whatever is still queued when the run ends is handed back to
 * the caller to be dispatched as fresh runs.
 *
 * All functions are synchronous Map operations: on Node's single-threaded
 * event loop an enqueue check followed immediately by a registration is
 * atomic, so two Bolt events for the same thread can never both start a run.
 */

const activeRuns = new Map(); // key -> { pending: Array<{message, slackAppContext}> }

/**
 * Build the canonical inbox key for a Slack thread.
 *
 * @param {Object} params
 * @param {string} params.channel - Slack channel ID
 * @param {string} params.threadTs - Slack thread timestamp
 * @returns {string}
 */
export function threadRunKey({ channel, threadTs }) {
	return `${channel}:${threadTs}`;
}

/**
 * Register a run as the owner of a thread. No-op if already registered.
 *
 * @param {string} key - Thread inbox key
 */
export function beginRun(key) {
	if (!activeRuns.has(key)) {
		activeRuns.set(key, { pending: [] });
	}
}

/**
 * Queue an entry when a run is in flight for the thread.
 *
 * @param {string} key - Thread inbox key
 * @param {{message: Object, slackAppContext?: Object}} entry - Late-arriving message
 * @returns {boolean} true when queued (a run owns the thread), false otherwise
 */
export function enqueueIfActive(key, entry) {
	const run = activeRuns.get(key);
	if (!run) return false;
	run.pending.push(entry);
	return true;
}

/**
 * Remove and return the queued entries matching a predicate, in Slack
 * timestamp order. Non-matching entries stay queued.
 *
 * @param {string} key - Thread inbox key
 * @param {(entry: Object) => boolean} [predicate] - Filter (default: all)
 * @returns {Array} The removed entries (empty when none match)
 */
export function takePending(key, predicate = () => true) {
	const run = activeRuns.get(key);
	if (!run || run.pending.length === 0) return [];

	const taken = [];
	const kept = [];
	for (const entry of run.pending) {
		(predicate(entry) ? taken : kept).push(entry);
	}
	run.pending = kept;

	taken.sort(
		(a, b) => Number.parseFloat(a?.message?.ts || "0") - Number.parseFloat(b?.message?.ts || "0")
	);
	return taken;
}

/**
 * True when queued entries matching the predicate exist for the thread.
 *
 * @param {string} key - Thread inbox key
 * @param {(entry: Object) => boolean} [predicate] - Filter (default: all)
 * @returns {boolean}
 */
export function hasPending(key, predicate = () => true) {
	const run = activeRuns.get(key);
	return !!run && run.pending.some(predicate);
}

/**
 * Release the thread and return whatever is still queued (messages that
 * arrived too late to inject, or from users the run could not fold in).
 *
 * @param {string} key - Thread inbox key
 * @returns {Array} Leftover entries (empty when none)
 */
export function endRun(key) {
	const run = activeRuns.get(key);
	activeRuns.delete(key);
	return run ? run.pending : [];
}

/**
 * Clear the whole inbox (used by tests).
 */
export function clearThreadInbox() {
	activeRuns.clear();
}
