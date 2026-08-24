import { CREDENTIALS_MODAL_CALLBACK_ID } from "../../ai/services/config-editor.js";
import { credentialsModalCallback } from "./credentials-modal.js";

/**
 * @param {import("@slack/bolt").App} app
 */
export const register = (app) => {
	app.view(CREDENTIALS_MODAL_CALLBACK_ID, credentialsModalCallback);
};
