// Sample configuration for MetricsHub MCP servers
// Copy this file to ai/mcp.config.local.js and customize. Do NOT commit the local file.
// You can reference environment variables here for security.

export default [
	// Example single server using env vars
	// {
	//   server_label: 'm8b-agent-01',
	//   server_url: process.env.MCP_AGENT_URL,
	//   token: process.env.MCP_AGENT_TOKEN,
	// },
	// Example multi-server setup
	// {
	//   server_label: 'metricshub-paris',
	//   server_url: process.env.MCP_PARIS_URL,
	//   token: process.env.MCP_PARIS_TOKEN,
	// },
	// {
	//   server_label: 'metricshub-nyc',
	//   server_url: process.env.MCP_NYC_URL,
	//   token: process.env.MCP_NYC_TOKEN,
	// },
	// Example with self-signed certificate (for HTTPS with custom CA)
	// {
	//   server_label: 'metricshub-dev',
	//   server_url: 'https://dev-server.local:8443/sse',
	//   token: process.env.MCP_DEV_TOKEN,
	//   allowSelfSignedCert: true, // Allow self-signed/untrusted certificates
	// },
];
