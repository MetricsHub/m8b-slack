# Live AI tests

Two harnesses verify that the bot and the LLM still behave as intended. Both use the real AI
provider (OpenAI or Ollama, whatever the environment selects) and the real MCP servers, and both
share the scenario list in [`scenarios.js`](scenarios.js). Hard expectations are regexes; soft
expectations are graded by an LLM judge ([`judge.js`](judge.js)) running on the same provider.

Both need the bot's dev environment loaded first:

```cmd
cmd /c "call .env.dev.cmd && npm run test:live"
cmd /c "call .env.dev.cmd && npm run test:e2e"
```

Exit codes: `0` all scenarios passed, `1` at least one failure, `2` environment not usable.

## `npm run test:live` — respond() seam

Drives `ai/respond.js` directly with a fake Slack client. No Slack connection, no bot process —
just the LLM + tools + MCP. Fast enough to run after every AI-related change. This harness can
also assert that tool calls actually happened (`expectToolCall`).

## `npm run test:e2e` — full Slack round-trip

Starts the bot (`node app.js`), sends each prompt as a real user DM to the bot, waits for the
threaded reply (polling until the streamed text stabilizes), and evaluates it. Catches
listener/Bolt/Socket Mode regressions the seam test cannot.

### One-time setup: SLACK_TEST_USER_TOKEN

The DMs must come from a **user** (the bot ignores bot-authored messages), so the script needs a
user token (`xoxp-...`):

1. Open the M8B app config at <https://api.slack.com/apps> → _OAuth & Permissions_.
2. Under **User Token Scopes** add: `chat:write`, `im:write`, `im:history`.
3. Reinstall the app to the workspace and copy the **User OAuth Token** (`xoxp-...`).
4. Add to `.env.dev.cmd`: `SET SLACK_TEST_USER_TOKEN=xoxp-...`

### Options

| Variable            | Effect                                                        |
| ------------------- | ------------------------------------------------------------- |
| `E2E_ATTACH=1`      | Don't spawn the bot; test against an already-running instance |
| `E2E_DM_CHANNEL=D…` | Use this DM channel instead of `conversations.open`           |
| `E2E_VERBOSE=1`     | Stream bot logs / verbose harness output                      |

## Adding scenarios

Append to `SCENARIOS` in [`scenarios.js`](scenarios.js):

```js
{
	name: "my-scenario",
	prompt: "The message to send",
	mustMatch: /expected/i,        // optional hard assertion
	expectToolCall: true,           // optional, test:live only
	judge: "What a correct answer must do", // optional soft assertion (LLM judge)
	timeoutMs: 180000,
}
```
