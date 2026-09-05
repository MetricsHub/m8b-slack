/**
 * Function tool definitions for MetricsHub configuration editing.
 *
 * These tools talk to the MetricsHub Agent REST API (same origin and API key
 * as the MCP endpoint). Handlers live in ai/services/config-editor.js.
 */

import { getMcpServerCount } from "../mcp_registry.js";

const AGENT_PARAM = {
	type: "string",
	description:
		'MetricsHub agent label (as returned by ListAgents, e.g. "m8b-agent-01"). Optional when a single agent is registered. A configuration edit must target the SAME agent the file was read from, unless the user explicitly asked to move the configuration to another agent.',
};

/**
 * MetricsHub configuration editing tools.
 */
export const METRICSHUB_CONFIG_TOOLS = [
	{
		type: "function",
		name: "get_resource_config",
		description:
			"Return the YAML configuration entry of ONE monitored resource (host) by its resource ID, plus the file and resource group it lives in. PREFERRED starting point for any change to a specific resource — much smaller than reading whole files. Resource IDs are the keys under resources:/resourceGroups.<group>.resources: and usually match the host keys returned by ListHosts/SearchHost (use SearchHost to map a hostname to its resource ID). Fails with a warning if the resource is defined in multiple places.",
		parameters: {
			type: "object",
			properties: {
				agent: AGENT_PARAM,
				resourceId: {
					type: "string",
					description: "The resource ID (YAML key), e.g. srv-web-01.",
				},
			},
			required: ["resourceId"],
			additionalProperties: false,
		},
	},
	{
		type: "function",
		name: "modify_resource_config",
		description:
			"Replace the YAML configuration of ONE monitored resource (or create it if missing). PREFERRED over file-level editing for resource changes: you only write the one entry, everything else in the file stays byte-identical. Read the current entry with get_resource_config first, then pass the COMPLETE updated entry: first line '<resourceId>:' at column 0, body indented beneath. Preserve existing encrypted password values verbatim; use {{CRED:...}} placeholders from request_credentials for NEW secrets. The result is schema-validated by the agent, and the user must approve the diff in Slack before anything is written; changes apply live. To CREATE a new resource, also pass 'file' (and 'resourceGroup' if it belongs in a group). Only authorized users may modify configuration.",
		parameters: {
			type: "object",
			properties: {
				agent: AGENT_PARAM,
				resourceId: {
					type: "string",
					description: "The resource ID (YAML key) to replace or create.",
				},
				resourceYaml: {
					type: "string",
					description:
						"The complete resource entry: first line '<resourceId>:' at column 0, everything else indented beneath it. Do NOT include the surrounding resources:/resourceGroups: sections.",
				},
				changeSummary: {
					type: "string",
					description:
						"One-sentence summary of the change, shown to the user in the approval message.",
				},
				file: {
					type: "string",
					description:
						"Only when CREATING a resource: the configuration file to add it to (from list_config_files).",
				},
				resourceGroup: {
					type: "string",
					description:
						"Only when CREATING a resource: the resource group to add it under. Omit for a top-level resource.",
				},
			},
			required: ["resourceId", "resourceYaml", "changeSummary"],
			additionalProperties: false,
		},
	},
	{
		type: "function",
		name: "delete_resource_config",
		description:
			"Remove ONE monitored resource (host) entry from the MetricsHub configuration. The user must approve the diff in Slack before anything is written; a backup is taken and the change applies live. Fails with a warning if the resource is defined in multiple places. Only authorized users may delete configuration.",
		parameters: {
			type: "object",
			properties: {
				agent: AGENT_PARAM,
				resourceId: {
					type: "string",
					description: "The resource ID (YAML key) to delete.",
				},
				changeSummary: {
					type: "string",
					description: "Optional one-sentence summary shown in the approval message.",
				},
			},
			required: ["resourceId"],
			additionalProperties: false,
		},
	},
	{
		type: "function",
		name: "list_config_files",
		description:
			"List the MetricsHub configuration files (YAML) of an agent, with size and last modification time. Configuration files define which resources (hosts) are monitored and how.",
		parameters: {
			type: "object",
			properties: { agent: AGENT_PARAM },
			additionalProperties: false,
		},
	},
	{
		type: "function",
		name: "get_config_file",
		description:
			"Read the content of a MetricsHub configuration file (YAML). ALWAYS read the current file before modifying it. Existing encrypted password values (long ciphertext strings) must be preserved verbatim when editing — do NOT re-request credentials that are already configured.",
		parameters: {
			type: "object",
			properties: {
				agent: AGENT_PARAM,
				fileName: {
					type: "string",
					description: "Configuration file name, e.g. metricshub.yaml (no path).",
				},
			},
			required: ["fileName"],
			additionalProperties: false,
		},
	},
	{
		type: "function",
		name: "request_credentials",
		description:
			"Ask the user to securely provide credentials (e.g. for a new snmp/wmi/ssh/http protocol configuration) through a Slack dialog. The values are encrypted with the target agent's keystore; you NEVER see the plaintext. Secret fields come back as opaque {{CRED:...}} placeholders — put them verbatim in the YAML where the password goes; they are replaced by the real ciphertext when the file is saved on the same agent. Only use this for NEW credentials: when editing an existing resource, keep its already-encrypted password values unchanged. Only authorized users can be asked for credentials.",
		parameters: {
			type: "object",
			properties: {
				agent: AGENT_PARAM,
				purpose: {
					type: "string",
					description:
						'Short human-readable reason shown to the user, e.g. "WMI credentials for host hou-win-01".',
				},
				fields: {
					type: "array",
					description:
						'Fields to collect. Default: ["username", "password"]. For SNMP v1/v2c use ["community"]. Secret-looking names (password, community, token, ...) are encrypted; others (username) are returned as plain text.',
					items: {
						type: "object",
						properties: {
							name: {
								type: "string",
								description: "Field name, e.g. username, password, community.",
							},
							label: { type: "string", description: "Optional label shown in the Slack dialog." },
							secret: {
								type: "boolean",
								description:
									"Force whether the value must be encrypted (auto-detected from the name by default).",
							},
						},
						required: ["name"],
						additionalProperties: false,
					},
				},
			},
			required: ["purpose"],
			additionalProperties: false,
		},
	},
	{
		type: "function",
		name: "save_config_file",
		description:
			"Save a MetricsHub configuration file (create or update). The result is validated by the agent, the current file is backed up, and the requesting user must approve the change via buttons in Slack before anything is written. Changes are applied live by MetricsHub — no restart needed. To MODIFY an existing file, ALWAYS use the edits parameter (small find/replace operations); NEVER retype the whole file — it will not fit in your output budget and any typo corrupts the config. Use content only to CREATE a new file. {{CRED:...}} placeholders from request_credentials are substituted with the encrypted secret at save time. Only authorized users may save configuration changes.",
		parameters: {
			type: "object",
			properties: {
				agent: AGENT_PARAM,
				fileName: {
					type: "string",
					description: "Configuration file name, e.g. metricshub.yaml (no path).",
				},
				edits: {
					type: "array",
					description:
						"Find/replace operations applied in order to the CURRENT file content (for modifying an existing file). Each find must be copied EXACTLY from get_config_file (including whitespace and indentation) and must match exactly once — include enough surrounding lines to make it unique. Keep edits small: only the region that changes.",
					items: {
						type: "object",
						properties: {
							find: {
								type: "string",
								description: "Exact text to replace, copied verbatim from the current file.",
							},
							replace: {
								type: "string",
								description: "Replacement text (may contain {{CRED:...}} placeholders).",
							},
						},
						required: ["find", "replace"],
						additionalProperties: false,
					},
				},
				content: {
					type: "string",
					description:
						"Complete file content (YAML) — ONLY for creating a new file. Do not use for existing files; use edits instead.",
				},
				changeSummary: {
					type: "string",
					description:
						"One-sentence summary of the change, shown to the user in the approval message.",
				},
			},
			required: ["fileName", "changeSummary"],
			additionalProperties: false,
		},
	},
];

/**
 * Return the config-editing tools, or an empty array when no MetricsHub agent
 * is registered (the REST API rides on the MCP agent connection settings).
 *
 * @returns {Array} Function tool definitions
 */
export function getMetricsHubConfigTools() {
	return getMcpServerCount() > 0 ? METRICSHUB_CONFIG_TOOLS : [];
}
