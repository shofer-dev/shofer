# Shofer Configuration Reference

Complete reference for all `shofer.*` VS Code settings. These are
configured in `settings.json` (user, workspace, or folder scope).

## Command Execution

### `shofer.allowedCommands`

|         |                                       |
| ------- | ------------------------------------- |
| Type    | `string[]`                            |
| Default | `["git log", "git diff", "git show"]` |
| Scope   | window                                |

Commands that can be automatically executed when "Always approve
execute operations" is enabled. Each entry is matched as a **prefix** —
`"git"` allows all git commands.

### `shofer.deniedCommands`

|         |            |
| ------- | ---------- |
| Type    | `string[]` |
| Default | `[]`       |
| Scope   | window     |

Command prefixes that are automatically denied without asking for
approval. When conflicting with `allowedCommands`, the **longest
prefix** wins. Use `"*"` to deny all commands.

### `shofer.commandExecutionTimeout`

|         |                  |
| ------- | ---------------- |
| Type    | `number`         |
| Default | `0` (no timeout) |
| Range   | 0–600 seconds    |
| Scope   | window           |

Maximum time to wait for a command to complete. `0` disables the
timeout.

### `shofer.commandTimeoutAllowlist`

|         |            |
| ------- | ---------- |
| Type    | `string[]` |
| Default | `[]`       |
| Scope   | window     |

Command prefixes exempt from the execution timeout. Commands matching
these prefixes run without time restrictions.

---

## Task Behaviour

### `shofer.preventCompletionWithOpenTodos`

|         |           |
| ------- | --------- |
| Type    | `boolean` |
| Default | `false`   |
| Scope   | window    |

When enabled, `attempt_completion` is refused if the task has
incomplete todo items.

### `shofer.newTaskRequireTodos`

|         |           |
| ------- | --------- |
| Type    | `boolean` |
| Default | `false`   |
| Scope   | window    |

When enabled, the `new_task` tool requires a `todos` parameter.

### `shofer.useAgentRules`

|         |           |
| ------- | --------- |
| Type    | `boolean` |
| Default | `true`    |
| Scope   | window    |

Enable loading `AGENTS.md` files for agent-specific rules. See
[agent-rules.org](https://agent-rules.org/).

---

## API & Providers

### `shofer.apiRequestTimeout`

|         |                    |
| ------- | ------------------ |
| Type    | `number`           |
| Default | `600` (10 minutes) |
| Range   | 0–3600 seconds     |
| Scope   | window             |

Maximum time to wait for API responses. Higher values recommended for
local providers (LM Studio, Ollama).

### `shofer.vsCodeLmModelSelector`

|         |          |
| ------- | -------- |
| Type    | `object` |
| Default | `{}`     |
| Scope   | window   |

Model selector for the VS Code Language Model API. Configures which
`vendor` and `family` the `vscode-lm` provider connects to.

| Child key | Type     | Description                         |
| --------- | -------- | ----------------------------------- |
| `vendor`  | `string` | Provider vendor (e.g., `"copilot"`) |
| `family`  | `string` | Model family (e.g., `"gpt-4"`)      |

### `shofer.enableLlmProviderIntegration`

|         |           |
| ------- | --------- |
| Type    | `boolean` |
| Default | `false`   |
| Scope   | window    |
| Since   | 3.56.x    |

Enable integration with the Shofer LLM Model Provider extension
(`extensions/llm-provider/`). When enabled, the `vscode-lm` provider
queries well-known commands for:

- `shofer.llm.getModelPricing` — per-token USD rates (Path 1)
- `shofer.llm.getRequestCost` — per-conversation cumulative cost (Path 2)
- `shofer.llm.getModelCapabilities` — tool calling, image input, prompt cache

These are **required** for cost-limit enforcement
([`cost-calculation-and-limits.md`](cost-calculation-and-limits.md)) and for the API Cost row to show
USD amounts. Without this setting, only token counts are available.

> **Note:** The llm-provider extension must be installed and active
> for this to work. If enabled but the commands are unavailable, the
> Shofer output channel will log a one-shot warning.

---

## Storage & UI

### `shofer.customStoragePath`

|         |                         |
| ------- | ----------------------- |
| Type    | `string`                |
| Default | `""` (default location) |
| Scope   | window                  |

Custom storage path for task history, checkpoints, and other
persistent data. Supports absolute paths (e.g.,
`"D:\\ShoferStorage"`).

### `shofer.enableCodeActions`

|         |           |
| ------- | --------- |
| Type    | `boolean` |
| Default | `true`    |
| Scope   | window    |

Enable Shofer Quick Fix code actions in the editor.

### `shofer.autoImportSettingsPath`

|         |                 |
| ------- | --------------- |
| Type    | `string`        |
| Default | `""` (disabled) |
| Scope   | window          |

Path to a Shofer configuration file to automatically import on
extension startup. Supports absolute paths and home-relative paths
(e.g., `"~/Documents/shofer-code-settings.json"`).

---

## Code Index & Search

### `shofer.maximumIndexedFilesForFileSearch`

|         |             |
| ------- | ----------- |
| Type    | `number`    |
| Default | `10000`     |
| Range   | 5000–500000 |
| Scope   | window      |

Maximum number of files to index for the `@`-file search feature.
Higher values improve search in large projects but consume more memory.

### `shofer.codeIndex.embeddingBatchSize`

|         |          |
| ------- | -------- |
| Type    | `number` |
| Default | `60`     |
| Scope   | window   |

Batch size for embedding operations during code indexing. Adjust to
match your API provider's limits.

---

## Debug & Diagnostics

### `shofer.debug`

|         |           |
| ------- | --------- |
| Type    | `boolean` |
| Default | `false`   |
| Scope   | window    |

Enable debug mode. Shows additional buttons for viewing the API
conversation history and UI messages as formatted JSON in temporary
files.

### `shofer.debugProxy.enabled`

|         |           |
| ------- | --------- |
| Type    | `boolean` |
| Default | `false`   |
| Scope   | window    |

Route all outgoing network requests through a proxy for MITM
debugging. Only active in debug mode (F5).

### `shofer.debugProxy.serverUrl`

|         |                           |
| ------- | ------------------------- |
| Type    | `string`                  |
| Default | `"http://127.0.0.1:8888"` |
| Scope   | window                    |

Proxy URL. Only used when `debugProxy.enabled` is `true`.

### `shofer.debugProxy.tlsInsecure`

|         |           |
| ------- | --------- |
| Type    | `boolean` |
| Default | `false`   |
| Scope   | window    |

Accept self-signed certificates from the proxy. Required for MITM
inspection. Use only for local debugging.

---

## Global Settings (JSON-only, no settings UI)

These settings are stored via `contextProxy.getValue()` and are
available in `globalSettingsSchema` but do not have settings-panel
rows yet. Configure them directly in `settings.json`.

### `shofer.defaultCostLimit`

```jsonc
{
	"shofer.defaultCostLimit": {
		"maxUsd": 0, // positive number = cap in USD
		"action": "pause", // "pause" | "abort" | "kill"
	},
}
```

Default per-root-task USD budget cap applied to all new tasks. When
`maxUsd` is `0` or unset, cost limiting is disabled. See
[`cost-calculation-and-limits.md`](cost-calculation-and-limits.md) for details.

### `shofer.disabledTools`

```jsonc
{
	"shofer.disabledTools": ["tool_name_1", "tool_name_2"],
}
```

List of native tool names to globally disable. Tools in this list are
excluded from prompt generation and rejected at execution time.
