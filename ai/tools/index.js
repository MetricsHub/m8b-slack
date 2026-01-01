/**
 * Tool definitions for OpenAI function calling.
 */

import { getMcpServerCount, getOpenAiFunctionTools } from "../mcp_registry.js";
import { getPromQLTool } from "../prometheus.js";

/**
 * Slack tool definitions.
 */
export const SLACK_TOOLS = [
	{
		type: "function",
		name: "slack_add_reaction",
		description: "Add a Slack reaction to the user's last message.",
		parameters: {
			type: "object",
			properties: {
				emoji: {
					type: "string",
					description: "Slack emoji shortcode (no colons).",
				},
			},
			required: ["emoji"],
			additionalProperties: false,
		},
	},
	{
		type: "function",
		name: "slack_add_reply",
		description: "Add a Slack reply message in the current thread.",
		parameters: {
			type: "object",
			properties: {
				text: {
					type: "string",
					description: "The text (in Slack mrkdwn format) of the reply message.",
				},
			},
			required: ["text"],
			additionalProperties: false,
		},
	},
];

/**
 * Knowledge/Vector Store tool definition.
 */
export const KNOWLEDGE_TOOL = {
	type: "function",
	name: "update_knowledge",
	description:
		"Update or add knowledge to the Vector Store which stores all past learnings, solutions, and troubleshooting knowledge. Use this tool when you discover something new that would be valuable for future reference, such as: how to fix a problem, the root cause of an issue, how to accomplish a specific task, or any insight that could save time in similar future situations. The knowledge will be stored and retrievable via file_search in future conversations.",
	parameters: {
		type: "object",
		properties: {
			fileId: {
				type: "string",
				description:
					"Optional. The ID of an existing file in the Vector Store to update (retrieved from a previous file_search). If not provided, a new knowledge file will be created.",
			},
			content: {
				type: "string",
				description:
					"The text content to upload. Should be a clear, well-structured summary including: the problem/question, the solution/answer, and any relevant context or steps taken. Use markdown formatting for readability.",
			},
			title: {
				type: "string",
				description:
					'A short descriptive title for the knowledge entry (used as filename). Example: "Fix for Docker container memory leak" or "How to configure Prometheus alerting rules".',
			},
		},
		required: ["content", "title"],
		additionalProperties: false,
	},
};

/**
 * Build the complete tools array for OpenAI.
 *
 * @param {Object} options - Tool configuration options
 * @param {Array<string>} options.vectorStoreIds - Vector store IDs for file search
 * @param {Set<string>} options.codeFileIds - File IDs for code interpreter
 * @returns {Array} Array of tool definitions
 */
export function buildToolsArray({ vectorStoreIds = [], codeFileIds = new Set() }) {
	const tools = [];

	// File search tool (if vector stores configured)
	if (vectorStoreIds.length > 0) {
		tools.push({
			type: "file_search",
			vector_store_ids: vectorStoreIds,
			max_num_results: 10,
		});
	}

	// MCP function tools
	tools.push(...getOpenAiFunctionTools());

	// Prometheus PromQL tool (if configured)
	const promqlTool = getPromQLTool();
	if (promqlTool) {
		tools.push(promqlTool);
	}

	// Code interpreter
	tools.push({
		type: "code_interpreter",
		container: { type: "auto", file_ids: Array.from(codeFileIds) },
	});

	// Web search
	tools.push({ type: "web_search_preview" });

	// Slack tools
	tools.push(...SLACK_TOOLS);

	// Knowledge tool (only if vector stores configured)
	if (vectorStoreIds.length > 0) {
		tools.push(KNOWLEDGE_TOOL);
	}

	return tools;
}

/**
 * Check and log tool configuration warnings.
 *
 * @param {Object} options - Configuration options
 * @param {Array<string>} options.vectorStoreIds - Vector store IDs
 * @param {Function} options.say - Say function for Slack messages
 * @param {Object} options.logger - Logger instance
 */
export async function logToolWarnings({ vectorStoreIds, say, logger }) {
	// Check MCP server configuration
	if (getMcpServerCount() === 0) {
		logger?.warn?.(
			"No MetricsHub MCP servers configured. Running without MetricsHub capabilities."
		);
		try {
			await say({
				text: ":warning: No MetricsHub MCP servers configured. Create ai/mcp.config.local.js or set MCP_AGENT_URL and MCP_AGENT_TOKEN. Running without MetricsHub capabilities.",
			});
		} catch (e) {
			logger?.warn?.("Failed to post Slack warning about missing MetricsHub MCP config", {
				e: String(e),
			});
		}
	}

	// Check vector store configuration
	if (vectorStoreIds.length === 0) {
		logger?.warn?.(
			"No OpenAI vector stores configured. File Search tool disabled. Set OPENAI_VECTOR_STORE_IDS or OPENAI_VECTOR_STORE_ID."
		);
	}
}
