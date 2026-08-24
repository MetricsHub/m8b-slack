/**
 * Handles the credential modal submission (view_submission).
 *
 * The plaintext values exist only inside this handler: secret fields are
 * immediately encrypted with the target agent's keystore
 * (POST /api/security/encrypt-password) and stored as thread-scoped
 * {{CRED:...}} placeholders. The pending request_credentials tool call then
 * resumes with the placeholders — the model never sees a password.
 */

import { storeCredential } from "../../ai/services/config-credentials.js";
import { encryptPassword, resolveAgentServer } from "../../ai/services/metricshub-api.js";
import {
	completePendingInteraction,
	decodeInteractionValue,
	getPendingInteraction,
	INTERACTION_INSTANCE_ID,
} from "../../ai/services/slack-interactions.js";

/**
 * @param {Object} params - Bolt view handler params
 */
export const credentialsModalCallback = async ({ ack, body, view, client, logger }) => {
	// Ack immediately: keystore encryption may exceed Slack's 3s ack window
	await ack();

	const { instanceId, id: interactionId, foreign } = decodeInteractionValue(view?.private_metadata);
	if (foreign) {
		logger?.error?.(
			"Credential modal submission routed to a different bot instance — the provided values were DROPPED. Make sure a single bot instance is running.",
			{ modalInstance: instanceId, thisInstance: INTERACTION_INSTANCE_ID }
		);
		return;
	}
	const interaction = interactionId ? getPendingInteraction(interactionId) : null;
	if (!interaction || interaction.kind !== "credentials") {
		logger?.warn?.("Credential modal submitted for an unknown/expired interaction");
		return;
	}
	if (body.user?.id !== interaction.requesterUserId) {
		logger?.warn?.("Credential modal submitted by an unexpected user; ignoring");
		return;
	}

	const { agentLabel, fields, threadKey, messageChannel, messageTs } = interaction.data;

	const notifyFailure = async (text) => {
		if (!messageChannel) return;
		try {
			await client.chat.postEphemeral({
				channel: messageChannel,
				user: body.user.id,
				thread_ts: messageTs,
				text,
			});
		} catch {
			/* best-effort */
		}
	};

	const resolved = resolveAgentServer(agentLabel);
	if (!resolved.ok) {
		completePendingInteraction(interactionId, { error: resolved.error });
		return;
	}

	const values = {};
	for (const field of fields) {
		const raw = view?.state?.values?.[`field_${field.name}`]?.value?.value;
		const value = typeof raw === "string" ? raw : "";

		if (!field.secret) {
			values[field.name] = value;
			continue;
		}

		const encrypted = await encryptPassword(resolved.server, value, logger);
		if (!encrypted.ok) {
			logger?.error?.("Password encryption failed", { agentLabel, error: encrypted.error });
			// Leave the interaction pending so the user can click the button and retry
			await notifyFailure(
				`:x: Encryption failed on \`${agentLabel}\` (${encrypted.error}). Click the button to try again.`
			);
			return;
		}
		values[field.name] = storeCredential({
			threadKey,
			agentLabel,
			encryptedPassword: encrypted.encryptedPassword,
		});
	}

	if (!completePendingInteraction(interactionId, { values })) {
		logger?.warn?.("Credential interaction expired before the modal was processed");
		return;
	}

	// Retire the "Provide credentials" button
	if (messageChannel && messageTs) {
		try {
			const text = `:white_check_mark: Credentials received from <@${body.user.id}> and encrypted with the \`${agentLabel}\` keystore.`;
			await client.chat.update({
				channel: messageChannel,
				ts: messageTs,
				text,
				blocks: [{ type: "section", text: { type: "mrkdwn", text } }],
			});
		} catch (e) {
			logger?.debug?.("Failed to update the credentials message", { error: String(e) });
		}
	}
};
