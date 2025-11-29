import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// In-memory registry state
const state = {
  servers: [], // [{ server_label, server_url, token, tools: Map(name -> toolDef) }]
  hosts: new Map(), // key -> { key, server_label, server_url, attributes, protocols }
};

function _log(logger, level, msg, meta) {
  try { logger?.[level]?.(msg, meta); } catch {}
}

function _baseUrlFromSse(url) {
  // If config points to /sse, derive a base URL for HTTP RPC
  try {
    if (!url) return url;
    return url.replace(/\/?sse$/i, '');
  } catch { return url; }
}

// Simple SSE + JSON-RPC client for MCP servers
class SseRpcClient {
  constructor({ url, token, logger }) {
    this.url = url;
    this.token = token;
    this.logger = logger;
    this.controller = null;
    this.connected = false;
    this.buffer = '';
    this.pending = new Map(); // id -> { resolve, reject }
    this.idCounter = 1;
  }

  async connect() {
    if (this.connected) return;
    this.controller = new AbortController();
    const headers = { Accept: 'text/event-stream' };
    if (this.token) headers['Authorization'] = `Bearer ${this.token}`;
    const res = await fetch(this.url, { method: 'GET', headers, signal: this.controller.signal });
    if (!res.ok || !res.body) throw new Error(`SSE connect failed (${res.status})`);
    this.connected = true;
    (async () => {
      try {
        const reader = res.body.getReader();
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          this._onChunk(value);
        }
      } catch (e) {
        _log(this.logger, 'warn', 'SSE read error', { e: String(e) });
      } finally {
        this.connected = false;
      }
    })();
  }

  _onChunk(uint8) {
    try {
      this.buffer += Buffer.from(uint8).toString('utf8');
      let idx;
      // SSE events are separated by \n\n
      while ((idx = this.buffer.indexOf('\n\n')) !== -1) {
        const rawEvt = this.buffer.slice(0, idx);
        this.buffer = this.buffer.slice(idx + 2);
        const lines = rawEvt.split(/\r?\n/);
        let dataLines = [];
        for (const line of lines) {
          if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
        }
        if (dataLines.length) {
          const payload = dataLines.join('\n');
          this._handleEventData(payload);
        }
      }
    } catch (e) {
      _log(this.logger, 'warn', 'SSE parse error', { e: String(e) });
    }
  }

  _handleEventData(str) {
    try {
      const msg = JSON.parse(str);
      // Expect JSON-RPC response: { jsonrpc, id, result } or { error }
      if (msg && typeof msg === 'object' && Object.prototype.hasOwnProperty.call(msg, 'id')) {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          if (Object.prototype.hasOwnProperty.call(msg, 'error')) p.reject(msg.error);
          else p.resolve(msg.result);
        }
        return;
      }
      // Non-RPC notifications can be ignored or logged
    } catch (e) {
      _log(this.logger, 'warn', 'Invalid SSE JSON', { snippet: str.slice(0, 200), e: String(e) });
    }
  }

  async send(method, params) {
    // Ensure connected to receive response
    if (!this.connected) await this.connect();
    const id = String(this.idCounter++);
    const body = { jsonrpc: '2.0', id, method, params: params || {} };
    const headers = { 'Accept': 'application/json', 'Content-Type': 'application/json' };
    if (this.token) headers['Authorization'] = `Bearer ${this.token}`;
    // Send request to the same SSE URL via POST (server must accept JSON-RPC writes on this endpoint)
    const p = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    const res = await fetch(this.url, { method: 'POST', headers, body: JSON.stringify(body) });
    if (!res.ok) {
      this.pending.delete(id);
      const txt = await res.text().catch(() => '');
      throw new Error(`RPC send failed ${res.status}: ${txt.slice(0, 200)}`);
    }
    return p; // resolve when SSE yields the response
  }

  close() {
    try { this.controller?.abort(); } catch {}
    this.connected = false;
  }
}

function _indexHostsFromList(server, listHostsResult) {
  // listHostsResult is expected to be an object keyed by a host identifier, with attributes/protocols
  try {
    const obj = listHostsResult && listHostsResult.result ? listHostsResult.result : listHostsResult;
    const data = obj && typeof obj === 'object' ? obj : {};
    for (const [key, val] of Object.entries(data)) {
      const entry = {
        key,
        server_label: server.server_label,
        server_url: server.server_url,
        attributes: val?.attributes || {},
        protocols: Array.isArray(val?.protocols) ? val.protocols : [],
      };
      state.hosts.set(key, entry);
      const hostName = entry.attributes?.['host.name'];
      if (hostName) state.hosts.set(hostName, entry);
      for (const p of entry.protocols) {
        if (p?.hostname) state.hosts.set(p.hostname, entry);
      }
    }
  } catch {}
}

export async function initializeMcpRegistry(logger) {
  state.servers = [];
  state.hosts.clear();

  // Load config file
  try {
    const localCfgPath = path.resolve(process.cwd(), 'ai', 'mcp.config.local.js');
    if (fs.existsSync(localCfgPath)) {
      const mod = await import(pathToFileURL(localCfgPath).href);
      const arr = (mod && (mod.default || mod.servers)) || [];
      if (Array.isArray(arr)) {
        for (const s of arr) {
          const server_url = s.server_url || s.url;
          const server_label = s.server_label || s.label;
          const token = s.token || s.apiKey || s.key;
          if (server_url && server_label && token) state.servers.push({ server_url, server_label, token, tools: new Map() });
        }
      }
    }
  } catch (e) {
    _log(logger, 'warn', 'Failed to load ai/mcp.config.local.js', { e: String(e) });
  }
  // Fallback to env single server
  if (state.servers.length === 0) {
    const url = process.env.MCP_AGENT_URL;
    const token = process.env.MCP_AGENT_TOKEN;
    if (url && token) state.servers.push({ server_url: url, server_label: 'm8b-agent-01', token, tools: new Map() });
  }

  // Discover tools and hosts per server via SSE/JSON-RPC
  for (const server of state.servers) {
    try {
      server.client = new SseRpcClient({ url: server.server_url, token: server.token, logger });
      await server.client.connect();
      const tools = await server.client.send('tools/list', {});
      const toolList = Array.isArray(tools?.tools) ? tools.tools : (Array.isArray(tools) ? tools : []);
      for (const t of toolList) {
        if (!t?.name) continue;
        server.tools.set(t.name, t);
      }
      // Try to load hosts via ListHosts if present
      if (server.tools.has('ListHosts')) {
        try {
          const res = await server.client.send('tools/call', { name: 'ListHosts', arguments: {} });
          _indexHostsFromList(server, { result: res });
        } catch (e) {
          _log(logger, 'warn', 'ListHosts call failed', { server: server.server_label, e: String(e) });
        }
      }
    } catch (e) {
      _log(logger, 'warn', 'Tool discovery failed', { server: server.server_label, e: String(e) });
    }
  }
}

export function getMcpServerCount() {
  return state.servers.length;
}

export function getAggregatedHosts() {
  // Return a consolidated object keyed by canonical key, deduping by key
  const out = {};
  for (const [key, entry] of state.hosts.entries()) {
    // Only emit primary keys (prefer those that equal attributes.host.name or unique object keys)
    // For simplicity, include all keys but with server info annotated
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
    type: 'function',
    name: 'ListHosts',
    description: 'Return the consolidated list of all known hosts across all MetricsHub agents/servers (on-prem).',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  });
  // SearchHost
  tools.push({
    type: 'function',
    name: 'SearchHost',
    description: 'Search hosts by regex (case-insensitive) across consolidated host keys and attributes.host.name.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regular expression to match host keys or host names (case-insensitive).' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
  });

  // Other tools discovered per server (excluding ListHosts)
  // Expose each tool once (by name). We’ll add a required `hosts` array to route calls.
  const seen = new Set();
  for (const server of state.servers) {
    for (const [name, def] of server.tools.entries()) {
      if (name === 'ListHosts') continue;
      if (seen.has(name)) continue; // expose by name once; execution will partition by server.
      seen.add(name);
      const schema = def?.input_schema || def?.inputSchema || { type: 'object', properties: {} };
      const params = { type: 'object', properties: {}, additionalProperties: false };
      // Merge tool parameters if object
      if (schema && typeof schema === 'object' && schema.type === 'object' && schema.properties) {
        params.properties = { ...schema.properties };
        if (Array.isArray(schema.required)) params.required = [...schema.required];
        params.additionalProperties = false;
      }
      // Ensure hosts param exists
      params.properties.hosts = {
        type: 'array', items: { type: 'string' },
        description: 'One or more host identifiers to target. Use ListHosts/SearchHost first to discover hosts.'
      };
      if (!Array.isArray(params.required)) params.required = [];
      if (!params.required.includes('hosts')) params.required.push('hosts');

      tools.push({
        type: 'function',
        name,
        description: def?.description || `Execute ${name} on one or more hosts via MetricsHub MCP (proxied).`,
        parameters: params,
      });
    }
  }
  return tools;
}

function _bucketHostsByServer(hosts) {
  const buckets = new Map(); // server -> array of host keys
  for (const h of hosts || []) {
    const entry = state.hosts.get(h);
    if (!entry) continue;
    const key = entry.server_label;
    if (!buckets.has(key)) buckets.set(key, { server: entry, hosts: [] });
    buckets.get(key).hosts.push(h);
  }
  return buckets;
}

export async function executeMcpFunctionCall(name, args, logger) {
  // Special local functions
  if (name === 'ListHosts') {
    return { ok: true, hosts: getAggregatedHosts() };
  }
  if (name === 'SearchHost') {
    try {
      const pattern = String(args?.pattern || '').trim();
      const rx = new RegExp(pattern, 'i');
      const out = {};
      for (const [key, entry] of state.hosts.entries()) {
        const hn = entry.attributes?.['host.name'];
        if (rx.test(key) || (hn && rx.test(hn))) out[key] = { server_label: entry.server_label, attributes: entry.attributes, protocols: entry.protocols };
      }
      return { ok: true, hosts: out };
    } catch (e) {
      return { ok: false, error: `Invalid regex: ${String(e)}` };
    }
  }

  // Other tools: partition by server and invoke
  const hosts = Array.isArray(args?.hosts) ? args.hosts : (args?.host ? [args.host] : []);
  const buckets = _bucketHostsByServer(hosts);
  const results = [];
  for (const [, { server, hosts: hs }] of buckets) {
    const passArgs = { ...args, hosts: hs };
    try {
      const res = await server.client.send('tools/call', { name, arguments: passArgs });
      results.push({ server_label: server.server_label, ok: true, result: res });
    } catch (e) {
      results.push({ server_label: server.server_label, ok: false, error: String(e) });
    }
  }
  return { ok: true, results };
}
