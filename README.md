# M8B Slack Bot (MetricsHub)

M8B is a grumpy but competent Slack bot that helps solve IT issues. It uses GPT-5.6 Sol through
the OpenAI Responses API and can query one or more MetricsHub MCP servers for real monitoring
data. It is built with Slack Bolt for Node.js.

## Features

- 🤖 IT troubleshooting with `gpt-5.6-sol`, reasoning summaries, and streamed Responses API output
- 📊 Real-time metrics from MetricsHub MCP servers
- 🧰 Hosted tool search with deferred MetricsHub, Prometheus, and knowledge-write schemas
- 🔍 Prometheus PromQL query support
- 📁 Image and PDF analysis plus Code Interpreter support for data and code files
- 🧠 Knowledge base with vector store search
- 💬 Slack Assistant threads and mentions with streaming responses and conversation continuity
- 🔧 Grumpy personality for maximum entertainment

## Project Structure

```
m8b-slackbot/
├── app.js                    # Application entry point
├── ai/
│   ├── index.js              # AI module exports
│   ├── respond.js            # Main response orchestrator
│   ├── mcp_registry.js       # MCP server management
│   ├── prometheus.js         # Prometheus PromQL integration
│   ├── config/
│   │   └── system-prompt.js  # Bot personality and configuration
│   ├── services/
│   │   ├── openai.js         # OpenAI client and helpers
│   │   ├── streaming.js      # Response streaming handler
│   │   ├── context-manager.js # Conversation context management
│   │   ├── function-calls.js # Tool call processing
│   │   ├── slack-files.js    # File upload handling
│   │   ├── tool-middleware.js # Caching, pagination, and large tool outputs
│   │   └── citations.js       # Citation post-processing
│   ├── tools/
│   │   ├── index.js          # Tool definitions and deferred namespaces
│   │   └── __tests__/        # Tool tests
│   └── utils/
│       ├── tokens.js         # Token estimation utilities
│       ├── output-handler.js # Large output handling
│       ├── json-parser.js    # JSON parsing utilities
│       └── __tests__/        # Utility tests
├── listeners/
│   ├── actions/              # Slack action handlers
│   ├── assistant/            # Assistant thread handlers
│   └── events/               # Event handlers (app_mention, etc.)
└── manifest.json             # Slack app manifest
```

## Prerequisites

- Node.js 20+ and npm
- A Slack workspace where you can install apps
- OpenAI API key with access to `gpt-5.6-sol` and the required Responses API tools
- Optional: MetricsHub MCP servers (URLs + API tokens)
- Optional: Prometheus server for PromQL queries

## Quick Start (Development)

1. Clone and install dependencies:

```bash
git clone https://github.com/MetricsHub/m8b-slack.git
cd m8b-slack
npm install
```

2. Create `.env` file:

```bash
cp .env.example .env
# Edit .env with your tokens
```

3. Start the bot:

```bash
npm start
# Or with auto-reload:
npm run dev
```

## Available Scripts

| Script                  | Description                         |
| ----------------------- | ----------------------------------- |
| `npm start`             | Start the bot                       |
| `npm run dev`           | Start with auto-reload (watch mode) |
| `npm test`              | Run tests                           |
| `npm run test:watch`    | Run tests in watch mode             |
| `npm run test:coverage` | Run tests with coverage report      |
| `npm run lint`          | Check code with Biome               |
| `npm run lint:fix`      | Fix linting issues                  |
| `npm run format`        | Format code                         |
| `npm run check`         | TypeScript type checking            |
| `npm run validate`      | Run format check + lint + tests     |

## Configuration

### Environment Variables

```bash
# Required
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
OPENAI_API_KEY=sk-...

# Optional
NODE_ENV=production
SLACK_API_URL=https://slack.com/api

# MetricsHub MCP Server (single server mode)
MCP_AGENT_URL=https://metricshub.example.com/sse
MCP_AGENT_TOKEN=...
# MCP_ALLOW_SELF_SIGNED_CERT=true

# Prometheus
M8B_PROMETHEUS_URL=http://prometheus.example.com:9090

# OpenAI Vector Stores (for knowledge base)
OPENAI_VECTOR_STORE_IDS=vs_123,vs_456
# Or single ID:
OPENAI_VECTOR_STORE_ID=vs_123
```

`NODE_ENV` controls Bolt logging:

- `production`: warnings and errors
- `test`: info and above
- Any other value or an unset value: debug logging

Info/debug logs include reasoning summaries, tool activity, token/cache usage, and the complete
LLM response. Treat development logs as potentially sensitive operational data.

### Multiple MCP Servers

Copy `ai/mcp.config.sample.js` to `ai/mcp.config.local.js` (not tracked by git), then configure
the servers:

```javascript
export default [
	{
		server_label: "metricshub-paris",
		server_url: process.env.MCP_PARIS_URL,
		token: process.env.MCP_PARIS_TOKEN,
	},
	{
		server_label: "metricshub-nyc",
		server_url: process.env.MCP_NYC_URL,
		token: process.env.MCP_NYC_TOKEN,
	},
];
```

When a valid local configuration contains at least one server, it takes precedence over the
single-server `MCP_AGENT_URL`/`MCP_AGENT_TOKEN` fallback.

### OpenAI Model and Tools

The active model configuration is in `ai/config/system-prompt.js`:

- Model: `gpt-5.6-sol`
- Reasoning effort: `medium`, with automatic summaries and reasoning context
- Output: low verbosity, up to 8,000 tokens
- Conversation continuity: `previous_response_id`
- End-user safety identifier: a privacy-preserving hash of the Slack workspace and user IDs

MetricsHub tools are grouped into namespaces of fewer than ten functions. `ListHosts` and
`SearchHost` remain immediately callable; larger MetricsHub schemas, PromQL, and knowledge-base
writes are loaded through hosted tool search only when needed. Large MCP outputs are uploaded as
files so Code Interpreter can analyze the complete result instead of a truncated inline preview.

## Create and Install the Slack App

1. Go to <https://api.slack.com/apps/new> and choose "From an app manifest"
2. Pick your workspace
3. Paste the contents of `manifest.json` (JSON tab) and click Next
4. Review and Create the app
5. On the app page, go to Install App and install to your workspace

> **Slack compatibility:** `manifest.json` currently uses Slack's legacy `assistant_view` and
> `assistant_thread_*` events. Existing Assistant-view installations can continue to use it, but
> Slack requires the newer `agent_view` for newly created agent apps. Migrating the manifest and
> event flow to Agent View is separate work; see Slack's
> [Agent messaging migration guidance](https://docs.slack.dev/ai/developing-agents/).

You will need two tokens from Slack:

- **SLACK_BOT_TOKEN** (Bot User OAuth Token)
- **SLACK_APP_TOKEN** (App-level token with `connections:write`)

## Production Deployment

Basic systemd service (`/etc/systemd/system/m8b-slack.service`):

```ini
[Unit]
Description=M8B Slack Bot
After=network.target

[Service]
Type=simple
User=m8b
WorkingDirectory=/opt/m8b-slack
EnvironmentFile=/etc/m8b-slack.env
ExecStart=/usr/bin/node app.js
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

## Development

### Running Tests

```bash
# Run all tests
npm test

# Run with coverage
npm run test:coverage

# Watch mode
npm run test:watch
```

### Code Quality

```bash
# Check linting
npm run lint

# Fix linting issues
npm run lint:fix

# Format code
npm run format

# Type checking
npm run check

# Run formatting checks, linting, and tests
npm run validate
```

### Architecture

The codebase is organized into clear modules:

- **Config**: System prompts, model settings, constants
- **Services**: OpenAI Responses API streaming, context, files, citations, and tool execution
- **Tools**: Immediate and deferred function definitions grouped for hosted tool search
- **Utils**: Helper functions (token counting, output handling)

Conversation history uses OpenAI response IDs when available. On a cold start it reconstructs
history from Slack, excluding Slack's synthetic `assistant_app_thread` root so the initial user
question is not replayed as an assistant message.

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Run `npm run validate` and, when working on typed interfaces, `npm run check`
5. Submit a pull request

## License

MIT License - see [LICENSE](LICENSE) for details.
