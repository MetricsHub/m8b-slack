# AGENTS.md - AI Agent Instructions for M8B Slackbot

This document provides instructions for AI agents working on this codebase.

## Project Overview

M8B is a Slack bot powered by OpenAI that acts as a grumpy but competent system administrator. It integrates with MetricsHub via MCP (Model Context Protocol) to provide monitoring and infrastructure insights.

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
├── app.js                 # Entry point
├── ai/
│   ├── config/            # AI configuration (system prompt, model settings)
│   ├── services/          # Core services (OpenAI, streaming, citations, etc.)
│   ├── tools/             # OpenAI tool definitions
│   ├── utils/             # Utilities (tokens, output handling, JSON parsing)
│   ├── respond.js         # Main AI response orchestrator
│   ├── mcp_registry.js    # MCP server management
│   └── prometheus.js      # PromQL integration
├── listeners/
│   ├── actions/           # Slack interactive actions
│   ├── assistant/         # Assistant thread handlers
│   └── events/            # Slack event handlers
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
7. **Automatic line endings** (uses native EOL for your OS)

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

This runs: `format:check` → `lint` → `check` (TypeScript) → `test`

## Environment Setup

1. Copy `.env.example` to `.env`
2. Fill in required values:
   - `SLACK_BOT_TOKEN` - Bot OAuth token (xoxb-...)
   - `SLACK_APP_TOKEN` - App-level token (xapp-...)
   - `OPENAI_API_KEY` - OpenAI API key

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

1. Edit system prompt in `ai/config/system-prompt.js`
2. Adjust model parameters in `MODEL_CONFIG` if needed
3. Test conversationally before committing

## Key Files Reference

| File                            | Purpose                             |
| ------------------------------- | ----------------------------------- |
| `ai/respond.js`                 | Main AI response orchestrator       |
| `ai/config/system-prompt.js`    | AI personality and configuration    |
| `ai/services/streaming.js`      | OpenAI streaming response handling  |
| `ai/services/function-calls.js` | Tool/function call processing       |
| `ai/tools/index.js`             | OpenAI tool definitions             |
| `ai/mcp_registry.js`            | MCP server discovery and management |

## Error Handling

- Use try/catch for async operations
- Log errors with appropriate context
- Return graceful fallbacks when possible
- Don't expose internal errors to users

## Dependencies

- Avoid adding new dependencies unless necessary
- Prefer native Node.js APIs when available
- Check existing utilities before creating new ones
