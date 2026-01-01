/**
 * The `assistant_thread_started` event is sent when a user opens the Assistant container.
 * This can happen via DM with the app or as a side-container within a channel.
 *
 * @param {Object} params
 * @param {import("@slack/types").AssistantThreadStartedEvent} params.event - The assistant thread started event.
 * @param {import("@slack/logger").Logger} params.logger - Logger instance.
 * @param {import("@slack/bolt").SayFn} params.say - Function to send messages.
 * @param {Function} params.setSuggestedPrompts - Function to set suggested prompts.
 * @param {Function} params.saveThreadContext - Function to save thread context.
 *
 * @see {@link https://docs.slack.dev/reference/events/assistant_thread_started}
 */
export const assistantThreadStarted = async ({
	event,
	client: _client,
	logger,
	say,
	setSuggestedPrompts,
	saveThreadContext,
}) => {
	const { context } = event.assistant_thread;

	try {
		// Resolve a user id candidate from available fields
		const userId = event.user || event.assistant_thread?.user_id || context?.user_id;

		await saveThreadContext();

		// Greet the user with their display name
		await say(`Hi <@${userId}>, what's up?`);

		/**
		 * Provide the user up to 4 optional, preset prompts to choose from.
		 *
		 * The first `title` prop is an optional label above the prompts that
		 * defaults to 'Try these prompts:' if not provided.
		 *
		 * @see {@link https://docs.slack.dev/reference/methods/assistant.threads.setSuggestedPrompts}
		 */
		if (!context.channel_id) {
			await setSuggestedPrompts({
				title: "Start with this suggested prompt:",
				prompts: [
					{
						title: "🖥️ List the monitored systems",
						message: "M8B, please list all the systems you are currently monitoring.",
					},
					{
						title: "🩺 How are we doing?",
						message: "M8B, give me a quick summary of the current status of our IT systems.",
					},
					{
						title: "🏆 System Admin challenge of the day",
						message:
							"M8B, find one issue in any of the monitored systems and report it back to me!",
					},
				],
			});
		}

		/**
		 * If the user opens the Assistant container in a channel, additional
		 * context is available. This can be used to provide conditional prompts
		 * that only make sense to appear in that context.
		 */
		if (context.channel_id) {
			await setSuggestedPrompts({
				title: "Perform an action based on the channel",
				prompts: [
					{
						title: "Summarize channel",
						message: "Assistant, please summarize the activity in this channel!",
					},
				],
			});
		}
	} catch (e) {
		logger.error(e);
	}
};
