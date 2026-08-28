# AGENTS.md - AI Agent Instructions for M8B Slackbot

This document provides instructions for AI agents working on this codebase.

## Project Overview

M8B is a Slack bot powered by OpenAI (hosted), Ollama, or vLLM (both local, OpenAI-compatible `/v1/responses`) that acts as a grumpy but competent system administrator. It integrates with MetricsHub via MCP (Model Context Protocol) to provide monitoring and infrastructure insights. The AI backend is selected with `AI_PROVIDER` and abstracted behind `ai/providers/` — application code depends on provider capability flags, not provider names.

## Tech Stack

- **Runtime**: Node.js 20+
- **Framework**: @slack/bolt (Socket Mode)
- **AI**: OpenAI SDK (Responses API with streaming)
- **MCP**: @modelcontextprotocol/sdk for tool integration
- **Testing**: Jest with ES modules
- **Linting**: Biome
- **Formatting**: Prettier

## Project Structure

```
m8b-slackbot/
├── app.js                 # Entry point (logs AI provider + health check)
├── ai/
│   ├── config/            # AI configuration (system prompt, model settings, provider env)
│   ├── providers/         # AI provider abstraction (openai / ollama)
│   ├── services/          # Core services (OpenAI, streaming, citations, local KB, etc.)
│   ├── tools/             # OpenAI tool definitions
│   ├── utils/             # Utilities (tokens, output handling, JSON parsing)
│   ├── respond.js         # Main AI response orchestrator
│   ├── mcp_registry.js    # MCP server management
│   └── prometheus.js      # PromQL integration
├── scripts/               # KB migration/indexing CLI scripts (kb:export, kb:index)
├── listeners/
│   ├── actions/           # Slack interactive actions
│   ├── agent/             # Agent messaging handlers (app home, context, messages)
│   ├── events/            # Slack event handlers
│   └── views/             # Slack views (modals, blocks)
└── __tests__/             # Test files (co-located with source in __tests__ folders)
```

## Code Style Guidelines

### General Rules

1. **ES Modules**: This project uses ES modules (`"type": "module"` in package.json). Use `import`/`export` syntax.
2. **Double quotes** for strings
3. **Semicolons** required
4. **Tab indentation**
5. **100 character line width** (soft limit)
6. **Trailing commas** in multi-line structures (ES5 style)
7. **Native line endings** per OS (git autocrlf gives CRLF on Windows, LF on Linux; Prettier uses endOfLine auto; Biome's formatter is disabled — it only lints — so EOLs are never enforced by tooling)

### Naming Conventions

- **Files**: kebab-case (`context-manager.js`, `slack-files.js`)
- **Functions/Variables**: camelCase (`buildConversationInput`, `vectorStoreIds`)
- **Constants**: UPPER_SNAKE_CASE (`MAX_INLINE_OUTPUT_CHARS`, `TOKEN_LIMITS`)
- **Classes**: PascalCase (`StatusUpdater`)

### Code Organization

- Keep functions focused and single-purpose
- Use JSDoc comments for exported functions
- Place related code in appropriate service modules
- Co-locate tests with source code in `__tests__/` directories

## Formatting Instructions

**IMPORTANT: Do not manually format code while editing.**

When making code changes:

1. Focus on correctness and functionality
2. Don't worry about formatting during edits
3. After completing your changes, run Prettier:

```bash
npm run format
```

This will automatically format all files according to project settings.

To check formatting without making changes:

```bash
npm run format:check
```

## Linting

Run Biome linter to catch code quality issues:

```bash
npm run lint        # Check for issues
npm run lint:fix    # Auto-fix issues
```

## Testing

### Running Tests

```bash
npm test              # Run all tests
npm run test:watch    # Watch mode
npm run test:coverage # With coverage report
```

### Live AI Tests (require the dev environment)

Scenario-based tests against the real AI provider and MCP servers (see `e2e/README.md`):

```bash
npm run test:live   # Drives ai/respond.js directly (fake Slack client, real LLM + MCP)
npm run test:e2e    # Full Slack round-trip: spawns the bot, DMs it, asserts on the reply
```

Both need the dev variables loaded first (e.g. `cmd /c "call .env.dev.cmd && npm run test:live"`).
`test:e2e` additionally needs `SLACK_TEST_USER_TOKEN`. Scenarios are shared in `e2e/scenarios.js`;
soft expectations are graded by an LLM judge on the same provider. These are NOT run by `npm test`
or `npm run validate` — they need live backends.

### Writing Tests

- Place test files in `__tests__/` directories next to the source files
- Name test files as `<module>.test.js`
- Import from `@jest/globals` for Jest functions:

```javascript
import { describe, it, expect, jest, beforeEach } from "@jest/globals";
```

- Mock external dependencies (OpenAI, Slack client, etc.)
- Test edge cases and error handling

### Test Structure Example

```javascript
import { describe, it, expect } from "@jest/globals";
import { myFunction } from "../my-module.js";

describe("myFunction", () => {
	it("should handle normal input", () => {
		const result = myFunction("input");
		expect(result).toBe("expected");
	});

	it("should handle edge cases", () => {
		expect(myFunction(null)).toBeNull();
		expect(myFunction("")).toBe("");
	});
});
```

## Validation Workflow

Before committing, run the full validation:

```bash
npm run validate
```

This runs: `format:check` → `lint` → `test` (TypeScript type checking is separate:
`npm run check` — run it too when touching typed interfaces)

## Environment Setup

1. Copy `.env.example` to `.env`
2. Fill in required values:
   - `SLACK_BOT_TOKEN` - Bot OAuth token (xoxb-...)
   - `SLACK_APP_TOKEN` - App-level token (xapp-...)
   - `OPENAI_API_KEY` - OpenAI API key (OpenAI mode)
3. To use a local model instead of OpenAI, set `AI_PROVIDER=ollama` plus
   `OLLAMA_BASE_URL`, `OLLAMA_MODEL`, and `OLLAMA_EMBEDDING_MODEL`, or
   `AI_PROVIDER=vllm` plus `VLLM_BASE_URL`/`VLLM_API_KEY` (and `M8B_MEDIA_*`
   for URL-based screenshot handling) — see README

## Common Tasks

### Adding a New Service

1. Create file in `ai/services/` (e.g., `my-service.js`)
2. Export functions from `ai/services/index.js`
3. Add tests in `ai/services/__tests__/my-service.test.js`
4. Run `npm run format && npm run validate`

### Adding a New Tool

1. Define tool schema in `ai/tools/index.js`
2. Add handler in `ai/services/function-calls.js`
3. Add tests for the handler
4. Run `npm run format && npm run validate`

### Modifying AI Behavior

1. Edit system prompt in `ai/config/system-prompt.js` (note: `buildSystemPrompt()` rewrites
   hosted-tool instructions for providers without them — keep its replacement strings in sync)
2. Adjust model parameters in `MODEL_CONFIG` (OpenAI) or `OLLAMA_*` env vars (Ollama) if needed
3. Test conversationally before committing

### Working on the Provider Abstraction

- Provider selection/config: `ai/config/providers.js`; provider objects: `ai/providers/`
- Never scatter `if (provider === "ollama")` through the app — branch on
  `provider.capabilities.*` flags instead
- Ollama's `/v1/responses` is stateless: no `previous_response_id`/`conversation`. Its request
  builder must only emit fields Ollama supports (model, input, instructions, tools, stream,
  temperature, top_p, max_output_tokens)
- vLLM is used statelessly too (its Responses store is unbounded/in-memory, so
  `previous_response_id` is deliberately not used). Its model is multimodal:
  `capabilities.imageInput` — images go in as `input_image` items (the `detail` field is
  REQUIRED by vLLM's schema) referencing local media-store URLs (`ai/services/media-store.js`),
  falling back to base64 data URLs when `M8B_MEDIA_BASE_URL` is unset
- In local modes (ollama/vllm), never send data to OpenAI (no silent fallback)

## Key Files Reference

| File                                | Purpose                                                      |
| ----------------------------------- | ------------------------------------------------------------ |
| `ai/respond.js`                     | Main AI response orchestrator                                |
| `ai/config/system-prompt.js`        | AI personality and configuration                             |
| `ai/services/streaming.js`          | OpenAI streaming response handling                           |
| `ai/services/function-calls.js`     | Tool/function call processing                                |
| `ai/services/tool-middleware.js`    | Tool output caching, compression, telemetry Markdown tables  |
| `ai/tools/index.js`                 | OpenAI tool definitions                                      |
| `ai/mcp_registry.js`                | MCP server discovery and management                          |
| `ai/providers/index.js`             | AI provider abstraction                                      |
| `ai/config/providers.js`            | Provider env configuration                                   |
| `ai/services/conversation-store.js` | App-side thread state (local modes)                          |
| `ai/services/knowledge-base.js`     | Local RAG knowledge base (local modes)                       |
| `ai/services/media-store.js`        | Local image store served to the vLLM host by URL             |
| `ai/services/code-sandbox.js`       | Local Python sandbox for run_python (local modes, Pyodide)   |
| `ai/services/web-search.js`         | App-side web search backends                                 |
| `ai/services/metricshub-api.js`     | MetricsHub Agent REST API client (config files, encryption)  |
| `ai/services/config-editor.js`      | Config-editing tool handlers (auth, validate, approve, save) |
| `ai/services/config-credentials.js` | Thread-scoped {{CRED:...}} placeholders for secrets          |
| `ai/services/yaml-resources.js`     | Locate/splice resource entries in MetricsHub config YAML     |
| `ai/services/slack-interactions.js` | Pending human interactions (modals, approval buttons)        |

## Error Handling

- Use try/catch for async operations
- Log errors with appropriate context
- Return graceful fallbacks when possible
- Don't expose internal errors to users

## Dependencies

- Avoid adding new dependencies unless necessary
- Prefer native Node.js APIs when available
- Check existing utilities before creating new ones
