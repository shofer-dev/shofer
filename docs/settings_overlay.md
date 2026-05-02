# Roo-Code Settings Merge & Storage Architecture

## Overview

Roo-Code stores mode configurations, custom instructions, and tool visibility/auto-approval settings across multiple layers, merged at runtime with a specific precedence order. This document explains the source of truth (SoT), storage locations, and merge logic.

---

## Storage Layers

### 1. `.roomodes` — Project-level overrides

| Property       | Value                                            |
| -------------- | ------------------------------------------------ |
| **Path**       | `<workspace_root>/.roomodes`                     |
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
      roleDefinition: "You are Roo, a custom code assistant..."
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
> 2. **Auto-approval eligibility** — the BRRR (Read/Edit/Command/MCP/Browser/
>    Modes/Subtasks) toggles in the auto-approval UI gate approval at the
>    _group_ level. If a mode does not include a group, the corresponding
>    auto-approval toggle has no effect for that mode.
>
> `tools_allowed` is additive (whitelist on top of groups). `tools_denied`
> takes precedence over both `tools_allowed` and groups. Both are evaluated
> in [`isToolAllowedForMode`](../src/core/tools/validateToolUse.ts).

### 2. Extension Global Storage — User settings (`custom_modes.yaml`)

| Property       | Value                                                                                      |
| -------------- | ------------------------------------------------------------------------------------------ |
| **Path**       | `~/.vscode/extensions/rooveterinaryinc.roo-cline/globalStorage/settings/custom_modes.yaml` |
| **Format**     | YAML                                                                                       |
| **Scope**      | Per-extension install (shared across workspaces on the same machine)                       |
| **Priority**   | Lower than `.roomodes`, higher than built-in                                               |
| **Purpose**    | User's personal modes and customizations via Settings UI                                   |
| **Source tag** | `source: "global"`                                                                         |
| **In git?**    | **No** — runtime artifact, created fresh on each machine                                   |
| **Editable**   | Via Settings UI (not recommended to edit directly)                                         |

> **This file is NOT part of the Roo-Code source tree.** It is a runtime artifact created on the user's machine when they first use the Settings UI to configure modes. The code references it only as a filename constant in [`GlobalFileNames`](../src/shared/globalFileNames.ts:5):
>
> ```typescript
> export const GlobalFileNames = {
> 	customModes: "custom_modes.yaml", // just the filename, no content
> }
> ```
>
> When the file doesn't exist yet, [`CustomModesManager`](../src/core/config/CustomModesManager.ts:261) writes an empty template:
>
> ```typescript
> if (!fileExists) {
> 	await fs.writeFile(filePath, yaml.stringify({ customModes: [] }, { lineWidth: 0 }))
> }
> ```
>
> So the file is created fresh on each user's machine with no pre-existing content from the extension's source tree.

### 3. VS Code `globalState` — Runtime persistence

| Property     | Value                                                 |
| ------------ | ----------------------------------------------------- |
| **Type**     | In-memory with disk persistence                       |
| **API**      | `context.globalState.get()` / `.update()`             |
| **Scope**    | Per-extension install                                 |
| **Priority** | Equivalent to extension global storage (synchronized) |
| **Purpose**  | Fast runtime access; acts as backup/fallback          |
| **Editable** | Via Settings UI only                                  |

Key globalState keys:
| Key | Contents |
|-----|----------|
| `customInstructions` | Global custom instructions (all modes) |
| `customModes` | Merged result of `.roomodes` + settings file |
| `customModePrompts` | Per-mode prompt overrides (roleDefinition, customInstructions, whenToUse) |
| `disabledTools` | Global flat list of tool names hidden from the LLM (Settings → Tools) — applied across all modes by `filterNativeToolsForMode` |

### 4. Built-in Modes — Compiled into extension

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

## Merge Order & Precedence

The merge happens in **two stages**:

### Stage 1: Merge `.roomodes` + Global Storage → `customModes`

From [`CustomModesManager.getCustomModes()`](../src/core/config/CustomModesManager.ts:363):

```
┌────────────────────────────────────────────────┐
│  Stage 1: CustomModesManager.getCustomModes()  │
│                                                 │
│  Read .roomodes          → projectModes (map)   │
│  Read global storage     → globalModes (map)    │
│                                                 │
│  MERGE:                                         │
│   - Project modes added first (priority)        │
│   - Global modes added only if slug NOT already │
│     in project modes (no conflict overwrite)    │
│                                                 │
│  Result: customModes[]                          │
│   - source: "project" (from .roomodes)          │
│   - source: "global"  (from global storage)     │
└────────────────────────────────────────────────┘
```

```typescript
// .roomodes wins for same slug; global ignored if project mode exists
for (const mode of roomodesModes) {
	projectModes.set(mode.slug, { ...mode, source: "project" })
}
for (const mode of settingsModes) {
	if (!projectModes.has(mode.slug)) {
		// ← only if not already in .roomodes
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

### Combined Flow

```
.roomodes ─────┐
               ├── Stage 1 merge ──→ customModes[] ──┐
global storage ┘                                      │
                                                      ├── Stage 2 overlay ──→ final ModeConfig[]
built-in modes ───────────────────────────────────────┘
```

### Conflict Resolution (Same Slug)

When the same slug exists in multiple sources:

| Sources with same slug             | Winner                  |
| ---------------------------------- | ----------------------- |
| `.roomodes` vs global storage      | `.roomodes` (Stage 1)   |
| `customModes` (merged) vs built-in | `customModes` (Stage 2) |

👉 **`.roomodes` > global storage > built-in**

---

## Write Paths

### Via Settings UI

```
Settings UI
  ├── globalState.update("customInstructions", value)    // global instructions
  ├── globalState.update("customModePrompts", {...})      // per-mode overrides
  ├── globalState.update("customModes", merged)           // merged result
  └── Write to global storage YAML file                    // file-based backup
```

### Via `.roomodes` file edit

```
User edits .roomodes
  └── File watcher triggers re-merge
       └── globalState.update("customModes", newMerged)
```

---

## Custom Instructions Flow

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

## File Watchers

The [`CustomModesManager`](../src/core/config/CustomModesManager.ts:268) watches both sources:

```typescript
// Watch global settings file
const settingsWatcher = vscode.workspace.createFileSystemWatcher(settingsPath)
settingsWatcher.onDidChange(handleSettingsChange)
settingsWatcher.onDidCreate(handleSettingsChange)
settingsWatcher.onDidDelete(handleSettingsChange)

// Watch .roomodes file
const roomodesWatcher = vscode.workspace.createFileSystemWatcher(roomodesPath)
roomodesWatcher.onDidChange(handleRoomodesChange)
roomodesWatcher.onDidCreate(handleRoomodesChange)
roomodesWatcher.onDidDelete(handleRoomodesChange)
```

On any file change, the manager re-reads both sources, re-merges, and updates `globalState`.

---

## Tool Visibility & Auto-Approval Composition

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
per-server `disabledTools` list in `mcp.json`.

### Two visibility kill-switches

| Layer                         | Storage                                  | Scope                | Edited via                                                        |
| ----------------------------- | ---------------------------------------- | -------------------- | ----------------------------------------------------------------- |
| Per-mode `groups` / `tools_*` | `.roomodes` / `custom_modes.yaml`        | Per mode             | Mode editor / file                                                |
| Global `disabledTools`        | `globalState["disabledTools"]: string[]` | All modes            | Settings → Tools                                                  |
| MCP per-tool visibility       | `mcp.json` per-server `disabledTools`    | All modes (per tool) | Settings → Tools (MCP rows dispatch `toggleToolEnabledForPrompt`) |

`ALWAYS_AVAILABLE_TOOLS` (defined in [`packages/types/src/tool.ts`](../packages/types/src/tool.ts))
bypasses mode/group restrictions — but **not** `disabledTools`. The execution-time
guard in [`isToolAllowedForMode`](../src/core/tools/validateToolUse.ts) honors
`toolRequirements` (built from `disabledTools`) before the always-available check.

### Auto-approval pipeline (whether the user is asked)

Auto-approval is decided by
[`checkAutoApproval`](../src/core/auto-approval/index.ts) and operates on
`(mode.groups ∋ groupForTool, BRRR toggle for that group, isProtected)`. It is
**independent** of `disabledTools`: if a tool is visible _and_ the matching BRRR
toggle is on for the tool's group, the action is auto-approved.

Auto-approved decisions short-circuit the `Task.ask()` round-trip and are
marked `autoApproved=true` on the `ClineMessage` so the webview suppresses the
Approve/Deny buttons (see [`ChatView.tsx`](../webview-ui/src/components/chat/ChatView.tsx)).

### Diagnostics

- The exact tool catalog sent to the LLM is logged on every API request from
  [`Task.attemptApiRequest`](../src/core/task/Task.ts):

    ```
    [tools] sending N tool(s) to LLM (mode=code): tool_a, tool_b, ...
    ```

    Use this in the Roo-Code output channel to confirm visibility filtering.

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

## Export/Import

- **Export**: Settings → Modes → Export writes a JSON file to `<workspace>/.roo/settings/`
- **Import**: Settings → Modes → Import reads a JSON file and merges into global state
- Only `source: "global"` modes are exported (project modes from `.roomodes` stay in the project)

---

## Summary Table

| Layer          | Path                                                                                       | Format           | Scope         | Priority        | Editable    |
| -------------- | ------------------------------------------------------------------------------------------ | ---------------- | ------------- | --------------- | ----------- |
| `.roomodes`    | `<workspace>/.roomodes`                                                                    | YAML             | Per-project   | Highest         | Direct edit |
| Global storage | `~/.vscode/extensions/rooveterinaryinc.roo-cline/globalStorage/settings/custom_modes.yaml` | YAML             | Per-extension | Medium          | Settings UI |
| globalState    | `context.globalState`                                                                      | In-memory + disk | Per-extension | Medium (synced) | Settings UI |
| Built-in modes | `packages/types/src/mode.ts`                                                               | TypeScript       | Per-version   | Lowest          | Code change |
