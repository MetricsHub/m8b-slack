/**
 * Observe when a user opens the Agent's Messages tab.
 * Suggested prompts are configured in manifest.json and Slack renders them at
 * the top of this tab, so opening it does not need to create a greeting message.
 *
 * @param {Object} params
 * @param {import("@slack/types").AppHomeOpenedEvent} params.event
 * @param {import("@slack/logger").Logger} params.logger
 */
export const appHomeOpened = async ({ event, logger }) => {
	if (event.tab !== "messages") return;

	logger.debug?.("Agent Messages tab opened", {
		user: event.user,
		hasContext: Boolean(event.context),
	});
};
