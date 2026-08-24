import { ACTION_IDS } from "../../ai/services/config-editor.js";
import { configDecisionCallback, credentialsOpenCallback } from "./config-interactions.js";
import { feedbackActionCallback } from "./feedback.js";

/**
 * @param {import("@slack/bolt").App} app
 */
export const register = (app) => {
	app.action("feedback", feedbackActionCallback);
	app.action(ACTION_IDS.credentialsOpen, credentialsOpenCallback);
	app.action(ACTION_IDS.configApprove, configDecisionCallback);
	app.action(ACTION_IDS.configReject, configDecisionCallback);
};
