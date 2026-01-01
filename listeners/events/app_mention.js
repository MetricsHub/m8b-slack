import { respond } from "../../ai/respond.js";

/**
 * The `appMentionCallback` event handler allows your app to receive message
 * events that directly mention your app. The app must be a member of the
 * channel/conversation to receive the event. Messages in a DM with your app
 * will not dispatch this event, event if the message mentions your app.
 *
 * @param {Object} params
 * @param {import("@slack/types").AppMentionEvent} params.event - The app mention event.
 * @param {import("@slack/web-api").WebClient} params.client - Slack web client.
 * @param {import("@slack/logger").Logger} params.logger - Logger instance.
 * @param {import("@slack/bolt").SayFn} params.say - Function to send messages.
 *
 * @see {@link https://docs.slack.dev/reference/events/app_mention/}
 */
export const appMentionCallback = async ({ event, client, logger, say }) => {
	try {
		const { channel, text, team, user } = event;
		const thread_ts = event.thread_ts || event.ts;

		// Build minimal message object
		const messageObj = {
			channel,
			thread_ts,
			ts: event.ts,
			text: text.replace(/<@[^>]+>\s*/, ""), // Remove the bot mention
			user,
			files: Array.isArray(event.files) ? event.files : undefined,
		};

		// Create wrappers that match the function signatures expected by handleAssistantMessage
		const setTitle = (_title) => void 0;

		const setStatus = (statusObj) =>
			client.assistant.threads.setStatus({
				channel_id: channel,
				thread_ts,
				...statusObj, // spread the status and loading_messages
			});

		return await respond({
			client,
			context: {
				userId: user,
				teamId: team,
			},
			logger,
			message: messageObj,
			say: (msg) => say({ ...(typeof msg === "string" ? { text: msg } : msg), thread_ts }),
			getThreadContext: () => void 0,
			setTitle,
			setStatus,
		});
	} catch (e) {
		logger.error(e);
		await say({
			text: `You needed me here? Well... 😬 ${e}`,
			channel: event.channel,
			thread_ts: event.thread_ts || event.ts,
		});
	}
};
