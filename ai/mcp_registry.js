import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

// In-memory registry state
const state = {
	servers: [], // [{ server_label, server_url, token, tools: Map(name -> toolDef), client: Client, transport: SSEClientTransport }]
	hosts: new Map(), // key -> { key, server_label, server_url, attributes, protocols }
};

function _log(logger, level, msg, meta) {
	try {
		logger?.[level]?.(msg, meta);
	} catch {}
}

// Create a new SSE transport for a server
function _createTransport(server) {
	return new SSEClientTransport(new URL(server.server_url), {
		eventSourceInit: {
			fetch: (url, init) => {
				return fetch(url, {
					...init,
					headers: {
						...init?.headers,
						Authorization: `Bearer ${server.token}`,
					},
				});
			},
		},
		requestInit: {
			headers: {
				Authorization: `Bearer ${server.token}`,
			},
		},
	});
}

// Ensure a server has a connected client, reconnecting if needed
async function _ensureConnected(server) {
	// If we have a client, try a ping to check if it's still alive
	if (server.client) {
		try {
			await server.client.ping({ timeout: 5000 });
			return true; // Connection is alive
		} catch (e) {
			console.log(
				`[MCP] Connection to ${server.server_label} appears dead (${e.message || e}), reconnecting...`
			);
			try {
				await server.client.close();
			} catch {}
			server.client = null;
		}
	}

	// Need to reconnect
	try {
		console.log(`[MCP] Connecting to ${server.server_label}...`);
		const transport = _createTransport(server);
		const client = new Client(
			{ name: "m8b-slackbot", version: "1.0.0" },
			{ capabilities: { tools: {} } }
		);
		await client.connect(transport);
		server.client = client;
		console.log(`[MCP] Connected to ${server.server_label}`);
		return true;
	} catch (e) {
		console.error(`[MCP] Failed to connect to ${server.server_label}:`, e);
		return false;
	}
}

function _indexHostsFromList(server, hostsData) {
	// hostsData is expected to be an object keyed by a host identifier, with attributes/protocols
	try {
		const data = hostsData && typeof hostsData === "object" ? hostsData : {};
		let indexedCount = 0;
		for (const [key, val] of Object.entries(data)) {
			if (key === "content" || key === "isError") continue; // Skip protocol fields
			const entry = {
				key,
				server_label: server.server_label,
				server_url: server.server_url,
				attributes: val?.attributes || {},
				protocols: Array.isArray(val?.protocols) ? val.protocols : [],
			};
			state.hosts.set(key, entry);
			const hostName = entry.attributes?.["host.name"];
			if (hostName && hostName !== key) state.hosts.set(hostName, entry);
			for (const p of entry.protocols) {
				if (p?.hostname && p.hostname !== key) state.hosts.set(p.hostname, entry);
			}
			indexedCount++;
		}
		console.log(
			`[MCP] Indexed ${indexedCount} hosts from ${server.server_label}. Total host keys: ${state.hosts.size}`
		);
	} catch (e) {
		console.error(`[MCP] Error indexing hosts from ${server.server_label}:`, e);
	}
}

function _parseToolResult(result) {
	// MCP tool results have content: [{ type: 'text', text: '...' }, ...]
	// Try to parse JSON from text content
	if (result?.content && Array.isArray(result.content)) {
		for (const item of result.content) {
			if (item.type === "text") {
				try {
					return JSON.parse(item.text);
				} catch {
					return item.text;
				}
			}
		}
	}
	return result;
}

export async function initializeMcpRegistry(logger) {
	_log(logger, "info", "Initializing MCP registry...");
	state.servers = [];
	state.hosts.clear();

	// Load config file
	try {
		const localCfgPath = path.resolve(process.cwd(), "ai", "mcp.config.local.js");
		if (fs.existsSync(localCfgPath)) {
			_log(logger, "info", "Loading local MCP config", { path: localCfgPath });
			const mod = await import(pathToFileURL(localCfgPath).href);
			const arr = (mod && (mod.default || mod.servers)) || [];
			if (Array.isArray(arr)) {
				for (const s of arr) {
					const server_url = s.server_url || s.url;
					const server_label = s.server_label || s.label;
					const token = s.token || s.apiKey || s.key;
					if (server_url && server_label && token) {
						state.servers.push({ server_url, server_label, token, tools: new Map(), client: null });
					}
				}
			}
		}
	} catch (e) {
		_log(logger, "warn", "Failed to load ai/mcp.config.local.js", { e: String(e) });
	}

	// Fallback to env single server
	if (state.servers.length === 0) {
		const url = process.env.MCP_AGENT_URL;
		const token = process.env.MCP_AGENT_TOKEN;
		if (url && token) {
			_log(logger, "info", "Using env MCP config", { url });
			state.servers.push({
				server_url: url,
				server_label: "m8b-agent-01",
				token,
				tools: new Map(),
				client: null,
			});
		}
	}

	_log(logger, "info", "Discovered MCP servers", { count: state.servers.length });

	// Discover tools and hosts per server using the MCP SDK directly
	for (const server of state.servers) {
		try {
			_log(logger, "info", "Connecting to server", { label: server.server_label });

			// Connect using the helper function
			const connected = await _ensureConnected(server);
			if (!connected) {
				_log(logger, "warn", "Failed to connect to server", { label: server.server_label });
				continue;
			}

			// Get all tools
			const toolsResult = await server.client.listTools();
			const tools = toolsResult.tools || [];
			_log(logger, "info", "Tools discovered", {
				server: server.server_label,
				count: tools.length,
			});

			for (const t of tools) {
				if (!t?.name) continue;
				server.tools.set(t.name, t);
			}

			// Try to load hosts via ListHosts if present
			if (server.tools.has("ListHosts")) {
				try {
					const res = await server.client.callTool(
						{ name: "ListHosts", arguments: {} },
						undefined,
						{ timeout: 60000 }
					);
					const hostsData = _parseToolResult(res);
					_indexHostsFromList(server, hostsData);
				} catch (e) {
					_log(logger, "warn", "ListHosts call failed", {
						server: server.server_label,
						e: String(e),
					});
				}
			}
		} catch (e) {
			_log(logger, "warn", "Tool discovery failed", { server: server.server_label, e: String(e) });
		}
	}

	_log(logger, "info", "MCP registry initialized");
}

export function getMcpServerCount() {
	return state.servers.length;
}

export function getAggregatedHosts() {
	const out = {};
	for (const [key, entry] of state.hosts.entries()) {
		out[key] = {
			server_label: entry.server_label,
			server_url: entry.server_url,
			attributes: entry.attributes,
			protocols: entry.protocols,
		};
	}
	return out;
}

export function getOpenAiFunctionTools() {
	const tools = [];

	// Consolidated ListHosts
	tools.push({
		type: "function",
		name: "ListHosts",
		description:
			"Return the consolidated list of all known hosts across all MetricsHub agents/servers (on-prem).",
		parameters: { type: "object", properties: {}, additionalProperties: false },
	});

	// SearchHost
	tools.push({
		type: "function",
		name: "SearchHost",
		description:
			"Search hosts by regex (case-insensitive) across consolidated host keys and attributes.host.name.",
		parameters: {
			type: "object",
			properties: {
				pattern: {
					type: "string",
					description: "Regular expression to match host keys or host names (case-insensitive).",
				},
			},
			required: ["pattern"],
			additionalProperties: false,
		},
	});

	// Other tools discovered per server (excluding ListHosts)
	const seen = new Set();
	for (const server of state.servers) {
		for (const [name, def] of server.tools.entries()) {
			if (name === "ListHosts") continue;
			if (seen.has(name)) continue;
			seen.add(name);

			const schema = def?.inputSchema || { type: "object", properties: {} };
			const params = { type: "object", properties: {}, additionalProperties: false };

			if (schema && typeof schema === "object" && schema.type === "object" && schema.properties) {
				params.properties = { ...schema.properties };
				if (Array.isArray(schema.required)) params.required = [...schema.required];
				params.additionalProperties = false;
			}

			// Ensure hosts param exists
			params.properties.hosts = {
				type: "array",
				items: { type: "string" },
				description:
					"One or more host identifiers to target. Use ListHosts/SearchHost first to discover hosts.",
			};
			if (!Array.isArray(params.required)) params.required = [];
			if (!params.required.includes("hosts")) params.required.push("hosts");

			tools.push({
				type: "function",
				name,
				description:
					def?.description || `Execute ${name} on one or more hosts via MetricsHub MCP (proxied).`,
				parameters: params,
			});
		}
	}

	return tools;
}

function _bucketHostsByServer(hosts) {
	const buckets = new Map(); // server_label -> { server, hosts: [] }
	for (const h of hosts || []) {
		const entry = state.hosts.get(h);
		if (!entry) continue;
		const srv = state.servers.find((s) => s.server_label === entry.server_label);
		if (!srv) continue;
		if (!buckets.has(srv.server_label)) buckets.set(srv.server_label, { server: srv, hosts: [] });
		buckets.get(srv.server_label).hosts.push(entry.key);
	}
	return buckets;
}

export async function executeMcpFunctionCall(name, args, _logger) {
	console.log(`[MCP] executeMcpFunctionCall called: ${name}`, JSON.stringify(args));

	// Special local functions
	if (name === "ListHosts") {
		return { ok: true, hosts: getAggregatedHosts() };
	}

	if (name === "SearchHost") {
		try {
			const pattern = String(args?.pattern || "").trim();
			const rx = new RegExp(pattern, "i");
			const out = {};
			for (const [key, entry] of state.hosts.entries()) {
				const hn = entry.attributes?.["host.name"];
				if (rx.test(key) || (hn && rx.test(hn))) {
					out[key] = {
						server_label: entry.server_label,
						attributes: entry.attributes,
						protocols: entry.protocols,
					};
				}
			}
			return { ok: true, hosts: out };
		} catch (e) {
			return { ok: false, error: `Invalid regex: ${String(e)}` };
		}
	}

	// Other tools: partition by server and invoke
	const hosts = Array.isArray(args?.hosts) ? args.hosts : args?.host ? [args.host] : [];
	console.log(`[MCP] Tool ${name} targeting hosts:`, hosts);

	const buckets = _bucketHostsByServer(hosts);
	console.log(`[MCP] Bucketed into ${buckets.size} server(s):`, [...buckets.keys()]);

	// If no hosts matched any server, return an error
	if (buckets.size === 0) {
		const knownHosts = [...state.hosts.keys()].slice(0, 10).join(", ");
		return {
			ok: false,
			error: `No matching hosts found in registry. Requested: [${hosts.join(", ")}]. Known hosts (sample): ${knownHosts}...`,
		};
	}

	const results = [];

	for (const [, { server, hosts: hs }] of buckets) {
		// Ensure connection is alive, reconnect if needed
		const connected = await _ensureConnected(server);
		if (!connected) {
			results.push({
				server_label: server.server_label,
				ok: false,
				error: "Failed to connect to MCP server",
			});
			continue;
		}

		// Build args for this server, including the hosts for this server
		const callArgs = { ...args, hosts: hs };

		try {
			// Use a longer timeout (120 seconds) for tool calls as some operations can be slow
			console.log(
				`[MCP] Calling tool '${name}' on ${server.server_label} with args:`,
				JSON.stringify(callArgs)
			);
			const startTime = Date.now();
			const res = await server.client.callTool({ name, arguments: callArgs }, undefined, {
				timeout: 120000,
			});
			console.log(
				`[MCP] Tool '${name}' on ${server.server_label} completed in ${Date.now() - startTime}ms`
			);
			const parsed = _parseToolResult(res);
			results.push({ server_label: server.server_label, ok: true, result: parsed });
		} catch (e) {
			console.error(`[MCP] Tool '${name}' on ${server.server_label} failed:`, e);
			results.push({ server_label: server.server_label, ok: false, error: String(e) });
		}
	}

	return { ok: true, results };
}
