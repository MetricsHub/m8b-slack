# M8B Slack Bot (MetricsHub)

M8B is a grumpy but competent Slack bot that helps solve IT issues. It supports three AI
backends: GPT-5.6 Sol through the hosted OpenAI Responses API (default), or a local model
(Qwen 3.8 27B) served by Ollama's or vLLM's OpenAI-compatible `/v1/responses` API for fully
on-prem/private AI. It can query one or more MetricsHub MCP servers for real monitoring data.
It is built with Slack Bolt for Node.js.

## Features

- 🤖 IT troubleshooting with `gpt-5.6-sol` (OpenAI) or Qwen 3.8 27B (local Ollama/vLLM), with streamed Responses API output
- 🔀 Configurable AI backend (`AI_PROVIDER=openai`, `ollama`, or `vllm`), no silent cross-provider fallback
- 📊 Real-time metrics from MetricsHub MCP servers
- 🧰 Hosted tool search with deferred MetricsHub, Prometheus, and knowledge-write schemas (OpenAI mode)
- 🔍 Prometheus PromQL query support
- 📁 Image and PDF analysis plus Code Interpreter support for data and code files (OpenAI mode)
- 🖼️ Native screenshot analysis in vLLM mode (multimodal model + local media store), sidecar vision model in Ollama mode
- 🧠 Knowledge base: OpenAI vector store search, or a local embeddings index in Ollama/vLLM mode
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
│   │   └── providers.js      # AI provider configuration (OpenAI vs Ollama vs vLLM)
│   ├── providers/
│   │   ├── index.js          # Provider abstraction (capabilities, request builder)
│   │   ├── openai-provider.js # Hosted OpenAI backend
│   │   ├── ollama-provider.js # Local Ollama backend (/v1/responses)
│   │   └── vllm-provider.js  # Local vLLM backend (/v1/responses, native vision)
│   ├── services/
│   │   ├── openai.js         # OpenAI client and helpers
│   │   ├── streaming.js      # Response streaming handler
│   │   ├── context-manager.js # Conversation context management
│   │   ├── context-budget.js # Deterministic context trimming (local modes)
│   │   ├── conversation-store.js # App-side thread state (local modes, stateless API)
│   │   ├── media-store.js    # Local image store served to the vLLM host by URL
│   │   ├── knowledge-base.js # Local RAG (chunks + local embeddings + cosine search)
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
│   ├── actions/              # Slack action handlers (config approval, feedback)
│   ├── agent/                # Agent messaging handlers (home opened, context, messages)
│   ├── events/               # Event handlers (app_mention, etc.)
│   └── views/                # Slack views (credentials modal, feedback blocks)
└── manifest.json             # Slack app manifest
```

## Prerequisites

- Node.js 20+ and npm
- A Slack workspace where you can install apps
- An AI backend, one of:
  - an OpenAI API key with access to `gpt-5.6-sol` and the required Responses API tools,
  - an Ollama server (current version) with `qwen3.8:27b` and an embedding model pulled, or
  - a vLLM server (0.27+) serving a multimodal model (e.g. Qwen 3.8 27B INT8) via `/v1/responses`
- Optional: MetricsHub MCP servers (URLs + API tokens)
- Optional: Prometheus server for PromQL queries
- Optional (local modes): a SearXNG instance for web search

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
- `AI_PROVIDER=ollama`: a local model through Ollama's OpenAI-compatible `/v1/responses` API. Nothing
  is ever sent to OpenAI: capabilities without a local equivalent are reported as unavailable
  instead of falling back.
- `AI_PROVIDER=vllm`: a local model through vLLM's OpenAI-compatible `/v1/responses` API. Same
  local-only guarantees, with one capability upgrade: the served model is multimodal, so
  screenshots are passed to it natively (no sidecar vision model needed).
- `AI_PROVIDER=openai-compatible`: any other endpoint serving the OpenAI `/v1/responses` API with
  streaming and function tools (a corporate inference proxy, an NVIDIA NIM, a LiteLLM gateway,
  ...). Same local-only guarantees, with model-dependent capabilities switched on by flags.

The three self-hosted modes share **one set of variables**, `AI_*` (endpoint, model, budgets,
embeddings — see the next sections). `AI_PROVIDER` is a preset: it fixes the defaults (Ollama's
port 11434 and dummy key, vLLM's port 8000 and single-model adoption) and the backend quirks
(Ollama's sidecar vision model, vLLM's strict chat template). Only genuinely vendor-specific
settings keep a vendor prefix: `OLLAMA_VISION_MODEL` / `OLLAMA_VISION_MAX_OUTPUT_TOKENS`, and
`OLLAMA_CONTEXT_LENGTH`, a permanent alias of `AI_CONTEXT_LENGTH` named after Ollama's own server
variable so the same line configures both sides. The former `OLLAMA_*` / `VLLM_*` names of the
common settings still work as deprecated aliases (they take precedence over `AI_*`), with one
startup warning listing the replacements.

At startup the bot logs the active backend and runs a health check (backend reachability + model
presence). In Ollama mode it also reads the server's _effective_ context length from the native
API (`/api/ps` for a loaded model, `/api/show` for a Modelfile `num_ctx`); in vLLM and
openai-compatible modes it reads `max_model_len` / `context_length` from `/v1/models` when the
server reports it. In all cases: an unset `AI_CONTEXT_LENGTH` adopts the detected value (or the 32k
default, with a warning, when nothing is reported), a smaller configured value is kept (tighter
budgets are safe), and a larger one is capped to the server's value with a warning — so the bot
can never believe it has more context than the server actually allocates:

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
AI_MAX_AGENT_ITERATIONS=15   # cap on model->tools->model loops per message

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

### Self-hosted backends: common variables

Every self-hosted mode (`ollama`, `vllm`, `openai-compatible`) reads the same variables; only the
defaults differ per preset:

```bash
AI_PROVIDER=ollama|vllm|openai-compatible
AI_BASE_URL=http://host:port/v1       # default: Ollama http://localhost:11434/v1, vLLM/generic http://localhost:8000/v1
AI_API_KEY=...                        # bearer token; default dummy value (the SDK requires one even if the server ignores it)
AI_MODEL=...                          # Ollama default qwen3.8:27b; vLLM: adopted from the single served model; generic: REQUIRED
AI_CONTEXT_LENGTH=32768               # the model's context window (see the detection rules above)
AI_MAX_OUTPUT_TOKENS=4000
# AI_REQUEST_TIMEOUT_MS=300000
# AI_MAX_TOOL_OUTPUT_CHARS=           # inline cap for one tool result; default scales with the context window

# Local knowledge base (unset AI_EMBEDDING_MODEL = disabled; Ollama defaults it to nomic-embed-text)
AI_EMBEDDING_MODEL=nomic-embed-text
# AI_EMBEDDING_BASE_URL=              # default: AI_BASE_URL (REQUIRED in vLLM mode, see below)
# AI_EMBEDDING_API_KEY=               # default: AI_API_KEY
# AI_EMBEDDING_QUERY_PREFIX=          # task prefixes; auto per model (nomic, mxbai)
# AI_EMBEDDING_DOCUMENT_PREFIX=
# AI_EMBEDDING_QUERY_INPUT_TYPE=      # per-request input_type; auto "query"/"passage" for nv-embed* models
# AI_EMBEDDING_DOCUMENT_INPUT_TYPE=
KNOWLEDGE_BASE_DIR=data/knowledge

# Web search backend (optional; unset = web search unavailable)
WEB_SEARCH_PROVIDER=searxng
SEARXNG_URL=http://searxng.internal:8080
```

### Ollama preset

```bash
AI_PROVIDER=ollama
AI_BASE_URL=http://dev-nvidia-01:11434/v1
AI_MODEL=qwen3.8:27b
AI_EMBEDDING_MODEL=nomic-embed-text
OLLAMA_CONTEXT_LENGTH=32768            # must match Ollama's num_ctx (same name as Ollama's own variable)
OLLAMA_VISION_MODEL=qwen3-vl:8b-instruct-8k  # optional: describes image attachments (unset = disabled)
# OLLAMA_VISION_MAX_OUTPUT_TOKENS=600
```

On the Ollama host, pull the models:

```bash
ollama pull qwen3.8:27b
ollama pull nomic-embed-text
ollama pull qwen3-vl:8b-instruct-8k   # optional, for screenshot analysis
```

### vLLM preset

```bash
AI_PROVIDER=vllm
AI_BASE_URL=http://dev-nvidia-01:8000/v1
AI_API_KEY=vllm_...                    # whatever the reverse proxy in front of vLLM expects
# AI_MODEL=qwen3.8-27b-int8            # optional: adopted automatically (vLLM serves one model)
# AI_CONTEXT_LENGTH=65536              # optional: detected from /v1/models max_model_len

# Media store: screenshots are saved locally and served to the vLLM host by URL
# (unset M8B_MEDIA_BASE_URL = degraded fallback: images inlined as base64 every turn)
M8B_MEDIA_DIR=/var/lib/m8b/media
M8B_MEDIA_BASE_URL=https://bm-linux-slack.internal.sentrysoftware.net/m8b-media
M8B_MEDIA_RETENTION_DAYS=7

# Local knowledge base embeddings: a vLLM instance serves ONE model, so the chat
# instance cannot embed. Point AI_EMBEDDING_BASE_URL at a dedicated embedding
# endpoint (a second small vLLM instance, or an Ollama server kept around for
# embeddings). Without it the knowledge base is disabled.
# AI_EMBEDDING_BASE_URL=http://dev-nvidia-01:8001/v1
# AI_EMBEDDING_MODEL=qwen3-embedding-0.6b
```

### OpenAI-compatible preset

For an endpoint that is neither Ollama nor vLLM (a corporate inference gateway, a NIM, ...):

```bash
AI_PROVIDER=openai-compatible
AI_BASE_URL=https://inference.example.com/v1
AI_API_KEY=...
AI_MODEL=llama-3.3-70b-instruct       # REQUIRED: a gateway serves many models, the bot never guesses
AI_CONTEXT_LENGTH=131072              # gateways rarely report it (see below)
# AI_IMAGE_INPUT=true                 # the model reads images natively (then configure M8B_MEDIA_*)
# AI_STRICT_INPUT=true                # single leading system message, string assistant history
# AI_EMBEDDING_MODEL=nvidia/nv-embedqa-e5-v5 # unset = knowledge base disabled
```

The endpoint must implement `/v1/responses` (streaming, `function` tools); `/v1/chat/completions`
alone is not enough. The health check calls `GET /v1/models`: `AI_MODEL` must be listed there,
and a reported `max_model_len` / `context_length` sizes the context window as in vLLM mode. Most
gateways do not report it: set `AI_CONTEXT_LENGTH` to the served model's real window, otherwise
the bot runs on a 32k default and warns at startup. A gateway that does not expose `/v1/models`
passes the check with a warning (model unverified); authentication or server errors on that
endpoint fail it, and so does any `/v1/models` failure in vLLM mode. A missing `AI_MODEL` stops
the bot at startup, and an `AI_MAX_OUTPUT_TOKENS` that leaves the prompt fewer than 8k tokens of
the context window is flagged. When `AI_EMBEDDING_MODEL` is set, the health
check also sends one test embedding request and warns if it fails; at runtime an embedding
failure makes `search_knowledge_base` report the knowledge base as unavailable for that call,
nothing else breaks. Without an embedding model, neither `search_knowledge_base` nor
`update_knowledge` is offered to the model. Embedding APIs that require a per-request
`input_type` (NVIDIA NIM retrieval models) are handled: `query` when searching, `passage` when
indexing, detected from the model name or set with `AI_EMBEDDING_QUERY_INPUT_TYPE` /
`AI_EMBEDDING_DOCUMENT_INPUT_TYPE`.
Only universally supported request fields are sent (`model`, `input`, `tools`, `stream`,
`max_output_tokens`); OpenAI-only fields (`reasoning`, `text`, `previous_response_id`,
`safety_identifier`, hosted tool types) never are. Enable `AI_STRICT_INPUT` when the server rejects
requests with `400 System message must be at the beginning` or refuses assistant history items
carrying `output_text` content (this is what the `vllm` preset does unconditionally).

### Local modes (Ollama/vLLM/openai-compatible): conversation state

Ollama's `/v1/responses` API is **stateless** — it does not implement OpenAI's
`previous_response_id` or `conversation`. vLLM has a Responses API store, but it is an
unbounded, process-local in-memory store, so the bot deliberately does not rely on it either.
In both local modes the bot therefore keeps conversation history application-side, keyed by
`team + channel + thread_ts`, and resends the relevant user/assistant/tool items in `input` on
every request. History is trimmed deterministically to fit the model's context window
(`AI_CONTEXT_LENGTH`), always retaining the system prompt, recent
turns, and intact tool-call/result pairs. The store is in-memory; after a restart the text
history is rebuilt from the Slack thread itself (the same cold-start path OpenAI mode uses),
losing only the tool-call detail of earlier turns. OpenAI mode continues to use
`previous_response_id` unchanged.

### Self-hosted modes: local knowledge base

OpenAI's hosted `file_search`/vector stores are not available locally, so the self-hosted modes
use a local RAG path: markdown documents in `data/knowledge/docs/` are chunked, embedded through
the configured `/v1/embeddings` endpoint (`AI_EMBEDDING_MODEL`; Ollama defaults it to
`nomic-embed-text`), and persisted in
`data/knowledge/index.json`. Retrieval is cosine similarity, exposed to the model as the
`search_knowledge_base` function tool; `update_knowledge` writes new entries into the same
local store. This flat-file design is intentional for a small corpus — no vector database
required.

**Migrating the existing OpenAI vector store** (the source documents live only in OpenAI):

```bash
# 1. Export the documents from the OpenAI vector store to data/knowledge/docs/
OPENAI_API_KEY=sk-... OPENAI_VECTOR_STORE_IDS=vs_... npm run kb:export

# 2. Build the embedding index (requires the embedding endpoint + model)
AI_PROVIDER=ollama AI_BASE_URL=http://dev-nvidia-01:11434/v1 npm run kb:index
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
  clear "rebuild" error). Override with `AI_EMBEDDING_QUERY_PREFIX` /
  `AI_EMBEDDING_DOCUMENT_PREFIX` if you use a model with different conventions.
- For a bilingual corpus (French/English), `bge-m3` usually beats `nomic-embed-text`:
  `ollama pull bge-m3`, set `AI_EMBEDDING_MODEL=bge-m3`, re-run `npm run kb:index`.
- Curate the corpus: cosine similarity has no notion of "deprecated". Delete legacy documents,
  or mark them with an explicit first line (e.g. `**Status: DEPRECATED — replaced by X**`) so
  the model dismisses them when they are retrieved, and keep one authoritative overview
  document per topic.

### Ollama mode: screenshots and images

The main chat model is text-only and Ollama's `/v1/responses` API has no image input, so
image attachments are handled by a sidecar **vision model** (`OLLAMA_VISION_MODEL`, e.g.
`qwen3-vl:8b-instruct-8k`) called through `/v1/chat/completions`. When a user posts a
screenshot, the bot downloads it from Slack, asks the vision model for a factual description
(verbatim text transcription, chart trends, anomalies) — including a short snippet of the
conversation so the description focuses on what matters — and injects that description into
the conversation as text. Descriptions are embedded in the per-thread conversation store, so
each image is described once, not on every stateless turn. Non-image attachments (and vision
failures) degrade to an explicit "cannot analyze" note. Unset `OLLAMA_VISION_MODEL` to disable
the feature entirely.

Note the vision model's own context window is separate from the chat model's and is often
small (8k for `qwen3-vl:8b-instruct-8k`): it must hold the image tokens plus the description,
which is why the context snippet and the output cap (`OLLAMA_VISION_MAX_OUTPUT_TOKENS`,
default 600) are kept deliberately tight.

### vLLM mode: screenshots and images (media store)

The vLLM-served model is multimodal, so screenshots go to it **natively** as `input_image`
items — no sidecar vision model, no lossy text description. Because the local conversation
history is resent on every turn, images are NOT embedded as base64 in the history (five 2 MB
screenshots would add ~13 MB to every subsequent request). Instead:

1. The bot downloads the image from Slack once (with its Slack credentials — those are never
   given to vLLM), saves it under `M8B_MEDIA_DIR` as `<uuid>.<ext>`, and stores only the short
   URL `M8B_MEDIA_BASE_URL/<uuid>.<ext>` in the conversation.
2. A reverse proxy (NGINX) serves `M8B_MEDIA_DIR` at that URL, restricted to the vLLM host's IP.
3. vLLM fetches the image itself (and caches it, when its bounded media cache is enabled).

Files older than `M8B_MEDIA_RETENTION_DAYS` (default 7) are deleted by the bot itself (a sweep
runs at startup and every 6 hours). If a stored conversation still references a deleted image,
the reference is replaced by a text marker before the request is sent — one expired screenshot
never fails the whole conversation. Threads rebuilt from Slack history re-download and re-save
their images, so old threads recover on their own. Unsupported formats (only PNG, JPEG, GIF,
and WebP are passed through) and oversized files (`M8B_MEDIA_MAX_FILE_BYTES`, default 10 MB)
degrade to explicit notes. Without `M8B_MEDIA_BASE_URL` the bot falls back to inline base64
data URLs — functional for development, with a startup warning, but not for production.

Server-side deployment notes (outside this repo):

```nginx
# NGINX on the bot host: expose the media dir to the vLLM host ONLY
location /m8b-media/ {
    alias /var/lib/m8b/media/;
    allow <vLLM-host-IP>;
    deny all;
    autoindex off;
}
```

```ini
# vLLM systemd unit: restrict remote media fetching to the bot host (anti-SSRF)
# and enable the bounded media-download cache
# vllm serve ... --allowed-media-domains bm-linux-slack.internal.sentrysoftware.net
Environment=VLLM_MEDIA_URL_ALLOW_REDIRECTS=0
Environment=VLLM_MEDIA_CACHE=/var/lib/vllm/media-cache
Environment=VLLM_MEDIA_CACHE_MAX_SIZE_MB=4096
Environment=VLLM_MEDIA_CACHE_TTL_HOURS=24
```

### Tool availability per provider

| Capability            | OpenAI mode                        | Ollama mode                                                                                             |
| --------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------- |
| MetricsHub MCP tools  | ✅ (deferred namespaces)           | ✅ (plain function tools)                                                                               |
| Prometheus PromQL     | ✅                                 | ✅                                                                                                      |
| Slack reaction/reply  | ✅                                 | ✅                                                                                                      |
| Knowledge base search | ✅ hosted `file_search`            | ✅ local `search_knowledge_base` (after `kb:index`)                                                     |
| Knowledge base writes | ✅ vector store upload             | ✅ local markdown + embeddings                                                                          |
| Web search            | ✅ hosted `web_search_preview`     | ⚙️ app-side `web_search` via SearXNG or opt-in Ollama cloud                                             |
| Code Interpreter      | ✅ hosted sandbox                  | ⚙️ local Python sandbox (`run_python` via Pyodide/WebAssembly; see below)                               |
| File/image analysis   | ✅ via OpenAI Files API            | ⚙️ images described by a local vision model (`OLLAMA_VISION_MODEL`); data files staged for `run_python` |
| Conversation state    | Server-side `previous_response_id` | Application-side per-thread store                                                                       |
| Streaming             | ✅                                 | ✅                                                                                                      |

**vLLM mode** matches the Ollama column, with two differences: images are passed natively to
the multimodal model via the media store (no `OLLAMA_VISION_MODEL` sidecar), and knowledge-base
embeddings need a dedicated endpoint (`AI_EMBEDDING_BASE_URL` + `AI_EMBEDDING_MODEL`; without
them the knowledge base is disabled).

**OpenAI-compatible mode** also matches the Ollama column, with the model-dependent rows driven
by flags: file/image analysis is native (`AI_IMAGE_INPUT=true`, as in vLLM mode) or unavailable
for images (default; data files are still staged for `run_python`), and the knowledge base is
enabled by `AI_EMBEDDING_MODEL` (served from `AI_EMBEDDING_BASE_URL`, default `AI_BASE_URL`).

**Code Interpreter in Ollama mode:** the hosted `code_interpreter` is replaced by a local
`run_python` function tool backed by [Pyodide](https://pyodide.org) (CPython compiled to
WebAssembly, running in a worker thread). The WASM boundary is the sandbox: the generated code
sees no network and no host filesystem except `/data`, a per-execution NODEFS mount holding the
inputs staged by the app — user-attached data files (streamed into a persistent disk cache under
`CODE_SANDBOX_STAGING_DIR`, downloaded from Slack once per file version, capped per file by
`CODE_SANDBOX_MAX_INPUT_FILE_BYTES` and in total by `CODE_SANDBOX_STAGING_CACHE_MAX_BYTES`) and
large tool outputs as JSON. Reads stream from host disk, so large attachments are not copied into
the WASM heap up front; the mount only contains per-execution copies deleted after the run.
`/outputs` (files collected after the run and posted to the Slack thread) stays an in-memory
filesystem. numpy, pandas, matplotlib, and openpyxl load on
demand (downloaded once by the _host_ — from the Pyodide CDN, plus pinned PyPI wheels for
openpyxl — then cached in `CODE_SANDBOX_PACKAGE_CACHE_DIR`). Pyodide's `js` interop module — which would expose the host
JavaScript scope in Node — is stripped from the interpreter at startup, and every execution is
bounded by a hard timeout (`CODE_SANDBOX_TIMEOUT_MS`, default 60s) enforced with
`worker.terminate()`. Set `CODE_SANDBOX_ENABLED=false` to disable the tool entirely; the
system prompt then tells the model to provide file contents inline instead.

**Privacy note:** in Ollama, vLLM and OpenAI-compatible modes, prompts, documents, and tool
results never go to OpenAI, and never leave your network (beyond your own inference endpoint) unless you explicitly opt in to `WEB_SEARCH_PROVIDER=ollama-cloud` (which sends
the search query — not the conversation — to ollama.com).

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
- Context overflow: when server-side history grows past ~100k tokens (or a context-window
  error is hit), older messages are summarized with `gpt-4o-mini` (OpenAI mode only — local
  modes trim deterministically instead)

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
  (OpenAI), or flat function tools (Ollama/vLLM)
- **Utils**: Helper functions (token counting, output handling)

Conversation history uses OpenAI response IDs when available (OpenAI mode) or the application-
side per-thread store (local modes). On a cold start it reconstructs history from Slack,
excluding Slack's synthetic `assistant_app_thread` root so the initial user question is not
replayed as an assistant message.

### Integration tests against a live Ollama server

The normal test suite mocks all external services. An opt-in integration suite runs against a
real Ollama instance when the Ollama preset is selected with an explicit endpoint and model:

```bash
AI_PROVIDER=ollama AI_BASE_URL=http://dev-nvidia-01:11434/v1 AI_MODEL=qwen3.8:27b npm test
```

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Run `npm run validate` and, when working on typed interfaces, `npm run check`
5. Submit a pull request

## License

MIT License - see [LICENSE](LICENSE) for details.
