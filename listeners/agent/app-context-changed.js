/**
 * Observe Agent View context changes. Slack also includes the current
 * app_context on subsequent message.im events, where it is passed to the LLM.
 *
 * @param {Object} params
 * @param {import("@slack/types").AppContextChangedEvent} params.event
 * @param {import("@slack/logger").Logger} params.logger
 */
export const appContextChanged = async ({ event, logger }) => {
	const entities = Array.isArray(event.context?.entities) ? event.context.entities : [];

	logger.debug?.("Agent context changed", {
		user: event.user,
		entityTypes: entities.map((entity) => entity.type),
	});
};
