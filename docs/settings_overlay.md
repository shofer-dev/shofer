# Shofer Settings Merge & Storage Architecture

## Overview

Shofer stores configuration across **three distinct categories**, each with its own storage backend, merge strategy, and scope. This document explains all storage layers, how they merge at runtime, and the import/export mechanics.

---

## Config Types at a Glance

| Category                 | Backend                                                            | Scope                        | Merge Priority                                  |
| ------------------------ | ------------------------------------------------------------------ | ---------------------------- | ----------------------------------------------- |
| **API Provider Configs** | VS Code `SecretStorage` + `globalState`                            | Per-extension (machine-wide) | Profile IDs resolve per-mode                    |
| **Mode Definitions**     | `.shofermodes` (YAML) + `custom_modes.yaml` (YAML) + built-in (TS) | Per-project + per-extension  | `.shofermodes` > `custom_modes.yaml` > built-in |
| **MCP Server Configs**   | `mcp_settings.json` (JSON file)                                    | Per-extension (machine-wide) | Single file; no overlay                         |
| **Global Settings**      | VS Code `globalState` (SQLite-backed)                              | Per-extension (machine-wide) | Flat key-value; no overlay                      |

---

## 1. API Provider Configuration Storage

API provider configurations (profiles, keys, models, base URLs) are stored across
**two VS Code extension APIs**, managed primarily by
[`ProviderSettingsManager`](../src/core/config/ProviderSettingsManager.ts:57) and
[`ContextProxy`](../src/core/config/ContextProxy.ts:40).

### 1a. Provider Profiles — VS Code `SecretStorage`

**Managed by:** [`ProviderSettingsManager`](../src/core/config/ProviderSettingsManager.ts:57)

**Storage key:** `roo_cline_config_api_config` (constructed at
[`ProviderSettingsManager.ts:576`](../src/core/config/ProviderSettingsManager.ts:576))

This is the **source of truth** for all provider/API configuration profiles. It stores a
single JSON blob in VS Code's secure credential store with this schema:

```typescript
{
  currentApiConfigName: string,              // e.g. "default" or "my-anthropic-profile"
  apiConfigs: {                              // all profiles keyed by name
    "default": { id: "...", apiProvider: "anthropic", apiModelId: "...", apiKey: "sk-...", ... },
    "my-profile": { id: "...", apiProvider: "openai", apiModelId: "gpt-5", apiKey: "sk-...", ... },
  },
  modeApiConfigs: {                          // per-mode profile assignments (by profile ID)
    "code": "<profile-id>",
    "architect": "<profile-id>",
    ...
  },
  cloudProfileIds: ["..."],                 // IDs synced from Shofer Cloud
  migrations: { ... }                       // migration tracking flags
}
```

Write/read methods: [`store()`](../src/core/config/ProviderSettingsManager.ts:669) /
[`load()`](../src/core/config/ProviderSettingsManager.ts:580).

### 1b. Individual API Keys — VS Code `SecretStorage`

**Managed by:** [`ContextProxy`](../src/core/config/ContextProxy.ts:40)

Each provider's API key is stored as a **separate** entry in VS Code's `SecretStorage`.
The full list of secret keys is defined in
[`SECRET_STATE_KEYS`](../packages/types/src/global-settings.ts:262):

| Key                                                                                                                                                                                           | Provider                         |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| `apiKey`                                                                                                                                                                                      | Generic / Anthropic              |
| `openRouterApiKey`                                                                                                                                                                            | OpenRouter                       |
| `openAiApiKey`                                                                                                                                                                                | OpenAI (compatible)              |
| `openAiNativeApiKey`                                                                                                                                                                          | OpenAI (native Responses API)    |
| `geminiApiKey`                                                                                                                                                                                | Google Gemini                    |
| `deepSeekApiKey`                                                                                                                                                                              | DeepSeek                         |
| `mistralApiKey`                                                                                                                                                                               | Mistral                          |
| `xaiApiKey`                                                                                                                                                                                   | xAI / Grok                       |
| `moonshotApiKey`                                                                                                                                                                              | Moonshot                         |
| `minimaxApiKey`                                                                                                                                                                               | MiniMax                          |
| `zaiApiKey`                                                                                                                                                                                   | Z.AI                             |
| `fireworksApiKey`                                                                                                                                                                             | Fireworks                        |
| `basetenApiKey`                                                                                                                                                                               | Baseten                          |
| `sambaNovaApiKey`                                                                                                                                                                             | SambaNova                        |
| `vercelAiGatewayApiKey`                                                                                                                                                                       | Vercel AI Gateway                |
| `requestyApiKey`                                                                                                                                                                              | Requesty                         |
| `unboundApiKey`                                                                                                                                                                               | Unbound                          |
| `litellmApiKey`                                                                                                                                                                               | LiteLLM                          |
| `ollamaApiKey`                                                                                                                                                                                | Ollama                           |
| `awsAccessKey`, `awsApiKey`, `awsSecretKey`, `awsSessionToken`                                                                                                                                | AWS Bedrock                      |
| `openRouterImageApiKey`                                                                                                                                                                       | Image generation (global secret) |
| `codeIndexOpenAiKey`, `codebaseIndexOpenAiCompatibleApiKey`, `codebaseIndexGeminiApiKey`, `codebaseIndexMistralApiKey`, `codebaseIndexVercelAiGatewayApiKey`, `codebaseIndexOpenRouterApiKey` | Codebase indexing                |

### 1c. Non-Secret Provider Settings — VS Code `globalState`

Non-sensitive provider settings are stored in VS Code's `globalState` API (backed by
a SQLite database at `~/.config/Code/User/globalStorage/shofer.dev/state.vscdb`
on Linux). These include:

- `apiProvider`, `apiModelId` — selected provider and model
- `anthropicBaseUrl`, `openAiBaseUrl`, `openAiNativeBaseUrl`, `googleGeminiBaseUrl`, etc. — custom base URLs
- `modelMaxTokens`, `modelMaxThinkingTokens` — token limits
- `temperature` — model temperature
- `rateLimitSeconds` — API rate limiting
- `consecutiveMistakeLimit` — error repetition guard
- `todoListEnabled` — per-profile toggle

### 1d. Runtime Merge (ContextProxy)

[`ContextProxy`](../src/core/config/ContextProxy.ts:40) acts as a caching layer that
merges `SecretStorage` (API keys) and `globalState` (non-secret settings) into a unified
`ShoferSettings` object at [`getValues()`](../src/core/config/ContextProxy.ts:515):

```
SecretStorage (apiKey, openRouterApiKey, ...)
    +
globalState (apiProvider, apiModelId, baseUrl, ...)
    =
ShoferSettings (unified view for runtime)
```

The `ContextProxy` maintains an in-memory cache (`stateCache` + `secretCache`) for
fast access and lazily syncs with the backing stores.

> **Important:** VS Code `SecretStorage` delegates to the OS-level credential store
> (libsecret/GNOME Keyring on Linux, Keychain on macOS, Credential Manager on Windows).
> In Docker/container environments, this typically falls back to an **in-memory store**
> that does NOT survive restarts. See the [Code-Server Pre-Configuration](#code-server-pre-configuration)
> section for strategies.

---

## 2. Mode Configuration Storage

Mode configurations (role definitions, groups, tool permissions) are stored across
four layers, merged at runtime with a specific precedence order.

### 2a. `.shofermodes` — Project-level overrides

| Property       | Value                                            |
| -------------- | ------------------------------------------------ |
| **Path**       | `<workspace_root>/.shofermodes`                  |
| **Format**     | YAML                                             |
| **Scope**      | Per-project (workspace folder)                   |
| **Priority**   | **Highest** (wins all conflicts)                 |
| **Purpose**    | Project-specific mode overrides to share via git |
| **Source tag** | `source: "project"` (auto-assigned)              |
| **Editable**   | Yes—directly edit the file                       |

Example:

```yaml
customModes:
    - slug: "code"
      name: "💻 Code"
      roleDefinition: "You are Shofer, a custom code assistant..."
      customInstructions: |
          Use our team's code style guide...
      whenToUse: "Use this mode for all code changes"
      groups: ["read", "edit", "command", "mcp"]
      tools_allowed: ["update_todo_list"] # optional: per-mode whitelist (additive)
      tools_denied: ["execute_command"] # optional: per-mode blacklist (overrides groups)
```

> **`groups` semantics.** A mode's `groups` field controls **two things at once**:
>
> 1. **Visibility** — which tools the LLM is allowed to see in its tool catalog
>    (`filterNativeToolsForMode` only emits tools whose canonical name passes
>    `isToolAllowedForMode` for the mode's groups, plus `tools_allowed`, minus
>    `tools_denied`).
> 2. **Auto-approval eligibility** — the All (Read/Edit/Command/MCP/Browser/
>    Modes/Subtasks) toggles in the auto-approval UI gate approval at the
>    _group_ level. If a mode does not include a group, the corresponding
>    auto-approval toggle has no effect for that mode.
>
> `tools_allowed` is additive (whitelist on top of groups). `tools_denied`
> takes precedence over both `tools_allowed` and groups. Both are evaluated
> in [`isToolAllowedForMode`](../src/core/tools/validateToolUse.ts).

### 2b. Extension Global Storage — User settings (`custom_modes.yaml`)

| Property       | Value                                                                |
| -------------- | -------------------------------------------------------------------- |
| **Path**       | `<globalStorage>/settings/custom_modes.yaml`                         |
| **Format**     | YAML                                                                 |
| **Scope**      | Per-extension install (shared across workspaces on the same machine) |
| **Priority**   | Lower than `.shofermodes`, higher than built-in                      |
| **Purpose**    | User's personal modes and customizations via Settings UI             |
| **Source tag** | `source: "global"`                                                   |
| **In git?**    | **No** — runtime artifact, created fresh on each machine             |
| **Editable**   | Via Settings UI (not recommended to edit directly)                   |

Where `<globalStorage>` is `context.globalStorageUri.fsPath` (e.g.,
`~/.config/Code/User/globalStorage/shofer.dev/` on Linux), overridable
via the `shofer.customStoragePath` setting.

> **This file is NOT part of the Shofer source tree.** It is a runtime artifact created
> on the user's machine when they first use the Settings UI to configure modes. The code
> references it only as a filename constant in
> [`GlobalFileNames`](../src/shared/globalFileNames.ts:5):
>
> ```typescript
> export const GlobalFileNames = {
> 	customModes: "custom_modes.yaml", // just the filename, no content
> }
> ```
>
> When the file doesn't exist yet,
> [`CustomModesManager`](../src/core/config/CustomModesManager.ts:261) writes an empty template:
>
> ```typescript
> if (!fileExists) {
> 	await fs.writeFile(filePath, yaml.stringify({ customModes: [] }, { lineWidth: 0 }))
> }
> ```

### 2c. VS Code `globalState` — Runtime persistence

| Property     | Value                                                 |
| ------------ | ----------------------------------------------------- |
| **Type**     | In-memory with disk persistence (SQLite)              |
| **API**      | `context.globalState.get()` / `.update()`             |
| **Scope**    | Per-extension install                                 |
| **Priority** | Equivalent to extension global storage (synchronized) |
| **Purpose**  | Fast runtime access; acts as backup/fallback          |
| **Editable** | Via Settings UI only                                  |

Key globalState keys for modes:

| Key                  | Contents                                                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `customInstructions` | Global custom instructions (all modes)                                                                                         |
| `customModes`        | Merged result of `.shofermodes` + settings file                                                                                |
| `customModePrompts`  | Per-mode prompt overrides (roleDefinition, customInstructions, whenToUse)                                                      |
| `disabledTools`      | Global flat list of tool names hidden from the LLM (Settings → Tools) — applied across all modes by `filterNativeToolsForMode` |

### 2d. Built-in Modes — Compiled into extension

| Property     | Value                                                         |
| ------------ | ------------------------------------------------------------- |
| **Path**     | [`packages/types/src/mode.ts`](../packages/types/src/mode.ts) |
| **Type**     | Read-only code constant                                       |
| **Scope**    | Per-extension version                                         |
| **Priority** | **Lowest** (fallback)                                         |
| **Purpose**  | Default modes: Architect, Code, Ask, Debug, Orchestrator      |

Built-in modes array (in order):

```typescript
export const DEFAULT_MODES: readonly ModeConfig[] = [
  { slug: "architect", ... },  // index 0 = default mode
  { slug: "code",      ... },
  { slug: "ask",       ... },
  { slug: "debug",     ... },
  { slug: "orchestrator", ... },
]
```

---

## 3. MCP Server Configuration Storage

MCP server configurations are stored in a **single JSON file** managed by
[`McpHub`](../src/services/mcp/McpHub.ts). There is **no overlay/merge** — it is a
flat file.

### 3a. `mcp_settings.json` — Global MCP config

| Property       | Value                                                                  |
| -------------- | ---------------------------------------------------------------------- |
| **Path**       | `<globalStorage>/settings/mcp_settings.json`                           |
| **Format**     | JSON                                                                   |
| **Scope**      | Per-extension install (shared across workspaces)                       |
| **Purpose**    | MCP server definitions (command, args, env, transport type, etc.)      |
| **Editable**   | Via Settings UI (Tools tab → MCP Servers) or direct file edit          |
| **Managed by** | [`McpHub.getMcpSettingsFilePath()`](../src/services/mcp/McpHub.ts:534) |

The file is watched for changes via `chokidar` at
[`McpHub.watchMcpSettingsFile()`](../src/services/mcp/McpHub.ts:557). On any change,
servers are re-read and connections re-established.

> **Note:** There is no project-level MCP config file. All MCP servers are defined in
> this single global file. The file name constant is defined in
> [`GlobalFileNames.mcpSettings`](../src/shared/globalFileNames.ts:4).

### 3b. MCP Tool Visibility

MCP tools have their own visibility pipeline parallel to native tools, in
[`filterMcpToolsForMode`](../src/core/prompts/tools/filter-tools-for-mode.ts):

- Gated by per-tool group assignment (`McpHub.getMcpToolMetadata`)
- Per-server `disabledTools` list in `mcp_settings.json`
- Allowed groups from the active mode

---

## 4. Mode Merge Order & Precedence

The merge happens in **two stages**:

### Stage 1: Merge `.shofermodes` + Global Storage → `customModes`

From [`CustomModesManager.getCustomModes()`](../src/core/config/CustomModesManager.ts:363):

```
┌────────────────────────────────────────────────┐
│  Stage 1: CustomModesManager.getCustomModes()  │
│                                                 │
│  Read .shofermodes          → projectModes (map)   │
│  Read global storage     → globalModes (map)    │
│                                                 │
│  MERGE:                                         │
│   - Project modes added first (priority)        │
│   - Global modes added only if slug NOT already │
│     in project modes (no conflict overwrite)    │
│                                                 │
│  Result: customModes[]                          │
│   - source: "project" (from .shofermodes)          │
│   - source: "global"  (from global storage)     │
└────────────────────────────────────────────────┘
```

```typescript
// .shofermodes wins for same slug; global ignored if project mode exists
for (const mode of shofermodesModes) {
	projectModes.set(mode.slug, { ...mode, source: "project" })
}
for (const mode of settingsModes) {
	if (!projectModes.has(mode.slug)) {
		// ← only if not already in .shofermodes
		globalModes.set(mode.slug, { ...mode, source: "global" })
	}
}
```

### Stage 2: Overlay `customModes` onto Built-in Modes → Final List

From [`getAllModes(customModes)`](../src/shared/modes.ts:91):

```
┌────────────────────────────────────────────────┐
│  Stage 2: getAllModes(customModes)              │
│                                                 │
│  Start with built-in modes (5 defaults)         │
│                                                 │
│  For each customMode in customModes[]:          │
│   - Same slug as built-in? → OVERRIDE it        │
│   - New slug?             → APPEND it           │
│                                                 │
│  Result: final ModeConfig[]                     │
│   - Built-in overridden by custom               │
│   - Custom-only modes appended                  │
│   - Unchanged built-ins remain                  │
└────────────────────────────────────────────────┘
```

```typescript
const allModes = [...modes] // start with built-ins
customModes.forEach((customMode) => {
	const index = allModes.findIndex((m) => m.slug === customMode.slug)
	if (index !== -1) {
		allModes[index] = customMode // override built-in
	} else {
		allModes.push(customMode) // add new mode
	}
})
```

### API Profile Assignment Per Mode

Separately from mode definitions, each mode can be assigned a specific API provider
profile via `modeApiConfigs` in the provider profiles blob (see §1a). This mapping
is stored in the SecretStorage profiles blob, NOT in the mode definitions. Resolution
happens at task creation time:

```
active mode slug → modeApiConfigs[slug] → profile ID → apiConfigs[profileName]
```

### Combined Flow

```
.shofermodes ─────┐
               ├── Stage 1 merge ──→ customModes[] ──┐
global storage ┘                                      │
                                                      ├── Stage 2 overlay ──→ final ModeConfig[]
built-in modes ───────────────────────────────────────┘

API profile assignments (modeApiConfigs) ──→ resolved at task creation (SecretStorage)
```

### Conflict Resolution (Same Slug)

When the same slug exists in multiple sources:

| Sources with same slug             | Winner                   |
| ---------------------------------- | ------------------------ |
| `.shofermodes` vs global storage   | `.shofermodes` (Stage 1) |
| `customModes` (merged) vs built-in | `customModes` (Stage 2)  |

👉 **`.shofermodes` > global storage > built-in**

---

## 5. Write Paths

### Via Settings UI

```
Settings UI
  ├── globalState.update("customInstructions", value)    // global instructions
  ├── globalState.update("customModePrompts", {...})      // per-mode overrides
  ├── globalState.update("customModes", merged)           // merged result
  ├── Write to global storage YAML file                    // file-based backup
  ├── ProviderSettingsManager.updateConfig(...)            // API profile changes → SecretStorage
  └── McpHub writes mcp_settings.json                      // MCP server changes
```

### API Profile Changes

```
Settings UI (API Provider tab)
  └── ProviderSettingsManager.updateConfig(name, config)
       └── secrets.store("roo_cline_config_api_config", JSON)
            └── ContextProxy.setProviderSettings(config)  // sync cache
```

### Via `.shofermodes` file edit

```
User edits .shofermodes
  └── File watcher triggers re-merge
       └── globalState.update("customModes", newMerged)
```

---

## 6. Custom Instructions Flow

### Global Custom Instructions (all modes)

1. Stored in `globalState["customInstructions"]`
2. Added to system prompt for ALL modes
3. Edited in: Settings → Modes → "Custom Instructions for All Modes"

### Mode-Specific Custom Instructions

1. Stored in `globalState["customModePrompts"]["<slug>"]`
2. Only applied when that mode is active
3. Edited in: Settings → Modes → Edit mode → "Mode-specific Custom Instructions"

### How Both Are Combined

From [`system.ts`](../src/core/prompts/system.ts:41):

```typescript
// Get mode config with overrides
const { roleDefinition, baseInstructions } = getModeSelection(mode, promptComponent, customModeConfigs)

// Build final prompt
const basePrompt = `${roleDefinition}

${markdownFormattingSection()}
${getSharedToolUseSection()}
${getToolUseGuidelinesSection()}
${getCapabilitiesSection(...)}
${modesSection}
${getRulesSection(...)}
${getSystemInfoSection(...)}
${getObjectiveSection()}

${await addCustomInstructions(baseInstructions, globalCustomInstructions, cwd, mode, {...})}`
```

From [`custom-instructions.ts`](../src/core/prompts/sections/custom-instructions.ts:449):

```typescript
// Global instructions come first, then mode-specific
if (globalCustomInstructions?.trim()) {
	sections.push(`Global Instructions:\n${globalCustomInstructions.trim()}`)
}
// Then mode-specific instructions...
```

---

## 7. File Watchers

### Mode Configs

The [`CustomModesManager`](../src/core/config/CustomModesManager.ts:268) watches both sources:

```typescript
// Watch global settings file
const settingsWatcher = vscode.workspace.createFileSystemWatcher(settingsPath)
settingsWatcher.onDidChange(handleSettingsChange)
settingsWatcher.onDidCreate(handleSettingsChange)
settingsWatcher.onDidDelete(handleSettingsChange)

// Watch .shofermodes file
const roomodesWatcher = vscode.workspace.createFileSystemWatcher(roomodesPath)
roomodesWatcher.onDidChange(handleRoomodesChange)
roomodesWatcher.onDidCreate(handleRoomodesChange)
roomodesWatcher.onDidDelete(handleRoomodesChange)
```

On any file change, the manager re-reads both sources, re-merges, and updates `globalState`.

### MCP Configs

The [`McpHub`](../src/services/mcp/McpHub.ts) watches both global and project MCP configs:

**Global:** [`mcp_settings.json`](../src/shared/globalFileNames.ts:4) via
[`watchMcpSettingsFile()`](../src/services/mcp/McpHub.ts:557) using `FileSystemWatcher`.

**Project:** `.shofer/mcp.json` via
[`watchProjectMcpFile()`](../src/services/mcp/McpHub.ts:377) using `FileSystemWatcher`.

Both use a 500ms debounce. On file change, servers are re-read, validated against
`McpSettingsSchema`, and connections are updated. File deletion triggers cleanup of
all project MCP servers.

```typescript
// Global: watchMcpSettingsFile()
const settingsPattern = new vscode.RelativePattern(
    path.dirname(settingsPath), path.basename(settingsPath))
this.settingsWatcher = vscode.workspace.createFileSystemWatcher(settingsPattern)
this.settingsWatcher.onDidChange((uri) => this.debounceConfigChange(...))
this.settingsWatcher.onDidCreate((uri) => this.debounceConfigChange(...))

// Project: watchProjectMcpFile()
const projectMcpPattern = new vscode.RelativePattern(workspaceFolder, ".shofer/mcp.json")
this.projectMcpWatcher = vscode.workspace.createFileSystemWatcher(projectMcpPattern)
this.projectMcpWatcher.onDidChange((uri) => this.debounceConfigChange(...))
this.projectMcpWatcher.onDidCreate((uri) => this.debounceConfigChange(...))
this.projectMcpWatcher.onDidDelete(async () => this.cleanupProjectMcpServers())
```

---

## 8. On-the-Fly Reloading (No Restart Required)

This section documents whether each configuration type can be updated without
restarting code-server or VS Code, and how changes are detected.

### Summary Table

| Config Type                                  | On-the-Fly?     | Detection Mechanism                    | Delay          | Notes                                                                       |
| -------------------------------------------- | --------------- | -------------------------------------- | -------------- | --------------------------------------------------------------------------- |
| **MCP servers** (global `mcp_settings.json`) | ✅ Yes          | VS Code `FileSystemWatcher` (chokidar) | 500ms debounce | Servers restarted/reconnected automatically                                 |
| **MCP servers** (project `.shofer/mcp.json`) | ✅ Yes          | VS Code `FileSystemWatcher` (chokidar) | 500ms debounce | File deletion triggers cleanup of project servers                           |
| **Mode definitions** (`.shofermodes`)        | ✅ Yes          | VS Code `FileSystemWatcher`            | Near-instant   | Triggers re-merge → `globalState` → `onUpdate` → UI refresh                 |
| **Mode definitions** (`custom_modes.yaml`)   | ✅ Yes          | VS Code `FileSystemWatcher`            | Near-instant   | Triggers re-merge → `globalState` → `onUpdate` → UI refresh                 |
| **API profiles** (SecretStorage)             | ⚠️ UI only      | No external change detection           | —              | Only changed via Settings UI or Import flow; OS keychain changes undetected |
| **API keys** (SecretStorage)                 | ⚠️ UI only      | No external change detection           | —              | Only changed via Settings UI or Import flow                                 |
| **Global settings** (globalState)            | ⚠️ UI only      | No external change detection           | —              | VS Code `globalState` does not emit change events for external writes       |
| **Auto-import**                              | 🔄 Startup only | Runs on extension `activate()`         | —              | Triggered only at extension activation; not re-triggerable without restart  |
| **Slash commands / rules** (`.shofer/`)      | ✅ Yes          | Read at task start / on-demand         | —              | Not cached — read fresh when constructing system prompt                     |

### ✅ File-Based Configs: Instant Reload

All JSON/YAML file-based configs use VS Code's `FileSystemWatcher` API (backed by
`chokidar` for MCP settings) and reload **immediately** when the file changes on disk:

#### MCP Settings (Global + Project)

**Global:** [`mcp_settings.json`](../src/shared/globalFileNames.ts:4) at
`<globalStorage>/settings/mcp_settings.json`, watched by
[`McpHub.watchMcpSettingsFile()`](../src/services/mcp/McpHub.ts:557).

**Project:** `.shofer/mcp.json` at `<workspace>/.shofer/mcp.json`, watched by
[`McpHub.watchProjectMcpFile()`](../src/services/mcp/McpHub.ts:377).

Both use a **500ms debounce** via [`debounceConfigChange()`](../src/services/mcp/McpHub.ts:316)
to avoid redundant server restarts during rapid edits. Programmatic updates
(from Settings UI) set `isProgrammaticUpdate = true` to skip the watcher-triggered
re-read entirely.

On change:

1. File is re-read and parsed
2. Schema validated against `McpSettingsSchema`
3. [`updateServerConnections()`](../src/services/mcp/McpHub.ts:363) reconnects affected servers
4. WebView is notified of server changes

#### Mode Definitions (`.shofermodes` + `custom_modes.yaml`)

Both files are watched by [`CustomModesManager.watchCustomModesFiles()`](../src/core/config/CustomModesManager.ts:268):

```typescript
// .shofermodes watcher (per workspace folder)
const roomodesWatcher = vscode.workspace.createFileSystemWatcher(roomodesPath)
roomodesWatcher.onDidChange(handleRoomodesChange)
roomodesWatcher.onDidCreate(handleRoomodesChange)
roomodesWatcher.onDidDelete(handleRoomodesChange)

// custom_modes.yaml watcher (global settings)
const settingsWatcher = vscode.workspace.createFileSystemWatcher(settingsPath)
settingsWatcher.onDidChange(handleSettingsChange)
settingsWatcher.onDidCreate(handleSettingsChange)
settingsWatcher.onDidDelete(handleSettingsChange)
```

On change:

1. Both sources are re-read
2. Stage 1 + Stage 2 merge re-executed
3. `globalState.update("customModes", merged)` written
4. `onUpdate()` callback triggers webview state refresh

### ⚠️ SecretStorage / globalState: No External Detection

API profiles and keys are stored in VS Code's `SecretStorage` API, which delegates to
the **OS-level credential store** (libsecret/Keychain/Credential Manager). There is
**no file watcher** and **no change event API** for external modifications.

Similarly, `globalState` is backed by a SQLite database with no change events.

This means:

| Change Method                       | Detected?                                                                                                          |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| **Settings UI** (user clicks Save)  | ✅ Immediate — `ProviderSettingsManager.updateConfig()` → `secrets.store()` → `ContextProxy.setProviderSettings()` |
| **Import flow**                     | ✅ Immediate — `importSettingsFromPath()` → `ProviderSettingsManager.import()` → `ContextProxy.setValues()`        |
| **Auto-import at startup**          | ✅ On activation — `autoImportSettings()` → full import                                                            |
| **Direct OS keychain edit**         | ❌ Not detected                                                                                                    |
| **Direct globalState SQLite write** | ❌ Not detected                                                                                                    |
| **External `secrets.store()` call** | ❌ Not detected (no cross-process notification)                                                                    |

### 🔄 Auto-Import: Startup Only

The auto-import mechanism in [`autoImportSettings`](../src/utils/autoImportSettings.ts:16) is
called **only once** during extension activation (in [`extension.ts:346`](../src/extension.ts:346)):

```typescript
// extension.ts activate()
await autoImportSettings(outputChannel, {
	providerSettingsManager: provider.providerSettingsManager,
	contextProxy: provider.contextProxy,
	customModesManager: provider.customModesManager,
})
```

It reads the path from the VS Code setting `shofer.autoImportSettingsPath` and, if
the file exists, imports both `providerProfiles` and `globalSettings`. There is **no
re-trigger mechanism** — to re-import, the extension must be restarted (or the Settings UI
Import button must be used manually).

### ✅ Slash Commands & Rules: Read On-Demand

Files under `.shofer/commands/`, `.shofer/rules/`, `.shofer/rules-<mode>/`, and `AGENTS.md` are
**not cached** and are read fresh each time the system prompt is constructed for a new
task. There is no file watcher needed — the read happens at task start and on mode switch.

---

## 9. Tool Visibility & Auto-Approval Composition

Tool visibility (what the LLM sees in its tool catalog) and auto-approval
(whether the user is asked before execution) are governed by **independent but
overlapping** layers. Knowing which layer affects what is essential for
debugging "why is tool X being asked / why is tool X invisible?" issues.

### Visibility pipeline (what the LLM sees)

The final list of tools sent to the LLM is computed by
[`buildNativeToolsArray`](../src/core/task/build-tools.ts) →
[`filterNativeToolsForMode`](../src/core/prompts/tools/filter-tools-for-mode.ts):

```
all native tools
  ∩  (mode.groups ∪ mode.tools_allowed ∪ ALWAYS_AVAILABLE_TOOLS)
  −  mode.tools_denied
  −  feature-disabled tools (codebase_search, update_todo_list,
                              generate_image, run_slash_command,
                              access_mcp_resource if no MCP resources)
  −  global  disabledTools  (Settings → Tools)
  →  rename canonical → alias if model declares includedTools alias
  =  tools sent to LLM
```

MCP tools follow a parallel pipeline via
[`filterMcpToolsForMode`](../src/core/prompts/tools/filter-tools-for-mode.ts),
gated by per-tool group assignment (`McpHub.getMcpToolMetadata`) and the
per-server `disabledTools` list in `mcp_settings.json`.

### Visibility kill-switches

| Layer                         | Storage                                        | Scope                | Edited via                                                        |
| ----------------------------- | ---------------------------------------------- | -------------------- | ----------------------------------------------------------------- |
| Per-mode `groups` / `tools_*` | `.shofermodes` / `custom_modes.yaml`           | Per mode             | Mode editor / file                                                |
| Global `disabledTools`        | `globalState["disabledTools"]: string[]`       | All modes            | Settings → Tools                                                  |
| MCP per-tool visibility       | `mcp_settings.json` per-server `disabledTools` | All modes (per tool) | Settings → Tools (MCP rows dispatch `toggleToolEnabledForPrompt`) |

`ALWAYS_AVAILABLE_TOOLS` (defined in [`packages/types/src/tool.ts`](../packages/types/src/tool.ts))
bypasses mode/group restrictions — but **not** `disabledTools`. The execution-time
guard in [`isToolAllowedForMode`](../src/core/tools/validateToolUse.ts) honors
`toolRequirements` (built from `disabledTools`) before the always-available check.

### Auto-approval pipeline (whether the user is asked)

Auto-approval is decided by
[`checkAutoApproval`](../src/core/auto-approval/index.ts) and operates on
`(mode.groups ∋ groupForTool, All toggle for that group, isProtected)`. It is
**independent** of `disabledTools`: if a tool is visible _and_ the matching All
toggle is on for the tool's group, the action is auto-approved.

Auto-approved decisions short-circuit the `Task.ask()` round-trip and are
marked `autoApproved=true` on the `ShoferMessage` so the webview suppresses the
Approve/Deny buttons (see [`ChatView.tsx`](../webview-ui/src/components/chat/ChatView.tsx)).

### Diagnostics

- The exact tool catalog sent to the LLM is logged on every API request from
  [`Task.attemptApiRequest`](../src/core/task/Task.ts):

    ```
    [tools] sending N tool(s) to LLM (mode=code): tool_a, tool_b, ...
    ```

    Use this in the Shofer output channel to confirm visibility filtering.

- If the model still calls a tool that has been removed by `disabledTools`
  (typically a hallucination from training data),
  [`validateToolUse`](../src/core/tools/validateToolUse.ts) throws a distinct
  error so the model stops retrying:

    ```
    Tool "X" has been disabled by the user in Settings → Tools and is not
    available in any mode. Do not attempt to call it again.
    ```

    This is reported separately from the mode-restriction error
    (`Tool "X" is not allowed in <mode> mode.`).

---

## 10. Export / Import

### 10a. What Gets Exported

Export (Settings → Modes → Export, or toolbar Export button) writes a single JSON file
(`shofer-code-settings.json`) containing two top-level sections:

```json
{
  "providerProfiles": {
    "currentApiConfigName": "default",
    "apiConfigs": { ... },
    "modeApiConfigs": { ... },
    "cloudProfileIds": [...],
    "migrations": { ... }
  },
  "globalSettings": {
    "mode": "architect",
    "customModes": [...],
    "customInstructions": "...",
    "customModePrompts": {...},
    "customSupportPrompts": {...},
    "autoApprovalEnabled": false,
    "alwaysAllowReadOnly": true,
    ... (see globalSettingsSchema for full list)
  }
}
```

#### `providerProfiles` — Full API Configuration

Exported from [`ProviderSettingsManager.export()`](../src/core/config/ProviderSettingsManager.ts:511).
Contains ALL provider profiles including:

- **API keys** — included in each profile's `apiKey`, `openRouterApiKey`, etc. fields
- **Model IDs** — `apiModelId` for each profile
- **Base URLs** — custom endpoints per provider
- **Model parameters** — `modelMaxTokens`, `modelMaxThinkingTokens`, `temperature`
- **Rate limiting** — `rateLimitSeconds`, `consecutiveMistakeLimit`
- **Headers** — `openAiHeaders`, custom provider headers
- **Retired provider profiles** — preserved as-is (not filtered out)
- **Profile-to-mode assignments** — `modeApiConfigs`

Token fields (`modelMaxTokens`, `modelMaxThinkingTokens`) are stripped for models
that don't support reasoning budgets during export.

#### `globalSettings` — Global Configuration

Exported from [`ContextProxy.export()`](../src/core/config/ContextProxy.ts:532).
Based on [`globalSettingsExportSchema`](../src/core/config/ContextProxy.ts:34) which is
`globalSettingsSchema` with these exclusions:

- `taskHistory` — excluded (per-task data, not portable)
- `listApiConfigMeta` — excluded (derived from providerProfiles)
- `currentApiConfigName` — excluded (derived from providerProfiles)

Includes:

- **Mode:** `mode` (default mode slug)
- **Custom modes:** `customModes` — only `source: "global"` entries (project `.shofermodes` modes are excluded)
- **Mode prompts:** `customModePrompts`, `customSupportPrompts`
- **Custom instructions:** `customInstructions` (global, all modes)
- **Auto-approval:** `autoApprovalEnabled`, all `alwaysAllow*` toggles, `followupAutoApproveTimeoutMs`
- **Command permissions:** `allowedCommands`, `deniedCommands`, `commandTimeoutAllowlist`, `commandExecutionTimeout`
- **Cost/rate limits:** `allowedMaxRequests`, `allowedMaxCost`
- **Checkpoints:** `enableCheckpoints`, `checkpointTimeout`
- **Context management:** `autoCondenseContext`, `autoCondenseContextPercent`, `writeDelayMs`
- **Code indexing:** `codebaseIndexConfig`, `codebaseIndexEnabled`
- **Experiments:** `experiments` (feature flags)
- **Telemetry:** `telemetrySetting`
- **UI preferences:** `includeCurrentTime`, `includeCurrentCost`, `includeDiagnosticMessages`, `maxDiagnosticMessages`, `maxGitStatusFiles`
- **Image generation:** `imageGenerationProvider`, `openRouterImageGenerationSelectedModel`
- **Storage:** `customStoragePath`, `preventCompletionWithOpenTodos`
- **Other:** `lastShownAnnouncementId`, `dismissedUpsells`, `pinnedApiConfigs`

### 10b. What Is NOT Exported

| Item                                             | Reason                                                                                           |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| **MCP server configs** (`mcp_settings.json`)     | Managed independently by `McpHub`; stored as a separate JSON file in `<globalStorage>/settings/` |
| **Task history**                                 | Per-task data; explicitly excluded via `globalSettingsExportSchema.omit({ taskHistory: true })`  |
| **Project `.shofermodes` modes**                 | File-based, per-workspace; only `source: "global"` custom modes are exported                     |
| **`currentApiConfigName` / `listApiConfigMeta`** | Derived from `providerProfiles` at import time                                                   |

### 10c. Import Flow

Import reads the JSON file and applies both sections:

```
shofer-code-settings.json
        │
   ┌────┴────┐
   ▼         ▼
providerProfiles   globalSettings
   │                │
   ▼                ▼
ProviderSettings   ContextProxy
Manager.import()   .setValues()
   │                │
   ▼                ▼
SecretStorage      globalState
(profiles blob)    (all non-secret settings)
   +
SecretStorage
(individual keys:
 apiKey, openRouterApiKey,
 geminiApiKey, etc.)
```

Import is handled by [`importSettingsFromPath`](../src/core/config/importExport.ts:75) which:

1. Validates and sanitizes each provider profile (handles retired/invalid providers gracefully)
2. Merges profiles with existing ones (does not delete existing profiles unless IDs conflict)
3. Merges `modeApiConfigs` with existing assignments
4. Imports `customModes` via `CustomModesManager.updateCustomMode()`
5. Sets all global settings via `ContextProxy.setValues()`

**Import is additive** for provider profiles — existing profiles not in the import file
are preserved. API keys in the import file overwrite existing ones for matching profiles.

### 10d. Auto-Import on Startup

Shofer supports automatic import on extension activation via the VS Code setting
`shofer.autoImportSettingsPath`. When set to a file path, the extension will
automatically import settings from that file on startup.

Implementation: [`autoImportSettings`](../src/utils/autoImportSettings.ts:16), called
from [`extension.ts:346`](../src/extension.ts:346).

```
Extension activation
  └── autoImportSettings()
       ├── Read shofer.autoImportSettingsPath from VS Code config
       ├── Check if file exists
       └── importSettingsFromPath(filePath)
            ├── ProviderSettingsManager.import(providerProfiles)  → SecretStorage
            └── ContextProxy.setValues(globalSettings)            → globalState
```

This is the recommended mechanism for pre-configuring code-server or other automated
deployments. The setting can be pre-seeded in VS Code's `settings.json`:

```json
{
	"shofer.autoImportSettingsPath": "/etc/shofer/settings.json"
}
```

---

## 11. Code-Server Pre-Configuration

When deploying Shofer in a code-server environment, the following strategies ensure
API configurations are available:

### Primary Approach: Auto-Import

1. Export settings from a configured Shofer instance (creates `shofer-code-settings.json`)
2. Place the file at a known path on the code-server image (e.g., `/etc/shofer/settings.json`)
3. Set the VS Code setting `shofer.autoImportSettingsPath` to point to it
4. On extension activation, all API profiles and global settings are automatically imported

### SecretStorage Persistence Caveat

VS Code `SecretStorage` delegates to the OS credential store. In Docker containers,
this typically falls back to an **in-memory store** that does NOT survive restarts.
Mitigations:

- **Re-import on restart:** Keep the auto-import path configured so API keys are
  re-imported on each activation
- **Mount a persistent volume:** for the code-server data directory
  (`~/.local/share/code-server/`) so the SecretStorage backend can persist
- **Use environment variables:** Set API keys via environment variables that the
  provider handlers check (e.g., `OPENAI_API_KEY`)

### Additional File Pre-Seeding

| File                        | Path                                              | Contents                                             |
| --------------------------- | ------------------------------------------------- | ---------------------------------------------------- |
| `.shofermodes`              | `<workspace>/.shofermodes`                        | Project-specific mode overrides (YAML)               |
| `custom_modes.yaml`         | `<globalStorage>/settings/custom_modes.yaml`      | Global user mode customizations (YAML)               |
| `mcp_settings.json`         | `<globalStorage>/settings/mcp_settings.json`      | MCP server definitions (JSON)                        |
| `shofer-code-settings.json` | Any path (referenced by `autoImportSettingsPath`) | Full export including API profiles + global settings |

> **Note:** `mcp_settings.json` is NOT covered by the export/import flow. To pre-configure
> MCP servers, place the file directly in the `<globalStorage>/settings/` directory.

---

## 12. All GlobalFileNames Constants

Defined in [`GlobalFileNames`](../src/shared/globalFileNames.ts:1):

| Constant                 | Filename                        | Purpose                                   |
| ------------------------ | ------------------------------- | ----------------------------------------- |
| `apiConversationHistory` | `api_conversation_history.json` | Per-task API message history              |
| `uiMessages`             | `ui_messages.json`              | Per-task UI message history               |
| `mcpSettings`            | `mcp_settings.json`             | Global MCP server definitions             |
| `customModes`            | `custom_modes.yaml`             | Global user mode customizations           |
| `taskMetadata`           | `task_metadata.json`            | Per-task metadata (mode, workspace, etc.) |
| `historyItem`            | `history_item.json`             | Per-task history item (for task list)     |
| `historyIndex`           | `_index.json`                   | Task history index (listing all tasks)    |

---

## 13. Complete Storage Summary

| Layer                       | Backend         | Path / Key                                                    | Format             | Scope         | Priority        | Editable           |
| --------------------------- | --------------- | ------------------------------------------------------------- | ------------------ | ------------- | --------------- | ------------------ |
| **API Profiles (SoT)**      | `SecretStorage` | `roo_cline_config_api_config`                                 | JSON blob          | Per-extension | —               | Settings UI        |
| **API Keys**                | `SecretStorage` | `apiKey`, `openRouterApiKey`, … (30+ keys)                    | String             | Per-extension | —               | Settings UI        |
| **Non-secret API settings** | `globalState`   | `apiProvider`, `apiModelId`, `anthropicBaseUrl`, …            | Key-value          | Per-extension | —               | Settings UI        |
| **`.shofermodes`**          | File            | `<workspace>/.shofermodes`                                    | YAML               | Per-project   | Highest (modes) | Direct edit        |
| **Global modes**            | File            | `<globalStorage>/settings/custom_modes.yaml`                  | YAML               | Per-extension | Medium (modes)  | Settings UI        |
| **MCP servers**             | File            | `<globalStorage>/settings/mcp_settings.json`                  | JSON               | Per-extension | —               | Settings UI / file |
| **Global settings**         | `globalState`   | `mode`, `customInstructions`, `autoApprovalEnabled`, …        | Key-value (SQLite) | Per-extension | —               | Settings UI        |
| **Built-in modes**          | Code            | [`packages/types/src/mode.ts`](../packages/types/src/mode.ts) | TypeScript         | Per-version   | Lowest (modes)  | Code change        |
| **Task history**            | File            | `<globalStorage>/tasks/<id>/` (multiple JSON files)           | JSON               | Per-extension | —               | Task lifecycle     |
| **Model cache**             | File            | `<globalStorage>/cache/<provider>_models.json`                | JSON               | Per-extension | —               | Auto-refreshed     |

Where `<globalStorage>` defaults to `context.globalStorageUri.fsPath`, overridable
via the `shofer.customStoragePath` VS Code setting.
