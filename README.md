# M8B Slack Bot (MetricsHub)

M8B is a grumpy but competent Slack bot that helps solve IT issues. It uses OpenAI for reasoning and can query one or more MetricsHub MCP servers for real metrics. Built with Slack Bolt (Node.js).

This README covers production deployment on Linux using systemd, plus developer setup.

## Prerequisites

- Linux host with systemd (Ubuntu/Debian/CentOS etc.)
- Node.js 20+ and npm installed (check with `node -v`)
- A Slack workspace where you can install apps
- OpenAI API key
- Optional: MetricsHub MCP servers (URLs + API tokens)

## Create and Install the Slack App

1. Go to <https://api.slack.com/apps/new> and choose "From an app manifest".
1. Pick your workspace.
1. Paste the contents of `manifest.json` (JSON tab) and click Next.
1. Review and Create the app.
1. On the app page, go to Install App and install to your workspace.

You will need two tokens from Slack:

- SLACK_BOT_TOKEN (Bot User OAuth Token)
- SLACK_APP_TOKEN (App-level token with `connections:write`)

## Production Installation on Linux

The following example installs into `/opt/m8b-slack` and manages the bot via systemd. Adjust paths/usernames to your needs.

1. Clone the repository

```bash
sudo mkdir -p /opt/m8b-slack
sudo chown "$USER":"$USER" /opt/m8b-slack
cd /opt/m8b-slack
git clone https://github.com/metricshub/m8b-slack .
```

1. Install dependencies

```bash
cd /opt/m8b-slack
npm ci
```

1. Configure environment variables in `/etc/m8b-slack.env`

Create the file and secure it:

```bash
sudo bash -c 'cat >/etc/m8b-slack.env' <<'EOF'
# Required
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
OPENAI_API_KEY=sk-...

# Optional
NODE_ENV=production
# SLACK_API_URL=https://slack.com/api

# Back-compat single MetricsHub server (optional, use local config file for multiple)
# MCP_AGENT_URL=https://metricshub.example.com/sse
# MCP_AGENT_TOKEN=...

# Optional: Prometheus server for PromQL queries
# M8B_PROMETHEUS_URL=http://prometheus.example.com:9090

# Optional: OpenAI Vector Store / Code Interpreter settings
# Multiple vector stores (comma-separated) or single ID
# OPENAI_VECTOR_STORE_IDS=vs_123,vs_456
# OPENAI_VECTOR_STORE_ID=vs_123
# OPENAI_CODE_CONTAINER_ID=cc_...
EOF
sudo chmod 600 /etc/m8b-slack.env
```

1. Configure one or more MetricsHub MCP servers (optional)

- Copy the sample and create a local file that is NOT tracked by git:

```bash
cp ai/mcp.config.sample.js ai/mcp.config.local.js
```

- Edit `ai/mcp.config.local.js` and list your servers. You can reference env vars from `/etc/m8b-slack.env`:

```js
export default [
  { server_label: 'metricshub-paris', server_url: process.env.MCP_PARIS_URL, token: process.env.MCP_PARIS_TOKEN },
  { server_label: 'metricshub-nyc',   server_url: process.env.MCP_NYC_URL,   token: process.env.MCP_NYC_TOKEN   },
];
```

1. Configure Prometheus for PromQL queries (optional)

If you have a Prometheus server, M8B can execute PromQL queries to retrieve metrics, alerts, and time-series data. Set the `M8B_PROMETHEUS_URL` environment variable to enable this feature:

```bash
# In /etc/m8b-slack.env
M8B_PROMETHEUS_URL=http://prometheus.example.com:9090
```

Once configured, the bot can:

- Execute **instant queries** to get current metric values
- Execute **range queries** to get values over a time period
- Query **Prometheus AlertManager alerts** using `ALERTS_FOR_STATE`

Example prompts the bot can handle:

- "What alerts are currently firing?"
- "Show me the CPU usage for server1 over the last hour"
- "Are there any alerts for host.example.com?"

The bot will use PromQL queries like:

- `ALERTS_FOR_STATE` - List all active alerts
- `ALERTS_FOR_STATE{host_name="some.host.name"}` - Alerts for a specific host
- `rate(system_cpu_usage_seconds_total{mode="user"}[5m])` - CPU usage rate

1. Create a systemd unit file

```bash
sudo bash -c 'cat >/etc/systemd/system/m8b-slack.service' <<'EOF'
[Unit]
Description=M8B Slack Bot
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
EnvironmentFile=/etc/m8b-slack.env
WorkingDirectory=/opt/m8b-slack
ExecStart=/usr/bin/env node app.js
Restart=always
RestartSec=3
# Hardening (optional)
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true

[Install]
WantedBy=multi-user.target
EOF
```

1. Start the service

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now m8b-slack
sudo systemctl status m8b-slack --no-pager
```

1. View logs

```bash
journalctl -u m8b-slack -f
```

## Updating to the latest version

```bash
cd /opt/m8b-slack
git fetch && git pull
npm ci
sudo systemctl restart m8b-slack
```

## Developer Setup (Slack CLI preferred)

Using the Slack CLI is the smoothest way to develop and run this app locally. It injects the required Slack tokens at runtime and helps you create/install the app from the included manifest.

### Slack CLI prerequisites

1. Install the Slack CLI for your platform (macOS/Linux/Windows):

  - <https://api.slack.com/automation/cli/install>

1. Verify installation and login:

  ```bash
  slack version
  slack login
  ```

1. Clone the repository and install dependencies:

  ```bash
  git clone https://github.com/metricshub/m8b-slack
  cd m8b-slack
  npm install
  ```

### Run the app with Slack CLI

1. Start the app with the CLI (it will use the included `manifest.json`). Choose "Create a new app" when prompted and select your workspace:

  ```bash
  slack run
  # ...
  # [INFO]  bolt-app ⚡️ Bolt app is running!
  ```

1. In Slack, open a DM with the app (or invite it to a channel) and interact.

1. To customize settings (icon, scopes, features), open app settings:

  ```bash
  slack app settings
  ```

### Making code changes

1. Edit files (for example `app.js` or `ai/openai_response.js`).

1. Restart or re-run the app to pick up changes:

  ```bash
  slack run
  ```

### Optional: Configure MetricsHub servers for dev

If you want multiple MetricsHub servers in dev, create `ai/mcp.config.local.js` (copied from `ai/mcp.config.sample.js`) and reference environment variables or inline values. This file is ignored by git.

### Linting

```bash
npm run lint
```

## Alternative Developer Setup (without Slack CLI)

You can also run the app directly with Node.js and a local `.env` file (useful in CI or if you prefer manual token management).

1. Clone and install:

  ```bash
  git clone https://github.com/metricshub/m8b-slack
  cd m8b-slack
  npm install
  ```

1. Create a `.env` file in the repo root with at least:

  ```env
  SLACK_BOT_TOKEN=xoxb-...
  SLACK_APP_TOKEN=xapp-...
  OPENAI_API_KEY=sk-...
  NODE_ENV=development
  ```

1. Run locally:

  ```bash
  npm start
  ```

## Notes

- The bot's logging level adapts to `NODE_ENV` (production hides DEBUG).
- MetricsHub MCP config is loaded from `ai/mcp.config.local.js` if present; otherwise a single server can be set via `MCP_AGENT_URL` + `MCP_AGENT_TOKEN`.
- Prometheus PromQL queries are enabled when `M8B_PROMETHEUS_URL` is set.
- Never commit real secrets. `/etc/m8b-slack.env` and `ai/mcp.config.local.js` are excluded via `.gitignore`.
