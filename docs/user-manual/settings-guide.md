# Shofer Settings — Your Complete Configuration Reference

Shofer has dozens of settings that control how tools behave, how much you spend,
what commands can run automatically, and more. This guide explains where settings
live, how to find them, and how to configure the ones that don't appear in the
VS Code Settings UI.

---

## Two Kinds of Settings

Shofer stores settings in two places:

| How You See Them        | Where They Live                                 | How to Configure                         |
| ----------------------- | ----------------------------------------------- | ---------------------------------------- |
| **VS Code Settings UI** | `settings.json` under `shofer.*` keys           | VS Code Settings editor (⌘, or `Ctrl+,`) |
| **JSON-only settings**  | Same `settings.json` file under `shofer.*` keys | Edit `settings.json` directly            |

### Settings You Can Edit in the VS Code Settings UI

These appear in the VS Code Settings editor under the **Shofer** category.
You can browse them by typing `shofer.` in the Settings search bar.

<!-- XXX: Screenshot — VS Code Settings UI with "shofer." typed in the search bar, showing a dropdown/list of Shofer settings. Call out the "Shofer" section header in the left sidebar tree. -->

The most commonly used settings with UI controls:

| Setting                                   | What It Does                                               | Default                               |
| ----------------------------------------- | ---------------------------------------------------------- | ------------------------------------- |
| `shofer.allowedCommands`                  | Commands auto-executed when "Always approve execute" is on | `["git log", "git diff", "git show"]` |
| `shofer.deniedCommands`                   | Command prefixes that are always blocked                   | `[]`                                  |
| `shofer.preventCompletionWithOpenTodos`   | Block task completion when todos are open                  | `false`                               |
| `shofer.apiRequestTimeout`                | Max wait for API responses (seconds)                       | `600`                                 |
| `shofer.vsCodeLmModelSelector`            | Vendor & family for the `vscode-lm` provider               | `{}`                                  |
| `shofer.enableLlmProviderIntegration`     | Enable USD cost tracking via llm-provider extension        | `false`                               |
| `shofer.customStoragePath`                | Override where task history lives                          | `""` (default)                        |
| `shofer.enableCodeActions`                | Show Shofer Quick Fix suggestions in editor                | `true`                                |
| `shofer.autoImportSettingsPath`           | Auto-import a settings file on startup                     | `""` (disabled)                       |
| `shofer.maximumIndexedFilesForFileSearch` | Max files to index for `@`-file search                     | `10000`                               |
| `shofer.codeIndex.embeddingBatchSize`     | Batch size for code indexing operations                    | `60`                                  |
| `shofer.debug`                            | Show debug buttons (API history, UI messages)              | `false`                               |
| `shofer.debugProxy.enabled`               | Route requests through a proxy for debugging               | `false`                               |
| `shofer.debugProxy.serverUrl`             | Proxy URL                                                  | `http://127.0.0.1:8888`               |
| `shofer.debugProxy.tlsInsecure`           | Accept self-signed proxy certificates                      | `false`                               |

### Settings You Must Edit in `settings.json` Directly

These settings do **not** appear in the VS Code Settings UI. You must open
your `settings.json` file and add them manually. To open `settings.json`:

1. Open the Command Palette (⌘⇧P / `Ctrl+Shift+P`)
2. Type **Preferences: Open User Settings (JSON)**
3. Add Shofer settings under the top-level JSON object

<!-- XXX: Screenshot — VS Code with settings.json open, showing a few `shofer.*` keys added manually (e.g. `shofer.defaultCostLimit`, `shofer.disabledTools`, `shofer.useAgentRules`). An arrow annotation should point to one of the keys showing they're valid JSON under the top-level `{...}`. -->

The most important JSON-only settings:

| Setting                          | What It Does                                  | Default           |
| -------------------------------- | --------------------------------------------- | ----------------- |
| `shofer.defaultCostLimit`        | Per-task USD budget cap                       | `null` (disabled) |
| `shofer.disabledTools`           | Globally disable specific tools               | `[]`              |
| `shofer.useAgentRules`           | Load `AGENTS.md` rule files from your project | `true`            |
| `shofer.commandExecutionTimeout` | Max seconds for command execution             | `0` (no timeout)  |
| `shofer.commandTimeoutAllowlist` | Commands exempt from the timeout              | `[]`              |

> **⚡ Important:** The command timeout settings are `shofer.commandExecutionTimeout`
> and `shofer.commandTimeoutAllowlist`. Do **not** use `shofer.devmandExecutionTimeout`
> or `shofer.devmandTimeoutAllowlist` — those are old, non-functional keys that
> appear in search results but have no effect.

### Settings in Both Places

Some settings appear in both the VS Code Settings UI AND as JSON-only keys.
For these, the two copies are stored independently — editing one does **not**
automatically update the other.

| Setting                               | Where to Edit                                                                  |
| ------------------------------------- | ------------------------------------------------------------------------------ |
| `shofer.enableLlmProviderIntegration` | Both. Prefer the Settings UI toggle.                                           |
| `shofer.allowedCommands`              | Settings UI (the top-level array). The GlobalState copy is managed internally. |

If you're unsure which copy is active, use the **Export** button in
Settings → About to see the complete merged configuration.

---

## Finding All Available Settings

### Method 1: The VS Code Settings UI

Open Settings (⌘, / `Ctrl+,`) and type `shofer.` in the search bar. This shows
only settings with UI controls.

### Method 2: Settings JSON

Open your `settings.json` and type `"shofer.` — VS Code's auto-complete will
suggest all known `shofer.*` keys, including JSON-only ones that have been
declared in the extension manifest.

### Method 3: Full Export

Settings → About → **Export** produces a `shofer-code-settings.json` file
containing **every** current setting value. This is the most complete snapshot
of your configuration.

---

## Quick Tips

- **Resetting a JSON-only setting to default:** Remove the key from
  `settings.json` entirely. Shofer will use the built-in default.
- **Disabling the cost limit:** Set `"shofer.defaultCostLimit": null` in
  `settings.json` — not `"maxUsd": 0` (zero is not a valid value for the
  schema and will be rejected).
- **Disabling a tool globally:** Add its snake_case name to
  `shofer.disabledTools`. Example: `"shofer.disabledTools": ["browser_action", "use_mcp_tool"]`.
- **Debug mode:** `shofer.debug` shows extra buttons; `shofer.debugProxy.*`
  routes network traffic through a local proxy like mitmproxy or Charles.
  The debug proxy only activates when the extension runs in Development mode.
- **Agent rules:** Set `"shofer.useAgentRules": false` if you want Shofer to
  ignore `AGENTS.md` files in your project.
