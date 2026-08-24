/**
 * Block Kit action handlers for the MetricsHub config-editing flows:
 * - "Provide credentials" button → opens the credential modal
 * - "Approve & save" / "Reject" buttons → resolves a pending config change
 *
 * Buttons carry the pending-interaction id in their value. Only the user who
 * triggered the tool call (an authorized config admin) may act on them.
 */

import { ACTION_IDS, CREDENTIALS_MODAL_CALLBACK_ID } from "../../ai/services/config-editor.js";
import {
	completePendingInteraction,
	decodeInteractionValue,
	encodeInteractionValue,
	getPendingInteraction,
	INTERACTION_INSTANCE_ID,
} from "../../ai/services/slack-interactions.js";

const FOREIGN_INSTANCE_TEXT =
	"This button was created by a different instance of the bot (it restarted, or several instances are running — a known Slack CLI issue on Windows). Make sure a single bot instance is running, then ask me again.";

/**
 * Decode a button value and resolve its pending interaction, reporting
 * foreign-instance clicks distinctly from genuinely expired requests.
 */
function _lookupInteraction(rawValue, expectedKind, client, body, logger) {
	const { instanceId, id, foreign } = decodeInteractionValue(rawValue);
	if (foreign) {
		logger?.warn?.("Interaction button from another bot instance", {
			buttonInstance: instanceId,
			thisInstance: INTERACTION_INSTANCE_ID,
		});
		_ephemeral(client, body, FOREIGN_INSTANCE_TEXT);
		return null;
	}
	const interaction = getPendingInteraction(id);
	if (!interaction || interaction.kind !== expectedKind) {
		logger?.warn?.("Interaction button for an unknown or completed request", { id, expectedKind });
		_ephemeral(client, body, "This request has expired or was already handled. Ask me again.");
		return null;
	}
	return { id, interaction };
}

async function _ephemeral(client, body, text) {
	try {
		await client.chat.postEphemeral({
			channel: body.channel?.id,
			user: body.user?.id,
			thread_ts: body.message?.thread_ts || body.message?.ts,
			text,
		});
	} catch {
		/* the note is best-effort */
	}
}

/**
 * Open the credential modal when the requesting user clicks the button.
 *
 * @param {Object} params - Bolt action handler params
 */
export const credentialsOpenCallback = async ({ ack, body, client, logger }) => {
	await ack();

	const found = _lookupInteraction(body.actions?.[0]?.value, "credentials", client, body, logger);
	if (!found) return;
	const { id: interactionId, interaction } = found;

	if (body.user?.id !== interaction.requesterUserId) {
		await _ephemeral(
			client,
			body,
			`Only <@${interaction.requesterUserId}> can provide these credentials.`
		);
		return;
	}

	const { purpose, fields, agentLabel } = interaction.data;
	try {
		await client.views.open({
			trigger_id: body.trigger_id,
			view: {
				type: "modal",
				callback_id: CREDENTIALS_MODAL_CALLBACK_ID,
				private_metadata: encodeInteractionValue(interactionId),
				title: { type: "plain_text", text: "MetricsHub credentials" },
				submit: { type: "plain_text", text: "Encrypt & send" },
				close: { type: "plain_text", text: "Cancel" },
				blocks: [
					{
						type: "context",
						elements: [
							{
								type: "mrkdwn",
								text: `${purpose}\nSecret values are encrypted with the \`${agentLabel}\` keystore. The AI never sees them. Note: Slack does not mask input while you type.`,
							},
						],
					},
					...fields.map((field) => ({
						type: "input",
						block_id: `field_${field.name}`,
						label: {
							type: "plain_text",
							text: field.secret ? `${field.label} 🔒` : field.label,
						},
						element: { type: "plain_text_input", action_id: "value" },
					})),
				],
			},
		});
	} catch (e) {
		logger?.error?.("Failed to open the credentials modal", { error: String(e) });
		await _ephemeral(client, body, "Could not open the credentials dialog. Try again.");
	}
};

/**
 * Resolve a pending configuration-change approval from its buttons.
 *
 * @param {Object} params - Bolt action handler params
 */
export const configDecisionCallback = async ({ ack, body, action, client, logger }) => {
	await ack();

	const approved = action?.action_id === ACTION_IDS.configApprove;
	const found = _lookupInteraction(action?.value, "config-approval", client, body, logger);
	if (!found) return;
	const { id: interactionId, interaction } = found;

	if (body.user?.id !== interaction.requesterUserId) {
		await _ephemeral(
			client,
			body,
			`Only <@${interaction.requesterUserId}> can decide on this change.`
		);
		return;
	}

	if (!completePendingInteraction(interactionId, { approved, userId: body.user.id })) {
		await _ephemeral(client, body, "This approval request has expired.");
		return;
	}

	// Replace the buttons with the decision so the message cannot be re-used
	try {
		const originalBlocks = Array.isArray(body.message?.blocks) ? body.message.blocks : [];
		const keptBlocks = originalBlocks.filter((block) => block.type !== "actions");
		const decision = approved
			? `:white_check_mark: Approved by <@${body.user.id}>`
			: `:x: Rejected by <@${body.user.id}> — the file was NOT changed`;
		await client.chat.update({
			channel: body.channel.id,
			ts: body.message.ts,
			text: decision,
			blocks: [...keptBlocks, { type: "context", elements: [{ type: "mrkdwn", text: decision }] }],
		});
	} catch (e) {
		logger?.debug?.("Failed to update the approval message", { error: String(e) });
	}
};
