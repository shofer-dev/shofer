# Mock Providers (`mock` and `fake-ai`)

Shofer ships two _faux providers_ — [`mock`](../src/api/providers/mock.ts) and
[`fake-ai`](../src/api/providers/fake-ai.ts) — that let the agent loop run
without a real LLM. Neither makes external inference calls nor requires API
credentials. Together they appear in the `fauxProviders` array in
[`provider-settings.ts`](../packages/types/src/provider-settings.ts:97).

## Overview

| Aspect            | `mock`                                        | `fake-ai`                                                      |
| ----------------- | --------------------------------------------- | -------------------------------------------------------------- |
| Response logic    | Built-in (hard-coded + env vars + JSON files) | External (injected `FakeAI` object)                            |
| Control mechanism | Environment variables                         | Programmatic object injection                                  |
| Use case          | CLI-driven automated functional tests         | Extensibility — custom AI backends from plugins                |
| Multi-turn        | Yes (cursor-based scenario replay)            | Delegated to injected implementation                           |
| Identity tracking | Stateless beyond per-instance cursor          | Module-scoped `Map<string, FakeAI>` for serialization survival |

---

## 1. `mock` Provider

[`MockHandler`](../src/api/providers/mock.ts:200) is a self-contained mock that
returns canned responses, emits realistic streaming chunks, and replays
multi-turn tool-call sequences. It is the primary driver of Shofer's automated
functional test suite.

### 1.1 Invocation

```bash
# All mock invocations use --provider mock --model mock.
# The --api-key value is ignored (the mock provider needs no credentials).

pnpm --filter @shofer/cli exec tsx src/index.ts \
  --provider mock --api-key x --model mock \
  -w /path/to/workspace \
  --print "Your prompt here"
```

The `mock` and `fake-ai` providers both skip the credential check in
[`checkExistApiConfig.ts`](../src/shared/checkExistApiConfig.ts:9). The CLI
explicitly exempts `mock` from the API-key requirement in
[`run.ts`](../apps/cli/src/commands/cli/run.ts:192).

### 1.2 Control Mechanisms (Priority Order)

The mock provider has four control levels, evaluated in descending priority:

#### Level 1 — `MOCK_TOOL_NAME` + `MOCK_TOOL_ARGS`

Force a specific tool call on every agent turn. The mock does **not** emit an
`attempt_completion` — the tool result from the agent loop feeds into the next
`createMessage` call, and if the same env vars are still set the same tool is
called again. Use this to test tool execution round-trips.

```bash
MOCK_TOOL_NAME=read_file \
MOCK_TOOL_ARGS='{"path": "package.json"}' \
pnpm --filter @shofer/cli exec tsx src/index.ts \
  --provider mock --model mock -w . --print "Read the package file"
```

`MOCK_TOOL_ARGS` can be a pre-serialized JSON string or omitted entirely (defaults to `{}`).

#### Level 2 — `MOCK_RESPONSES_PATH`

Load a multi-turn scenario file. The provider matches the user prompt
(case-insensitive substring) against `scenarios[].match`, pins the matched
scenario for the lifetime of the task, and replays one turn per `createMessage`
call, advancing an instance-local cursor.

```bash
MOCK_RESPONSES_PATH=/path/to/scenarios.json \
pnpm --filter @shofer/cli exec tsx src/index.ts \
  --provider mock --model mock -w . --print "do something multi-step"
```

#### Level 3 — `MOCK_RESPONSE`

Simple text response wrapped in an `attempt_completion` tool call. The agent
loop receives a completion with the given text and exits.

```bash
MOCK_RESPONSE="Hello from mock!" \
pnpm --filter @shofer/cli exec tsx src/index.ts \
  --provider mock --model mock -w . --print "say hello"
```

#### Level 4 — Built-in Defaults

When none of the above are set, the prompt is matched against a built-in table
of 19 scenarios (case-insensitive substring match, longest match first):

| Prompt contains  | Response                      |
| ---------------- | ----------------------------- |
| `DEEPSEEK_OK`    | `DEEPSEEK_OK`                 |
| `2+2`            | `4`                           |
| `STREAM_OK`      | `STREAM_OK`                   |
| `STORED`         | `STORED`                      |
| `EPHEMERAL_OK`   | `EPHEMERAL_OK`                |
| `API_OK`         | `API_OK`                      |
| `TASK_ONE`       | `TASK_ONE`                    |
| `TASK_TWO`       | `TASK_TWO`                    |
| `EXPORT_TEST`    | `EXPORT_TEST`                 |
| `SUBTASK_OK`     | `SUBTASK_OK`                  |
| `SESSION_MARKER` | `SESSION_MARKER`              |
| `SELECTOR_TEST`  | `SELECTOR_TEST`               |
| `BANANA`         | `BANANA`                      |
| `SHELL_OK`       | `SHELL_OK`                    |
| `WRITE_OK`       | `WRITE_OK`                    |
| `WORKFLOW_OK`    | `WORKFLOW_OK`                 |
| `42`             | `42`                          |
| `Hello`          | `Hello! Mock assistant here.` |
| `number`         | `42`                          |

If nothing matches, the fallback response is `"OK"`.

### 1.3 Scenario File Format

A scenario file is a JSON document with the following schema (validated via
Zod at load time — malformed files fall back to built-in scenarios):

```json
{
  "scenarios": [
    {
      "match": "substring in prompt (case-insensitive)",
      "response": "optional single-turn text → attempt_completion",
      "turns": [
        { "text": "optional plain text response" },
        { "reasoning": "optional thinking text before tool call" },
        { "tool": { "name": "tool_name", "arguments": { ... } } },
        { "response": "shorthand for attempt_completion" }
      ]
    }
  ]
}
```

Each `scenarios` entry must have a `match` field. A scenario can be:

- **Single-turn**: provide `response` (no `turns`). The entire response is
  emitted as an `attempt_completion` tool call on the first turn.
- **Multi-turn**: provide `turns` (no `response`). Each turn is replayed in
  order, one per `createMessage` call. If the scenario runs out of turns, it
  falls through to the built-in/MOCK_RESPONSE fallback on subsequent calls.

Each `MockTurn` object supports:

| Field       | Description                                                                                                                                                                                                            |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reasoning` | Optional thinking text emitted as a `reasoning` chunk (simulates extended thinking).                                                                                                                                   |
| `text`      | Optional plain text emitted as a `text` chunk.                                                                                                                                                                         |
| `tool`      | A tool call with `name` (string) and `arguments` (object or JSON string). Emitted via the `tool_call_partial`/`tool_call_end` streaming contract so `NativeToolCallParser` consumes it identically to a real provider. |
| `response`  | Shorthand — wraps the string in an `attempt_completion` tool call. Mutually exclusive with `tool` (if both present, `tool` wins).                                                                                      |

### 1.4 Multi-Turn Scenario Examples

#### Single tool call + completion

```json
{
	"scenarios": [
		{
			"match": "read the secret file",
			"turns": [
				{ "tool": { "name": "read_file", "arguments": { "path": "secret.txt" } } },
				{ "response": "READ_DONE" }
			]
		}
	]
}
```

This makes the agent call `read_file(path="secret.txt")` on turn 1, then
`attempt_completion(result="READ_DONE")` on turn 2.

#### Multi-turn with shell execution

```json
{
	"scenarios": [
		{
			"match": "run the marker command",
			"turns": [
				{
					"tool": {
						"name": "execute_command",
						"arguments": { "command": "echo EXEC_MARKER > /tmp/out.txt" }
					}
				},
				{ "response": "EXEC_DONE" }
			]
		}
	]
}
```

#### Subtask (new_task) scenario

The parent task matches one scenario, the spawned subtask matches another:

```json
{
	"scenarios": [
		{
			"match": "delegate work to a subtask",
			"turns": [
				{
					"tool": {
						"name": "new_task",
						"arguments": {
							"mode": "code",
							"message": "Reply with exactly SUBTASK_OK"
						}
					}
				},
				{ "response": "PARENT_DONE" }
			]
		},
		{
			"match": "SUBTASK_OK",
			"response": "SUBTASK_COMPLETE"
		}
	]
}
```

#### Text + reasoning + tool

```json
{
	"scenarios": [
		{
			"match": "analyze and report",
			"turns": [
				{ "reasoning": "Let me think about this step by step..." },
				{ "tool": { "name": "read_file", "arguments": { "path": "data.json" } } },
				{ "text": "The file contains valid JSON with 3 keys." },
				{ "response": "Analysis complete" }
			]
		}
	]
}
```

### 1.5 Streaming Contract

The mock provider emits the same streaming chunk types as real providers:

- `tool_call_partial` (initial chunk with `id` + `name`) →
- `tool_call_partial` (argument fragments, 24 bytes each) →
- `tool_call_end`
- `usage` (fake token counts + $0 cost)

This means `NativeToolCallParser` and the agent loop consume mock output
identically to real provider output. The older `tool_call_start`/`tool_call_delta`
chunks are **not** read by the agent loop and are not emitted by the mock.

### 1.6 CLI Flags Compatible with `mock`

All CLI flags work with the mock provider, but certain flags are especially
useful in test scenarios:

```bash
# Print mode — run to completion and print result
--print "prompt"

# Ephemeral — leave no task files behind
--ephemeral

# Session persistence — resume a previous mock session
--session-id <uuid>

# Create with known session ID
--create-with-session-id <uuid>

# Output formats
--output-format text       # default
--output-format json       # { success, content, cost, ... }
--output-format stream-json  # NDJSON event stream

# Mode switching
--mode architect
--mode code

# Stdin prompt stream (NDJSON control protocol)
--stdin-prompt-stream
```

---

## 2. `fake-ai` Provider

[`FakeAIHandler`](../src/api/providers/fake-ai.ts:43) is a **pure proxy** — it
contains no response logic of its own. Every method delegates to an externally
injected `FakeAI` object. This makes it the extensibility hook for plugins and
custom AI backends.

### 2.1 The `FakeAI` Interface

```typescript
interface FakeAI {
	/** Unique identifier — survives VS Code global state serialization. */
	readonly id: string

	/** Internal: removed from the module-scoped cache when no longer needed. */
	removeFromCache?: () => void

	createMessage(
		systemPrompt: string,
		messages: Anthropic.Messages.MessageParam[],
		metadata?: ApiHandlerCreateMessageMetadata,
	): ApiStream

	getModel(): { id: string; info: ModelInfo }

	countTokens(content: Array<Anthropic.Messages.ContentBlockParam>): Promise<number>

	completePrompt(prompt: string): Promise<string>
}
```

Any object implementing this interface can be injected as a provider by setting
`apiProvider: "fake-ai"` and including the object as the `fakeAi` field in the
API configuration.

### 2.2 Object Identity Across Serialization

Provider configurations are persisted in VS Code global state. When a config is
serialized and later rehydrated, the `FakeAI` object loses its methods (only
plain JSON survives). To handle this, `FakeAIHandler` maintains a module-scoped
`Map<string, FakeAI>` ([line 41](../src/api/providers/fake-ai.ts:41)):

1. The caller creates a `FakeAI` object with a unique `id` and injects it into
   the API config as `{ apiProvider: "fake-ai", fakeAi: <the object> }`.
2. On first construction, `FakeAIHandler` stores the object in the map keyed by
   `id` and attaches a `removeFromCache` callback.
3. On subsequent rehydrations, the handler looks up the **original** live object
   by `id` rather than using the serialized shell.

### 2.3 Usage

```typescript
import { ShoferProvider } from ".../ShoferProvider"

const fakeAi: FakeAI = {
	id: "my-custom-ai-v1",
	createMessage(systemPrompt, messages, metadata) {
		// Return an ApiStream — can be synchronous or async generator.
		// Must conform to the chunk types the agent loop expects.
	},
	getModel() {
		return {
			id: "custom-model",
			info: {
				maxTokens: 4096,
				contextWindow: 128_000,
				inputPrice: 0,
				outputPrice: 0,
				supportsPromptCache: false,
				supportsImages: false,
				description: "Custom mock AI backend",
			},
		}
	},
	async countTokens(content) {
		return content.length * 2 // simplistic estimation
	},
	async completePrompt(prompt) {
		return `Response to: ${prompt.slice(0, 50)}...`
	},
}

// Inject into provider settings
await providerSettingsManager.upsertApiConfiguration("custom-ai-profile", {
	apiProvider: "fake-ai",
	fakeAi, // ← the live FakeAI object
	apiModelId: "custom-model",
})

// The fake-ai provider is now available for use like any other provider.
```

### 2.4 When to Use `fake-ai` vs `mock`

| Need                                                            | Use                            |
| --------------------------------------------------------------- | ------------------------------ |
| CLI-driven functional tests with canned tool calls              | `mock` + env vars              |
| Multi-turn scenario replay from JSON files                      | `mock` + `MOCK_RESPONSES_PATH` |
| Programmatic control over LLM responses at runtime              | `fake-ai`                      |
| Plugin-provided AI backends (e.g., custom inference endpoints)  | `fake-ai`                      |
| Testing a companion extension that needs to drive Shofer's loop | `fake-ai`                      |
| Quick ad-hoc CLI smoke tests                                    | `mock` (no setup needed)       |

---

## 3. Complete Test Example

The functional test suite in [`todos/test_cli.md`](../../todos/test_cli.md) and
[`todos/cli-tests/test_cli.sh`](../../todos/cli-tests/test_cli.sh) exercises the
mock provider across 25 scenarios including:

- Basic print roundtrip (built-in scenario match)
- JSON and stream-JSON output formats
- Stdin prompt stream with follow-up messages
- Session persistence and ephemeral mode
- Tool execution: `read_file`, `execute_command`, `write_to_file`
- Subtask spawning (`new_task` tool)
- Mode switching (`--mode architect`)
- ShoferAPI library (programmatic API via ExtensionHost)

Run the full suite:

```bash
bash todos/cli-tests/test_cli.sh
```

---

## 4. Reference Files

| File                                                                                    | Role                                                 |
| --------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| [`src/api/providers/mock.ts`](../src/api/providers/mock.ts)                             | Mock provider implementation                         |
| [`src/api/providers/fake-ai.ts`](../src/api/providers/fake-ai.ts)                       | FakeAI proxy/delegation handler                      |
| [`packages/types/src/provider-settings.ts`](../packages/types/src/provider-settings.ts) | `fauxProviders` array, `FakeAI` schema, `mockSchema` |
| [`src/shared/checkExistApiConfig.ts`](../src/shared/checkExistApiConfig.ts)             | Credential skip for `fake-ai` and `mock`             |
| [`apps/cli/src/commands/cli/run.ts`](../apps/cli/src/commands/cli/run.ts)               | CLI API-key exemption for `mock`                     |
| [`todos/test_cli.md`](../../todos/test_cli.md)                                          | Test scenario specifications                         |
| [`todos/cli-tests/test_cli.sh`](../../todos/cli-tests/test_cli.sh)                      | Executable test suite                                |
| [`todos/cli-tests/mock_llm_server.py`](../../todos/cli-tests/mock_llm_server.py)        | Alternative: HTTP mock server (OpenAI-compatible)    |
