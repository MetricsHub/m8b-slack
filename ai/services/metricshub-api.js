/**
 * REST API client for MetricsHub Agents.
 *
 * Each MetricsHub agent exposes a REST API on the same origin as its MCP
 * endpoint, authenticated with the same API key (Bearer token). This module
 * covers the configuration-file endpoints (/api/config-files/*) and password
 * encryption (/api/security/encrypt-password) used by the config-editing tools.
 */

import { getMcpServers } from "../mcp_registry.js";

/**
 * Test hook: replaces the server source (defaults to the MCP registry).
 * @type {null | (() => Array<Object>)}
 */
let serverSourceOverride = null;

/**
 * Override where agent connection settings come from (tests only).
 *
 * @param {null | (() => Array<Object>)} fn - Returns registry-shaped server entries, or null to reset
 */
export function _setServerSourceForTests(fn) {
	serverSourceOverride = fn;
}

function _getServers() {
	return serverSourceOverride ? serverSourceOverride() : getMcpServers();
}

/**
 * Derive the REST API base URL (origin) from an agent's MCP server URL.
 * The MCP endpoint (e.g. https://host:31888/sse) and the REST API
 * (e.g. https://host:31888/api/...) share the same origin.
 *
 * @param {Object} server - Registry server entry
 * @returns {string} Origin such as "https://host:31888"
 */
export function getRestBaseUrl(server) {
	return new URL(server.server_url).origin;
}

/**
 * Resolve a MetricsHub agent by label. With a single registered agent the
 * label may be omitted; with several it is required.
 *
 * @param {string} [label] - Agent label (e.g. "m8b-agent-01")
 * @returns {{ok: boolean, server?: Object, error?: string}}
 */
export function resolveAgentServer(label) {
	const servers = _getServers();
	if (servers.length === 0) {
		return { ok: false, error: "No MetricsHub agents are registered" };
	}

	const wanted = typeof label === "string" ? label.trim() : "";
	if (!wanted) {
		if (servers.length === 1) return { ok: true, server: servers[0] };
		return {
			ok: false,
			error: `Several MetricsHub agents are registered; specify the agent label. Available: ${servers
				.map((s) => s.server_label)
				.join(", ")}`,
		};
	}

	const server = servers.find((s) => s.server_label === wanted);
	if (!server) {
		return {
			ok: false,
			error: `Unknown MetricsHub agent "${wanted}". Available: ${servers
				.map((s) => s.server_label)
				.join(", ")}`,
		};
	}
	return { ok: true, server };
}

/**
 * Perform an authenticated request against a MetricsHub agent's REST API.
 *
 * @param {Object} server - Registry server entry ({server_url, token, allowSelfSignedCert})
 * @param {string} apiPath - Path starting with /api/ or /auth
 * @param {Object} [options]
 * @param {string} [options.method] - HTTP method (default GET)
 * @param {string|Object} [options.body] - Request body: objects are sent as JSON, strings as text/plain
 * @param {Object} [options.logger] - Logger instance
 * @returns {Promise<{ok: boolean, status?: number, data?: any, error?: string}>}
 */
export async function metricsHubApiRequest(server, apiPath, { method = "GET", body, logger } = {}) {
	const url = `${getRestBaseUrl(server)}${apiPath}`;

	const headers = { Authorization: `Bearer ${server.token}` };
	let payload;
	if (body !== undefined) {
		if (typeof body === "string") {
			headers["Content-Type"] = "text/plain; charset=utf-8";
			payload = body;
		} else {
			headers["Content-Type"] = "application/json";
			payload = JSON.stringify(body);
		}
	}

	const fetchOptions = { method, headers, body: payload };
	if (server.allowSelfSignedCert && url.startsWith("https:")) {
		fetchOptions.dispatcher = new (await import("undici")).Agent({
			connect: { rejectUnauthorized: false },
		});
	}

	let response;
	try {
		response = await fetch(url, fetchOptions);
	} catch (e) {
		logger?.error?.(`[MetricsHub API] ${method} ${url} failed`, { error: String(e) });
		return { ok: false, error: `Cannot reach MetricsHub agent: ${e?.message || e}` };
	}

	const contentType = response.headers.get("content-type") || "";
	let data;
	try {
		data = contentType.includes("application/json") ? await response.json() : await response.text();
	} catch {
		data = undefined;
	}

	if (!response.ok) {
		const detail =
			typeof data === "string"
				? data.slice(0, 500)
				: data
					? JSON.stringify(data).slice(0, 500)
					: "";
		logger?.warn?.(`[MetricsHub API] ${method} ${url} → HTTP ${response.status}`, { detail });
		return {
			ok: false,
			status: response.status,
			data,
			error: `HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
		};
	}

	return { ok: true, status: response.status, data };
}

/**
 * List the configuration files of an agent.
 *
 * @param {Object} server - Registry server entry
 * @param {Object} [logger] - Logger instance
 */
export async function listConfigFiles(server, logger) {
	return metricsHubApiRequest(server, "/api/config-files", { logger });
}

/**
 * Get the content of one configuration file (plain text).
 *
 * @param {Object} server - Registry server entry
 * @param {string} fileName - Configuration file name
 * @param {Object} [logger] - Logger instance
 */
export async function getConfigFileContent(server, fileName, logger) {
	return metricsHubApiRequest(server, `/api/config-files/${encodeURIComponent(fileName)}`, {
		logger,
	});
}

/**
 * Validate configuration file content without saving it.
 *
 * @param {Object} server - Registry server entry
 * @param {string} fileName - Configuration file name
 * @param {string} content - Candidate content
 * @param {Object} [logger] - Logger instance
 * @returns {Promise<{ok: boolean, status?: number, data?: {fileName: string, valid: boolean, errors: Array}, error?: string}>}
 */
export async function validateConfigFile(server, fileName, content, logger) {
	return metricsHubApiRequest(server, `/api/config-files/${encodeURIComponent(fileName)}`, {
		method: "POST",
		body: String(content),
		logger,
	});
}

/**
 * Save (create or update) a configuration file. The agent picks the change up
 * live — no restart needed.
 *
 * @param {Object} server - Registry server entry
 * @param {string} fileName - Configuration file name
 * @param {string} content - New content
 * @param {Object} [logger] - Logger instance
 */
export async function saveConfigFile(server, fileName, content, logger) {
	return metricsHubApiRequest(server, `/api/config-files/${encodeURIComponent(fileName)}`, {
		method: "PUT",
		body: String(content),
		logger,
	});
}

/**
 * Save a backup copy of a configuration file (before overwriting it).
 *
 * @param {Object} server - Registry server entry
 * @param {string} fileName - Backup file name
 * @param {string} content - Content to back up
 * @param {Object} [logger] - Logger instance
 */
export async function saveBackupFile(server, fileName, content, logger) {
	return metricsHubApiRequest(server, `/api/config-files/backup/${encodeURIComponent(fileName)}`, {
		method: "PUT",
		body: String(content),
		logger,
	});
}

/**
 * Encrypt a password with the agent's keystore. The ciphertext is what goes
 * into YAML configuration files; it is only decryptable by this agent.
 *
 * @param {Object} server - Registry server entry
 * @param {string} password - Plaintext password (never logged, never stored)
 * @param {Object} [logger] - Logger instance
 * @returns {Promise<{ok: boolean, encryptedPassword?: string, error?: string}>}
 */
export async function encryptPassword(server, password, logger) {
	const passwordBase64 = Buffer.from(String(password), "utf8").toString("base64");
	const result = await metricsHubApiRequest(server, "/api/security/encrypt-password", {
		method: "POST",
		body: { passwordBase64 },
		logger,
	});
	if (!result.ok) {
		return { ok: false, error: result.error || "Password encryption failed" };
	}
	const encryptedPassword = result.data?.encryptedPassword;
	if (!encryptedPassword) {
		return { ok: false, error: "Agent returned no encryptedPassword" };
	}
	return { ok: true, encryptedPassword };
}
