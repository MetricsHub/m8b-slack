import { respond } from "../../ai/respond.js";

/**
 * Normalize an Agent View message.im event for the shared response pipeline.
 * In Agent View, a user's first message is the thread root and has no thread_ts.
 *
 * @param {Record<string, any>} event
 * @returns {(Record<string, any> & {channel: string, user: string, thread_ts: string}) | null}
 */
export function normalizeAgentMessage(event) {
	if (!event) return null;

	const subtype = "subtype" in event ? event.subtype : undefined;
	// A file shared without a caption arrives with empty text: the attachment
	// itself is the message, so files count as content
	const hasFiles = Array.isArray(event.files) && event.files.length > 0;
	if (
		event.channel_type !== "im" ||
		(!event.text && !hasFiles) ||
		!("user" in event) ||
		!event.user ||
		!("ts" in event) ||
		!event.ts ||
		"bot_id" in event ||
		(subtype && subtype !== "file_share")
	) {
		return null;
	}

	return {
		...event,
		text: event.text || "",
		channel: event.channel,
		user: event.user,
		thread_ts: "thread_ts" in event && event.thread_ts ? event.thread_ts : event.ts,
	};
}

/**
 * Build Agent View thread helpers using the unchanged assistant.threads APIs.
 *
 * @param {Object} params
 * @param {import("@slack/web-api").WebClient} params.client
 * @param {string} params.channel
 * @param {string} params.threadTs
 */
export function createAgentThreadUtilities({ client, channel, threadTs }) {
	return {
		say: (value) =>
			client.chat.postMessage({
				...(typeof value === "string" ? { text: value } : value),
				channel,
				thread_ts: threadTs,
			}),
		setTitle: (title) =>
			client.assistant.threads.setTitle({
				channel_id: channel,
				thread_ts: threadTs,
				title,
			}),
		setStatus: (status) =>
			client.assistant.threads.setStatus({
				...status,
				channel_id: channel,
				thread_ts: threadTs,
			}),
	};
}

/**
 * Handle direct messages in Slack's Agent messaging experience.
 *
 * @param {Object} params
 * @param {Record<string, any>} params.event
 * @param {Object} params.body
 * @param {import("@slack/bolt").Context} params.context
 * @param {import("@slack/web-api").WebClient} params.client
 * @param {import("@slack/logger").Logger} params.logger
 */
export const message = async ({ event, body, context, client, logger }) => {
	const normalizedMessage = normalizeAgentMessage(event);
	if (!normalizedMessage || normalizedMessage.user === context.BOT_USER_ID) return;

	const { channel, thread_ts, user } = normalizedMessage;
	const teamId = event.team || context.teamId || body.team_id;
	const { say, setTitle, setStatus } = createAgentThreadUtilities({
		client,
		channel,
		threadTs: thread_ts,
	});

	await respond({
		client,
		context: {
			...context,
			userId: user,
			teamId,
		},
		logger,
		message: normalizedMessage,
		body,
		say,
		setTitle,
		setStatus,
		slackAppContext: event.app_context,
	});
};
