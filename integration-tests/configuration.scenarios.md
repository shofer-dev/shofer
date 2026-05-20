# Configuration System — Integration Test Scenarios

Feature under test: Shofer configuration key sources, dual-source setting
coherence, dead config key isolation, GlobalSettings runtime application, and
settings migration correctness.  
Sources: [`configuration.md`](../docs/configuration.md),
[`package.json`](../src/package.json),
[`global-settings.ts`](../packages/types/src/global-settings.ts),
[`ContextProxy.ts`](../src/core/config/ContextProxy.ts),
[`networkProxy.ts`](../src/utils/networkProxy.ts).

## Smoke Tests

These should pass on every build.

### S1 — All VS Code settings appear in the Settings UI

- Open VS Code Settings UI (⌘, / `Ctrl+,`).
- Type `shofer.` in the search bar.
- **Assert**: `shofer.allowedCommands`, `shofer.deniedCommands`,
  `shofer.preventCompletionWithOpenTodos`, `shofer.newTaskRequireTodos`,
  `shofer.apiRequestTimeout`, `shofer.vsCodeLmModelSelector`,
  `shofer.customStoragePath`, `shofer.enableCodeActions`,
  `shofer.autoImportSettingsPath`, `shofer.maximumIndexedFilesForFileSearch`,
  `shofer.codeIndex.embeddingBatchSize`, `shofer.debug`,
  `shofer.debugProxy.enabled`, `shofer.debugProxy.serverUrl`,
  `shofer.debugProxy.tlsInsecure`, `shofer.enableLlmProviderIntegration`
  all appear as configurable settings.

### S2 — Dead config keys do NOT crash extension startup

- Write `"shofer.devmandExecutionTimeout": 30` and
  `"shofer.devmandTimeoutAllowlist": ["npm"]` into `settings.json`.
- Restart the Shofer extension (Developer: Reload Window).
- **Assert**: Shofer loads without errors in the output channel.
- **Assert**: No crash, no unhandled rejection, no activation failure.

### S3 — GlobalSettings keys survive an export/import round-trip

- Set `"shofer.useAgentRules": false` in `settings.json`.
- Set `"shofer.disabledTools": ["browser_action"]` in `settings.json`.
- Export settings via Settings → About → Export.
- Delete both keys from `settings.json`, reload window.
- **Assert**: `shofer.useAgentRules` is `true` (default).
- Import the previously exported file.
- **Assert**: `shofer.useAgentRules` is `false` (restored).
- **Assert**: `shofer.disabledTools` is `["browser_action"]` (restored).

## Functional Tests

Run on release candidates and after changes to ContextProxy or settings plumbing.

### F1 — `shofer.defaultCostLimit` with `null` disables the limit

- Ensure no existing `shofer.defaultCostLimit` in `settings.json`.
- Start a new task and check the task header.
- **Assert**: No cost limit badge/indicator is shown (limit is disabled).
- Set `"shofer.defaultCostLimit": null` explicitly.
- Reload, start a new task.
- **Assert**: No cost limit badge.

### F2 — `shofer.defaultCostLimit` with `maxUsd: 0` is rejected

- Set `"shofer.defaultCostLimit": { "maxUsd": 0, "action": "pause" }`.
- Reload window.
- **Assert**: Shofer's output channel logs a Zod validation error for
  `defaultCostLimit.maxUsd` (expected a positive number).
- **Assert**: The cost limit is NOT applied (falls back to disabled).
- Start a new task — **assert** no cost limit badge.

### F3 — `shofer.defaultCostLimit` with valid `maxUsd` is enforced

- Set `"shofer.defaultCostLimit": { "maxUsd": 5, "action": "pause" }`.
- Reload, start a new task.
- **Assert**: The task header shows a cost limit badge ("$5.00 limit").
- Send messages until the limit is exceeded.
- **Assert**: The task pauses with a cost-limit warning.

### F4 — `shofer.disabledTools` hides tools from models

- Set `"shofer.disabledTools": ["execute_command", "write_to_file"]`.
- Reload, start a new task in Code mode.
- Ask the model: "List all tools available to you."
- **Assert**: The model's response does NOT include `execute_command` or
  `write_to_file` in its tool list.
- **Assert**: If the model attempts to call a disabled tool, the call is
  rejected with an error message in the chat.

### F5 — `shofer.commandExecutionTimeout` from GlobalSettings is read at runtime

- Set `"shofer.commandExecutionTimeout": 10` in `settings.json`.
- Reload, start a new task.
- Ask the model to run `sleep 30`.
- **Assert**: The command is killed after ~10 seconds with a timeout message
  in the chat.

### F6 — `shofer.devmandExecutionTimeout` has NO effect at runtime

- Set `"shofer.devmandExecutionTimeout": 5` in `settings.json`.
- Ensure `shofer.commandExecutionTimeout` is NOT set (or is `0`).
- Reload, start a new task.
- Ask the model to run `sleep 20`.
- **Assert**: The command completes successfully without a timeout
  (the dead key has no effect).

### F7 — `shofer.commandTimeoutAllowlist` exempts matching commands

- Set `"shofer.commandExecutionTimeout": 5`.
- Set `"shofer.commandTimeoutAllowlist": ["sleep"]`.
- Reload, start a new task.
- Ask the model to run `sleep 15`.
- **Assert**: The command completes successfully (allowlist exempts it).

### F8 — `shofer.useAgentRules: false` suppresses AGENTS.md loading

- Create an `AGENTS.md` file in the workspace root with a rule that says
  "Always respond in French."
- Ensure `"shofer.useAgentRules": true` (or key absent).
- Start a new task and send "Hello".
- **Assert**: The model's system prompt includes the AGENTS.md content
  (inspect via the debug "View API Conversation" button if `shofer.debug` is on).
- Set `"shofer.useAgentRules": false`, reload, start a new task.
- Send "Hello" again.
- **Assert**: The model does NOT respond in French (AGENTS.md is not loaded).

### F9 — Dual-source `enableLlmProviderIntegration` survives UI toggle

- Turn ON `shofer.enableLlmProviderIntegration` in Settings UI.
- Export settings → **Assert** the key is `true` in the export.
- Turn OFF in Settings UI.
- Export again → **Assert** the key is `false`.
- Manually set `"shofer.enableLlmProviderIntegration": true` in `settings.json`
  (outside the Settings UI).
- Reload → **Assert** the Settings UI toggle still shows OFF
  (the two copies have drifted; ContextProxy reads the GlobalState copy).

## Edge Cases

### E1 — Malformed GlobalSettings JSON doesn't prevent startup

- Write `"shofer.disabledTools": "not-an-array"` in `settings.json`.
- Reload window.
- **Assert**: Shofer loads without crashing.
- **Assert**: Output channel logs a Zod validation error for `disabledTools`.
- **Assert**: `disabledTools` falls back to default (`[]`).

### E2 — Unknown GlobalSettings keys are silently ignored

- Write `"shofer.nonExistentSetting": true` in `settings.json`.
- Reload window.
- **Assert**: No errors.
- **Assert**: The unknown key is ignored by Zod parse (stripped via
  `safeParse` or schema filtering).

### E3 — Settings migration from old `allowedCommands` globalState works

- Pre-populate the VS Code `globalState` with `allowedCommands: ["git log", "npm test"]`
  using the old key format (without `shofer.` prefix).
- Start the extension for the first time.
- **Assert**: The old commands are migrated to `shofer.allowedCommands` in
  `settings.json`.
- **Assert**: The old `globalState` key is removed or updated.

### E4 — `debugProxy.*` activates only in Development mode

- Set `"shofer.debugProxy.enabled": true` and
  `"shofer.debugProxy.serverUrl": "http://127.0.0.1:9999"`.
- Run Shofer in production mode (installed from `.vsix`).
- **Assert**: Network requests do NOT go through the proxy.
- Run Shofer in development mode (`F5` from source).
- **Assert**: Network requests ARE routed through
  `http://127.0.0.1:9999`.
