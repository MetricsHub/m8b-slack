# M8B Slack Bot (MetricsHub)

M8B is a grumpy but competent Slack bot that helps solve IT issues. It uses OpenAI for reasoning and can query one or more MetricsHub MCP servers for real metrics. Built with Slack Bolt (Node.js).

## Features

- 🤖 AI-powered IT troubleshooting using OpenAI GPT models
- 📊 Real-time metrics from MetricsHub MCP servers
- 🔍 Prometheus PromQL query support
- 📁 File analysis (images, PDFs, code files)
- 🧠 Knowledge base with vector store search
- 💬 Slack-native with streaming responses
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
│   │   └── citations.js      # Citation post-processing
│   ├── tools/
│   │   └── index.js          # Tool definitions
│   └── utils/
│       ├── tokens.js         # Token estimation utilities
│       ├── output-handler.js # Large output handling
│       └── json-parser.js    # JSON parsing utilities
├── listeners/
│   ├── actions/              # Slack action handlers
│   ├── assistant/            # Assistant thread handlers
│   └── events/               # Event handlers (app_mention, etc.)
└── tests/                    # Test files (in __tests__ directories)
```

## Prerequisites

- Node.js 20+ and npm
- A Slack workspace where you can install apps
- OpenAI API key
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
| `npm run validate`      | Run lint + check + test             |

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

# Prometheus
M8B_PROMETHEUS_URL=http://prometheus.example.com:9090

# OpenAI Vector Stores (for knowledge base)
OPENAI_VECTOR_STORE_IDS=vs_123,vs_456
# Or single ID:
OPENAI_VECTOR_STORE_ID=vs_123
```

### Multiple MCP Servers

Create `ai/mcp.config.local.js` (not tracked by git):

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

## Create and Install the Slack App

1. Go to <https://api.slack.com/apps/new> and choose "From an app manifest"
2. Pick your workspace
3. Paste the contents of `manifest.json` (JSON tab) and click Next
4. Review and Create the app
5. On the app page, go to Install App and install to your workspace

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

# Run all validations
npm run validate
```

### Architecture

The codebase is organized into clear modules:

- **Config**: System prompts, model settings, constants
- **Services**: Core business logic (OpenAI, streaming, context)
- **Tools**: Function definitions for AI tool calls
- **Utils**: Helper functions (token counting, output handling)

Each module is testable and has a single responsibility.

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Run `npm run validate` to ensure quality
5. Submit a pull request

## License

MIT License - see [LICENSE](LICENSE) for details.
