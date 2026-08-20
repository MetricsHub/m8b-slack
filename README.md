# M8B Slack Bot (MetricsHub)

M8B is a grumpy but competent Slack bot that helps solve IT issues. It supports two AI backends:
GPT-5.6 Sol through the hosted OpenAI Responses API (default), or a local model (Qwen 3.8 27B)
served by Ollama's OpenAI-compatible `/v1/responses` API for fully on-prem/private AI. It can
query one or more MetricsHub MCP servers for real monitoring data. It is built with Slack Bolt
for Node.js.

## Features

- 🤖 IT troubleshooting with `gpt-5.6-sol` (OpenAI) or `qwen3.8:27b` (local Ollama), with streamed Responses API output
- 🔀 Configurable AI backend (`AI_PROVIDER=openai` or `AI_PROVIDER=ollama`), no silent cross-provider fallback
- 📊 Real-time metrics from MetricsHub MCP servers
- 🧰 Hosted tool search with deferred MetricsHub, Prometheus, and knowledge-write schemas (OpenAI mode)
- 🔍 Prometheus PromQL query support
- 📁 Image and PDF analysis plus Code Interpreter support for data and code files (OpenAI mode)
- 🧠 Knowledge base: OpenAI vector store search, or a local embeddings index in Ollama mode
- 🌐 Web search: hosted (OpenAI) or pluggable application-side search (SearXNG / opt-in Ollama cloud)
- 💬 Slack Assistant threads and mentions with streaming responses and conversation continuity
- 🔧 Grumpy personality for maximum entertainment

## Project Structure

```
m8b-slackbot/
├── app.js                    # Application entry point (logs AI provider + health check)
├── ai/
│   ├── index.js              # AI module exports
│   ├── respond.js            # Main response orchestrator
│   ├── mcp_registry.js       # MCP server management
│   ├── prometheus.js         # Prometheus PromQL integration
│   ├── config/
│   │   ├── system-prompt.js  # Bot personality and configuration
│   │   └── providers.js      # AI provider configuration (OpenAI vs Ollama)
│   ├── providers/
│   │   ├── index.js          # Provider abstraction (capabilities, request builder)
│   │   ├── openai-provider.js # Hosted OpenAI backend
│   │   └── ollama-provider.js # Local Ollama backend (/v1/responses)
│   ├── services/
│   │   ├── openai.js         # OpenAI client and helpers
│   │   ├── streaming.js      # Response streaming handler
│   │   ├── context-manager.js # Conversation context management
│   │   ├── context-budget.js # Deterministic context trimming (Ollama, 32K window)
│   │   ├── conversation-store.js # App-side thread state (Ollama, stateless API)
│   │   ├── knowledge-base.js # Local RAG (chunks + Ollama embeddings + cosine search)
│   │   ├── web-search.js     # Application-side web search (SearXNG / Ollama cloud)
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
├── scripts/
│   ├── export-openai-knowledge.js # Export OpenAI vector-store docs to local files
│   └── index-knowledge.js    # Build the local knowledge base embedding index
├── listeners/
│   ├── actions/              # Slack action handlers
│   ├── assistant/            # Assistant thread handlers
│   └── events/               # Event handlers (app_mention, etc.)
└── manifest.json             # Slack app manifest
```

## Prerequisites

- Node.js 20+ and npm
- A Slack workspace where you can install apps
- An AI backend, either:
  - an OpenAI API key with access to `gpt-5.6-sol` and the required Responses API tools, or
  - an Ollama server (current version) with `qwen3.8:27b` and an embedding model pulled
- Optional: MetricsHub MCP servers (URLs + API tokens)
- Optional: Prometheus server for PromQL queries
- Optional (Ollama mode): a SearXNG instance for web search

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

| Script                  | Description                                                       |
| ----------------------- | ----------------------------------------------------------------- |
| `npm start`             | Start the bot                                                     |
| `npm run dev`           | Start with auto-reload (watch mode)                               |
| `npm test`              | Run tests                                                         |
| `npm run test:watch`    | Run tests in watch mode                                           |
| `npm run test:coverage` | Run tests with coverage report                                    |
| `npm run lint`          | Check code with Biome                                             |
| `npm run lint:fix`      | Fix linting issues                                                |
| `npm run format`        | Format code                                                       |
| `npm run check`         | TypeScript type checking                                          |
| `npm run validate`      | Run format check + lint + tests                                   |
| `npm run kb:export`     | Export OpenAI vector-store docs to local files (Ollama migration) |
| `npm run kb:index`      | Build the local knowledge base embedding index                    |

## Configuration

### Selecting the AI backend

The AI backend is selected with `AI_PROVIDER`:

- `AI_PROVIDER=openai` (default): hosted OpenAI Responses API with `gpt-5.6-sol` — current behavior, unchanged.
- `AI_PROVIDER=ollama`: a local model through Ollama's OpenAI-compatible `/v1/responses` API. When Ollama mode is active, nothing is ever sent to OpenAI: capabilities without a local equivalent are reported as unavailable instead of falling back.

At startup the bot logs the active backend and runs a health check (Ollama reachability + model
presence). In Ollama mode it also reads the server's _effective_ context length from the native
API (`/api/ps` for a loaded model, `/api/show` for a Modelfile `num_ctx`): an unset
`OLLAMA_CONTEXT_LENGTH` adopts the detected value, a smaller configured value is kept (tighter
budgets are safe), and a larger one is capped to the server's value with a warning — so the bot
can never believe it has more context than Ollama actually allocates:

```text
AI provider: ollama
AI model: qwen3.8:27b
AI endpoint: http://dev-nvidia-01:11434/v1
AI backend health check passed (model "qwen3.8:27b" available)
```

### Environment Variables

```bash
# Required
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
OPENAI_API_KEY=sk-...        # required in OpenAI mode only

# AI backend selection (default: openai)
AI_PROVIDER=openai

# Optional
NODE_ENV=production
SLACK_API_URL=https://slack.com/api
AI_MAX_AGENT_ITERATIONS=10   # cap on model->tools->model loops per message

# MetricsHub MCP Server (single server mode)
MCP_AGENT_URL=https://metricshub.example.com/sse
MCP_AGENT_TOKEN=...
# MCP_ALLOW_SELF_SIGNED_CERT=true

# Prometheus
M8B_PROMETHEUS_URL=http://prometheus.example.com:9090

# OpenAI Vector Stores (knowledge base, OpenAI mode)
OPENAI_VECTOR_STORE_IDS=vs_123,vs_456
# Or single ID:
OPENAI_VECTOR_STORE_ID=vs_123
```

### Example Ollama configuration

```bash
AI_PROVIDER=ollama
OLLAMA_BASE_URL=http://dev-nvidia-01:11434/v1
OLLAMA_MODEL=qwen3.8:27b
OLLAMA_API_KEY=ollama                  # dummy value required by the OpenAI SDK; Ollama ignores it
OLLAMA_EMBEDDING_MODEL=nomic-embed-text
OLLAMA_CONTEXT_LENGTH=32768            # must match Ollama's num_ctx (same name as Ollama's own variable)
OLLAMA_MAX_OUTPUT_TOKENS=4000
KNOWLEDGE_BASE_DIR=data/knowledge

# Web search backend (optional; unset = web search unavailable)
WEB_SEARCH_PROVIDER=searxng
SEARXNG_URL=http://searxng.internal:8080
```

On the Ollama host, pull the models:

```bash
ollama pull qwen3.8:27b
ollama pull nomic-embed-text
```

### Ollama mode: conversation state

Ollama's `/v1/responses` API is **stateless** — it does not implement OpenAI's
`previous_response_id` or `conversation`. In Ollama mode the bot therefore keeps
conversation history application-side, keyed by `team + channel + thread_ts`, and resends the
relevant user/assistant/tool items in `input` on every request. History is trimmed
deterministically to fit the model's context window (`OLLAMA_CONTEXT_LENGTH`, default 32K),
always retaining the system prompt, recent turns, and intact tool-call/result pairs. The store
is in-memory; after a restart the text history is rebuilt from the Slack thread itself (the
same cold-start path OpenAI mode uses), losing only the tool-call detail of earlier turns.
OpenAI mode continues to use `previous_response_id` unchanged.

### Ollama mode: local knowledge base

OpenAI's hosted `file_search`/vector stores are not available locally, so Ollama mode uses a
local RAG path: markdown documents in `data/knowledge/docs/` are chunked, embedded with a local
Ollama embedding model (`OLLAMA_EMBEDDING_MODEL`, default `nomic-embed-text`), and persisted in
`data/knowledge/index.json`. Retrieval is cosine similarity, exposed to the model as the
`search_knowledge_base` function tool; `update_knowledge` writes new entries into the same
local store. This flat-file design is intentional for a small corpus — no vector database
required.

**Migrating the existing OpenAI vector store** (the source documents live only in OpenAI):

```bash
# 1. Export the documents from the OpenAI vector store to data/knowledge/docs/
OPENAI_API_KEY=sk-... OPENAI_VECTOR_STORE_IDS=vs_... npm run kb:export

# 2. Build the embedding index (requires the Ollama server + embedding model)
OLLAMA_BASE_URL=http://dev-nvidia-01:11434/v1 npm run kb:index
```

Indexing is incremental where it can be:

- **Bot-written knowledge** (`update_knowledge`) is embedded and added to the index at write
  time — no reindex needed; it is searchable on the next message.
- **Manual edits** to one or a few documents: `npm run kb:index -- <file.md> [more.md ...]`
  re-embeds only those documents (chunks of each listed doc are replaced).
- **Full rebuild** (`npm run kb:index` with no arguments) is required after adding/removing many
  documents, or whenever you switch embedding models or task prefixes — the index refuses
  mixed-configuration writes and searches with a clear "rebuild" error.

**Retrieval quality tips:**

- Task prefixes are applied automatically per embedding model (`nomic-embed-text` requires
  `search_query:`/`search_document:` prefixes; searching an index built without them returns a
  clear "rebuild" error). Override with `OLLAMA_EMBEDDING_QUERY_PREFIX` /
  `OLLAMA_EMBEDDING_DOCUMENT_PREFIX` if you use a model with different conventions.
- For a bilingual corpus (French/English), `bge-m3` usually beats `nomic-embed-text`:
  `ollama pull bge-m3`, set `OLLAMA_EMBEDDING_MODEL=bge-m3`, re-run `npm run kb:index`.
- Curate the corpus: cosine similarity has no notion of "deprecated". Delete legacy documents,
  or mark them with an explicit first line (e.g. `**Status: DEPRECATED — replaced by X**`) so
  the model dismisses them when they are retrieved, and keep one authoritative overview
  document per topic.

### Tool availability per provider

| Capability            | OpenAI mode                        | Ollama mode                                                 |
| --------------------- | ---------------------------------- | ----------------------------------------------------------- |
| MetricsHub MCP tools  | ✅ (deferred namespaces)           | ✅ (plain function tools)                                   |
| Prometheus PromQL     | ✅                                 | ✅                                                          |
| Slack reaction/reply  | ✅                                 | ✅                                                          |
| Knowledge base search | ✅ hosted `file_search`            | ✅ local `search_knowledge_base` (after `kb:index`)         |
| Knowledge base writes | ✅ vector store upload             | ✅ local markdown + embeddings                              |
| Web search            | ✅ hosted `web_search_preview`     | ⚙️ app-side `web_search` via SearXNG or opt-in Ollama cloud |
| Code Interpreter      | ✅ hosted sandbox                  | ❌ unavailable (no secure local sandbox; see below)         |
| File/image analysis   | ✅ via OpenAI Files API            | ❌ attachments surfaced as text notes                       |
| Conversation state    | Server-side `previous_response_id` | Application-side per-thread store                           |
| Streaming             | ✅                                 | ✅                                                          |

**Code Interpreter in Ollama mode:** running model-generated code requires a proper isolated
sandbox. Passing generated commands to a shell or `eval()` on the Slackbot host would be a
security hole, so the capability is cleanly marked unavailable: the tool is not offered to the
model and the system prompt tells it to provide file contents inline instead. Adding local
parity later would require a dedicated sandbox (e.g. a locked-down container runtime such as
gVisor/Firecracker, no network, resource limits) exposed as a `code_interpreter` function tool.

**Privacy note:** in Ollama mode, prompts, documents, and tool results never leave your
network unless you explicitly opt in to `WEB_SEARCH_PROVIDER=ollama-cloud` (which sends the
search query — not the conversation — to ollama.com).

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

The manifest uses Slack's Agent messaging experience (`agent_view`). Conversations appear in the
app's standard Messages tab, with each user message starting or continuing a thread. The bot listens
for `app_home_opened`, `app_context_changed`, and `message.im` events as described in Slack's
[Agent messaging guidance](https://docs.slack.dev/ai/developing-agents/).

> Switching an existing Slack app from `assistant_view` to `agent_view` is irreversible. Update and
> test the application code before applying `manifest.json` to an existing installation. Users need
> to hard-refresh Slack after the manifest update. Updating an existing app does not require
> registering a new bot. Slack CLI 4.4.0 or newer is required to apply an Agent View manifest.

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

- **Config**: System prompts, model settings, provider selection, constants
- **Providers**: The AI backend abstraction — each provider exposes its SDK client, capability
  flags (server-side state, hosted tools, file uploads), a request builder that only emits
  fields its backend supports, and a health check. The rest of the app depends on capabilities,
  not on `if (provider === "ollama")` conditionals.
- **Services**: Responses API streaming, context management, conversation store, local
  knowledge base, web search, files, citations, and tool execution
- **Tools**: Immediate and deferred function definitions grouped for hosted tool search
  (OpenAI), or flat function tools (Ollama)
- **Utils**: Helper functions (token counting, output handling)

Conversation history uses OpenAI response IDs when available (OpenAI mode) or the application-
side per-thread store (Ollama mode). On a cold start it reconstructs history from Slack,
excluding Slack's synthetic `assistant_app_thread` root so the initial user question is not
replayed as an assistant message.

### Integration tests against a live Ollama server

The normal test suite mocks all external services. An opt-in integration suite runs against a
real Ollama instance when both variables are set:

```bash
OLLAMA_BASE_URL=http://dev-nvidia-01:11434/v1 OLLAMA_MODEL=qwen3.8:27b npm test
```

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Run `npm run validate` and, when working on typed interfaces, `npm run check`
5. Submit a pull request

## License

MIT License - see [LICENSE](LICENSE) for details.
