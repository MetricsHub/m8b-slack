import { appContextChanged } from "./app-context-changed.js";
import { appHomeOpened } from "./app-home-opened.js";
import { message } from "./message.js";

/**
 * Register the events used by Slack's Agent messaging experience.
 *
 * @param {import("@slack/bolt").App} app
 */
export const register = (app) => {
	app.event("app_context_changed", appContextChanged);
	app.event("app_home_opened", appHomeOpened);
	app.event("message", message);
};
