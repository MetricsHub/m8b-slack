/**
 * Tool definitions for OpenAI function calling.
 */

import { getMcpServerCount, getOpenAiFunctionTools } from "../mcp_registry.js";
import { getPromQLTool } from "../prometheus.js";
import { getFetchUrlTool, isFetchUrlEnabled } from "../services/fetch-url.js";
import { SEARCH_KNOWLEDGE_TOOL } from "../services/knowledge-base.js";
import { getWebSearchTool } from "../services/web-search.js";
import { getMetricsHubConfigTools } from "./metricshub-config.js";

const MAX_NAMESPACE_TOOLS = 9;
const IMMEDIATE_MCP_TOOLS = new Set(["ListHosts", "SearchHost"]);

/**
 * Group function tools into small namespaces for hosted tool search.
 * Deferred definitions stay out of the initial model context until they are relevant.
 *
 * @param {Object} options - Namespace options
 * @param {string} options.name - Namespace base name
 * @param {string} options.description - High-level namespace description
 * @param {Array} options.functionTools - Function tools to group
 * @param {Set<string>} [options.immediateToolNames] - Tools available without a search
 * @returns {Array} Namespace tool definitions
 */
export function buildFunctionNamespaces({
	name,
	description,
	functionTools,
	immediateToolNames = new Set(),
}) {
	const namespaces = [];

	for (let offset = 0; offset < functionTools.length; offset += MAX_NAMESPACE_TOOLS) {
		const chunk = functionTools.slice(offset, offset + MAX_NAMESPACE_TOOLS);
		const chunkIndex = namespaces.length + 1;
		const chunkCount = Math.ceil(functionTools.length / MAX_NAMESPACE_TOOLS);
		const namespaceName = chunkCount === 1 ? name : `${name}_${chunkIndex}`;
		const capabilityNames = chunk.map((tool) => tool.name).join(", ");

		namespaces.push({
			type: "namespace",
			name: namespaceName,
			description: `${description} Capabilities: ${capabilityNames}.`,
			tools: chunk.map((tool) => ({
				...tool,
				defer_loading: !immediateToolNames.has(tool.name),
			})),
		});
	}

	return namespaces;
}

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
];

/**
 * Knowledge/Vector Store tool definition.
 */
export const KNOWLEDGE_TOOL = {
	type: "function",
	name: "update_knowledge",
	description:
		"Update or add knowledge to the Vector Store which stores all past learnings, solutions, and troubleshooting knowledge. Use this tool when you discover something new that would be valuable for future reference, such as: how to fix a problem, the root cause of an issue, how to accomplish a specific task, or any insight that could save time in similar future situations. The knowledge will be stored and retrievable via file_search in future conversations. To correct or extend an existing entry, pass its fileId so the entry is replaced instead of duplicated.",
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
 * Local Python sandbox tool (app-side replacement for the hosted
 * code_interpreter on providers without one). Executed by
 * ai/services/code-sandbox.js (Pyodide in a worker thread).
 */
export const RUN_PYTHON_TOOL = {
	type: "function",
	name: "run_python",
	description:
		"Execute Python code in a local sandbox (Pyodide/WebAssembly; no network access). Use it for calculations, data analysis, and to create files or charts for the user. numpy, pandas, matplotlib, and openpyxl are available — import them normally. Input data files, when tool results mention them, are in /data/. Save every file the user should receive into the working directory (which is /outputs/), e.g. open('report.csv','w') or plt.savefig('chart.png'); those files are automatically posted to Slack. Each call runs in a fresh interpreter with no variables from previous calls, so include everything (imports, data, logic) in one script. Use print() for any value you need to see.",
	parameters: {
		type: "object",
		properties: {
			code: {
				type: "string",
				description: "The Python source code to execute.",
			},
		},
		required: ["code"],
		additionalProperties: false,
	},
};

/**
 * Build a flat function-only tools array for providers without hosted tools
 * (Ollama). The model sees ordinary function tools; the application executes them.
 *
 * @param {Object} options - Tool configuration options
 * @param {boolean} [options.knowledgeBaseAvailable] - Local knowledge base indexed and usable
 * @param {boolean} [options.knowledgeBaseWritable] - Knowledge can be written (an embedding
 *   backend is configured; the index may still be empty). Defaults to knowledgeBaseAvailable.
 * @param {boolean} [options.codeSandboxAvailable] - Local Python sandbox (run_python) enabled
 * @param {boolean} [options.configEditingAllowed] - Requesting user may edit MetricsHub config
 * @returns {Array} Array of plain function tool definitions
 */
export function buildFunctionToolsArray({
	knowledgeBaseAvailable = false,
	knowledgeBaseWritable = knowledgeBaseAvailable,
	codeSandboxAvailable = false,
	configEditingAllowed = false,
} = {}) {
	const tools = [];

	// MCP function tools, flat (no namespaces, no deferred loading)
	tools.push(...getOpenAiFunctionTools());

	// MetricsHub configuration editing (REST API on the MCP agents). Hidden
	// from unauthorized users entirely: the model should not waste turns on
	// calls our own authorization check would deny anyway.
	if (configEditingAllowed) {
		tools.push(...getMetricsHubConfigTools());
	}

	// Prometheus PromQL tool (if configured)
	const promqlTool = getPromQLTool();
	if (promqlTool) {
		tools.push(promqlTool);
	}

	// Local knowledge base: retrieval (needs an index) + writes (need only an
	// embedding backend; without one the write is guaranteed to fail, so the
	// tool is not offered at all)
	if (knowledgeBaseAvailable) {
		tools.push(SEARCH_KNOWLEDGE_TOOL);
	}
	if (knowledgeBaseWritable) {
		tools.push({
			...KNOWLEDGE_TOOL,
			description: KNOWLEDGE_TOOL.description.replace(
				"retrievable via file_search",
				"retrievable via search_knowledge_base"
			),
			parameters: {
				...KNOWLEDGE_TOOL.parameters,
				properties: {
					...KNOWLEDGE_TOOL.parameters.properties,
					fileId: {
						type: "string",
						description:
							"Optional. The docId of an existing knowledge article to replace (as returned in search_knowledge_base results). If not provided, a new knowledge entry will be created.",
					},
				},
			},
		});
	}

	// Application-side web search (only when a search backend is configured)
	const webSearchTool = getWebSearchTool();
	if (webSearchTool) {
		tools.push(webSearchTool);
	}

	// Application-side page reader (hosted web search reads pages itself;
	// here the model needs an explicit tool). Removed by FETCH_URL_ENABLED=false.
	// An MCP server exporting its own fetch_url wins: the built-in would only
	// shadow it (duplicate names in the tool list, calls intercepted app-side)
	const fetchUrlTool = getFetchUrlTool();
	if (fetchUrlTool && !tools.some((tool) => tool.name === fetchUrlTool.name)) {
		tools.push(fetchUrlTool);
	} else if (!isFetchUrlEnabled()) {
		// The switch removes page reading entirely, an MCP-provided reader
		// included (it may reach internal URLs, and the prompt's fetched-content
		// guidance is off when the flag is off)
		const kept = tools.filter((tool) => tool.name !== "fetch_url");
		tools.length = 0;
		tools.push(...kept);
	}

	// Local Python sandbox (app-side code_interpreter replacement)
	if (codeSandboxAvailable) {
		tools.push(RUN_PYTHON_TOOL);
	}

	// Slack tools
	tools.push(...SLACK_TOOLS);

	return tools;
}

/**
 * Build the complete tools array for the active provider.
 *
 * With hosted-tool providers (OpenAI) this includes file_search, deferred tool
 * namespaces, code_interpreter, and web_search. For function-only providers
 * (Ollama) it delegates to buildFunctionToolsArray.
 *
 * @param {Object} options - Tool configuration options
 * @param {Array<string>} options.vectorStoreIds - Vector store IDs for file search
 * @param {Set<string>} options.codeFileIds - File IDs for code interpreter
 * @param {import("../providers/index.js").AiProvider} [options.provider] - Active AI provider
 * @param {boolean} [options.knowledgeBaseAvailable] - Local knowledge base usable (Ollama mode)
 * @param {boolean} [options.knowledgeBaseWritable] - Local knowledge base accepts writes
 *   (defaults to knowledgeBaseAvailable)
 * @param {boolean} [options.configEditingAllowed] - Requesting user may edit MetricsHub config
 * @returns {Array} Array of tool definitions
 */
export function buildToolsArray({
	vectorStoreIds = [],
	codeFileIds = new Set(),
	provider,
	knowledgeBaseAvailable = false,
	knowledgeBaseWritable = knowledgeBaseAvailable,
	configEditingAllowed = false,
}) {
	if (provider && !provider.capabilities.toolNamespaces) {
		return buildFunctionToolsArray({
			knowledgeBaseAvailable,
			knowledgeBaseWritable,
			codeSandboxAvailable: provider.capabilities.localCodeInterpreter === true,
			configEditingAllowed,
		});
	}

	const tools = [];
	let hasDeferredTools = false;

	// File search tool (if vector stores configured)
	if (vectorStoreIds.length > 0) {
		tools.push({
			type: "file_search",
			vector_store_ids: vectorStoreIds,
			max_num_results: 10,
		});
	}

	// MCP function tools. Keep host discovery immediately callable; defer the larger
	// per-host schemas until GPT-5.6 determines that it needs them.
	const mcpNamespaces = buildFunctionNamespaces({
		name: "metricshub",
		description: "MetricsHub infrastructure discovery, monitoring, and diagnostics.",
		functionTools: getOpenAiFunctionTools(),
		immediateToolNames: IMMEDIATE_MCP_TOOLS,
	});
	tools.push(...mcpNamespaces);
	hasDeferredTools ||= mcpNamespaces.some((namespace) =>
		namespace.tools.some((tool) => tool.defer_loading)
	);

	// MetricsHub configuration editing (used rarely; schemas load on demand).
	// Only exposed when the requesting user is an authorized config admin.
	const configTools = configEditingAllowed ? getMetricsHubConfigTools() : [];
	if (configTools.length > 0) {
		tools.push(
			...buildFunctionNamespaces({
				name: "metricshub_config",
				description:
					"Edit MetricsHub agent configuration files (YAML): add or modify monitored resources, collect credentials securely.",
				functionTools: configTools,
			})
		);
		hasDeferredTools = true;
	}

	// Prometheus PromQL tool (if configured)
	const promqlTool = getPromQLTool();
	if (promqlTool) {
		tools.push(
			...buildFunctionNamespaces({
				name: "prometheus",
				description: "Prometheus metric queries and time-series analysis.",
				functionTools: [promqlTool],
			})
		);
		hasDeferredTools = true;
	}

	// Knowledge updates are useful but infrequent, so load their schema on demand.
	if (vectorStoreIds.length > 0) {
		tools.push(
			...buildFunctionNamespaces({
				name: "knowledge_base",
				description: "Store reusable operational and troubleshooting knowledge.",
				functionTools: [KNOWLEDGE_TOOL],
			})
		);
		hasDeferredTools = true;
	}

	if (hasDeferredTools) {
		tools.push({ type: "tool_search" });
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

	return tools;
}

/**
 * Check and log tool configuration warnings.
 *
 * @param {Object} options - Configuration options
 * @param {Array<string>} options.vectorStoreIds - Vector store IDs
 * @param {import("../providers/index.js").AiProvider} [options.provider] - Active AI provider
 * @param {boolean} [options.knowledgeBaseAvailable] - Local knowledge base usable (Ollama mode)
 * @param {Function} options.say - Say function for Slack messages
 * @param {Object} options.logger - Logger instance
 */
export async function logToolWarnings({
	vectorStoreIds,
	provider,
	knowledgeBaseAvailable,
	say,
	logger,
}) {
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

	// Provider-specific capability warnings
	if (provider && !provider.capabilities.toolNamespaces) {
		if (!knowledgeBaseAvailable) {
			logger?.warn?.(
				"Local knowledge base is empty or not indexed. search_knowledge_base disabled. Run npm run kb:index (or npm run kb:export first)."
			);
		}
		if (!getWebSearchTool()) {
			logger?.info?.(
				"No web-search backend configured (WEB_SEARCH_PROVIDER unset). web_search tool disabled."
			);
		}
		if (!getFetchUrlTool()) {
			logger?.info?.(
				"Page reader disabled (FETCH_URL_ENABLED=false). The bot cannot read URLs pasted by users."
			);
		}
		if (provider.capabilities.localCodeInterpreter) {
			logger?.info?.(
				"Local Python sandbox (run_python via Pyodide) replaces the hosted code_interpreter."
			);
		} else {
			logger?.warn?.(
				"Code execution is disabled (CODE_SANDBOX_ENABLED=false). The bot cannot generate files or run analyses."
			);
		}
		return;
	}

	// Check vector store configuration (OpenAI mode)
	if (vectorStoreIds.length === 0) {
		logger?.warn?.(
			"No OpenAI vector stores configured. File Search tool disabled. Set OPENAI_VECTOR_STORE_IDS or OPENAI_VECTOR_STORE_ID."
		);
	}
}
