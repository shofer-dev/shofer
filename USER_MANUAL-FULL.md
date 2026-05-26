# Shofer User Manual

Welcome to Shofer. This manual covers every feature, setting, and concept you'll encounter while using Shofer.

---

## Table of Contents

1. [UI & Concepts Guide](#1-ui--concepts-guide)
2. [Settings](#2-settings)
3. [Settings Backup, Restore & Reset](#3-settings-backup-restore--reset)
4. [Custom Modes](#4-custom-modes)
5. [Auto-Approval](#5-auto-approval)
6. [Tool Categories & Mode Access Control](#6-tool-categories--mode-access-control)
7. [Native Tools Reference](#7-native-tools-reference)
8. [Model Tool Preferences](#8-model-tool-preferences)
9. [Extension Tools](#9-extension-tools)
10. [MCP Servers](#10-mcp-servers)
11. [Assistant Agent](#11-assistant-agent)
12. [Semantic Code Search (RAG Indexing)](#12-semantic-code-search-rag-indexing)
13. [Git Commit History Search](#13-git-commit-history-search)
14. [Context Management & Condensation](#14-context-management--condensation)
15. [Context Window Sizes](#15-context-window-sizes)
16. [Per-Task Cost Limit](#16-per-task-cost-limit)
17. [Parallel Tasks](#17-parallel-tasks)
18. [Understanding Task States](#18-understanding-task-states)
19. [The Stop Button](#19-the-stop-button)
20. [Queued Messages, Send Now, and Per-Task Drafts](#20-queued-messages-send-now-and-per-task-drafts)
21. [File Changes Panel](#21-file-changes-panel)
22. [Exporting Task History](#22-exporting-task-history)
23. [Attaching Files via Drag & Drop](#23-attaching-files-via-drag--drop)
24. [Working with Images](#24-working-with-images)
25. [Chat Scrolling](#25-chat-scrolling)
26. [Commands & Skills Quick-Access](#26-commands--skills-quick-access)
27. [Skills](#27-skills)
28. [Tool Preparation Progress Indicator](#28-tool-preparation-progress-indicator)
29. [Parallel Work with Git Worktrees](#29-parallel-work-with-git-worktrees)
30. [Checkpoints with Nested Git Repositories & Submodules](#30-checkpoints-with-nested-git-repositories--submodules)
31. [Special Files](#31-special-files)
32. [Privacy & Telemetry](#32-privacy--telemetry)
33. [Migrating from Roo-Code to Shofer](#33-migrating-from-roo-code-to-shofer)
34. [Migrating from GitHub Copilot](#34-migrating-from-github-copilot)
35. [Community](#35-community)

---

## 1. UI & Concepts Guide

This section explains the names and purposes of every part of Shofer's interface so you can navigate it confidently and communicate clearly about what you see.

### The Main Chat Screen

When you open Shofer and start a new task, the main chat screen fills the sidebar or editor tab.

<img src="images/chat.png" alt="Shofer Chat Interface" width="500" />

#### 1.1 Task Header (Top Bar)

The **Task Header** sits above your conversation. It shows:

| Element                      | What It Does                                                                                                                                                  |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Task Selector** (dropdown) | Lists all your tasks. Colored dots show each task's current state (green = running, yellow = waiting for you, gray = idle). Use this to switch between tasks. |
| **Task Actions** (buttons)   | Archive, pin, export (JSON or Markdown), or delete the current task.                                                                                          |
| **Context Window Bar**       | A horizontal progress bar that fills up as your conversation approaches the model's token limit.                                                              |
| **Todo List**                | The current task's checklist of steps (if one was created). Check off items as they're completed.                                                             |

<img src="images/task-hierarchy.png" alt="Task Selector with Colored State Dots" width="280" />

#### 1.2 Chat Input Bar (Bottom)

The **Chat Input Bar** is where you type messages. From left to right:

| Control                            | Icon / Label              | Purpose                                                                           |
| ---------------------------------- | ------------------------- | --------------------------------------------------------------------------------- |
| **Mode Selector** (dropdown)       | e.g. "💻 Code"            | Choose which mode Shofer operates in (see [Modes](#modes)).                       |
| **API Config Selector** (dropdown) | e.g. "openrouter"         | Pick which API provider and model to use for the current task.                    |
| **Auto-Approve Dropdown**          | Shield icon               | Toggle which tool categories Shofer can run without asking permission.            |
| **Commands Button**                | Slash `/`                 | Open a list of slash commands (e.g., `/explain`, `/fix`).                         |
| **Skills Button**                  | 🎓 Graduation cap         | Open the skills popover to load domain-specific instructions.                     |
| **Worktree Indicator**             | Branch name (e.g. `main`) | Shows your current git branch and whether the worktree is clean or dirty.         |
| **Indexing Badge**                 | Index status text         | Shows whether the codebase index is ready (Standby, Indexing, Indexed, or Error). |
| **Text Input Field**               | —                         | Type your request here. Supports `@file/path` mentions and image attachments.     |
| **Send / Stop Button**             | Arrow / Square            | Send your message, or stop Shofer while it's working.                             |

<img src="images/modes.png" alt="Mode Selector in Chat Input Bar" width="280" />

#### 1.3 Message History

The conversation appears as a scrollable list of messages. Each message is rendered as a **Chat Row**:

| Message Kind          | Appearance                                                                                      |
| --------------------- | ----------------------------------------------------------------------------------------------- |
| Your messages         | Right-aligned bubbles with your text and any attached images.                                   |
| Shofer's text replies | Left-aligned, rendered from Markdown (headings, lists, code blocks with syntax highlighting).   |
| Reasoning blocks      | Collapsible sections labeled "Thinking…" showing the model's internal reasoning.                |
| Tool calls            | Labeled blocks showing what tool Shofer used, with expandable input/output details.             |
| Tool preparation      | "Tool preparing…" spinner shown while Shofer streams tool arguments.                            |
| Errors / Warnings     | Red or yellow rows explaining what went wrong.                                                  |
| Profile violations    | Warning rows when API usage thresholds (cost, request count, tool count) are hit.               |
| File changes          | A collapsible panel listing every file Shofer modified, with **Accept** and **Revert** buttons. |

<!-- XXX: Screenshot of a conversation showing: a user message, Shofer's Markdown reply with a code block, a collapsed reasoning block, an expanded tool call, and the File Changes panel. -->

### Modes

The **Mode** determines what Shofer is allowed to do and how it behaves. You select a mode via the **Mode Selector** in the Chat Input Bar. Shofer ships with five built-in modes:

| Mode             | Icon | Best For                                                         |
| ---------------- | ---- | ---------------------------------------------------------------- |
| **Code**         | 💻   | Writing, modifying, and refactoring code.                        |
| **Architect**    | 🏗️   | Planning and designing before writing any code.                  |
| **Ask**          | ❓   | Getting explanations, answers, or recommendations.               |
| **Debug**        | 🪲   | Troubleshooting errors and diagnosing root causes.               |
| **Orchestrator** | 🪃   | Coordinating complex multi-step work by delegating to sub-tasks. |

You can add any number of custom modes via [`.shofermodes` files](#31-special-files). Common examples include a read-only **Reviewer**, a fast **Search** agent, an **Opinion** advisor, or a **Browser** mode for web interaction.

<img src="images/modes.png" alt="Mode Selector Dropdown" width="280" />

### Task States

Every task has a **lifecycle state** shown as a colored dot next to the task name in the **Task Selector**.

| Dot Color | State         | Meaning                                                              |
| --------- | ------------- | -------------------------------------------------------------------- |
| Gray      | **Idle**      | The task is not currently active.                                    |
| Green     | **Running**   | Shofer is actively processing — an API call or tool is in progress.  |
| Yellow    | **Waiting**   | Shofer needs your input — an approval dialog or question is waiting. |
| Orange    | **Paused**    | You manually paused the task. It will not resume until unpaused.     |
| ✅ Green  | **Completed** | The task finished successfully.                                      |
| ⚠️ Red    | **Error**     | The task stopped due to an error.                                    |

<img src="images/task-hierarchy.png" alt="Task Selector with State Indicators" width="280" />

### Cost Limits

You can set a USD budget cap on any root task. When the cap is reached, Shofer will:

- **Pause** — hold the task and ask if you want to increase the limit.
- **Abort** — stop the task gracefully.
- **Kill** — stop the task immediately.

### Queued Messages

If you type a message while Shofer is still processing, your message goes into a **message queue** (shown as a collapsible section above the input bar). When Shofer finishes its current work, it automatically reads the next message from the queue.

You can also click **Send Now** to cancel Shofer's current work and jump to your queued message immediately.

<img src="images/parallelism.png" alt="Parallel Tasks with Queued Messages" width="500" />

### Files Changed Panel

When Shofer modifies files in your workspace, the **File Changes Panel** appears above the input bar. It lists each modified file with:

- **+N / -N** line counts
- **Accept** button — keep the change.
- **Revert** button — undo the change.
- **Show Diff** — open a side-by-side diff view.

You can also **Accept All** or **Revert All** at once.

<!-- XXX: Screenshot of the File Changes Panel showing three modified files with diff stats, and the Accept/Revert buttons per file. -->

### Panel Title Bar Buttons

The VS Code title bar of the Shofer panel has these native icons (not part of the webview):

| Button               | Icon          | What It Does                                                                   |
| -------------------- | ------------- | ------------------------------------------------------------------------------ |
| **Plus**             | ✏️ Edit       | Start a new task (current task moves to background).                           |
| **Tasks**            | 🌳 Tree       | Open the parallel-tasks drawer.                                                |
| **Settings**         | ⚙️ Gear       | Open the settings panel.                                                       |
| **Marketplace**      | 🧩 Extensions | Open the marketplace (if enabled).                                             |
| **⋯ (More Actions)** | —             | Opens a menu containing **History** and **Popout** (open in a new editor tab). |

### API Provider Profiles

An **API Provider Profile** bundles your API key, model selection, and endpoint URL into a named configuration. You can create multiple profiles (e.g., "openrouter", "deepseek", "local-ollama") and switch between them via the **API Config Selector** dropdown.

| Concept                | What It Means                                                                                                                 |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **Sticky Profile**     | Each task remembers the profile it was started with. Switching tasks restores that task's profile.                            |
| **Sticky Mode**        | Each task remembers the mode it was started with. Switching tasks restores that task's mode.                                  |
| **Lock API Config**    | Prevents Shofer from switching profiles on its own (feature flag).                                                            |
| **Prompt Enhancement** | The ✨ button next to the chat input sends your draft through a quick LLM pass to improve clarity before Shofer processes it. |

<img src="images/provider.png" alt="API Config Selector with Provider Profiles" width="280" />

### Quick Reference

| If you see this…                              | It's called…              |
| --------------------------------------------- | ------------------------- |
| The dropdown with task names and colored dots | **Task Selector**         |
| The bar at the bottom where you type          | **Chat Input Bar**        |
| The dropdown for choosing Code / Debug / etc. | **Mode Selector**         |
| The dropdown for choosing your API provider   | **API Config Selector**   |
| The shield icon with toggles                  | **Auto-Approve Dropdown** |
| The panel listing changed files               | **File Changes Panel**    |
| The section showing waiting messages          | **Queued Messages**       |
| The progress bar showing token usage          | **Context Window Bar**    |
| The task name and info bar at the top         | **Task Header**           |
| The full-screen task list                     | **History View**          |
| The settings page                             | **Settings View**         |

---

## 2. Settings

Shofer has dozens of settings that control how tools behave, how much you spend, what commands can run automatically, and more. This section explains where settings live, how to find them, and how to configure the ones that don't appear in the VS Code Settings UI.

### Two Kinds of Settings

Shofer stores settings in two places:

| How You See Them        | Where They Live                                 | How to Configure                         |
| ----------------------- | ----------------------------------------------- | ---------------------------------------- |
| **VS Code Settings UI** | `settings.json` under `shofer.*` keys           | VS Code Settings editor (⌘, or `Ctrl+,`) |
| **JSON-only settings**  | Same `settings.json` file under `shofer.*` keys | Edit `settings.json` directly            |

#### Settings You Can Edit in the VS Code Settings UI

These appear in the VS Code Settings editor under the **Shofer** category. You can browse them by typing `shofer.` in the Settings search bar.

<img src="images/settings.png" alt="Shofer Settings in VS Code Settings UI" width="180" />

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

#### Settings You Must Edit in `settings.json` Directly

These settings do **not** appear in the VS Code Settings UI. You must open your `settings.json` file and add them manually. To open `settings.json`:

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

> **⚡ Important:** The command timeout settings are `shofer.commandExecutionTimeout` and `shofer.commandTimeoutAllowlist`. Do **not** use `shofer.devmandExecutionTimeout` or `shofer.devmandTimeoutAllowlist` — those are old, non-functional keys that appear in search results but have no effect.

#### Settings in Both Places

Some settings appear in both the VS Code Settings UI AND as JSON-only keys. For these, the two copies are stored independently — editing one does **not** automatically update the other.

| Setting                               | Where to Edit                                                                  |
| ------------------------------------- | ------------------------------------------------------------------------------ |
| `shofer.enableLlmProviderIntegration` | Both. Prefer the Settings UI toggle.                                           |
| `shofer.allowedCommands`              | Settings UI (the top-level array). The GlobalState copy is managed internally. |

If you're unsure which copy is active, use the **Export** button in Settings → About to see the complete merged configuration.

### Finding All Available Settings

**Method 1 — The VS Code Settings UI:** Open Settings (⌘, / `Ctrl+,`) and type `shofer.` in the search bar. This shows only settings with UI controls.

**Method 2 — Settings JSON:** Open your `settings.json` and type `"shofer.` — VS Code's auto-complete will suggest all known `shofer.*` keys, including JSON-only ones that have been declared in the extension manifest.

**Method 3 — Full Export:** Settings → About → **Export** produces a `shofer-code-settings.json` file containing **every** current setting value. This is the most complete snapshot of your configuration.

### Quick Tips

- **Resetting a JSON-only setting to default:** Remove the key from `settings.json` entirely. Shofer will use the built-in default.
- **Disabling the cost limit:** Set `"shofer.defaultCostLimit": null` in `settings.json` — not `"maxUsd": 0` (zero is not a valid value for the schema and will be rejected).
- **Disabling a tool globally:** Add its snake_case name to `shofer.disabledTools`. Example: `"shofer.disabledTools": ["browser_action", "use_mcp_tool"]`.
- **Debug mode:** `shofer.debug` shows extra buttons; `shofer.debugProxy.*` routes network traffic through a local proxy like mitmproxy or Charles. The debug proxy only activates when the extension runs in Development mode.
- **Agent rules:** Set `"shofer.useAgentRules": false` if you want Shofer to ignore `AGENTS.md` files in your project.

---

## 3. Settings Backup, Restore & Reset

Shofer stores your API keys, mode customizations, MCP server definitions, auto-approval preferences, and other settings across several places on your machine. This section explains what lives where, how to back everything up, how to restore from a backup, and how to factory-reset.

### Quick Reference: What Lives Where

| What You Configure                               | Where It's Stored                          | Survives Restart?    |
| ------------------------------------------------ | ------------------------------------------ | -------------------- |
| API keys (Anthropic, OpenAI, etc.)               | OS credential store (Keychain / libsecret) | ✅ Yes               |
| API provider profiles & model choices            | OS credential store (profiles blob)        | ✅ Yes               |
| Non-secret API settings (base URLs, temperature) | VS Code global state (SQLite)              | ✅ Yes               |
| Custom modes (`.shofermodes` file)               | `<project>/.shofermodes` (YAML file)       | ✅ Yes (it's a file) |
| Custom modes (Settings UI)                       | `custom_modes.yaml` in Shofer data dir     | ✅ Yes               |
| MCP server definitions                           | Settings → Tools → MCP Servers             | ✅ Yes               |
| Auto-approval toggles, custom instructions       | VS Code global state (SQLite)              | ✅ Yes               |
| Task history                                     | `<data>/tasks/<id>/` (JSON files)          | ✅ Yes               |

### Backing Up Your Settings

#### Full Export (Recommended)

The easiest way to back up **everything** (API profiles, keys, modes, auto-approval settings, custom instructions) is the Export button:

1. Open Shofer settings: click the ⚙️ gear icon in the Shofer panel title bar
2. Navigate to the **About** tab
3. Click **Export**

<!-- XXX: Screenshot — About tab in SettingsView showing the Export, Import, and Reset buttons in a row. The Export button should be highlighted or called out with an arrow annotation. -->

This saves a `shofer-code-settings.json` file containing your full configuration.

> **Note:** MCP server definitions are NOT included in the export. To back up MCP configs separately, copy `mcp_settings.json` from your Shofer data directory (see [Finding Your Data Directory](#finding-your-data-directory)).

#### What the Export Contains

- **All API provider profiles** — including API keys, model IDs, base URLs, and temperature/rate-limit settings
- **All custom modes** that you created via Settings → Modes
- **Global custom instructions** and **mode-specific custom instructions**
- **Auto-approval settings** — which tool groups are auto-approved
- **Command execution permissions, cost limits, checkpoint settings**, and more

#### What Is NOT Exported

| Not Exported                 | Why                                                            |
| ---------------------------- | -------------------------------------------------------------- |
| MCP server definitions       | Managed separately; copy `mcp_settings.json` manually          |
| Project `.shofermodes` files | Already in your git repo — no need to export                   |
| Task history                 | Per-task data — export individual tasks from the History panel |

### Restoring Settings

#### Full Import

1. Open Shofer settings → **About** tab
2. Click **Import**
3. Choose a previously-exported `shofer-code-settings.json` file

<!-- XXX: Screenshot — File open dialog showing selection of a shofer-code-settings.json file, with the file path visible. -->

Import is **additive** — existing profiles not in the import file are preserved. API keys in the import file overwrite existing ones for matching profiles.

#### Per-Mode Import/Export

The **Modes** tab has its own Export/Import system for individual mode definitions:

- **Export** button next to each mode → saves a single `.yaml` file with that mode's definition, instructions, and bundled rules
- **Import** button in the Modes toolbar → load a `.yaml` file into either:
    - **Project** (`.shofermodes`) — available in this workspace only
    - **Global** (`custom_modes.yaml`) — available in all workspaces on your machine

<!-- XXX: Screenshot — Modes tab showing the Export icon button next to a mode row (e.g. "💻 Code") and the Import button in the toolbar at the top. -->

### Factory Reset

The **Reset** button in Settings → About wipes all Shofer settings back to defaults. This is **destructive and cannot be undone**.

> ⚠️ **Export your settings first** if you want to restore them later.

#### What Reset Wipes

| Wiped                                                   | Not Wiped                                   |
| ------------------------------------------------------- | ------------------------------------------- |
| ✅ All API profiles & keys                              | ❌ MCP server configs (`mcp_settings.json`) |
| ✅ Global settings (auto-approval, custom instructions) | ❌ Project `.shofermodes` file              |
| ✅ Custom modes                                         | ❌ VS Code `settings.json`                  |
| ✅ Task history                                         |                                             |

### Custom Modes: `.shofermodes` vs Settings UI

You can define custom modes in **two places**, and they merge with a specific order of precedence:

| Source              | Location                     | Priority    | Shared via Git?     |
| ------------------- | ---------------------------- | ----------- | ------------------- |
| `.shofermodes` file | `<project>/.shofermodes`     | **Highest** | ✅ Yes              |
| Settings → Modes    | `custom_modes.yaml` (global) | Medium      | ❌ No (per-machine) |
| Built-in modes      | Compiled into extension      | Lowest      | —                   |

When the same mode slug exists in both `.shofermodes` and global settings, the `.shofermodes` version **always wins**.

<!-- XXX: Screenshot — Side-by-side: a .shofermodes file open in the editor showing a custom mode definition (YAML), and the Modes tab in Settings showing the same mode with a "project" source badge. -->

### Auto-Import on Startup (Code-Server / Docker)

If you run Shofer in code-server or a container environment, you can pre-configure it to import settings automatically on every startup:

1. Export your settings from a configured Shofer instance
2. Place `shofer-code-settings.json` at a known path (e.g. `/etc/shofer/settings.json`)
3. Set the VS Code setting `shofer.autoImportSettingsPath` to that path

```json
{
	"shofer.autoImportSettingsPath": "/etc/shofer/settings.json"
}
```

On extension activation, all API profiles and global settings are imported automatically. This is especially useful in Docker where the OS credential store may not persist across restarts.

> **Note:** The auto-import only runs on startup. To re-import without restarting, use the **Import** button in Settings → About manually.

### Finding Your Data Directory

Shofer stores its runtime data under VS Code's global storage directory:

| Platform | Typical Path                                                        |
| -------- | ------------------------------------------------------------------- |
| Linux    | `~/.config/Code/User/globalStorage/shofer.dev/`                     |
| macOS    | `~/Library/Application Support/Code/User/globalStorage/shofer.dev/` |
| Windows  | `%APPDATA%\Code\User\globalStorage\shofer.dev\`                     |

Within this directory:

| Path                         | Contents                      |
| ---------------------------- | ----------------------------- |
| `settings/custom_modes.yaml` | Your custom mode definitions  |
| `settings/mcp_settings.json` | MCP server definitions        |
| `tasks/<id>/`                | Per-task history and messages |
| `cache/`                     | Cached model lists            |

You can override this path with the `shofer.customStoragePath` VS Code setting.

### Frequently Asked Questions

**Why do my MCP servers survive a factory reset?** MCP server definitions live in `mcp_settings.json`, which is **not** part of the reset process. To clear MCP servers, delete them manually in Settings → Tools → MCP Servers, or delete the `mcp_settings.json` file from your data directory.

**Can I share my API keys across machines with Export/Import?** Yes. The Export file contains your API keys (in `providerProfiles.apiConfigs.*.apiKey` fields). Importing this file on another machine will copy those keys into that machine's OS credential store. Be careful who you share the export file with.

**What happens if both `.shofermodes` and `custom_modes.yaml` define the same mode?** The `.shofermodes` version wins. If you later delete the mode from `.shofermodes`, the global version from `custom_modes.yaml` takes effect again.

**Do I need to restart after editing `.shofermodes`?** No. Shofer watches `.shofermodes` for changes and reloads mode definitions automatically within seconds. The same applies to `mcp_settings.json` and `custom_modes.yaml`.

---

## 4. Custom Modes

Every Shofer mode (Code, Architect, Debug, Reviewer, etc.) is defined by a configuration that controls **which tools the AI can call** while operating in that mode. You can create your own custom modes or override built-in ones by writing a `.shofermodes` file.

This section explains the three fields that govern tool access — `groups`, `tools_allowed`, and `tools_denied` — and shows you how to combine them to build safe, focused modes.

### Quick Start: Creating Your First Custom Mode

Create a `.shofermodes` file at the root of your project (or in your global Shofer config directory). Here is the simplest possible custom mode — a read-only reviewer that can only search and read files:

```yaml
customModes:
    - slug: my-reviewer
      name: 🔍 My Reviewer
      roleDefinition: You are a code reviewer. You read code, find issues, and
          propose fixes — but you never edit files.
      groups:
          - read
```

**XXX: Screenshot showing the ModeSelector dropdown in the chat input bar with a custom mode entry visible (e.g. "🔍 My Reviewer" alongside the built-in modes like "💻 Code", "🏗️ Architect").**

Save the file, reload your VS Code window, and your mode appears in the mode dropdown. When you select it, the AI can only call tools from the `read` group — things like `read_file`, `grep_search`, `list_files`, `lsp_search`, and other read-only operations.

### The Three Tool-Access Fields

Every mode definition supports three fields that control tool access:

| Field           | Type            | What It Does                                                                                     |
| --------------- | --------------- | ------------------------------------------------------------------------------------------------ |
| `groups`        | list of strings | Grants access to broad **categories** of tools (e.g. `read`, `write`, `mcp`)                     |
| `tools_allowed` | list of strings | Grants access to **individual** tool IDs, independent of groups                                  |
| `tools_denied`  | list of strings | Unconditionally **blocks** specific tool IDs, even if groups or `tools_allowed` would grant them |

#### How They Combine

When Shofer decides whether a tool is allowed in a mode, it applies this rule:

> **Allowed** = (tool is in `groups` **OR** tool is in `tools_allowed`) **AND** tool is **NOT** in `tools_denied`

In plain English:

- `groups` and `tools_allowed` are **additive** — both grant access, and a tool needs only one of them to pass.
- `tools_denied` is a **hard veto** — it always wins, no exceptions.

### Field-by-Field Reference

#### `groups` — Broad Capability Categories

Groups are the primary way to assign tool access. Instead of listing dozens of individual tool names, you grant a group and get all its tools.

Available groups and what they contain:

| Group           | What It Grants                                                                   |
| --------------- | -------------------------------------------------------------------------------- |
| `read`          | Read files, search code, list directories, inspect project structure, etc.       |
| `write`         | Modify files: create, edit, rename, delete, apply diffs, generate images.        |
| `execute`       | Run CLI commands (`execute_command`, `read_command_output`, `sleep`).            |
| `mcp`           | MCP protocol tools: call tools and access resources on connected MCP servers.    |
| `browser`       | Browser automation: navigate pages, click, type, extract content, screenshot.    |
| `mode`          | Mode switching (`switch_mode`).                                                  |
| `subtasks`      | Spawn and manage background child tasks (`new_task`, `check_task_status`, etc.). |
| `questions`     | Ask the user questions (`ask_followup_question`).                                |
| `uncategorized` | Fallback for tools without a specific group. Currently empty.                    |

**XXX: Screenshot showing a `.shofermodes` file open in the VS Code editor with YAML syntax highlighting. The `groups:` list should be visible and a few group names (`read`, `write`, `mcp`, `browser`) should be recognizable. Show the YAML schema validation warning/error tooltip if VS Code flags an invalid group name.**

##### Group Entry Forms

Each entry in the `groups` list can be written in three ways:

1. **Bare group name** — the simplest form. Grants all tools in that group:

    ```yaml
    groups:
        - read
        - mcp
    ```

2. **Tuple with options** — adds a `fileRegex` restriction (only for the `write` group currently):

    ```yaml
    groups:
        - - write
          - fileRegex: "\\.md$"
    ```

    This restricts write tools to only touch `.md` files. The AI can still read any file, but `write_to_file`, `apply_diff`, etc. will be rejected for files not matching the regex.

3. **Scoped group** — narrows a group to specific tools:

    ```yaml
    groups:
        - browser
        - mcp
        - read:
              allowed:
                  - mcp--arkware--web_search
    ```

    This gives the mode ALL `browser` and `mcp` tools, but from the `read` group it gets ONLY `mcp--arkware--web_search`. You can also use `denied` to remove specific tools from a group:

    ```yaml
    groups:
        - write:
              denied:
                  - generate_image
    ```

#### `tools_allowed` — Individual Tool Grants

Use `tools_allowed` to grant specific tools without pulling in an entire group:

```yaml
groups:
    - read
tools_allowed:
    - new_task
```

This mode has every tool from `read` **plus** `new_task` (which belongs to the `subtasks` group, not `read`).

A mode can also declare access purely through `tools_allowed` and omit `groups` entirely:

```yaml
tools_allowed:
    - read_file
    - grep_search
    - list_files
    - lsp_search
```

#### `tools_denied` — Hard Veto List

Use `tools_denied` to subtract a tool from an otherwise broad permission set:

```yaml
groups:
    - read
    - write
    - execute
tools_denied:
    - execute_command
```

This mode can read, write, and run most command-line operations — but `execute_command` is blocked.

**Deny always wins.** Even if you list a tool in both `tools_allowed` and `tools_denied`, it will be blocked:

```yaml
tools_allowed:
    - read_file
    - execute_command
tools_denied:
    - execute_command
```

Result: `read_file` is allowed, `execute_command` is denied.

### Choosing Your Strategy

| Goal                                           | Use This                                                             |
| ---------------------------------------------- | -------------------------------------------------------------------- |
| "Grant a broad set of capabilities"            | `groups: [read, write, mcp]`                                         |
| "Grant read + one specific extra tool"         | `groups: [read]` + `tools_allowed: [new_task]`                       |
| "Grant everything except one dangerous tool"   | `groups: [read, write, execute]` + `tools_denied: [execute_command]` |
| "Grant only a handful of specific tools"       | `tools_allowed: [read_file, grep_search, ...]` (no `groups`)         |
| "Allow write but only for documentation files" | `groups: [["write", { fileRegex: "\\.md$" }]]`                       |
| "Allow most read tools except web search"      | `groups: [{ read: { denied: [mcp--arkware--web_search] } }]`         |

### Real-World Examples

**Example: Safe Reviewer (Read + Execute, No Writes)**

```yaml
- slug: reviewer
  name: 👀 Reviewer
  roleDefinition: You perform code review. You read code, run linting and
      tests, query logs and metrics — but you NEVER edit files.
  groups:
      - read
      - execute
      - mcp
      - questions
```

**XXX: Screenshot of the ChatView when the Reviewer mode is active. The chat input bar should show "👀 Reviewer" in the ModeSelector. A chat message from the AI should be visible showing review findings with file paths and line numbers but no file edits.**

**Example: Docs-Only Editor (Write Scoped to Markdown)**

```yaml
- slug: docs-editor
  name: 📝 Docs Editor
  roleDefinition: You write and edit documentation. You can only modify
      Markdown files.
  groups:
      - read
      - - write
        - fileRegex: "\\.(md|mdx)$"
```

If the AI tries to edit a `.ts` file in this mode, Shofer blocks it with an error message.

**XXX: Screenshot of the ChatView showing an error/warning row that appears when the AI attempts to write a file that doesn't match the fileRegex. The message should say something like "Tool 'write_to_file' blocked — only files matching \\.md$ are allowed in 📝 Docs Editor mode."**

**Example: Search Sub-Task (Bare Minimum)**

```yaml
- slug: search
  name: 🔎 Search
  roleDefinition: Fast codebase search and retrieval. You find things and
      return results — you never edit.
  groups:
      - read
      - questions
```

### Where to Put Your `.shofermodes` File

| Location                                 | Scope                                                    |
| ---------------------------------------- | -------------------------------------------------------- |
| `<project-root>/.shofermodes`            | Project-level — affects everyone working on this project |
| `~/.shofer/.shofermodes` (global config) | Global — available in all your projects                  |

**XXX: Screenshot showing the VS Code file explorer with a `.shofermodes` file visible at the project root. The file should be highlighted to show its location.**

Project-level modes override global modes with the same `slug`. This means your team can ship a `.shofermodes` in the repo with safe defaults, and individual developers can customize further in their global config.

### Validating Your Configuration

After saving `.shofermodes`:

1. Reload the VS Code window (`Developer: Reload Window` from the command palette).
2. Open the mode dropdown — your custom mode should appear.
3. Try using a tool that should be blocked — Shofer will tell the AI `"Tool X is not allowed in <mode> mode"`.

**XXX: Screenshot of the ChatView showing the validation error when the AI tries to use a blocked tool. The error message row should be clearly visible — show the exact error text: `Tool "write_to_file" is not allowed in reviewer mode.`**

### Rules & Constraints

- **At least one allow-source required.** A mode must have `groups` or `tools_allowed` (or both). `tools_denied` alone is not sufficient.
- **Built-in modes can be overridden.** Create a custom mode with the same `slug` as a built-in mode (e.g. `code`, `ask`, `debug`) and your version wins within that project.
- **Duplicate group names are rejected.** You cannot list the same group twice in a mode's `groups` array.
- **Group names must be valid.** Only the nine groups listed above are recognized. Old names (`edit`, `command`, `modes`) are auto-translated to their canonical forms (`write`, `execute`, `mode`).
- **Tool names must exist.** Referencing a tool that doesn't exist (or was removed) will cause validation errors.

### Troubleshooting

| Symptom                                               | Likely Cause                                                      |
| ----------------------------------------------------- | ----------------------------------------------------------------- |
| Mode doesn't appear in the dropdown                   | YAML syntax error, or missing `slug`/`name`/`roleDefinition`      |
| AI says a tool is "not allowed" unexpectedly          | Check `tools_denied` — deny always wins                           |
| Write tools work on files that should be blocked      | `fileRegex` only applies to the `write` group; use scoped denied  |
| Custom mode takes effect but built-in still shows     | You overrode the slug correctly — the name changes but slug stays |
| "Either 'groups' or 'tools_allowed' must be provided" | Your mode has neither field; add at least one                     |

---

## 5. Auto-Approval

Shofer's auto-approval system lets you control when the AI agent can act without asking for permission first. You configure it through a set of toggles — each controlling a specific category of actions — accessible from the **AutoApproveDropdown** in the chat input bar.

<!-- XXX: Screenshot — The AutoApproveDropdown open, showing the full list of toggle categories (Read-Only, Write, Browser, MCP, Mode Switch, Subtasks, Command Execution, Follow-Up Questions) with their on/off states and additional options (Outside Workspace, Protected Files, Uncategorized MCP). The dropdown should be attached to the gear/sliders icon next to the mode selector and API config selector in the ChatTextArea. -->

### How It Works

Every time the agent wants to use a tool, run a command, or ask a follow-up question, the extension checks your auto-approval settings. The request matches the **first applicable rule** in this order:

1. Some lightweight actions are **always auto-approved** — they have no side effects and don't need explicit permission.
2. If the **master toggle** (`autoApprovalEnabled`) is off, everything goes to you for approval.
3. If the master toggle is on, each category toggle is checked.

If a toggle is off, Shofer shows you the tool's parameters and waits for your **Approve** or **Reject** click before proceeding.

### Toggle Reference

<!-- XXX: Screenshot — The Settings panel (SettingsView) scrolled to the "Auto-Approval" section showing all toggles as labelled switches with their additional option dropdowns next to them. -->

Each toggle is a simple ON/OFF switch. The table below explains what each one controls and lists any extra options that refine its behavior.

| Toggle                  | What It Auto-Approves                                                                       | Extra Options                                                                                                                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Read-Only**           | Reading files, searching code, listing directories, fetching web pages, getting diagnostics | **Outside Workspace** — also allow reading files _outside_ the project folder                                                                                                          |
| **Write**               | Creating, editing, renaming, or deleting files                                              | **Outside Workspace** — allow writing outside the project folder; **Protected Files** — allow modifying `.shoferignore`, `.shofermodes`, `AGENTS.md`, and other sensitive config files |
| **Browser**             | Browser automation tools (navigate, click, screenshot, etc.)                                | —                                                                                                                                                                                      |
| **MCP**                 | MCP (Model Context Protocol) tool calls and resource access                                 | **Uncategorized MCP** — also allow MCP tools that don't have an explicit tool group assigned                                                                                           |
| **Mode Switch**         | Switching the agent between modes (Code, Architect, Debug, etc.)                            | —                                                                                                                                                                                      |
| **Subtasks**            | Spawning, cancelling, and completing background child tasks                                 | —                                                                                                                                                                                      |
| **Command Execution**   | Running shell commands                                                                      | **Allowed Commands** / **Denied Commands** — see [Command Allowlisting](#command-allowlisting) below                                                                                   |
| **Follow-Up Questions** | Auto-selecting the first suggested answer after a countdown                                 | **Timeout** — milliseconds to wait before auto-selecting (e.g., `5000` for 5 seconds); without this, the toggle alone does nothing                                                     |

> **Mode-scoped:** Each mode (Code, Architect, Debug, etc.) has its own set of auto-approval toggles. Toggling Read-Only ON in Code mode does NOT affect Architect mode. Switch modes via the **ModeSelector** dropdown.
>
> <!-- XXX: Screenshot — Two side-by-side AutoApproveDropdowns: one with Code mode selected and Read-Only + Write ON, another with Architect mode selected and only Read-Only ON. The mode label above each dropdown should make it clear they're independent. -->

### Always Auto-Approved Actions

These actions never require your approval, regardless of toggle state:

| Action                              | Why                                            |
| ----------------------------------- | ---------------------------------------------- |
| **Updating the todo list**          | UI-only, no side effects                       |
| **Loading a skill**                 | Skills must be installed by you first          |
| **Renaming a task**                 | Non-destructive metadata change                |
| **Sending feedback**                | Appends a line to the extension output channel |
| **Checking background task status** | Reads in-memory state only                     |
| **Waiting for background tasks**    | Event-driven, no polling                       |
| **Checking MCP call status**        | Reads in-memory async call state               |
| **Fetching web pages**              | HTTP GET of public URLs                        |
| **Finding files by name**           | Glob matching against workspace index          |
| **Viewing images**                  | Reads a file for visual analysis               |
| **Getting diagnostics**             | Language-server errors/warnings                |
| **Listing changed files**           | Session-local file tracking                    |
| **Project info**                    | Detected languages, frameworks, build system   |
| **Reading project structure**       | Directory tree                                 |
| **Finding code references**         | LSP "find all references"                      |
| **Symbol search**                   | LSP workspace symbols                          |

### Command Allowlisting

The **Command Execution** toggle is a _gate_ — turning it ON by itself does **not** auto-approve any command. You must also configure **Allowed Commands** (a list of command prefixes) for the toggle to have any effect.

#### How It Works

When enabled, each shell command is split by `&&`, `||`, `;`, `|`, `&`, and newlines into sub-commands. Each sub-command is matched against your allowlist and denylist using a **"longest prefix wins"** rule:

<!-- XXX: Screenshot — The Settings panel showing the Command Execution section with Allowed Commands (a multi-line text input containing "git", "npm run", "go") and Denied Commands (containing "git push", "npm run build"). Below it, a sample command "git status && npm test" with a green checkmark annotation "auto-approve" and a breakdown showing each sub-command match result. -->

| allowedCommands          | deniedCommands | Command              | Result          | Why                                                                                |
| ------------------------ | -------------- | -------------------- | --------------- | ---------------------------------------------------------------------------------- |
| `["git"]`                | `[]`           | `git status`         | ✅ Auto-approve | Allowlist match                                                                    |
| `["git"]`                | `["git push"]` | `git push origin`    | ❌ Auto-deny    | Denylist `"git push"` (10 chars) beats allowlist `"git"` (4 chars)                 |
| `["git push --dry-run"]` | `["git push"]` | `git push --dry-run` | ✅ Auto-approve | Allowlist `"git push --dry-run"` (20 chars) beats denylist `"git push"` (10 chars) |
| `["*"]`                  | `["rm"]`       | `rm -rf /`           | ❌ Auto-deny    | Wildcard `*` matches everything, but denylist entry blocks `rm`                    |
| `["*"]`                  | `[]`           | `echo hello`         | ✅ Auto-approve | Wildcard with no denylist                                                          |
| `["git"]`                | `[]`           | `npm install`        | 🔶 Ask user     | No allowlist match for `npm`                                                       |
| `[]` (empty)             | `[]`           | `anything`           | 🔶 Ask user     | Nothing matches                                                                    |

**Key rules:**

- If the longest match is on the allowlist → approved
- If the longest match is on the denylist → denied
- If both match → whichever prefix is longer wins
- If neither matches → the user is asked
- If **any** sub-command in a chain is denied, the whole chain is denied

#### Wildcard `*`

Putting `*` in your allowed commands approves _everything_ — but you can still block specific commands via the denylist. Denylist entries override `*` when their prefix is more specific.

#### Dangerous Patterns (Never Auto-Approved)

Certain shell patterns are **never** auto-approved, even with `allowedCommands = ["*"]`. These patterns can execute arbitrary commands through shell expansion and always require explicit approval:

- `${var@P}` — prompt string expansion (executes embedded commands)
- `${var@Q}`, `${var@E}`, `${var@A}`, `${var@a}` — parameter expansion operators
- `${!var}` — indirect variable references
- `<<<$(...)` or `` <<<`...` `` — here-strings with command substitution
- `=(...)` — Zsh process substitution
- `*(e:...:)`, `?(e:...:)` — Zsh glob qualifiers with code execution

### Cost & Request Limits

Beyond per-tool approval, Shofer also tracks cumulative cost and API request count. When either exceeds a configured threshold, the user is prompted for approval regardless of toggle state. Configure these in **Settings → Limits**.

<img src="images/cost-limits.png" alt="Cost Limits Configuration" width="280" />

### Security Best Practices

- **Start with toggles OFF** and enable them incrementally as you build trust in the agent's behavior.
- **Use the denylist for destructive commands** (`rm`, `git push --force`, `shutdown`, `format`) even when you allowlist broadly with `*`.
- **Keep "Protected Files" OFF** unless you genuinely want the agent editing your `.shoferrules`, `AGENTS.md`, or VS Code workspace settings.
- **Leave "Outside Workspace" OFF** unless you're comfortable with the agent reading or writing files anywhere on your filesystem.
- **Review the Always Auto-Approved list** above — some actions like `fetch_web_page` never prompt, so they won't appear in your approval flow.
- **Per-mode configuration matters** — a Write toggle ON in Code mode does not grant write in Architect mode. Set up each mode's toggles based on what you expect the agent to do in that mode.

---

## 6. Tool Categories & Mode Access Control

This section explains how Shofer's tool categories control which tools are available in each mode and how you can configure them.

### What are tool categories?

Every tool Shofer can use belongs to exactly one **category** (also called a **ToolGroup**). These categories determine two things:

1. **Which modes can use the tool** — each mode declares which categories it allows.
2. **Which auto-approval toggle controls the tool** — you can let Shofer auto-approve tools from specific categories without asking you each time.

There are 9 categories:

| Category        | What it controls                                       | Example tools                                             |
| --------------- | ------------------------------------------------------ | --------------------------------------------------------- |
| `read`          | Reading files, searching code, inspecting your project | `read_file`, `grep_search`, `rag_search`                  |
| `write`         | Creating and editing files                             | `apply_diff`, `write_to_file`, `insert_edit`              |
| `execute`       | Running terminal commands                              | `execute_command`, `sleep`                                |
| `browser`       | Controlling a web browser                              | `browser_navigate`, `browser_click`, `browser_screenshot` |
| `mcp`           | Talking to external MCP servers                        | `use_mcp_tool`, `access_mcp_resource`                     |
| `mode`          | Switching modes and managing tasks                     | `switch_mode`                                             |
| `subtasks`      | Delegating work to background tasks                    | `new_task`, `check_task_status`                           |
| `questions`     | Asking you questions                                   | `ask_followup_question`                                   |
| `uncategorized` | Catch-all for tools without a declared category        | (typically empty)                                         |

### How categories affect mode availability

Each mode declares which categories it allows. Here's what the built-in modes include:

<!-- XXX Screenshot: ModeSelector dropdown in the ChatTextArea, showing the mode picker with "Code" selected. The dropdown should be expanded showing all available modes. -->

| Default mode        | Categories available                                                                |
| ------------------- | ----------------------------------------------------------------------------------- |
| 💻 **Code**         | `read`, `write`, `execute`, `mcp`, `mode`, `subtasks`, `questions`, `uncategorized` |
| 🏗️ **Architect**    | `read`, `write` (.md files only), `mcp`, `questions`                                |
| ❓ **Ask**          | `read`, `mcp`                                                                       |
| 🪲 **Debug**        | `read`, `write`, `execute`, `mcp`, `subtasks`, `questions`, `uncategorized`         |
| 🪃 **Orchestrator** | (none — delegates work via `new_task`)                                              |

> **Key point:** The Code and Debug modes have the broadest tool access. Architect mode can read code and write markdown plans but can't run commands or edit source files. Ask mode is read-only plus MCP tools.

#### Always-available tools

A small set of tools are available in **every** mode, regardless of category membership:

`attempt_completion`, `update_todo_list`, `run_slash_command`, `skills`, `set_task_title`, `give_feedback`

### How categories affect auto-approval

<!-- XXX Screenshot: AutoApproveDropdown expanded in the ChatTextArea, showing the toggle switches for: Read, Write, Execute, Browser, MCP, Mode, Subtasks, and Questions. Each toggle should be labeled with its category name. -->

Each category maps to an auto-approval toggle in the **AutoApproveDropdown** (the shield icon in the chat input bar):

| Toggle        | Category    | Description                                             |
| ------------- | ----------- | ------------------------------------------------------- |
| **Read**      | `read`      | Auto-approve file reads, searches, and code inspections |
| **Write**     | `write`     | Auto-approve file creation and edits                    |
| **Execute**   | `execute`   | Auto-approve terminal command execution                 |
| **Browser**   | `browser`   | Auto-approve browser automation                         |
| **MCP**       | `mcp`       | Auto-approve MCP tool calls                             |
| **Mode**      | `mode`      | Auto-approve mode switching                             |
| **Subtasks**  | `subtasks`  | Auto-approve spawning and managing background tasks     |
| **Questions** | `questions` | Auto-approve or auto-timeout follow-up questions        |

Toggle a category ON and Shofer will use those tools without asking you. Toggle it OFF and you'll be prompted to approve each use.

### Configuring custom modes

When you define a custom mode in a `.shofermodes` file, you control which categories (and specific tools) the mode can use:

<!-- XXX Screenshot: SettingsView showing the Custom Modes section where a user is defining a new mode. The "Groups" field should be visible with category checkboxes. -->

```json
{
	"customModes": [
		{
			"slug": "reviewer",
			"name": "👀 Reviewer",
			"roleDefinition": "You are a code reviewer...",
			"groups": ["read"],
			"tools_allowed": ["ask_followup_question"],
			"tools_denied": ["execute_command"]
		}
	]
}
```

- **`groups`** — list of categories. The mode gets ALL tools from those categories.
- **`tools_allowed`** — additional individual tools to add, even if their category is not in `groups`.
- **`tools_denied`** — individual tools to remove, even if their category IS in `groups`.

You can also scope a category to specific file types (e.g., Architect's `write` is restricted to `.md` files):

```json
"groups": ["read", ["write", { "fileRegex": "\\.md$", "description": "Markdown files only" }], "mcp"]
```

### Assigning categories to MCP tools

When you add an MCP server in `mcp.json`, you can assign each tool to a category:

```json
{
	"mcpServers": {
		"github": {
			"command": "npx",
			"args": ["-y", "@modelcontextprotocol/server-github"],
			"toolGroups": {
				"get_pull_request": "read",
				"create_issue": "write",
				"merge_pull_request": "execute"
			}
		}
	}
}
```

This controls both mode availability and auto-approval behavior for each MCP tool.

If you don't assign a category, the tool defaults to `uncategorized` — which means it's only available in modes that explicitly include the `uncategorized` group (Code and Debug, by default).

### Quick reference

- **Want Shofer to edit files without asking?** → Enable the **Write** toggle in AutoApproveDropdown.
- **Want to limit Architect mode to reading only?** → It already is! Architect only has `read` + `write` for `.md`.
- **Added an MCP server but its tools don't appear?** → Check that your current mode includes the category you assigned (or `uncategorized`).
- **Creating a custom mode?** → Start with `groups: ["read", "mcp"]` for a safe read-only mode, then add categories as needed.

---

## 7. Native Tools Reference

This section explains the built-in tools Shofer uses to read, edit, and search your workspace, execute commands, manage tasks, and interact with external services.

### What are native tools?

Native tools are Shofer's "hands" — the actions it can take in your workspace without external plugins or MCP servers. When you ask Shofer to "find where authentication logic is defined" or "refactor this function," it uses these tools to read files, search code, apply edits, and run commands.

Everything Shofer does — from reading a single line to spawning background sub-tasks — goes through a native tool call. Understanding what's available helps you know what to expect.

### How Shofer chooses tools

Shofer doesn't use every tool in every conversation. Two things control which tools are available:

1. **Your current mode** — Each mode (Code, Architect, Ask, Debug, Orchestrator) allows a different set of tool categories. Code mode has the most access; Ask mode is read-only.
2. **Your auto-approval settings** — You can let Shofer auto-approve certain categories of tools so it doesn't ask permission every time, or keep them gated behind your explicit approval.

<!-- XXX Screenshot: Chat view with a tool-use card expanded, showing a read_file call with the file path, line range, and the resulting file content displayed in the chat. The tool card should show the "Approved" badge indicating auto-approval was used. -->

### Tool overview by category

#### File Operations

Tools for reading, creating, editing, and organizing files.

| Tool               | What it does                                                                                                                       |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `read_file`        | Reads one or more files with line numbers, supports two modes: **slice** (offset/limit) and **indentation** (semantic code blocks) |
| `write_to_file`    | Creates a new file or overwrites an existing one                                                                                   |
| `apply_diff`       | Applies precise search/replace edits to existing files                                                                             |
| `insert_edit`      | Inserts text at a specific line and column                                                                                         |
| `sed`              | Performs regex find-and-replace across a file                                                                                      |
| `file`             | Moves, renames, or deletes files and directories                                                                                   |
| `create_directory` | Creates a new directory (including parent directories)                                                                             |
| `rename_symbol`    | Renames a symbol (function, variable, class) across the entire codebase using the language server                                  |
| `view_image`       | Displays an image file in the chat                                                                                                 |

<!-- XXX Screenshot: Chat view showing a file change card (green/red diff) after Shofer applied an edit. The "Accept" and "Reject" buttons should be visible in the card header. -->

#### Search & Discovery

Tools for finding code, exploring the project, and understanding the codebase.

| Tool                     | What it does                                                                           |
| ------------------------ | -------------------------------------------------------------------------------------- |
| `grep_search`            | Regex search across the workspace with configurable context lines                      |
| `find_files`             | Find files by glob pattern (e.g., `**/*.test.ts`)                                      |
| `list_files`             | List directory contents (optionally recursive)                                         |
| `lsp_search`             | Search for symbols (functions, classes, variables) using the language server           |
| `rag_search`             | Semantic search using AI embeddings — finds code by meaning, not exact text            |
| `git_search`             | Semantic search over git commit history to find relevant changes, authors, and context |
| `list_code_usages`       | Find all references to a symbol across the codebase                                    |
| `read_project_structure` | Get a tree view of the workspace directory layout                                      |
| `get_errors`             | Retrieve language server diagnostics (errors and warnings)                             |
| `get_project_setup_info` | Detect languages, frameworks, build systems, and package managers in the project       |
| `get_changed_files`      | List files Shofer has modified in the current task                                     |
| `ask_assistant_agent`    | Ask a background assistant agent that maintains long-term codebase knowledge           |

<!-- XXX Screenshot: Chat view showing a rag_search result card, with the query shown and a list of matching file paths with relevance scores and code snippets displayed below. -->

#### Execution & System

Tools for running commands, fetching web content, and interacting with the system.

| Tool                  | What it does                                                                       |
| --------------------- | ---------------------------------------------------------------------------------- |
| `execute_command`     | Run a shell command in a VS Code terminal, with optional timeout                   |
| `read_command_output` | Retrieve output from a previously-run command (supports search, offset, and limit) |
| `fetch_web_page`      | Download and extract text content from web pages                                   |
| `sleep`               | Pause execution for a specified duration                                           |

<!-- XXX Screenshot: Chat view showing an execute_command card expanded, with the command shown and terminal output displayed below. A "Running..." indicator should be visible if captured mid-execution. -->

#### Task & Workflow Management

Tools for organizing work across multiple parallel tasks.

| Tool                      | What it does                                                    |
| ------------------------- | --------------------------------------------------------------- |
| `new_task`                | Spawn a new child task (synchronous or background) in any mode  |
| `check_task_status`       | Check progress of a background child task                       |
| `wait_for_task`           | Wait for one or more background tasks to complete               |
| `cancel_tasks`            | Stop running background tasks                                   |
| `answer_subtask_question` | Answer a question a background child asked                      |
| `list_background_tasks`   | List all background tasks spawned by the current task           |
| `set_task_title`          | Set a descriptive title for the current conversation            |
| `give_feedback`           | Send feedback to the Shofer.Dev team                            |
| `attempt_completion`      | Mark the task as complete and present the final result          |
| `update_todo_list`        | Update the checklist tracking progress through the task         |
| `skills`                  | Load and execute a skill — a packaged workflow for common tasks |
| `switch_mode`             | Switch to a different mode mid-task                             |

<!-- XXX Screenshot: TaskSelector sidebar panel showing a parent task with two child tasks indented underneath. The parent should show "waiting" state and one child should show "running" with a title. -->

#### MCP (Model Context Protocol)

Tools for interacting with external MCP servers. (Requires configured MCP servers.)

| Tool                    | What it does                                                                   |
| ----------------------- | ------------------------------------------------------------------------------ |
| `access_mcp_resource`   | Read a resource (file, API response, system info) from an MCP server           |
| `call_mcp_tool_async`   | Call an MCP server tool without blocking — returns a call ID for later polling |
| `check_mcp_call_status` | Check the status of a pending async MCP call                                   |
| `wait_for_mcp_call`     | Wait for one or more async MCP calls to complete                               |

<!-- XXX Screenshot: Chat view showing an MCP tool result card, with the server name, tool name, and response content visible. The card header should show the MCP server icon. -->

#### Other

| Tool                    | What it does                                                          |
| ----------------------- | --------------------------------------------------------------------- |
| `create_new_workspace`  | Create a new workspace/project directory with optional subdirectories |
| `ask_followup_question` | Ask you a clarifying question when it needs more information          |

### Feature-gated tools

Some tools depend on external services or configuration to work:

| Tool                  | Requirement                                              |
| --------------------- | -------------------------------------------------------- |
| `rag_search`          | Codebase index must be configured and built              |
| `git_search`          | Git-index settings must be configured                    |
| `access_mcp_resource` | At least one MCP server must expose resources            |
| `run_slash_command`   | Workspace must have `.shofer/slash-commands/` configured |

If a feature-gated tool doesn't work, check that the corresponding service is enabled in Settings.

### Always-available tools

A small set of tools work in every mode regardless of category restrictions:

`attempt_completion`, `update_todo_list`, `skills`, `set_task_title`, `give_feedback`, `ask_followup_question`

These are the tools Shofer uses to end tasks, track progress, and communicate with you — they're always available because they're essential for every workflow.

### Seeing available tools

<!-- XXX Screenshot: ChatTextArea with the mode selector dropdown expanded, showing the current mode ("💻 Code") and below it a collapsible "Available tools in this mode" section listing tool names grouped by category. -->

The set of tools Shofer can use depends on your current mode. To see exactly which tools are available:

1. Open the mode selector dropdown in the chat input bar
2. Look for the available-tools summary below each mode name
3. Switch modes to see how the tool list changes

---

## 8. Model Tool Preferences

Shofer automatically selects the best editing tools for the AI model you're using. Different models have different strengths — some work better with patch-style edits, others with string replacement. Shofer handles this transparently so you get reliable file edits without thinking about it.

### Why This Matters

Every time Shofer modifies a file — adding a function, fixing a bug, or refactoring code — it uses one of several editing tools:

| Tool            | How it works                                   |
| --------------- | ---------------------------------------------- |
| `apply_diff`    | Search/replace blocks (precise, line-targeted) |
| `write_to_file` | Overwrites the entire file                     |
| `edit`          | Old-string / new-string replacement            |
| `apply_patch`   | Unified diff format (`@@` hunks)               |

If a model is given a tool it handles poorly, edits become unreliable — the model might produce broken diffs, miss replacements, or fail to apply changes.

Shofer's **model tool preferences** system prevents this by automatically tailoring the available tool set for each model.

### Which Models Prefer Which Tools

**OpenAI (via OpenRouter):** OpenAI models receive `apply_patch` instead of `apply_diff` and `write_to_file`. OpenAI models have historically performed better with unified diff format.
XXX: Screenshot of a chat with an OpenAI model showing an apply_patch tool call in the chat history — the tool-use block would show "@@ hunk headers" and line-numbered diff context.

**Gemini (Native & Vertex):** Gemini models receive the `edit` tool instead of `apply_diff`. Gemini performs more reliably with old-string/new-string replacement than with search/replace block format.
XXX: Screenshot of a chat with a Gemini model showing an edit tool call — the chat row would display old_string and new_string parameters.

**Anthropic, DeepSeek, Ollama, VS Code LM:** These providers currently use the **default tool set** with no special customization. All standard editing tools are available.

**Shofer Cloud (API-Configured):** If your organization uses the Shofer Cloud API, administrators can configure per-model tool preferences remotely. These settings are fetched automatically and override any built-in defaults.

### How It Works (Behind the Scenes)

When you start a task, Shofer:

1. Identifies the model you selected in the API Config Selector.
   XXX: screenshot of the API Config Selector dropdown in the chat input bar, with a model name highlighted.

2. Determines which editing tools the model should use based on built-in provider rules and any Shofer Cloud overrides.

3. Removes tools the model handles poorly (`excludedTools`) and adds tools it handles well (`includedTools`), but only if those tools belong to a mode group your current mode allows.

4. Renames tools to aliases if the model expects them under a different name (for example, some models know `write_file` but not `write_to_file`).

You don't need to do anything — this happens automatically every time you switch models or start a new conversation.

### Can I Customize This?

Tool preferences are **not directly configurable** through the Shofer UI or `settings.json`. They are:

- **Built into the extension** for native providers (Gemini, Vertex, OpenAI via routers).
- **Configurable via the Shofer Cloud API** if you have administrative access to your organization's cloud settings.

If you're using a self-hosted or local model and find that a specific tool doesn't work well with it, contact your Shofer administrator or file an issue describing the model and the tool behavior.

---

## 9. Extension Tools

Shofer can use tools from companion VS Code extensions. This makes Shofer extensible — extensions can add tools for controlling the editor UI, the browser, or any other system, and Shofer discovers them automatically.

### How Tool Extensions Work

A **tool extension** is a regular VS Code extension that registers itself as a "private tool provider." Instead of using Copilot's tool API (`vscode.lm.tools`), it uses a dedicated Shofer-only channel so that Copilot never sees or calls these tools.

When Shofer starts, it:

1. Reads the `shofer.privateToolProviders` configuration to find installed tool extensions.
2. Calls each extension's **get-definitions command** to learn what tools it provides (their names, descriptions, and input schemas).
3. Assigns each tool to a **tool group** for access control.
4. At runtime, calls the extension's **invoke command** whenever Shofer's model decides to use one of those tools.

### Installing a Tool Extension

Install a tool extension the same way you install any VS Code extension. Two companion extensions are available:

| Extension                 | Tools Provided                                                                                   | Marketplace             |
| ------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------- |
| **Arkware VSCode Tools**  | Editor controls: open/close files, focus panels, navigate the explorer, execute VS Code commands | `arkware-vscode-tools`  |
| **Arkware Browser Tools** | Browser automation: navigate pages, click elements, fill forms, take screenshots                 | `arkware-browser-tools` |

After installing, Shofer needs a one-time configuration entry so it knows where to find the extension's tools. Add this to your `settings.json`:

```json
{
	"shofer.privateToolProviders": {
		"vscode-tools": {
			"getDefinitionsCommand": "arkware.vscodeTools.getDefinitions",
			"invokeToolCommand": "arkware.vscodeTools.invokeTool"
		},
		"browser-tools": {
			"getDefinitionsCommand": "arkware.browserTools.getDefinitions",
			"invokeToolCommand": "arkware.browserTools.invokeTool"
		}
	}
}
```

<!-- XXX screenshot: VS Code settings editor showing the shofer.privateToolProviders object with vscode-tools and browser-tools entries expanded, highlighting the getDefinitionsCommand and invokeToolCommand fields -->

Restart Shofer (or reload the VS Code window: `Ctrl+Shift+P` → "Reload Window"). The extension's tools appear in Shofer's tool set immediately.

### Configuring Tool Groups

Every tool in Shofer belongs to a **tool group** — a category like "read", "write", "browser", or "execute". Tool groups control:

- **Which modes can use the tool** (e.g., Code mode allows "write" tools; Reviewer mode does not).
- **Whether the tool is auto-approved** (you can toggle auto-approval per group in the `AutoApproveDropdown`).

Shofer assigns groups to extension tools through a three-step fallback:

1. If the tool definition itself declares a `group`, that wins.
2. Otherwise, Shofer checks a per-tool mapping you can set in `settings.json`.
3. If neither exists, the tool goes into the default `"uncategorized"` group.

#### Setting per-tool groups

To override the group for a specific tool, add a `toolGroups` mapping under the provider's config namespace:

```json
{
	"shofer.vscode-tools.toolGroups": {
		"ide_file_read": "read",
		"ide_file_open": "execute",
		"ide_file_reveal_in_explorer": "execute",
		"ide_file_list": "read",
		"ide_execute_vscode_command": "execute"
	}
}
```

<!-- XXX screenshot: AutoApproveDropdown expanded in the chat input bar, showing the toggles per tool group (read, write, execute, browser, mcp, mode, subtasks, questions, uncategorized). The 'browser' group toggle should be highlighted to show where extension browser tools are gated. -->

#### Available groups

| Group           | What it controls       | Example extension tool                        |
| --------------- | ---------------------- | --------------------------------------------- |
| `read`          | Read-only access       | `ide_file_read`, `ide_file_list`              |
| `write`         | Content mutations      | (extension tools rarely write files directly) |
| `execute`       | System/editor commands | `ide_file_open`, `ide_execute_vscode_command` |
| `browser`       | Web automation         | `browser_navigate`, `browser_click`           |
| `mcp`           | MCP protocol tools     | (not used by extension tools)                 |
| `mode`          | Mode switching         | (not used by extension tools)                 |
| `subtasks`      | Task management        | (not used by extension tools)                 |
| `questions`     | User-facing questions  | (not used by extension tools)                 |
| `uncategorized` | Fallback default       | Any tool without an explicit group            |

### How Extension Tools Appear in Chat

When Shofer's model uses an extension tool, it looks the same as any other tool call in the chat: a collapsible block showing the tool name, its arguments, and the result. The only difference is the tool name prefix — extension tools use `ide_*` (editor) or `browser_*` (browser) naming.

<!-- XXX screenshot: ChatView showing a tool call row for "ide_file_read" with arguments { "path": "src/main.ts" } and a result containing the file contents -->

### Differences From Built-in Tools and MCP Tools

|                      | Built-in Tools                               | Extension Tools                     | MCP Tools                   |
| -------------------- | -------------------------------------------- | ----------------------------------- | --------------------------- |
| **Where defined**    | Inside Shofer's source code                  | In a separate VS Code extension     | On an external MCP server   |
| **Examples**         | `read_file`, `apply_diff`, `execute_command` | `ide_file_open`, `browser_navigate` | `server__tool_name`         |
| **Installation**     | Always available                             | Install extension + add config      | Add server to MCP settings  |
| **Config key**       | (none — built in)                            | `shofer.privateToolProviders`       | MCP server config           |
| **Group assignment** | Hardcoded in `TOOL_GROUPS`                   | Configurable via `toolGroups`       | Configurable via MCP config |

### Troubleshooting

**Tools don't appear after installing an extension:**

1. Check that the extension is **activated** — open the VS Code Output panel and select the extension's output channel (e.g., "Arkware VSCode Tools").
2. Verify your `settings.json` has the correct `shofer.privateToolProviders` entry with the right command IDs.
3. Reload the VS Code window (`Ctrl+Shift+P` → "Reload Window").

**Tools appear but are grayed out / unavailable:** The current mode may not allow the tool's assigned group. Check the mode's allowed groups in **Settings → Modes** and ensure the tool's group is listed there.

**A tool keeps asking for approval when I expect it to be auto-approved:** Check the `AutoApproveDropdown` in the chat input bar. Make sure the toggle for the tool's group is enabled.

**"Provider Error" when the model tries to use an extension tool:** The extension's invoke command may have failed. Open the Shofer output channel (`Ctrl+Shift+P` → "Shofer: Show Output Channel") and look for errors. Also check the extension's own output channel for stack traces.

---

## 10. MCP Servers

Give Shofer access to external tools by connecting MCP (Model Context Protocol) servers. MCP servers can provide anything from web search and database queries to file-system access and browser automation — all callable by the LLM as if they were built-in tools.

### How It Works

1. You add an MCP server configuration (a JSON entry specifying the server's transport type and connection details).
2. Shofer connects to the server and discovers its available tools and resources.
3. The discovered tools appear in the LLM's tool list alongside Shofer's built-in tools, using the naming convention `mcp--<server>--<tool>`.
4. When the LLM calls one of these tools, Shofer routes the call to the MCP server, streams the result back, and displays it in chat.

### Adding an MCP Server

MCP servers are configured in JSON files. There are two scopes:

| Scope   | Location                       | Applies To             |
| ------- | ------------------------------ | ---------------------- |
| Project | `.shofer/mcp.json`             | Current workspace only |
| Global  | VS Code settings → MCP Servers | All workspaces         |

Project config takes priority when the same server name appears in both.

<img src="images/mcp-settings.png" alt="MCP Servers Configuration in Settings" width="280" />

### Server Configuration

Each server entry supports the following fields:

| Field           | Required For              | Description                                            |
| --------------- | ------------------------- | ------------------------------------------------------ |
| `type`          | automatic (inferred)      | `"stdio"`, `"sse"`, or `"streamable-http"`             |
| `command`       | `stdio`                   | The executable to spawn (e.g., `"node"`, `"python"`)   |
| `args`          | `stdio`                   | Arguments passed to the command                        |
| `cwd`           | `stdio`                   | Working directory (defaults to workspace)              |
| `env`           | `stdio`                   | Extra environment variables                            |
| `url`           | `sse` / `streamable-http` | Server endpoint URL                                    |
| `headers`       | `sse` / `streamable-http` | Custom HTTP headers                                    |
| `disabled`      | optional                  | Set to `true` to skip this server at startup           |
| `timeout`       | optional                  | Per-tool-call timeout in seconds (1–3600, default: 60) |
| `disabledTools` | optional                  | Tool names to hide from the LLM                        |
| `toolGroups`    | optional                  | Per-tool group override for auto-approval              |

#### Example: Local Node.js Server (stdio)

```json
{
	"my-tools": {
		"type": "stdio",
		"command": "node",
		"args": ["./mcp-servers/my-tools/dist/server.js"],
		"timeout": 60
	}
}
```

#### Example: Remote HTTP Server (streamable-http)

```json
{
	"arkware-tools": {
		"type": "streamable-http",
		"url": "http://localhost:30089",
		"disabled": false
	}
}
```

#### Using Environment Variables in Paths

You can inject environment variables and the workspace folder path into config values using `${env:KEY}` and `${workspaceFolder}`:

```json
{
	"my-server": {
		"type": "stdio",
		"command": "${env:HOME}/.local/bin/mcp-server",
		"args": ["--data-dir", "${workspaceFolder}/.mcp-data"]
	}
}
```

### Controlling Which Tools the LLM Sees

#### Disabling Individual Tools

If a server exposes tools you don't want the LLM to use, list them in `disabledTools`. The server stays connected but those tools won't appear in the LLM's tool list:

```json
{
	"my-server": {
		"command": "node",
		"args": ["server.js"],
		"disabledTools": ["dangerous_tool", "slow_tool"]
	}
}
```

#### Disabling an Entire Server

Set `"disabled": true` to prevent Shofer from connecting to a server at all. Useful for temporarily removing a server without deleting its configuration.

### Auto-Approval of MCP Tools

By default, every MCP tool call requires your approval. You can configure auto-approval to skip the prompt for trusted servers:

1. **Master gate:** Enable the **Always Allow MCP** toggle in the auto-approval settings.
2. **Per-tool control:** Assign tool groups to individual tools via the `toolGroups` field so only specific tools auto-approve.

<!-- XXX: Screenshot showing the AutoApproveDropdown with the MCP toggle enabled and per-group toggles visible. -->

Example with per-tool group assignment:

```json
{
	"readonly-server": {
		"command": "node",
		"args": ["server.js"],
		"toolGroups": {
			"search_tool": "read",
			"fetch_tool": "read"
		}
	}
}
```

With `alwaysAllowMcp` enabled and these tools assigned to the `"read"` group, Shofer auto-approves `search_tool` and `fetch_tool` without prompting. Any tool left unassigned defaults to `"uncategorized"` and still requires approval.

### Server Status & Troubleshooting

Connection status is visible in the Settings view. Each server shows:

- **Connected** (green): Server is running and tools are available.
- **Disconnected** (red): Server connection failed or was lost. Hover for error details.

<!-- XXX: Screenshot showing the MCP Servers section of Settings with one server showing green/connected and another showing red/disconnected with an error tooltip visible. -->

#### Common Issues

| Symptom                         | Likely Cause                                     |
| ------------------------------- | ------------------------------------------------ |
| Server stays "disconnected"     | Command not found, wrong `cwd`, or process crash |
| "Tool not found" error in chat  | Tool name mismatch or tool disabled in config    |
| Timeout errors                  | `timeout` too low for long-running operations    |
| Server appears but has no tools | Server started but didn't register any tools     |

Config files are watched automatically — saving `mcp.json` triggers a reconnect without restarting Shofer.

### Using MCP Resources

Some MCP servers expose **resources** (files, data blobs, API responses) in addition to tools. Shofer can access these via the `access_mcp_resource` tool. The LLM provides the server name and resource URI, and Shofer fetches the content.

### MCP in the Chat

When the LLM calls an MCP tool, you'll see:

- The tool name displayed as `mcp--<server>--<tool>` in the chat row.
- Real-time execution status: **started → output → completed** (or **error**).
- The tool result rendered as text, with images displayed inline.

<!-- XXX: Screenshot showing a chat conversation where the LLM calls mcp--arkware--web_search, the result is streaming back with a progress indicator, and the final result is displayed with a citation. -->

---

## 11. Assistant Agent

The Assistant Agent is a **persistent, read-only AI companion** that lives inside your Shofer workspace. It accumulates knowledge about your codebase over time, answering questions from your main coding agents without them having to re-read files they've already seen. Think of it as a long-term memory for your AI assistants — it runs on a separate, cost-optimized model with a very large context window, keeping token costs low while staying informed.

### What It Does

- **Answers codebase questions** — Shofer tasks call `ask_assistant_agent` to ask about your project: "What does UserService do?", "Where is auth logic?", "List the public API of PaymentHandler."
- **Accumulates knowledge** — each question and answer is remembered. The agent's context window fills organically as tasks ask questions, so it gets smarter over time.
- **Stays aware of changes** — when Shofer tools modify files, or when you edit files externally, the agent is notified. It won't blindly trust stale content.
- **Persists across restarts** — the agent's conversation history survives VS Code restarts. When you re-open your workspace, it picks up right where it left off.

### How It Differs from `rag_search`

|                       | `rag_search`                                     | Assistant Agent                                             |
| --------------------- | ------------------------------------------------ | ----------------------------------------------------------- |
| **How it works**      | Vector search over indexed code                  | Conversational Q&A with persistent memory                   |
| **Best for**          | Finding code by meaning across the whole project | Follow-up questions, multi-turn exploration                 |
| **Remembers context** | No — each search is independent                  | Yes — conversation history accumulates                      |
| **Tool access**       | N/A (returns snippets)                           | Has full read-only tool access (can read files, grep, etc.) |
| **Cost model**        | Per-embedding                                    | Per-token chat; cumulative cost tracked                     |

Both tools are complementary — `rag_search` is great for initial discovery, the Assistant Agent is great for deeper investigation.

### Quick Start

#### 1. Link an API Configuration Profile

The Assistant Agent needs an LLM to run. It uses **any API Configuration profile** you've already set up in Shofer — just pick one:

1. Open **Settings** (gear icon in the toolbar, or `Ctrl+,`).
2. Under **Providers**, create or select an API Configuration profile (e.g., "openrouter" with Claude Haiku, or "gemini" with Gemini Flash).
3. Under **Assistant Agent**, select that profile from the **Linked Profile** dropdown.

> **💡 Model choice:** The Assistant Agent is designed for cheap, large-context models. Ideal choices: Gemini 2.0 Flash (1M token window), GPT-4o-mini (128K), Claude Haiku. A 128K+ context window is recommended for best results.

<!-- XXX: Screenshot — SettingsView scrolled to the "Assistant Agent" section, showing the "Enabled" toggle ON, the "Linked Profile" dropdown with a provider selected, and the optional "Max Context Tokens" override field. The "Context Fill Threshold" slider should be visible at 80%. -->

#### 2. Enable the Agent

Toggle **Assistant Agent → Enabled** to ON. The agent will start initializing immediately. You'll see the status badge in the chat input toolbar change.

<!-- XXX: Screenshot — The Shofer chat-input toolbar (ChatTextArea) showing the AssistantAgentStatusBadge with a "Ready" state indicator and a percentage (e.g., "Ready (0%)" on first start). -->

#### 3. That's It

Your coding agents will now automatically use `ask_assistant_agent` when they need codebase knowledge. You don't need to do anything else — the agent works behind the scenes.

### Toolbar Badge & Popover

The Assistant Agent's status badge lives in the **chat input toolbar** (the row of controls at the bottom of the chat). It shows:

| State                 | What It Means                                                                              |
| --------------------- | ------------------------------------------------------------------------------------------ |
| **Standby**           | Agent is configured but not started. Click to start it.                                    |
| **Initializing...**   | Agent is starting up — loading config, restoring conversation.                             |
| **Ready (42%)**       | Agent is idle, waiting for questions. The percentage shows how full its context window is. |
| **Busy (42%)**        | Processing a question. The badge pulses to show activity.                                  |
| **Nearly Full (87%)** | Context window is above the fill threshold — truncation may happen soon.                   |
| **Error**             | Configuration or connection issue. Click the badge for details.                            |

<!-- XXX: Screenshot — A close-up of the AssistantAgentStatusBadge in the toolbar, annotated with callouts for the state text, percentage fill, and pulsing animation. Show two states side by side: Ready (0%) and Busy (35%). -->

#### Popover

Click the badge to open a popover with detailed information:

- **Current state** and model name
- **Context usage bar** — visual progress bar showing `current / max` tokens
- **Context window source** — shows whether the token limit came from the model's reported context window, an override, or is unresolved
- **Cost tracking** — total input/output/truncated tokens and estimated USD cost
- **Files in context** — list of files the agent currently knows about
- **Quick Actions:**
    - **Start / Stop** — control agent lifecycle
    - **View Chat** — open the dedicated chat panel
    - **Clear Context** — reset the conversation (preserves cost tracking)
    - **Open Settings** — jump to the Assistant Agent settings section

<!-- XXX: Screenshot — The AssistantAgentPopover opened from the badge, showing the context usage bar at ~35%, the cost tracking row, the file list, and the Quick Actions buttons at the bottom. -->

### Chat View Panel

The **View Chat** action opens a dedicated read-only panel showing everything the Assistant Agent has seen and done:

- **Full conversation history** — every question/answer pair, newest at the bottom
- **Live streaming** — when the agent is Busy, you can watch answers stream in token-by-token, including reasoning (collapsible) and tool calls (expandable)
- **Message metadata** — which task asked the question, timestamps, file references
- **Context sidebar** — files in context with token estimates, token usage bar

The panel is **read-only** — you can't send messages directly. All interaction happens through the `ask_assistant_agent` tool used by your coding agents. This keeps the context window clean and predictable.

<!-- XXX: Screenshot — The AssistantAgentChatPanel showing a conversation with 2-3 Q&A pairs. The latest assistant response should be streaming (partial text visible), with a reasoning block collapsed above it and a tool_call block expanded below showing file contents. The context sidebar on the right should show 3 files with token estimates. -->

### The `ask_assistant_agent` Tool

Your coding agents use this tool automatically. You don't need to invoke it yourself, but understanding its parameters helps you know what to expect:

| Parameter          | Required | Default        | Description                                                      |
| ------------------ | -------- | -------------- | ---------------------------------------------------------------- |
| `question`         | Yes      | —              | The question to ask about the codebase.                          |
| `contextFiles`     | No       | —              | File paths to load into context before answering.                |
| `timeoutMs`        | No       | 300000 (5 min) | Hard time limit for an answer. If exceeded, the call is aborted. |
| `softTimeoutSec`   | No       | 60             | Hint for how long the agent should spend (not enforced).         |
| `softResultLength` | No       | 2000           | Hint for max answer length in characters (not enforced).         |

The tool is **auto-approved** — it never requires your manual approval, since it uses a separate, cost-optimized model and is strictly read-only.

### Context Window & Truncation

The Assistant Agent has a **context window** — the maximum number of tokens it can "remember" at once. By default, this is set to the model's reported context window (e.g., 128K for GPT-4o-mini, 1M for Gemini Flash).

#### How the Window Fills

1. Each question and answer takes up tokens in the window.
2. Files loaded into context (via `contextFiles` or the agent's own `read_file` calls) also consume tokens.
3. The **directory tree** of your workspace is always present (~10% of the window).

#### Fill Threshold Warning

When the window reaches **80% full** (configurable), the badge shows "Nearly Full" and questions carry a warning. This is your cue that old conversations will soon be dropped.

#### Truncation Policy

When the window is full, the agent **truncates** — it simply drops the oldest content. There is no summarization or compression:

1. Least-recently-referenced **file contexts** are dropped first.
2. If still over budget, the oldest **conversation turns** are dropped next.
3. A marker message is inserted: _"[N earlier messages were truncated due to context limit]"_

Truncated content is permanently lost from the agent's memory. The **system prompt** (including the workspace directory tree) is never truncated.

#### Clear Context

If you want to reset the agent's memory entirely, use the **Clear Context** button in the popover or run the `Shofer: Assistant Agent: Clear Context` command. This drops all messages and file contexts but preserves the cost tracking. The agent starts fresh with just the system prompt and directory tree.

### Cost Tracking

The Assistant Agent tracks cumulative token usage and estimated cost across its entire lifecycle, including across VS Code restarts:

- **Total input tokens** — tokens sent to the model (questions, file contents, conversation history)
- **Total output tokens** — tokens generated by the model (answers)
- **Total truncated tokens** — tokens dropped by context window enforcement
- **Estimated cost (USD)** — calculated from the provider's published per-token pricing

Cost information is visible in the **popover** (click the toolbar badge), the **chat view panel** (context sidebar), and the **Settings** page.

> **💡 Note:** The cost estimate depends on the provider publishing pricing data. For local models (Ollama) or custom OpenAI-compatible endpoints, fallback conservative estimates are used.

### Configuration Reference

| Setting                    | Default           | Description                                                                                   |
| -------------------------- | ----------------- | --------------------------------------------------------------------------------------------- |
| **Enabled**                | `true`            | Master on/off toggle.                                                                         |
| **Linked Profile**         | _(none)_          | API Configuration profile providing credentials and model selection.                          |
| **Max Context Tokens**     | _(model default)_ | Optional override for the context window size. Leave unset to use the model's reported limit. |
| **Context Fill Threshold** | `0.80` (80%)      | Fraction at which the "Nearly Full" warning triggers.                                         |

### Commands

All Assistant Agent commands are available via the Command Palette (`Ctrl+Shift+P`):

| Command                                  | Action                                                |
| ---------------------------------------- | ----------------------------------------------------- |
| `Shofer: Assistant Agent: Start`         | Start the agent from Standby state.                   |
| `Shofer: Assistant Agent: Stop`          | Stop the agent and cancel all pending questions.      |
| `Shofer: Assistant Agent: Clear Context` | Reset the conversation to just the system prompt.     |
| `Shofer: Assistant Agent: Show Chat`     | Open the dedicated chat view panel.                   |
| `Shofer: Assistant Agent: Open Settings` | Open Settings focused on the Assistant Agent section. |

### File Awareness & KV-Cache Preservation

The Assistant Agent stays aware of file changes without invalidating its attention cache (which would slow down subsequent requests and increase cost):

- **External edits** — if you edit files in VS Code or via git, a file watcher detects the change and marks the file as stale. The agent will re-read it when needed.
- **Shofer tool edits** — when Shofer tools modify files (via `write_to_file`, `apply_diff`, etc.), the agent is notified. Files are NOT evicted from context — instead, a "recently modified" hint is attached to the next question so the model knows the content may be outdated.

This approach preserves the LLM provider's **KV cache** (attention cache), keeping requests fast and cheap.

### Worktree Awareness

Shofer creates per-task git worktrees under `.shofer/worktrees/` for isolated work. The Assistant Agent:

- **Never loads worktree files** — these are ephemeral and branch-specific
- **Only tracks main-branch files** — its knowledge represents the primary branch
- **One agent per workspace** — all tasks share the same assistant agent

### What It Can't Do

The Assistant Agent is **strictly read-only**. It cannot:

- Modify files
- Run commands
- Create new tasks
- Use MCP tools (browser, Kubernetes, etc.)
- Switch modes
- Send messages to the user

These restrictions are enforced at the tool-filtering layer — the agent's system prompt and internal tool set both prevent write operations.

---

## 12. Semantic Code Search (RAG Indexing)

Shofer can build a **semantic search index** of your codebase, letting the AI agent find code by _meaning_ rather than just by exact keyword matches. This is powered by vector embeddings stored in a Qdrant database and exposed through the `rag_search` tool.

For a lighter, zero-config alternative that works out of the box, Shofer also provides `lsp_search`, which uses VS Code's built-in language server for symbol-based search.

### Quick Start

1. **Set up Qdrant** — you need a running Qdrant instance (local or cloud).
2. **Choose an embedding provider** — OpenAI, Ollama (local), Gemini, Mistral, AWS Bedrock, OpenRouter, or any OpenAI-compatible API.
3. **Enter credentials** — API keys are stored securely in VS Code's `SecretStorage`.
4. **Enable indexing** in the Settings panel under **RAG / Code Index**.

Shofer will start scanning your workspace files, building embeddings, and storing them in Qdrant. The **indexing status badge** in the chat input bar shows progress:

<!-- XXX: Screenshot — ChatTextArea (the chat input bar at the bottom) with the IndexingStatusBadge visible in the toolbar row, showing "Indexing" state with a spinner animation. The badge should be clearly callout-able. -->

Once complete, the agent can use `rag_search` to query your codebase semantically.

### Indexing Status Badge

The badge in the chat input bar shows one of five states:

| State        | Meaning                                                            |
| ------------ | ------------------------------------------------------------------ |
| **Standby**  | Indexing is enabled but not running (not yet started, or stopped). |
| **Indexing** | Currently scanning and embedding files. A spinner is shown.        |
| **Indexed**  | Indexing is complete and the index is up to date.                  |
| **Error**    | Something went wrong (e.g., Qdrant unreachable, bad API key).      |
| **Stopping** | Indexing is being cancelled.                                       |

<!-- XXX: Screenshot — Close-up of the IndexingStatusBadge in "Indexed" state (checkmark icon), with the CodeIndexPopover open next to it showing the file count ("12,430 files indexed"), the current state label, and the Start/Stop/Clear buttons. -->

Click the badge to open the **Code Index Popover**, which shows the number of indexed files and provides buttons to start, stop, or clear the index.

### Choosing an Embedding Provider

Shofer supports 8 embedding providers. Each has different cost, latency, and privacy characteristics:

| Provider              | Requires                 | Best for                             |
| --------------------- | ------------------------ | ------------------------------------ |
| **OpenAI**            | API key                  | Quick setup, high quality embeddings |
| **Ollama**            | Local Ollama server      | Privacy, no API costs, air-gapped    |
| **OpenAI-Compatible** | Base URL + API key       | Self-hosted embedding servers        |
| **Gemini**            | API key                  | Google Cloud users                   |
| **Mistral**           | API key                  | European-hosted option               |
| **Vercel AI Gateway** | API key                  | Vercel ecosystem users               |
| **AWS Bedrock**       | Region + AWS credentials | AWS-native, no internet egress       |
| **OpenRouter**        | API key                  | Multi-provider routing               |

Configure these in **Settings → RAG / Code Index → Embedding Provider**.

<!-- XXX: Screenshot — The Settings panel scrolled to the RAG / Code Index section, showing the Embedding Provider dropdown expanded with all 8 options visible, and the sub-fields (API key input, model ID, base URL) shown for the currently selected provider. -->

If you're just trying it out locally, **Ollama** is the fastest path — install Ollama, pull an embedding model (e.g., `nomic-embed-text`), and point Shofer at `http://localhost:11434`.

### Configuration Reference

All settings live under the **RAG / Code Index** section in Settings. They can also be set via `settings.json`:

```jsonc
{
	// Enable/disable the entire RAG indexing feature
	"shofer.codebaseIndexEnabled": true,

	// Qdrant connection
	"shofer.codebaseIndexQdrantUrl": "http://localhost:6333",

	// Embedding provider & model
	"shofer.codebaseIndexEmbedderProvider": "openai",
	"shofer.codebaseIndexEmbedderModelId": "text-embedding-3-small",
	"shofer.codebaseIndexEmbedderModelDimension": 1536,

	// Search defaults
	"shofer.codebaseIndexSearchMinScore": 0.4, // 0–1, lower = more results
	"shofer.codebaseIndexSearchMaxResults": 50, // 10–200

	// Provider-specific overrides (examples)
	"shofer.codebaseIndexOpenAiCompatibleBaseUrl": "https://my-embedder.example.com",
	"shofer.codebaseIndexBedrockRegion": "us-east-1",
}
```

Secrets (API keys) are stored via VS Code's `SecretStorage` and configured through the settings UI — they are **never** written to `settings.json`.

### What Gets Indexed

Shofer indexes files whose extensions are in a curated list of ~30 supported languages. This includes:

- **Languages**: JavaScript, TypeScript, Python, Go, Rust, Java, C/C++, C#, Ruby, PHP, Swift, Kotlin, Scala, Elixir, Lua, Zig, OCaml, Solidity, Vue, Elisp, and more.
- **Documents**: Markdown (`.md`, `.markdown`) — parsed by heading structure.
- **Data/config**: JSON, TOML.

<!-- XXX: Screenshot — The Settings panel showing the "Advanced Configuration" read-only section with the CODEBASE_INDEX_FILE_EXTENSIONS list displayed as a scrollable chip/pill list, plus CODEBASE_INDEX_IGNORED_DIRS shown below it. -->

Directories like `node_modules`, `.git`, `dist`, `build`, `vendor`, `__pycache__` are always skipped. Shofer also respects your `.gitignore` and `.shoferignore` files.

Files larger than **1 MB** are skipped. Individual code blocks are capped at **1,000 characters** (with 15% tolerance). Blocks shorter than **10 characters** are dropped as noise.

### `rag_search` vs `lsp_search` vs `grep_search`

Shofer provides three search tools. Here's when to use each:

| Tool          | How it works                                  | Needs setup? | Best for                                     |
| ------------- | --------------------------------------------- | ------------ | -------------------------------------------- |
| `rag_search`  | Semantic vector search (embeddings in Qdrant) | ✅ Yes       | "How does auth work?", finding by concept    |
| `lsp_search`  | VS Code workspace symbol provider             | ❌ No        | Finding function/class definitions by name   |
| `grep_search` | Regex text search across files                | ❌ No        | Exact string matches, finding all call sites |

**The agent decides which to use automatically.** You don't need to tell it — the system prompt describes all three tools and the agent picks the right one for each query.

### Reboots & Cache

The vector index lives on **Qdrant** (durable storage) and survives reboots. Shofer also maintains a local **file cache** in VS Code's global storage (`~/.config/Code/User/globalStorage/.../shofer-index-cache-<hash>.json`).

On restart:

- **If the cache is intact** → Shofer checks each file's modification time and size against the cache. Unchanged files are skipped (no re-reading, no re-hashing). Only changed or new files are re-indexed. This makes startup nearly instant on large workspaces.
- **If the cache is lost** → Shofer re-indexes everything from scratch. The Qdrant vectors are still there (they survive reboots), but without the cache, Shofer can't tell which files are unchanged and must re-embed all of them.

<!-- XXX: Screenshot — The CodeIndexPopover immediately after a VS Code restart, showing "Indexed" with a file count, and the text "Index is up to date" visible. This demonstrates the fast-path incremental reconciliation working without a full re-scan. -->

### When to Clear & Re-Index

You generally don't need to clear the index. It updates incrementally as files change. However, you may want to clear and re-index if:

- You switch embedding providers (different embedding dimensions).
- Qdrant data becomes inconsistent (rare).
- You want to force a full re-scan for debugging.

Use the **Clear Index** button in the Code Index Popover, then click **Start Indexing** to rebuild.

### Limitations

- **~30 file extensions** are indexed. If your language isn't in the list, files are silently skipped. Check **Settings → Advanced Configuration** for the current list.
- **Swift and Visual Basic .NET** use line-based fallback chunking (no AST parsing) because their tree-sitter parsers are unstable or unavailable.
- **Multi-workspace**: each workspace folder gets its own Qdrant collection. The status badge reflects the active workspace only.
- **Performance**: embedding all files in a large repo requires API calls. With a cloud provider, indexing a 50k-file workspace may take several minutes and incur API costs. With local Ollama, it's free but CPU-bound.

---

## 13. Git Commit History Search

Shofer can build a **semantic search index of your git commit history**, letting the AI agent find relevant commits by _meaning_ rather than by exact keyword matches. This is exposed through the `git_search` tool and complements `rag_search` (which indexes source code) with historical rationale — who changed what, when, and why.

> **Note:** `git_search` indexes commit _messages_ only (subject + body). It does NOT index diffs, file contents, or blame data.

### Quick Start

1. **Prerequisite — Code Index must be configured.** `git_search` reuses the same Qdrant instance and embedding provider as `rag_search`. If you haven't set those up yet, do that first.
2. **Enable git indexing** in **Settings → RAG / Code Index → Git History**.
3. Shofer will scan your repository's commit history (default: last 365 days, up to 10,000 commits), build embeddings of commit messages, and store them in Qdrant.

The **indexing status badge** in the chat input bar reflects combined code and git index status. Hover to see tooltip details:

<!-- XXX: Screenshot — Hover tooltip on the IndexingStatusBadge showing the combined status breakdown: "Code: Indexed / 12,430 files" and "Git: Indexed / 847 commits". The badge should show a green checkmark (both healthy). -->

### Indexing Status Badge

The same badge used for code indexing also reflects git index state. The tooltip breaks down each indexer status separately:

| State        | Meaning                                                                  |
| ------------ | ------------------------------------------------------------------------ |
| **Standby**  | Git indexing is enabled but not running (not yet started, or stopped).   |
| **Indexing** | Currently extracting and embedding commit messages. A spinner is shown.  |
| **Indexed**  | Indexing is complete and up to date. Watcher is polling for new commits. |
| **Error**    | Something went wrong (e.g., not a git repo, Qdrant unreachable).         |

Click the badge to open the **Code Index Popover**, which shows a **Git History** section with the number of indexed commits and **Start / Stop / Clear** buttons.

<!-- XXX: Screenshot — CodeIndexPopover open, scrolled down to show the "Git History" section with a green dot (Indexed state), "Indexed all commits" label, commit count ("847 commits indexed"), and the Start/Stop/Clear buttons below. -->

### How the Agent Uses `git_search`

The AI agent can call `git_search` to answer questions like:

- _"Who added the authentication middleware?"_
- _"When was the rate limiter last changed?"_
- _"Find commits related to the database migration."_
- _"What was the rationale for removing the caching layer?"_

The tool returns matching commits sorted by relevance (cosine similarity score), each including: commit hash, short hash, author, date, subject, and body.

The agent decides when to use `git_search` vs. `rag_search` vs. `grep_search` automatically — you don't need to tell it.

<!-- XXX: Screenshot — A ChatView showing a `git_search` result block: the agent's query ("Find commits related to authentication"), followed by a results card showing 3–5 commit entries, each with short hash, author name, date, subject line, and a relevance score. The "Showing N of M commits" header should be visible. -->

### Configuration Reference

All git search settings live under **Settings → RAG / Code Index → Git History**. They can also be set via `settings.json`:

```jsonc
{
	// Enable/disable git commit history indexing
	"shofer.codebaseIndexGitEnabled": true,

	// Max days of commit history to index (1–365, default: 365)
	"shofer.codebaseIndexGitMaxHistoryDays": 365,

	// Hard cap on number of commits indexed (100–10000, default: 10000)
	"shofer.codebaseIndexGitMaxCommits": 10000,

	// Branch (git ref) to index; empty = HEAD (default)
	"shofer.codebaseIndexGitBranch": "",

	// Poll interval for new commit detection (1–60 min, default: 5)
	"shofer.codebaseIndexGitPollIntervalMinutes": 5,

	// Minimum similarity score for search results (0–1, default: 0.4)
	"shofer.codebaseIndexGitSearchMinScore": 0.4,

	// Default max results per query (1–50, default: 20)
	"shofer.codebaseIndexGitSearchMaxResults": 20,
}
```

<!-- XXX: Screenshot — The Settings panel scrolled to the RAG / Code Index → Git History section, showing the Enable toggle, all sliders (Max history, Max commits, Poll interval, Min similarity, Max results), and the Start/Stop/Clear action buttons. -->

### What Gets Indexed

- **All commits** on the configured branch within the time window, up to the max commits cap.
- Each commit's **subject line + body** is embedded as a single unit.
- Commits from **git submodules** are included if your workspace contains them.
- Messages longer than **4,000 characters** are truncated before embedding.
- Non-UTF-8 commit messages are handled (forced to UTF-8 with replacement characters).

### Incremental Updates

Once the initial index is built, Shofer starts a **watcher** that polls for new commits every N minutes (configurable, default 5). When you make new commits, they're automatically picked up and indexed. The poll interval can be adjusted in Settings.

### Reboots & Cache

Shofer caches per-commit content hashes in VS Code's `globalStorage`. On restart or re-index, unchanged commits are skipped — only new commits are embedded. This makes re-indexing fast even for large repositories.

If Qdrant or the embedding provider is unreachable, the cache is preserved and indexing resumes when connectivity is restored.

### `git_search` vs Other Search Tools

| Tool          | Searches                   | Needs setup?    | Best for                                     |
| ------------- | -------------------------- | --------------- | -------------------------------------------- |
| `git_search`  | Git commit messages        | ✅ Yes (shared) | "Who added this?", "When did this change?"   |
| `rag_search`  | Source code (semantic)     | ✅ Yes          | "How does auth work?", finding by concept    |
| `lsp_search`  | Symbols (functions, types) | ❌ No           | Finding function/class definitions by name   |
| `grep_search` | File contents (text)       | ❌ No           | Exact string matches, finding all call sites |

### Privacy

Commit messages are embedded by your configured embedding provider (same one used for code indexing). If you use a local provider like **Ollama**, your commit messages never leave your machine. If you use a cloud provider (OpenAI, etc.), commit message text is sent for embedding generation — consider this when indexing repositories with sensitive commit messages.

---

## 14. Context Management & Condensation

When a conversation with Shofer goes on for many turns, the accumulated messages eventually approach the model's **context window** limit — the maximum number of tokens the model can process in a single API call.

Shofer handles this automatically so you don't have to worry about running out of context space mid-task.

### What You See

#### The Context Window Bar

At the top of every task, the TaskHeader bar shows a horizontal **context window meter** that fills from left (empty) to right (full) as tokens accumulate:

<!-- XXX: Screenshot — TaskHeader in ChatView showing the context window bar at approximately 50–70% full (yellow/orange zone), with the token count readable next to it: "32,400 / 64,000 tokens". -->

| Zone       | Meaning                                                                                       |
| ---------- | --------------------------------------------------------------------------------------------- |
| Green      | Plenty of room. No action needed.                                                             |
| Yellow     | Approaching the limit. Condensation will trigger soon.                                        |
| Red / full | Near or at the context window maximum. Condensation or truncation is imminent or in progress. |

Hovering over the bar shows the exact token numbers.

#### The "Condensing Context" Indicator

When Shofer decides to condense, you may briefly see a **spinner** or progress indicator in the chat before the next model response. This means Shofer is summarizing older messages to free up space.

<!-- XXX: Screenshot — ChatView showing the "condensing context" spinner row in the chat, with the TaskHeader context window bar near 90% full. -->

The condensation completes automatically; after a few seconds, the conversation continues normally.

#### After Condensation

The older messages **are not deleted** — they're still visible in the chat history. However, the model will only "see" the condensed summary going forward. This is called the **fresh start** model: the model starts each condensed turn with a clean slate, carrying forward only the summary.

You can scroll up and read the full history at any time.

### What Happens Behind the Scenes

#### Automatic Condensation

By default, Shofer triggers condensation when the conversation reaches **90%** of the model's context window. You can adjust this threshold in settings:

```
// settings.json
{
  "shofer.autoCondenseContextPercent": 85   // Trigger at 85% instead of 90%
}
```

The allowed range is **5–100%**. Setting it to 100 disables automatic condensation (but a hard safety net still fires at ~90% — see below).

Even if you set the threshold to 100%, Shofer has a built-in safety net: condensation or truncation **always** triggers when tokens exceed roughly 90% of the context window (minus the model's output reservation). This prevents the conversation from ever exceeding the context window and failing with an error.

#### Per-Profile Thresholds

If you use multiple API configurations (e.g., one profile for Claude and another for GPT-4), you can set **different thresholds per profile** in the API Configuration settings:

<!-- XXX: Screenshot — SettingsView API Configuration section showing a profile row with an expanded "Advanced" subsection revealing the "Condense Threshold" field set to 75 for a profile called "claude-opus". -->

A value of `-1` means "use the global default."

#### Manual Condensation

You can trigger condensation at any time via the **condense** slash command or the corresponding button in the chat toolbar. This is useful when you want to free up context proactively before a long operation.

Manual condensation does **not** include environment details in the summary (since fresh ones are injected on the next turn).

#### When Condensation Fails

If the condensation API call fails (network error, rate limit, empty response), Shofer falls back to **sliding window truncation**: it hides the oldest messages from the model's view without summarizing them. You lose some conversation context, but the task continues without error.

### How Condensation Preserves Your Work

Shofer tries to be smart about what gets summarized:

| Preserved Element        | What It Keeps                                                                      |
| ------------------------ | ---------------------------------------------------------------------------------- |
| **Conversation Summary** | An LLM-generated summary of the condensed messages                                 |
| **Active Workflows**     | Any `<command>` blocks (e.g., from the orchestrator mode) are carried forward      |
| **File Structure**       | Signatures of files you've read (function names, class declarations) are preserved |
| **Environment Details**  | For automatic condensation, the current workspace state is included                |

This means that even after multiple rounds of condensation, the model retains awareness of what you were doing and what files look like.

### Troubleshooting

| Symptom                                          | Likely Cause & Fix                                                                                                       |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| Condensation never triggers, then task errors    | Auto-condense is disabled (`autoCondenseContext = false`) or threshold set too high. Check settings.                     |
| "Failed to condense context" message appears     | The condensation API call failed. Shofer will fall back to truncation. If it keeps happening, check your API connection. |
| Task forgets earlier conversation details        | This is expected after condensation. The model works from a summary, not the full history.                               |
| Condensation happens too frequently              | Lower the `autoCondenseContextPercent` (e.g., from 90 to 80) so there's less room per condensation.                      |
| Condensation happens too late / too aggressively | Raise the `autoCondenseContextPercent` (e.g., from 90 to 95).                                                            |

### Related Settings

| Setting                      | Default | Description                                                      |
| ---------------------------- | ------- | ---------------------------------------------------------------- |
| `autoCondenseContext`        | `true`  | Enable automatic context condensation.                           |
| `autoCondenseContextPercent` | `90`    | Percentage of context window that triggers condensation (5–100). |
| Per-profile threshold        | `-1`    | Override the global threshold for a specific API profile.        |

---

## 15. Context Window Sizes

Every AI model has a maximum **context window** — the total number of tokens it can process in a single conversation turn. Shofer discovers this size automatically for each model and shows it in the ContextWindowProgress bar at the top of every task.

Understanding your model's context window size helps you plan: a 200K window can hold a novel-length conversation with large files attached; a 32K window is better suited for focused, short tasks.

### Where to See Your Model's Context Window Size

#### The Context Window Bar

In the TaskHeader at the top of the chat area, you'll see a horizontal progress bar. The right endpoint of this bar represents your model's **maximum context window**. Hover over the bar to see the exact number of tokens used and the total available:

`32,400 / 200,000 tokens`

<!-- XXX: Screenshot — TaskHeader showing the context window bar, with the mouse hovering over the bar to reveal the tooltip "32,400 / 200,000 tokens". The model name should be visible in the ApiConfigSelector dropdown in the chat input bar. -->

#### In the API Configuration Selector

The ApiConfigSelector dropdown in the chat input bar shows your current model. When you open the dropdown, each model entry displays its context window size:

- **Anthropic Claude Sonnet 4** — 200K
- **OpenAI GPT-4o** — 128K
- **DeepSeek V4 Chat** — 1M

<!-- XXX: Screenshot — ApiConfigSelector dropdown open, showing 3-4 model entries with their context window sizes visible (e.g., "200K", "128K", "1M" next to each model name). -->

### How Shofer Discovers Context Window Sizes

Shofer determines the context window size differently depending on how your model is connected. This happens automatically — you don't need to configure anything.

#### Models via Shofer Router (Direct API)

For models configured through the Shofer Router (Anthropic, OpenAI, DeepSeek, Google, Ollama, etc.), the context window size comes directly from Shofer's model registry. This is the most reliable path: the size is hardcoded per model and always accurate.

#### Models via VS Code LM API

If you use models through VS Code's built-in **Language Model API** (e.g., GitHub Copilot models), Shofer enriches the basic information VS Code provides with additional data from the Shofer Router:

- **Context window size** — the maximum tokens the model can handle
- **Pricing** — cost per 1M input/output tokens (shown in the selector)
- **Capabilities** — whether the model supports image input, tool calling, and prompt caching

This enrichment happens through side-channel commands that llm-provider registers with VS Code. When you open the model selector, Shofer requests this extra data and merges it with VS Code's built-in model list.

<!-- XXX: Screenshot — ApiConfigSelector dropdown open showing a VS Code Copilot model entry, with context window size, pricing, and capability icons visible next to the model name. -->

#### Fallback Values

If Shofer cannot determine a model's context window size (rare — typically only for unknown or newly released models), it uses a sensible default of **128,000 tokens**. This fallback ensures the context window bar still functions, but the bar may not accurately reflect your model's true capacity.

If you suspect your model is showing the wrong context window size, try switching to a different API configuration profile or contacting your Shofer administrator to update the model registry.

### What Context Window Size Means for You

| Window Size | Practical Capacity                                     |
| ----------- | ------------------------------------------------------ |
| 32K         | ~80 pages of text; short, focused tasks                |
| 128K        | ~300 pages; full codebase exploration                  |
| 200K        | ~500 pages; novel-length analysis, multi-file projects |
| 1M          | ~2,500 pages; massive codebases, entire documentation  |

The context window includes **everything** the model sees: your prompt, attached files, tool outputs, conversation history, and the model's own responses. Larger windows let you work with more files and have longer conversations without condensation kicking in.

### Troubleshooting

**My context window bar shows the wrong total:** This can happen if your model was added to the Shofer Router registry with an incorrect `context_length` value, or if you're using a VS Code Copilot model that hasn't been mapped yet.

- **To check**: hover over the context window bar and note the max token count. Compare it with your model's published specification.
- **To fix**: If using Shofer Router, the model registry needs updating (this is a backend configuration change). If using VS Code Copilot models, try restarting VS Code — the side-channel data is refreshed on startup.

**The bar shows 128,000 for all models:** This indicates Shofer is using the fallback default for every model, which means the enrichment data isn't reaching the UI. This was a known bug (fixed in a recent release) where VS Code LM models fell through to the static `128_000` default because the dynamic model list wasn't being populated. If you're still seeing this, ensure you're on the latest version of Shofer.

---

## 16. Per-Task Cost Limit

Shofer lets you set a **USD budget cap** on any task. When the running cost reaches the limit, Shofer pauses, aborts, or kills the task — so you never get a surprise bill from a runaway agentic loop or a forgotten background subtask.

### Where You See It

#### The Cost Row in the Task Header

When a cost limit is active, the TaskHeader at the top of the chat shows `$0.09 / $1.00` next to the API Cost row, with a **pencil icon** for live-editing the cap:

<!-- XXX: Screenshot — TaskHeader in ChatView showing "$0.0924 / $1.00" next to the API Cost row, with the pencil (edit) icon visible to the right. The task is mid-execution with some chat messages visible below. -->

| Element                | Meaning                                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------------------------- |
| `$0.09` (left number)  | Total USD spent so far (root task + all subtasks). Includes an `*` indicator when subtask costs are included. |
| `$1.00` (right number) | The current budget cap. Editable via the pencil icon.                                                         |
| Pencil icon            | Opens the Budget Limit dialog for changing the cap or action mid-task.                                        |

#### The Budget Limit Dialog

Clicking the pencil opens a small popup where you set:

- **Cap amount** (USD, must be > $0)
- **Action on exceed**: `Pause` (ask you what to do), `Abort` (clean stop), or `Kill` (immediate stop)

<!-- XXX: Screenshot — BudgetLimitDialog popup showing a "Max USD" text field with "1.00" filled in and a dropdown for Action with "Pause" selected, plus Save/Cancel buttons. -->

#### When the Limit Is Hit (Pause Mode)

If the action is `Pause`, Shofer stops the current request and shows a prompt in the chat with three choices:

<!-- XXX: Screenshot — ChatView showing a budget-limit ask row: "Cost limit reached: $0.0501 of $0.05" with two buttons "Continue without limit" (primary) and "Abort task" (secondary), plus a text input for typing a new USD amount. -->

| Choice                     | What happens                                                       |
| -------------------------- | ------------------------------------------------------------------ |
| **Continue without limit** | Removes the cap for the rest of this task only. No further checks. |
| **Abort task**             | Stops the current task cleanly (preserves history).                |
| **Type a new amount**      | Replaces the cap with the value you type (e.g. `0.25` or `$0.25`). |

The prompt also shows the exact amount spent (`$0.0501`) and the limit that was hit (`$0.05`).

### Setting a Default (Global) Limit

You can set a default cost limit that applies to **every new root task** automatically. This is configured via `settings.json`:

```json
{
	"shofer.defaultCostLimit": {
		"maxUsd": 1.0,
		"action": "pause"
	}
}
```

- `maxUsd` — the cap in USD (must be > 0)
- `action` — `"pause"`, `"abort"`, or `"kill"`

> **Note:** This setting currently has no UI in the Settings panel. You must set it via JSON editing. A Settings panel row is planned.

### Per-Task vs. Global

| Scope    | Set via                                              | Persists across sessions?    |
| -------- | ---------------------------------------------------- | ---------------------------- |
| Global   | `settings.json` → `shofer.defaultCostLimit`          | Yes — all new root tasks     |
| Per-task | Pencil icon in TaskHeader, or the Pause prompt reply | Yes — stored in task history |

Each task inherits the global default at creation time, then you can edit it independently. Editing a running task's limit updates the **root task** — subtasks always share their root's cap.

### How Subtask Costs Are Counted

The displayed spend includes **all descendant subtasks** recursively. If you have a root task and it spawns 3 background `new_task` children, the `$0.09 / $1.00` in the header includes all 4 tasks. An `*` indicator confirms subtask costs are folded in.

When a `new_task` tool call would push the root's total over the cap, the child is **refused** with a tool error — the subtask never starts.

### Prerequisites

Cost-limit enforcement depends on the **Shofer LLM Model Provider** extension being installed and active. This extension registers VS Code commands that supply USD pricing data.

If you set a cost limit but see `$0` for every request and the limit never fires, check the **Shofer output channel** for messages like:

```
[vscode-lm] shofer.llm.getRequestCost command not found — is the Shofer LLM Model Provider extension installed and active?
```

The integration is controlled by the `shofer.enableLlmProviderIntegration` setting (also in `settings.json`, default `false`).

### Known Limitations

- **Per-task caps at task creation** are not yet supported. You must set the cap after the task starts (live-edit) or rely on the global default.
- **Resuming an already-over-limit task** does not immediately surface the budget prompt. The check fires on the next API request.
- There is no **80% "soft warning"** before the hard cap fires.
- **Parallel subtasks** racing the check may in rare cases have multiple racers observe the exceed simultaneously, though in practice only the first abort matters.

---

## 17. Parallel Tasks

Shofer can run **multiple tasks at the same time** — one in the foreground that you're watching, and others in the background that keep working independently. This is especially useful when you have a large goal that can be broken into smaller pieces.

### What Are Parallel Tasks?

When Shofer runs a task (Code, Debug, Search, etc.), it's a single conversation running a tool loop. Normally you interact with one task at a time in the chat panel. With parallel tasks, Shofer can **spawn child tasks** that run concurrently — either blocking (the parent waits for the result) or in the background (the parent keeps going).

**Real-world examples:**

- **"Audit all TypeScript files for security issues"** — Shofer spawns one background task per file, then collects the results.
- **"Research this topic and also refactor the auth module"** — two independent background tasks run in parallel.
- **"Write tests for every module in src/"** — one synchronous delegation per module, collecting results sequentially.

<!-- XXX: Screenshot showing the TaskSelector dropdown with three tasks listed — one focused (green dot, pulsing), two background (their status dots), with parent-child indentation visible. Caption: "The TaskSelector showing a parent task and its two background children." -->

### How It Works

Shofer's model uses the **`new_task`** tool to spawn children. There are two modes:

#### Synchronous (Blocking)

The model spawns a child task and **waits** for it to finish. The child's result is fed back into the parent as a tool result, and the parent continues from where it left off. This is useful for sequential work — "do A, then B, then C."

In the UI, the child task takes focus (its messages appear in the chat panel). When the child finishes, the parent is restored automatically.

<!-- XXX: Screenshot showing a child task's chat view (with messages from the child's work) while the parent is waiting. The TaskSelector shows "Parent Task" below with a blue "waiting" indicator. Caption: "A child task running in synchronous mode — the parent is waiting below." -->

#### Background (Async)

The model spawns one or more children that run **concurrently in the background**. The parent receives the child's ID and continues immediately. Multiple background children can run at the same time.

<!-- XXX: Screenshot showing the chat view of a parent task with background children running — the TaskSelector shows the parent (green running dot) with two indented children below (their own status dots). A notification badge appears next to a child that needs input. Caption: "Parent task running while two background children work — one needs input (yellow badge)." -->

### Controlling Background Tasks

When the model spawns background children, it uses five tools to manage them. These are **always available** and do not require your approval for read-only operations:

| Tool                      | What it does                           | Needs approval?                    |
| ------------------------- | -------------------------------------- | ---------------------------------- |
| `check_task_status`       | Check how a background child is doing  | No                                 |
| `wait_for_task`           | Wait until one or more children finish | No                                 |
| `list_background_tasks`   | List all background children           | No                                 |
| `cancel_tasks`            | Stop one or more background children   | Yes (if alwaysAllowSubtasks is on) |
| `answer_subtask_question` | Answer a question a child asked        | Yes (if alwaysAllowSubtasks is on) |

The parent can `wait_for_task` on all children, or just wait for **any** one child to finish first (the `"any"` strategy). A timeout (default 120 seconds) prevents infinite blocking.

<!-- XXX: Screenshot showing a tool-call chat row for `wait_for_task` — displays the tool name, the list of task IDs being waited on, and the strategy ("all"). Caption: "The `wait_for_task` tool call rendered in chat." -->

### When a Background Child Needs Help

If a background child calls `ask_followup_question` (e.g., "Which file should I check next?"), the question is **automatically routed to the parent task** — not to you. The parent sees the question through `check_task_status` and answers via `answer_subtask_question`. The child then resumes as if the parent had answered directly.

This keeps the experience clean: you, the user, only need to interact with the focused task. Background children communicate through their parent.

### Task Lifecycle & Indicators

Every task has a lifecycle state shown as a colored dot in the TaskSelector:

| Color            | State           | Means                                  |
| ---------------- | --------------- | -------------------------------------- |
| Gray             | `idle`          | Not running                            |
| Green (pulsing)  | `running`       | Actively working                       |
| Yellow (pulsing) | `waiting_input` | Needs your approval or input           |
| Blue (pulsing)   | `waiting`       | Blocked on a subtask (`wait_for_task`) |
| Orange           | `paused`        | You paused it                          |
| Green (solid)    | `completed`     | Finished via `attempt_completion`      |
| Red              | `error`         | Failed or stopped                      |

<!-- XXX: Screenshot showing the TaskSelector expanded with a mix of task states visible — one running (green pulse), one waiting_input (yellow pulse), one completed (green solid), one error (red). Show parent-child indentation with nested children under their parent. Caption: "TaskSelector showing various task lifecycle states across a parent task and its children." -->

You can always click any task in the TaskSelector to switch focus to it. Switching to a different task **does not abort** the current task — it continues running in the background.

### Limits

Shofer enforces concurrent task limits to prevent API rate-limit issues:

| Limit                          | Default | What it controls                                   |
| ------------------------------ | ------- | -------------------------------------------------- |
| Max concurrent active tasks    | 3       | Total tasks running at once (focused + background) |
| Max concurrent streaming tasks | 2       | Tasks streaming LLM responses at once              |
| Background task timeout        | 30s     | Internal timeout for background task operations    |

If the limit is reached, new background children are rejected with an error message.

### What Happens When...

**The parent finishes before the children:** All background children are **automatically aborted**. Children cannot outlive their parent task.

**The parent is stopped (you press Stop):** Background children are aborted automatically. The abort propagates down to all children.

**A child encounters an error:** The child transitions to `error` state. The parent discovers this through `check_task_status` or `wait_for_task` (which returns `status: "error"`). The parent can then decide to `cancel_tasks` on the failed child or continue with other children.

**You restart VS Code:** Tasks that were `running` or `waiting_input` are reset to `idle`. Completed, errored, and paused tasks keep their state. Task instances are **not** automatically restarted — you must explicitly re-open a task to resume it.

### Tips

- **Break large tasks into smaller ones.** Instead of "refactor the whole project," ask Shofer to spawn one background child per module.
- **Use `wait_for_task` with `"any"`** when order doesn't matter — the parent processes children as they finish.
- **Check the notification badge** in the TaskSelector — a yellow badge means a background child needs your input.
- **Cancel stalled children** if you don't need their results anymore — it frees up a concurrency slot.

---

## 18. Understanding Task States

Shofer shows the status of every task — past and present — with colored icons in the task dropdown and chat header. This section explains what each state means so you can tell at a glance what your tasks are doing.

### Where You See Task States

Task states appear in two places:

1. **TaskSelector dropdown** — the sidebar drawer that opens when you click the tree-list icon in the VS Code title bar. Every history item and running parallel task has a state icon.

 <!-- XXX: Screenshot — TaskSelector dropdown open, showing several task rows with different state icons: a spinning sync icon (running) on one row, a question mark (waiting_input) on a background task, a green pass-filled (completed/excellent) on an older task. -->

2. **Chat header dot** — the small colored circle in the TaskHeader bar above the chat messages. It matches the same state as the TaskSelector icon for the current task.

 <!-- XXX: Screenshot — ChatView with TaskHeader visible, showing the green pulsing dot next to the task title ("running" state), with the context window bar and token/cost counters visible. -->

### The Seven Task States

| Icon               | State                 | What It Means                                                                                                                                                                                            |
| ------------------ | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ○ (outline circle) | **Idle**              | The task is not running. It may be waiting for you to send a message, or it may be a completed/stopped task from history.                                                                                |
| ⟳ (spinning sync)  | **Running**           | Shofer is actively working — making API calls, executing tools, or streaming a response.                                                                                                                 |
| ? (question)       | **Waiting for Input** | The task needs your approval or answer. You'll see an Ask prompt in the chat (e.g., "Approve tool call?" or a followup question). Background tasks show a notification badge when they reach this state. |
| ⌚ (watch)         | **Waiting**           | The task is blocked waiting for something external — for example, a parent task waiting for its child subtask to finish (`wait_for_task`). This is not waiting for _you_; no action is needed.           |
| ⏸ (pause)         | **Paused**            | You stopped the task (clicked Stop) or it was paused due to a budget limit. You can resume it by sending another message.                                                                                |
| ✓ (pass / filled)  | **Completed**         | The task finished successfully. A green circle — hollow for "poor," filled for "well," or a filled pass icon for "excellent" — shows the agent's self-assessment.                                        |
| ✕ (error)          | **Error**             | The task stopped due to an error. Hover for details or switch to the task to see what went wrong.                                                                                                        |

<!-- XXX: Screenshot — Composite image showing a callout for each of the 7 state icons, ideally arranged in a 2-row grid: idle (gray outline), running (spinning blue), waiting_input (yellow question), waiting (blue watch), paused (orange pause), completed (green pass), error (red error). -->

### Completion Ratings

When a task completes, the agent rates its own work as **poor**, **well**, or **excellent**. The rating changes the icon:

| Rating    | Icon                         | Meaning                                                                                                             |
| --------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Poor      | ○ (hollow circle, gray)      | The task finished but the result has significant issues. You may want to start a new task with better instructions. |
| Well      | ● (filled circle, green 60%) | The task completed acceptably. Room for improvement but the result is usable.                                       |
| Excellent | ✓ (filled checkmark, green)  | The task executed excellently. High-quality result.                                                                 |

<!-- XXX: Screenshot — TaskSelector showing three completed task rows side by side with the three rating icons: hollow circle (poor), filled circle (well), pass-filled (excellent), each with a different task name and "Completed · X" label. -->

### Where Ratings Come From

The rating is set by Shofer itself when it calls the `attempt_completion` tool at the end of a task. You cannot manually assign a rating — it reflects the agent's own assessment of how well it met your request.

### Task States After Restart

When you restart VS Code (or reload the window), tasks that were running or waiting are shown as **Idle** — because no live task instance survives a restart. Tasks that completed, errored, or were paused keep their state. This prevents stale "Running" indicators from a previous session.

### Notification Badges

The TaskSelector shows a notification badge (count) when background tasks need your attention:

- A background task reached **Waiting for Input** and needs your approval.
- The badge disappears once you focus that task and answer the prompt.

Tasks in the **Waiting** state do **not** trigger a badge — they are waiting for something other than you.

<!-- XXX: Screenshot — TaskSelector header showing a red notification badge with count "2", and two background task rows below with yellow question-mark icons. -->

---

## 19. The Stop Button

Shofer processes your requests through a loop: it streams a response, runs tools, waits for MCP servers, and asks you for approvals. The **Stop** button lets you interrupt this cycle at any point — whether you want to change direction, stop a runaway tool, or simply pause and rethink.

### When Stop Is Available

Stop is shown in the chat input bar whenever Shofer could be doing work on your behalf. Specifically:

1. **Shofer is streaming a response** — text is appearing in the chat. Stop is shown in place of the Send button.

2. **Shofer is running a tool** — even if no text is streaming (e.g., a long-running browser action or an MCP tool call), the Stop button stays visible so you can interrupt the operation immediately.

3. **Shofer has asked you a question** — any approval prompt (tool approval, command execution, follow-up question) shows the Stop button as a "never mind" escape.

Stop is hidden when the task is effectively idle: no work is in flight, the task is waiting for you to type a new message in an empty input, or the task has completed.

<!-- XXX: Screenshot — ChatView with an active streaming response. The Stop button (a red square icon) is visible in the chat input bar. Above, Shofer is mid-response with streaming text. The task is in "running" state. -->

### What Happens When You Click Stop

Clicking Stop does the following, near-instantly:

1. **Cancels the current API request** — Shofer stops waiting for the LLM response immediately. Any partially-streamed text stays visible in the chat as-is.

2. **Aborts in-flight tools** — if Shofer is running an MCP tool (browser action, HTTP request, Kubernetes query, etc.), the tool is cancelled right away instead of running to its built-in timeout.

3. **Stops the task loop** — the task transitions to an idle state. The conversation history up to this point is preserved.

4. **You regain control** — the input area re-enables, and you can type a new message to continue the task, or switch to a different task.

<!-- XXX: Screenshot — ChatView immediately after clicking Stop. The streaming response is truncated mid-sentence (with an ellipsis or partial text visible). The input is active and ready for typing. The TaskHeader shows the task as "idle" or no longer streaming. -->

> **Note:** Stop does NOT delete anything. Your conversation history, context, and any files Shofer has already modified are left exactly as they were.

### Stop vs. Send Now

Stop is **not** the same as sending a queued message with **Send Now**. They serve different purposes:

|              | Stop button                        | Send Now (on queued message)        |
| ------------ | ---------------------------------- | ----------------------------------- |
| **Goal**     | Stop and wait for new instructions | Cancel + immediately send a message |
| **Result**   | Task goes idle                     | Task restarts with your message     |
| **Use case** | "Wrong direction, let me think"    | "Wrong direction — here's a fix"    |

If you have a queued message (you typed while Shofer was busy), clicking the Stop button leaves that message in the queue. Shofer will send it when you next interact with the task.

If you want to **both cancel and immediately redirect** Shofer, use **Send Now** on a queued message instead.

<!-- XXX: Screenshot — Side-by-side comparison. Left: The chat input with just the Stop button visible (no queued messages). Right: A queued message bubble with the "Send Now" button highlighted, the Streaming response visible above. -->

### Stopping Long-Running Tools

When Shofer is running a tool that takes a long time (e.g., a browser action that navigates a multi-page form, or a Kubernetes query timing out), Stop cancels the tool immediately rather than letting it run to its own timeout. This is especially important for MCP tools that may have 60-second server timeouts — without Stop, you'd be stuck waiting.

<!-- XXX: Screenshot — ChatView showing an active MCP tool call (a tool status indicator or "Running: browser_navigate" card). The Stop button is visible even though no text is streaming. A caption: "Stop is available during tool execution — you don't have to wait for the timeout." -->

### Keyboard Shortcut

In the Shofer webview, you can also press **Escape** to trigger Stop when the task is running.

### What Stop Does Not Do

- **Does not close the task.** Your conversation stays open. The same task instance continues — you can type a new message right away.
- **Does not undo file changes.** Any files Shofer wrote or modified before you clicked Stop are left as-is. You can review them in the File Changes Panel and revert if needed.
- **Does not cancel background tasks.** If you have parallel background tasks running, Stop only affects the task you're looking at. Background children continue independently.

---

## 20. Queued Messages, Send Now, and Per-Task Drafts

When Shofer is busy working on your request, you can keep typing — your messages are queued and sent as soon as Shofer is ready. You can also force-send a queued message immediately with **Send Now**, and your half-typed drafts stay with the task you were writing in.

### Typing While Shofer Is Busy

When Shofer is streaming a response, running a tool, or waiting for an API reply, you'll see the Send button change to a **Stop** button. If you type a message and press **Enter** (or click **Send**), the message doesn't get sent immediately. Instead, it appears in the **Queued Messages** section — a collapsible bar that shows up above the chat input:

<!-- XXX: Screenshot — ChatView showing a streaming response in progress. The chat input bar has a queued message visible in the "Queued Messages" section (collapsed bar showing "1 message waiting…"), and the Stop button is active. Above the input, Shofer is mid-response with streaming text visible. -->

Once Shofer finishes the current turn (the streaming response completes and any tool approvals are resolved), the queued message is automatically sent as your next input. No need to re-type it.

If you type multiple messages while Shofer is busy, they queue up in **FIFO order** — first typed, first sent. The Queued Messages section shows a count:

<!-- XXX: Screenshot — ChatView with Queued Messages section expanded, showing 3 queued message bubbles in chronological order. Each bubble shows the message text preview. The oldest message has a "Send Now" button on its right. -->

#### When Messages Queue

Messages are queued in three situations:

1. **Shofer is streaming a response** — you'll see text appearing in the chat. Any message you type during this time is queued.
2. **Shofer is running a tool** — the chat shows a tool call or approval prompt. Your message is queued until the tool finishes and Shofer resumes listening.
3. **Between asks** — there's a brief window between Shofer finishing one thing and posting the next ask. If you type during this window, your message is queued.

In all cases, your message is **not lost**. You'll see it appear as a queued bubble, and it will be delivered when Shofer is ready.

### Send Now — Skip the Wait

If you don't want to wait for Shofer to finish its current response, you can click **Send Now** on any queued message bubble. This will:

1. **Cancel** the current API request (stop streaming).
2. **Keep** the conversation context — Shofer doesn't lose any of your conversation history.
3. **Send** the queued message immediately as your next turn.
4. **Continue** — Shofer processes your new message just like a normal message.

<!-- XXX: Screenshot — A queued message bubble with a "Send Now" button highlighted/circled. Below it, a brief animation frame or second screenshot showing the same chat after Send Now was clicked: the old streaming response stopped mid-sentence, and Shofer is now responding to the newly-sent message. -->

> **Tip:** Send Now is perfect when Shofer is going down a wrong path and you want to redirect it immediately. Instead of waiting for the response to finish, type your correction and hit Send Now.

Send Now does **not** create a new task or reset your conversation. It stops the current turn only, and the same task instance continues with your new message.

#### Cancelling Queued Messages

To remove a queued message you no longer want to send, hover over the bubble and click the **×** (delete) icon. The message is removed from the queue. Other queued messages keep their original order.

### Per-Task Drafts

If you switch between tasks while you have unsent text in the chat input, Shofer saves your draft for each task separately:

<!-- XXX: Screenshot — Two ChatView windows side by side (from task switching). Left side: Task A ("Fix login bug") with a half-typed message "The issue is in the auth middleware where…" in the input. Right side: Task B ("Add unit tests") with an empty input. The TaskSelector dropdown is open, showing both tasks. -->

1. **Switch away**: When you switch to a different task (or start a new one via the pencil icon), the text, images, and dropped files in the input area are saved for the task you're leaving.
2. **Switch back**: When you return to that task, your draft is restored — text, images, and context files.

This means you can start composing a question for one task, switch to check something in another, and come back to find your draft exactly where you left it.

<!-- XXX: Screenshot — Before-and-after: ChatView showing Task A with input containing "Can you explain how…" → TaskSelector click to switch to Task B with empty input → TaskSelector click back to Task A showing "Can you explain how…" restored in the input. Ideally a 3-panel sequence. -->

#### What Gets Preserved

- **Text** — your typed message
- **Images** — any images you've attached
- **Context files** — files dropped into the chat area (`@file/path` and `@folder/path` mentions)

#### When Drafts Are NOT Preserved

- Drafts are cleared when you **send** the message. The input area resets for your next message, which is the normal flow.
- If you **delete** a task, its draft is also deleted permanently.

---

## 21. File Changes Panel

Whenever Shofer modifies your workspace files — applying a diff, writing a new file, deleting or renaming something — those changes are tracked per-task and displayed in the **File Changes Panel.** The panel sits above the chat input and gives you a single place to review, revert, redo, or accept every edit Shofer made during the current task.

<!-- XXX: Screenshot showing the FileChangesPanel in its expanded state above the ChatTextArea, with 2–3 entries visible — one "modified", one "added", one "deleted". Each entry should show the file path, the +/- line counts, and the Accept / Revert / Redo buttons. Caption: "The File Changes Panel showing three files Shofer edited during a task." -->

### What You See

Each row in the panel corresponds to a file Shofer touched at least once during the current task. For every file you'll see:

| Element             | Meaning                                                                |
| ------------------- | ---------------------------------------------------------------------- |
| **File path**       | Workspace-relative path (e.g. `src/utils/helpers.ts`).                 |
| **+/− line counts** | Net insertions and deletions compared to the task's start.             |
| **State label**     | `modified`, `added`, `deleted`, or `reverted`.                         |
| **Accept button**   | Promote the current disk state as the new accepted baseline.           |
| **Revert button**   | Restore the file to its pre-Shofer content.                            |
| **Redo button**     | Re-apply the last Shofer-produced state (visible only after a revert). |

<!-- XXX: Close-up screenshot of a single panel entry with callout arrows / labels pointing to each element described above. Caption: "Anatomy of a single file-change entry." -->

Files you modified yourself (without Shofer's involvement) **do not** appear in the panel — the panel is scoped exclusively to files Shofer edited during the current task.

### Core Actions

#### Viewing a Diff (Click-to-Diff)

Click **any row** to open a VS Code diff editor comparing the **original** content (before Shofer edited it) against the **current on-disk** content. This shows you Shofer's cumulative effect on the file, not incremental patches.

<!-- XXX: Screenshot of the VS Code diff editor opened by clicking a row, showing original on the left (read-only, "shofer-original" label) and current on the right. Caption: "Click-to-diff showing the original vs. current state of a file Shofer edited." -->

The diff button is dimmed only when the original content isn't available (a rare edge case when the file was captured after the first edit).

#### Accepting Changes

Click **Accept** on a single file or **Accept All** in the panel header. This copies the current on-disk content into Shofer's internal baseline, so the file disappears from the panel. Accept is **persistent** — closing the task or restarting Shofer won't bring the file back.

> **When to accept:** You've reviewed the diff, you're happy with the result, and you want to "lock in" the change and clean up the panel.

#### Reverting Changes

Click **Revert** on a single file or **Revert All** in the panel header (requires a confirmation click). Revert restores the file to its original state as it existed **before Shofer first edited it** in this task.

> **When to revert:** Shofer made a change you don't want. The file goes back to exactly how it was.

**What happens after a revert:**

- The entry stays in the panel, but its state changes to `reverted`.
- A **Redo** button appears — click it to re-apply the last Shofer-produced version (useful if you reverted by accident or want to A/B compare).
- The file's edit count drops to +0/−0 but the entry is preserved so Redo is always reachable.

<!-- XXX: Screenshot showing a reverted entry with the Redo button visible. The entry should have 0 insertions / 0 deletions and state "reverted". Caption: "A reverted file showing the Redo button." -->

#### User-Edits Warning

If you edited a file yourself **after** Shofer touched it, clicking Revert shows a warning modal:

> _"This file has changes you made after Shofer last touched it. Reverting will discard those edits. Continue?"_

This prevents you from accidentally losing your own work.

<!-- XXX: Screenshot of the revert-confirmation modal showing the user-edits warning. Caption: "The user-edits warning shown when reverting a file you modified after Shofer." -->

### Accept All & Revert All

Two header buttons next to the file count let you operate on every tracked file at once.

| Button         | Effect                                                                                                                                      |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **Accept All** | Accepts every file simultaneously — all entries vanish from the panel.                                                                      |
| **Revert All** | Shows a confirmation modal, then reverts every file back to task-start state. All entries shift to `reverted` with Redo available per-file. |

> **Pro tip:** Revert All is a quick way to undo an entire task's filesystem changes without deleting the conversation. The chat history is preserved — only the files on disk are rolled back.

### When the Panel Won't Show a File

Some edits don't produce panel entries:

- **Zero net change:** Shofer added a line, then deleted it — or created a file, then removed it. If the final state matches the original, there's no diff to show.
- **Directory-only operations:** `create_directory` and `create_new_workspace` don't modify file contents, so they aren't tracked.
- **Arbitrary shell commands:** `execute_command` runs CLI tools directly; Shofer can't know which files were modified.

### Active-Task Guard

The Revert and Redo buttons are blocked while Shofer is **actively streaming** (the task is generating a response or executing tools). You'll see a toast: _"Cannot modify files while Shofer is running. Pause or cancel the task first."_

Stop the task first, then revert or accept — this ensures the panel always shows a consistent snapshot.

### Multi-Task Editing

If you run multiple tasks in parallel and both edit the same file:

- Each task tracks its own `before` snapshot independently.
- Task A's **Revert** restores to _before-Task-A_ started (which may include Task B's edits if Task B ran first).
- Task B's **Revert** restores to _before-both-tasks_ (the true original).

The panel always shows changes for the **currently focused foreground task** only. Switch tasks via the TaskSelector to see a different task's file changes.

### Quick Reference

| Goal                                  | Action                                         |
| ------------------------------------- | ---------------------------------------------- |
| See what Shofer changed               | Look at the File Changes Panel above the input |
| Inspect a specific diff               | Click the file row                             |
| Keep Shofer's change                  | Click **Accept**                               |
| Undo Shofer's change                  | Click **Revert**                               |
| Re-apply after revert                 | Click **Redo**                                 |
| Undo **all** Shofer changes this task | Click **Revert All** then confirm              |
| Lock in **all** Shofer changes        | Click **Accept All**                           |
| Check another task's changes          | Switch tasks via the TaskSelector              |

### What's Not Affected

The File Changes Panel operates independently of git. It uses Shofer's own per-task working directories — no git repo required, no commits created, no interaction with your staging area or working tree.

---

## 22. Exporting Task History

Shofer lets you export your task conversations so you can review them offline, share them with your team, or run your own analysis. Two formats are available: **Markdown** for reading and **JSON** for data crunching.

### What Gets Exported

The export captures the **full conversation** — every message you sent, every response the model gave, every tool it called, and every reasoning step it took. It is a complete transcript of everything that happened in that task.

### Exporting a Task

#### From the task header

1. Open the task you want to export.
2. Click the task title bar at the top of the chat to expand it.
 <!-- XXX: Screenshot — ChatView task header bar expanded, showing the action row with Export (download icon) and Export JSON (file icon) buttons highlighted. -->
3. Click one of the two export buttons:
    - **Export** (download icon) — saves a `.md` Markdown transcript.
    - **Export JSON** (file icon) — saves a `.json` structured trace.
4. Choose where to save the file in the file dialog that appears.

#### From the History panel

You can also export completed tasks from the History panel:

1. Open the **History panel** (clock icon in the VS Code title bar).
2. Find the task you want to export.
3. Click the **Export** or **Export JSON** button in that task's row.
 <!-- XXX: Screenshot — HistoryView showing a task row with Export and Export JSON buttons highlighted. -->

### Choosing a Format

| You want to…                     | Use Markdown (`.md`)          | Use JSON (`.json`)               |
| -------------------------------- | ----------------------------- | -------------------------------- |
| Read the conversation            | ✅ Yes — open in any editor   | ❌ Needs a JSON viewer/formatter |
| Share with a colleague           | ✅ Easy to read               | ❌ Hard to skim                  |
| Track token usage and cost       | ❌ Not included               | ✅ Per-call + totals             |
| See which model was used         | ❌ Not included               | ✅ Per call                      |
| Run scripts or build dashboards  | ❌ Free-form text             | ✅ Schema'd and predictable      |
| Compare reasoning vs final reply | ✅ Inline `[Reasoning]` block | ✅ Dedicated `reasoning` field   |

### Markdown Export

The Markdown file is a plain-text transcript. Each exchange between you and the model is separated by `---` and labelled with the role.

```
**User:**

Fix the bug in the login handler.

---

**Assistant:**

[Reasoning]
The login handler has a missing null check on line 42…

[Tool Use: read_file]
Path: src/auth/login.ts
Offset: 35
Limit: 20

[Tool{ (Error)}]
Error: file not found
…
```

#### What the annotations mean

| What you see       | What it means                                                                                                   |
| ------------------ | --------------------------------------------------------------------------------------------------------------- |
| `[Reasoning]`      | The model's internal reasoning before it wrote the response.                                                    |
| `[Tool Use: name]` | The model called a tool (e.g., `read_file`, `execute_command`). The block below shows the parameters it passed. |
| `[Tool]`           | The tool returned a result (shown below the label).                                                             |
| `[Tool (Error)]`   | The tool call failed (error message shown below).                                                               |
| `[Image]`          | An image was attached at this point in the conversation.                                                        |

### JSON Export

The JSON file is designed for programmatic use. Every API call the model made is a separate entry with detailed metadata.

#### What's in it

- **`calls[]`** — one entry per API request, in chronological order.
- **Token counts** — input tokens, output tokens, cache read/write tokens.  
  If the provider didn't report token usage, Shofer estimates it and marks the call with `"_tokensEstimated": true`.
- **Cost in USD** — per call and total.
- **`apiProtocol`** and **`model`** — tells you which provider and model handled each request.
- **`toolCalls[]`** — every tool the model called, including the input and result.
- **`reasoning`** — the model's thinking, extracted into its own field.
- **`error`** — structured error info for failed calls (message, type, HTTP status code).
- **`wireRequest`** — a snapshot of what was about to be sent to the provider, useful for debugging.
- **`retryAttempt`** — 0 for the first try, 1 for the first retry, etc.

Error-only calls (network failures, rate limits, empty streams) are included too — with empty `messages` and `toolCalls` but a populated `error` object. This way you can see every attempt, not just the successful ones.

<!-- XXX: Screenshot — JSON file opened in VS Code, with the top-level object expanded to show version, taskId, totalTokens, and the first element of calls[] expanded to show index, model, token counts, and toolCalls[]. -->

### Edge Cases

- **Empty tasks** — tasks with no messages export an empty `calls[]` array (JSON) or an empty file (Markdown).
- **Very large tasks** — the export includes all messages; long conversations produce large files.
- **Tasks with images** — images are marked as `[Image]` in Markdown exports. JSON exports do not embed the image data.
- **Estimated tokens** — if your provider doesn't report token usage during streaming, Shofer uses a character-count estimate. The JSON export flags these calls with `"_tokensEstimated": true`.
- **Cancelled tasks** — a task that was stopped mid-response is exported up to the point it was cancelled. Cancelled calls are marked with `"cancelled": true` and a `cancelReason`.
- **Failed API calls** — calls that never received a response (network error, rate limit) still appear in the JSON export with an `error` object and empty messages, so you have a complete audit trail.

---

## 23. Attaching Files via Drag & Drop

Shofer lets you attach files and folders to your chat by dragging them from the Explorer panel or using the right-click context menu. Attached files become `@mentions` in your message — the AI sees them as part of your request.

### Two ways to attach files

#### 1. Drag from the Explorer

At the bottom of the Shofer sidebar, you'll find a row labeled **"Drop Files for Context."** Drag any file or folder from the VSCode Explorer onto this row.

<!-- XXX Screenshot: The Shofer sidebar with the Explorer visible on the left. An arrow overlay should show files being dragged from the Explorer tree onto the "Drop Files for Context" row at the bottom of the Shofer sidebar. The row should be highlighted/active to show it's a valid drop target. -->

- **You don't need to expand the view first** — dropping directly onto the title bar works.
- Dragging the **same file twice** is harmless — duplicates are automatically ignored.
- Both files and folders are accepted.

After a successful drop, the status bar briefly shows "Added N files to chat context."

#### 2. Right-click in the Explorer (no drag)

Select one or more files or folders in the Explorer, right-click, and choose **"Add to Shofer Context."**

<!-- XXX Screenshot: VS Code Explorer with several files selected, the right-click context menu open, and "Add to Shofer Context" highlighted in the menu. -->

This has the same effect as dragging — the files appear as tags above the chat input.

### File tags

Once files are attached, they appear as **removable tags** above the chat input.

<!-- XXX Screenshot: The ChatView input area with 3-4 file tags shown above the text input. Each tag should show a file/folder icon, the relative path, and a small (×) remove button. A "Clear all" link/button should be visible to the right of the tags. -->

Each tag shows:

- A file or folder icon (folders have a distinct icon).
- The **workspace-relative path** (e.g., `src/utils/auth.ts`).
- A **remove button** (×) to remove that specific file.

To the right of the tags, a **"Clear all"** button removes every file at once.

### What happens when you send

When you press Send, Shofer automatically prepends the files as `@mentions` to your message. For example:

```
@/src/utils/auth.ts @/src/middleware/session.ts

Can you review these files for security issues?
```

<!-- XXX Screenshot: ChatView showing a sent message with @mentions prepended above the user's typed text. The file tags above the input should be cleared (no longer visible). The @mentions in the chat bubble should be styled as clickable links. -->

The file tags are cleared from the chat input once the message is sent.

### Per-task file tags

Each task remembers which files you attached to it. If you switch to a different task, that task's files are restored when you switch back. Files attached to one task never leak into another.

### Tips

- **Drop onto the busy indicator**: Even while Shofer is processing, you can still drop files to attach them to the current task.
- **Use the context menu for precision**: The right-click method is useful when the Explorer and Shofer sidebar are far apart or on different monitors.
- **Folders**: Dropping a folder includes its path as a mention — the AI uses it as a directory reference.
- **Status bar confirmation**: After each drop, the status bar briefly confirms how many files were added. No confirmation means the drop didn't register (try again or use the right-click method).

---

## 24. Working with Images

Shofer lets you attach images to your messages so that vision-capable AI models can see and analyze them. You can paste screenshots directly, drag image files onto the chat, or pick files from a dialog.

Images are encoded as base64 data URLs and sent to the AI provider as part of your message — no file uploads to a third-party image host.

### Attaching Images

There are three ways to add images to your message:

#### 1. Paste from Clipboard

Copy an image to your clipboard (screenshot, copied from a browser, etc.) and press **Ctrl+V** (Windows/Linux) or **⌘+V** (macOS) while your cursor is in the chat input box.

Shofer detects the image data on the clipboard and attaches it automatically. Supported formats: PNG, JPEG, WebP.

XXX: Screenshot of a user pressing Ctrl+V in the chat input, with an image appearing as a small thumbnail above the input bar. Annotation: "Image attached via clipboard paste — appears as thumbnail."

#### 2. Drag & Drop

Drag an image file from your file manager (Explorer, Finder, etc.) and drop it onto the chat text area.

You can also drag files from VS Code's Explorer panel or editor tabs, which are resolved as file `@`-mentions rather than images.

XXX: Screenshot of a user dragging a PNG file from the OS file manager onto the chat input area. Annotation showing the drop target highlight and the resulting thumbnail.

#### 3. File Picker

Click the 🖼️ button in the bottom-right corner of the chat input box. This opens your operating system's file picker dialog where you can select one or more image files.

The 🖼️ button only appears when the selected AI model supports vision (see [Model-Aware Gating](#model-aware-gating)).

XXX: Screenshot of the chat input bar with the 🖼️ button highlighted. Inset: the OS file picker dialog showing PNG/JPEG files being selected.

### Viewing and Removing Images

#### Thumbnails

Each attached image appears as a small thumbnail above the mode and API configuration selectors.

- **Click** a thumbnail to open the image full-size in VS Code's built-in image viewer.
- **Hover** over a thumbnail and click the red **×** to remove it.

Images persist across mode changes, API configuration switches, and even task switches — they stay in the input until you remove them or send the message.

XXX: Screenshot showing the thumbnail strip with 3 images attached. Highlight the red × button on hover and the click-to-open behavior.

#### Image Generation Results

When you use the `generate_image` tool, generated images appear in a dedicated viewer that supports **zoom**, **copy to clipboard**, **save to file**, and Mermaid-style action buttons.

XXX: Screenshot of a generated image displayed in the ImageViewer modal, with the zoom/save/copy buttons annotated.

### Supported Formats

| Format   | Notes                                                     |
| -------- | --------------------------------------------------------- |
| **PNG**  | Lossless. Best for screenshots, diagrams, and UI mockups. |
| **JPEG** | Lossy. Best for photographs and natural images.           |
| **WebP** | Modern format with good compression for both types.       |

There is no built-in format conversion — send images in their native format.

### Model-Aware Gating

Image features are automatically enabled or disabled based on the AI model you have selected:

| Your model supports…                       | What you see                                           |
| ------------------------------------------ | ------------------------------------------------------ |
| Vision (e.g., Claude Sonnet, GPT-4o)       | 🖼️ button visible, paste and drag-drop work            |
| No vision (e.g., older models, o1-preview) | 🖼️ button hidden, paste and drag-drop silently ignored |

When images are disabled because the model doesn't support them, the chat placeholder text also omits instructions about attaching images.

If you switch from a vision model to a non-vision model mid-conversation, previously sent images in the conversation history are replaced with `[Referenced image in conversation]` placeholders so the API call doesn't fail.

XXX: Side-by-side screenshots: (left) ChatTextArea with a vision-capable model selected — 🖼️ button visible, placeholder mentions images. (right) Same area with a non-vision model — 🖼️ button hidden, no image mentions.

### Sending Messages with Images

You can send a message with images even if you haven't typed any text — the Send button is visible whenever text or images are present.

When you click Send, images are included alongside your text in the message payload sent to the AI provider. The AI receives the images as part of the conversation and can analyze their contents.

XXX: Screenshot of a conversation where the user sent an image with the question "What does this diagram show?". The AI responds with a detailed analysis of the diagram contents.

### Editing Messages with Images

When you edit a message that had images attached, the existing images are preserved in the edit view. You can:

- **Keep** the original images — they'll be re-sent with your edited text.
- **Add more** images via paste, drag-drop, or the file picker.
- **Remove** images by hovering and clicking ×.

XXX: Screenshot of the edit message view showing preserved thumbnails from the original message, with the text input editable above them.

### Image Size Limits

- **Per message**: up to **20 images** (matching the Anthropic API limit).
- **Per file** (for `read_file` tool): configurable in **Settings → Advanced → Max Image File Size** (default 5 MB per image).
- **Total per operation** (for `read_file` tool): configurable in **Settings → Advanced → Max Total Image Size** (default 20 MB).

### Tips

- **Screenshots work best as PNG** — the lossless format preserves text clarity for the model to read.
- **Keep images focused** — crop to the relevant area. Extraneous UI chrome or desktop backgrounds waste context window space.
- **Combine with text** — a brief question like "What does this error mean?" alongside a screenshot of the error dialog gets better results than an image alone.

---

## 25. Chat Scrolling

Shofer's chat panel keeps new messages visible automatically so you can watch the AI work without manually scrolling. When you scroll up to review older messages, Shofer pauses the auto-follow and shows a button to jump back to the latest message.

### Auto-Follow During Streaming

When a task is running, Shofer pins the chat viewport to the bottom:

- **New messages appear immediately** — the panel scrolls down as text, tool calls, and results stream in.
- **Growing messages stay visible** — when a message row expands (a tool result loading, code block rendering), the viewport adjusts automatically.

You don't need to do anything — just watch the conversation unfold.

XXX: Screenshot showing the chat panel mid-streaming with a tool call expanding. Annotations: "Viewport stays pinned to bottom", "New messages appear without scrolling".

### Browsing History While Streaming

You can scroll up at any time to read earlier messages without interrupting the task:

- **Scroll up** (mouse wheel, touchpad drag, or keyboard PageUp/ArrowUp) to enter "browse mode."
- Shofer **keeps streaming** in the background — new messages arrive normally, but the viewport stays where you are.
- A **↓ scroll-to-bottom button** appears in the bottom-right corner of the chat area.

XXX: Screenshot of the chat panel scrolled up mid-streaming. Annotation highlighting the ↓ button in the bottom-right corner. Callout: "Click to return to the latest message."

This also triggers when you **expand a collapsed row** (like a reasoning block or a long tool result) — expanding something above the viewport enters browse mode so the expanded content stays in view.

### Returning to the Latest Message

Click the **↓** (chevron-down) button to re-engage auto-follow:

1. The viewport scrolls to the bottom immediately.
2. A second scroll fires on the next animation frame to absorb any pending layout changes.
3. Auto-follow resumes — new messages will scroll into view automatically.

XXX: Screenshot of the ↓ button being clicked, with an arrow showing the viewport snapping to the bottom. Or a short animated GIF.

### Task Switching

When you switch to a different task (via the TaskSelector dropdown or by creating a new task):

- The chat panel scrolls to the bottom of the new task's messages.
- If the viewport doesn't reach the bottom on the first attempt (e.g., the virtualized list is still measuring), Shofer retries up to 3 times automatically.
- The scroll-to-bottom button is **hidden** during this brief "hydration" window — even if the viewport momentarily reports not-at-bottom, Shofer knows you didn't intentionally scroll up.

### Session Search (Ctrl+F)

Press **Ctrl+F** (or **⌘F** on macOS) to search the current task's message history. When you jump to a search result:

- Shofer scrolls to center the matching message in the viewport.
- Browsing/search navigation does **not** change the auto-follow state — if you were in browse mode you stay there; if you were auto-following you stay auto-following.

XXX: Screenshot of the SessionSearch overlay with a search term entered and a match count. Annotation: "Search jumps to message without changing scroll mode."

### Summary

| Situation                          | Behavior                                    |
| ---------------------------------- | ------------------------------------------- |
| Task running, you're at the bottom | Auto-follow — new messages scroll into view |
| You scroll up during streaming     | Browse mode — ↓ button appears              |
| You click the ↓ button             | Re-engages auto-follow, scrolls to bottom   |
| You switch tasks                   | Auto-scroll to bottom with retry logic      |
| You use Ctrl+F session search      | Scrolls to match, preserves scroll mode     |

---

## 26. Commands & Skills Quick-Access

Next to the mode and API config selectors in the chat input bar, you'll find two compact buttons that let you browse and insert slash commands and skills without typing or opening Settings.

<!-- XXX: Full-width screenshot of the ChatTextArea bar showing the full row of controls: ModeSelector, ApiConfigSelector, AutoApproveDropdown, WorktreeIndicator, CommandsButton (⚡), and SkillsButton (🎓). The CommandsButton popover should be open, showing grouped slash commands. Caption: "The chat input bar with the Commands popover open." -->

### Commands Button (⚡)

Click the **⚡ Commands** button to see every slash command available in your workspace. Commands are grouped by source:

- **Project Commands** — defined in your workspace's `.shofer/commands/` directory.
- **Global Commands** — defined in your user-level `~/.shofer/commands/` directory.
- **Built-in Commands** — provided by Shofer itself (e.g., `init`).

<!-- XXX: Close-up of the Commands popover with all three groups visible and one command hovered to show the open-file (ExternalLink) icon. Caption: "Commands popover showing Project, Global, and Built-in groups." -->

**To use a command:**

1. Click ⚡ to open the popover.
2. Click any command — it's appended to the chat input as `/command-name`.
3. Review the command text, edit if needed, then click **Send**.

Commands with an **argument hint** (e.g., `/review <branch-name>`) include the placeholder in the inserted text — just replace it with your value before sending.

The popover header includes a **↻ refresh button** (re-reads the commands directories) and a **⚙ gear** (opens Settings → Slash Commands). Each command row also shows a file-open icon on hover when the command has a known source file.

### Skills Button (🎓)

Click the **🎓 Skills** button to browse all available skills. The popover shows skills in two sections:

1. **Loaded** (with a green ✓ checkmark) — skills already loaded into the current task's context. Clicking a loaded skill re-inserts its instruction text so the model can reference it again.
2. **Available** — skills not yet loaded, grouped by mode restriction:
    - **All Modes** (🌐 icon) — skills available in every mode.
    - **Per-mode groups** (📁 icon) — skills restricted to specific modes, sorted alphabetically.

<!-- XXX: Close-up of the Skills popover showing both the Loaded section (with green checkmarks) and the Available section (grouped by mode). One loaded skill and two available skills visible. Caption: "Skills popover with loaded and available skills." -->

**To use a skill:**

1. Click 🎓 to open the popover.
2. Click any skill — the text `Use the <skill-name> skill` is inserted into the chat input.
3. Click **Send**. The model will load the skill's instructions via its tool-calling mechanism and then follow them.

The popover header includes a **↻ refresh button** (re-discovers skills from `.shofer/skills/` directories) and a **⚙ gear** (opens Settings → Skills). Each skill row shows a file-open icon on hover (opens the `SKILL.md` file in the editor).

> **Note:** Skills are never auto-executed. Shofer always inserts an instruction and lets you decide when (and whether) to send it.

### Loaded Skills Tracking

As a task runs, Shofer remembers which skills the model has already loaded. This information is shown in the Skills popover so you always know what's active in your current conversation.

- **On load:** The skill appears in the "Loaded" section with a ✓.
- **On context condensation:** When Shofer summarizes the conversation to free up context window space, the loaded-skills list is cleared (summarization invalidates previously loaded skill instructions).

### Refreshing

Both popovers have a **↻ refresh** button in the header:

- **Commands:** Re-reads the `.shofer/commands/` directories (project and global) and picks up any newly added or removed command files.
- **Skills:** Re-discovers all `SKILL.md` files from `.shofer/skills/` directories and updates the popover list. The Skills button also automatically refreshes every time you open its popover, so loaded/unloaded status is always current.

### When Buttons Are Hidden

- The **Commands** button hides when there are no commands available (no project, global, or built-in commands).
- The **Skills** button hides when there are no skills available (no `SKILL.md` files discovered in any skills directory).

Both buttons are always enabled regardless of task state — you can browse and insert commands and skills even while Shofer is actively working.

---

## 27. Skills

Skills are reusable instruction packs that teach Shofer how to handle specific tasks — searching a particular website, following a multi-step workflow, or applying domain-specific rules. When you install or create a skill, Shofer automatically detects it and uses it whenever the task matches.

### What Are Skills?

A skill is a folder containing a `SKILL.md` file with YAML frontmatter (name, description, optional mode restrictions) followed by markdown instructions. Shofer discovers skills from your filesystem, includes their descriptions in the system prompt, and loads the full instructions on-demand when the model decides the skill applies.

**Key properties:**

- **Lazy-loaded** — only the name and description appear in the system prompt. The full instructions are loaded only when the model invokes `skills`.
- **Mode-aware** — a skill can be restricted to specific modes (Code, Architect, etc.) or be available in all modes.
- **Loaded once per task** — Shofer remembers which skills are already loaded and won't reload them. All loaded skills are cleared automatically when the conversation context is condensed.
- **Overridable** — project-level skills override global skills with the same name. Mode-specific skills override generic ones.

### Where Skills Live

Shofer discovers skills from these directories (in priority order — later directories override earlier):

| Directory                   | Scope   | Priority |
| --------------------------- | ------- | -------- |
| `~/.agents/skills/`         | Global  | Lowest   |
| `{project}/.agents/skills/` | Project |          |
| `~/.shofer/skills/`         | Global  |          |
| `{project}/.shofer/skills/` | Project | Highest  |

Plus mode-specific subdirectories: `skills-code/`, `skills-architect/`, etc.

### Creating a Skill

#### Step 1: Create the directory

Create a folder named after your skill inside `.shofer/skills/` (project-level) or `~/.shofer/skills/` (global).

The folder name must be **1–64 characters, lowercase letters, digits, and hyphens only** (e.g., `my-skill`, `eauction-search`).

```
.shofer/skills/
└── my-skill/
    └── SKILL.md
```

XXX: Screenshot showing the .shofer/skills/ directory in the VS Code file explorer with a skill subdirectory expanded to show the SKILL.md file inside.

#### Step 2: Write the SKILL.md file

Create a `SKILL.md` file with YAML frontmatter followed by your instructions:

```markdown
---
name: my-skill
description: Brief description of when to use this skill (1-1024 characters)
modeSlugs:
    - code
    - architect
---

# My Skill

Full instructions that Shofer will follow when this skill is loaded...
```

| Frontmatter Field | Required | Description                                                             |
| ----------------- | -------- | ----------------------------------------------------------------------- |
| `name`            | ✅       | Must match the directory name                                           |
| `description`     | ✅       | 1–1024 characters describing when to use this skill                     |
| `modeSlugs`       | ❌       | List of mode slugs; leave empty or omit to make it available everywhere |

XXX: Screenshot showing a SKILL.md file open in the editor with the YAML frontmatter section visually distinguished from the markdown body below.

#### Step 3: Reload

Shofer watches for changes automatically. The skill appears in the Skills popover within seconds. You can also click the ↻ (Refresh) button in the popover to force a re-scan.

### Using Skills in Practice

#### The Skills Button (🎓)

The 🎓 button in the chat input bar opens a popover showing all available skills:

- **✓ LOADED** — skills already loaded in the current task (green checkmark).
- **Available** — skills grouped by mode restriction, sorted alphabetically.

XXX: Screenshot showing the SkillsButton popover open, with a loaded skill (green checkmark) at top and available skills grouped by mode below, including the ↻ Refresh and ⚙ Settings buttons.

#### How the Model Uses Skills

1. You send a message — Shofer evaluates all skill descriptions against your request.
2. If a skill matches, Shofer calls the `skills` tool to load its full instructions.
3. The skill instructions become part of the conversation, and Shofer follows them precisely.
4. Once loaded, a skill stays loaded for the rest of the task (or until context condensation clears it).

#### Triggering a Skill Manually

There are two ways to manually load a skill:

- **Click the skill in the popover** — this inserts `"Use the <skill-name> skill"` into the chat input. Send the message, and Shofer loads the skill.
- **Type `/skill-name` in the chat** — Shofer recognizes slash-prefixed skill names and loads the skill before processing your message.

XXX: Screenshot showing a message typed in the chat input: "Use the eauction-search skill to find properties in Athens" with the SkillsButton visible in the input bar.

### Approving Skills

When Shofer loads a skill, you'll see an approval prompt in the chat showing the skill name, description, and source (project or global). Click **Accept** to allow the skill to load, or **Reject** to cancel.

If you have auto-approval enabled for the `skills` tool (it's in the always-available tools list), this prompt is skipped and skills load silently.

XXX: Screenshot showing the skill approval chat row — with skill name, description, source badge (project/global), and Accept/Reject buttons.

### Managing Skills

#### Creating a Skill from Settings

Open Settings → Skills to create, rename, or delete skills through the UI. The settings panel lets you:

- Set the skill name, description, and mode restrictions.
- Choose between creating a project-level or global skill.
- Open the created `SKILL.md` file for editing.

#### Deleting or Moving a Skill

From the Skills popover or the Settings panel, you can delete a skill or move it between modes. Deleting removes the skill directory and its `SKILL.md` file. Moving a skill updates the `modeSlugs` in the frontmatter.

### Skill Override Rules

When Shofer discovers multiple skills with the same name:

1. **Project beats global** — if both `.shofer/skills/my-skill/` and `~/.shofer/skills/my-skill/` exist, the project version wins.
2. **Mode-specific beats generic** — `skills-code/my-skill/` overrides `skills/my-skill/` for the Code mode.
3. **First discovered wins** — if two skills have the same priority and specificity, the first one found during scanning wins.

### Quick Reference

| Task                                 | How                                                                         |
| ------------------------------------ | --------------------------------------------------------------------------- |
| See available skills                 | Click the 🎓 button in the chat input bar                                   |
| Create a skill                       | Create a folder + `SKILL.md` in `.shofer/skills/`, or use Settings → Skills |
| Restrict a skill to a mode           | Add `modeSlugs: [code, architect]` to the frontmatter                       |
| Manually load a skill                | Click the skill in the popover, or type `/skill-name` in the chat           |
| Refresh the skill list               | Click ↻ in the Skills popover                                               |
| Delete a skill                       | Settings → Skills, or delete the folder manually                            |
| Override a global skill in a project | Create a skill with the same name in the project's `.shofer/skills/`        |
| Share a skill                        | Copy the skill folder to another machine's `.shofer/skills/` directory      |

---

## 28. Tool Preparation Progress Indicator

When Shofer invokes a tool with a large payload — for example, writing a multi-kilobyte file with `write_to_file` or applying a complex `apply_diff` — the arguments must stream from the AI provider before the tool call can begin. This can take several seconds of silence in the chat.

The **Tool Preparation Progress Indicator** shows you what's happening during this wait. Instead of a blank chat panel, you'll see an inline row with a spinner, the tool name, and a live byte count that updates as data arrives.

<!-- XXX screenshot: the progress row visible in the chat, showing the spinner, tool name in monospace, and right-aligned byte count (e.g., "1.4 KB"). Capture during a large write_to_file operation. -->

### What you'll see

While tool arguments are streaming in, a row appears in the chat:

```
┌──────────────────────────────────────────────┐
│ ◌  Preparing write_to_file…        1.4 KB   │
└──────────────────────────────────────────────┘
```

| Element        | Description                                                                          |
| -------------- | ------------------------------------------------------------------------------------ |
| **Spinner**    | Rotating ring indicator, signaling the tool call is not yet ready                    |
| **Tool name**  | The function being prepared (e.g., `write_to_file`, `apply_diff`, `execute_command`) |
| **Byte count** | How many bytes of arguments have arrived so far — formatted as `B` or `KB`           |

The row **updates in place** — the byte count increases and the spinner continues rotating until the full tool call arrives. Once the tool actually starts executing, the progress row disappears and is replaced by the normal tool call and result display.

### When this appears

The progress indicator shows up whenever a tool call has a non-trivial argument size. This commonly happens during:

- **`write_to_file`** — writing large file contents
- **`apply_diff`** — applying complex patches
- **`execute_command`** — long command strings
- **`new_task`** — detailed subtask instructions

If the tool call arguments are tiny (a few bytes), the row may appear and disappear so quickly you won't notice it. The indicator is designed to be useful precisely when the wait would otherwise be confusing.

<!-- XXX screenshot: side-by-side comparison showing (a) chat with no progress indicator during a long wait vs (b) chat with the progress indicator active. This shows the "before and after" improvement. -->

### What to expect

The progress row is purely informational — it does not require any action from you. If something goes wrong (e.g., the AI provider disconnects), the row simply disappears when the tool call fails, and an error message appears instead.

---

## 29. Parallel Work with Git Worktrees

Shofer lets you run multiple tasks **in parallel** using git worktrees — all inside a single VS Code window. No windows to juggle, no terminal commands to memorize.

### What Are Worktrees?

A git worktree is an additional working copy of your repository on a different branch. Shofer manages them for you: each new parallel task gets its own worktree under `.shofer/worktrees/` so you can work on a feature in one task while a code review or refactor runs in another — with no branch conflicts or file collisions.

### Quick Start

1. Click the **branch chip** in the chat input bar (`WorktreeIndicator`).
 <!-- XXX: Screenshot — chat input bar with the WorktreeIndicator chip highlighted (shows branch name + git status). -->

2. In the popover, click **"Create new worktree…"** .
 <!-- XXX: Screenshot — WorktreeIndicator popover open, pointer hovering over "Create new worktree…" entry at the bottom. -->

3. The **Create Worktree** modal opens with auto-generated branch and path names. Optionally pick a base branch from the searchable dropdown.
 <!-- XXX: Screenshot — CreateWorktreeModal showing auto-generated "worktree/shofer-abc12" branch and ".shofer/worktrees/myproject-xyz89" path, with the base branch dropdown expanded. -->

4. Click **Create**. A progress bar shows files being copied (from `.worktreeinclude`). Once created, a new task spawns automatically in that worktree.
 <!-- XXX: Screenshot — CreateWorktreeModal during creation, showing progress bar with bytes copied and current item name. -->

5. **You now have two tasks running in parallel.** Switch between them in the TaskSelector dropdown — each operates in its own branch with its own working directory.
 <!-- XXX: Screenshot — ChatView showing two tasks in the TaskSelector dropdown, one badge "main" and the other badge "worktree/shofer-abc12". -->

### Switching Between Worktrees

Click the WorktreeIndicator chip → the popover lists every other worktree. Click any entry to **spawn a new parallel task** in that worktree's directory — you stay in the same window.

<!-- XXX: Screenshot — WorktreeIndicator popover showing a list of worktree entries: "feature-login (ahead 3)", "fix-typo (clean)", each clickable. -->

Each task in the TaskSelector shows a **worktree badge** (the branch or directory name) so you can tell them apart at a glance.

<!-- XXX: Screenshot — TaskSelector dropdown with two entries: "Add login page" badge "main", "Refactor auth module" badge "worktree/shofer-abc12". -->

### The `.worktreeinclude` File

When you create a worktree, only tracked git files are present — `node_modules`, `.env`, and build artifacts are **not** copied by default. The `.worktreeinclude` file lets you specify which ignored files to copy automatically.

**How to set it up:**

1. Go to **Settings** → **Worktrees** tab (`WorktreesView`).
2. If your workspace has a `.gitignore` but no `.worktreeinclude`, click **"Create from .gitignore"** .
3. Edit the generated `.worktreeinclude` to keep only the directories you want copied (e.g., `node_modules/`).
 <!-- XXX: Screenshot — WorktreesView settings page showing the ".worktreeinclude status" footer with "Create from .gitignore" button. -->

Only files that appear in **both** `.gitignore` and `.worktreeinclude` are copied — so you never accidentally duplicate tracked source files.

### Managing Worktrees

Open **Settings** → **Worktrees** tab to see all worktrees. From there you can:

- View details: path, branch, commit hash, locked status.
- **Delete** a worktree (removes the directory and optionally the branch). Use **Force Delete** if the worktree has uncommitted changes.
  <!-- XXX: Screenshot — WorktreesView showing a table of worktrees with Delete buttons and a confirmation dialog. -->

The list refreshes every 3 seconds so you always see the latest state.

### Viewing Worktree Status

The WorktreeIndicator chip shows:

- Current branch name
- **Ahead/behind** counts (e.g., "↑3 ↓0" means 3 commits ahead of base)
- **Uncommitted changes** count
- **Last commit** info (hash, subject, author, relative time)
- **Merge readiness** — whether merging the current branch into the base would cause conflicts
  <!-- XXX: Screenshot — WorktreeIndicator popover fully expanded showing the Status section with ahead/behind arrows, "3 files changed (+42, -7)", "Last commit: a1b2c3d Fix login bug (2 hours ago) by Jane", and "Merge into main: no conflicts". -->

### Caveats

| Situation              | What Happens                                                                                                                                                               |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Multi-root workspaces  | Worktrees are **not supported**. Open the repo as a single-folder workspace first.                                                                                         |
| Subfolder workspaces   | Worktrees are disabled unless the subfolder is itself an embedded worktree (i.e., opened from `.shofer/worktrees/`).                                                       |
| Submodules             | `git worktree add` does **not** run `git submodule update --init`. Submodule directories appear empty — initialize them manually.                                          |
| Untracked files        | Only files listed in `.worktreeinclude` are copied. Other untracked files (outside `.gitignore`) are not available in the new worktree.                                    |
| **Merging / Rebasing** | Shofer only provides create, delete, and select operations on worktrees. Merging and rebasing should be done manually for safety — Shofer does not merge, rebase, or push. |
| Untracked files        | Only files listed in `.worktreeinclude` are copied. Other untracked files (outside `.gitignore`) are not available in the new worktree.                                    |

---

## 30. Checkpoints with Nested Git Repositories & Submodules

Shofer automatically saves **checkpoints** as you work — snapshotting your workspace so you can undo, redo, or revert file changes at any point during a task. Checkpoints use a background "shadow" git repository that lives outside your workspace.

Previously, if your workspace contained a **nested git repository** (a submodule, a cloned project inside another project, or a git worktree), checkpoints were disabled with an error:

> Checkpoints are disabled because a nested git repository was detected at: ...

This is no longer the case. Checkpoints now work **transparently** in workspaces that contain nested `.git` directories or git submodules — no errors, no configuration, no limitations.

<!-- XXX: Screenshot — Shofer chat view during an active task with the CheckpointWarning component absent (not shown). The file changes panel is visible with Accept/Revert buttons, demonstrating that checkpoint-based features (diff, revert, redo) work in a workspace that has a nested .git subdirectory. Ideally taken in a workspace like arkware.ai which has extensions/shofer as a git submodule. -->

### What Changed

| Before                                                  | After                                          |
| ------------------------------------------------------- | ---------------------------------------------- |
| Checkpoints blocked with error message                  | Checkpoints initialize silently                |
| Workspace with submodules → no checkpoint functionality | Workspace with submodules → full functionality |
| Manual workaround: relocate nested repos                | No user action required                        |

### What This Means for You

- **No action required.** If you previously saw the "nested git repository" error, it is gone. Checkpoints now initialize normally in the same workspace.
- **All checkpoint features work**: undo file changes per-task, revert to any checkpoint, redo reverted changes, and view diffs.
- **Your workspace is not modified.** The fix operates entirely within Shofer's internal shadow git — your nested repos and submodules are left untouched.

### When This Applies

Your workspace triggers the old detection if it contains any of these:

- A **git submodule** (declared in `.gitmodules`, with a `.git` file pointing to the parent's `.git/modules/` directory).
- A **nested git clone** (a project inside another project, each with its own `.git/`).
- A **git worktree** (created by `git worktree add`, with a `.git` file pointing back to the main repository).

All three cases are handled automatically.

### Verifying Checkpoints Are Working

1. Open a workspace that contains a nested git repository or submodule.
2. Start any Shofer task and make a file edit.
3. Open the **File Changes Panel** — the edited file appears with Accept and Revert buttons.
 <!-- XXX: Screenshot — FileChangesPanel showing a modified file with insertion/deletion counts, Accept (checkmark) and Revert (undo) action buttons visible. This confirms the working-directory backend is functioning. -->
4. Click **Revert** on the file — the file is restored to its pre-edit state. Click **Redo** to re-apply Shofer's edit.

If revert and redo work, checkpoints are functioning correctly.

### Technical Note

Shofer isolates its shadow git from your workspace's git structure by setting the `GIT_DIR` environment variable to point exclusively to the internal checkpoint repository. This prevents git from discovering nested `.git` directories as submodules during checkpoint operations, while leaving your actual workspace git configuration untouched.

---

## 31. Special Files

Shofer recognizes certain files and directories in your project that change how it behaves. Some files control what the AI can see, others add custom instructions or skills, and some are write-protected so the AI cannot accidentally modify them.

### Quick Reference

| File / Directory        | What it does                               | Where to put it                |
| ----------------------- | ------------------------------------------ | ------------------------------ |
| `.shoferignore`         | Hides files from the AI                    | Workspace root                 |
| `.shofermodes`          | Adds custom AI modes for this project      | Workspace root                 |
| `.shofer/rules/`        | Adds rules the AI always follows           | Project or global `~/.shofer/` |
| `.shofer/rules-<mode>/` | Adds rules for a specific mode             | Project or global `~/.shofer/` |
| `.shofer/commands/`     | Adds slash commands                        | Project or global `~/.shofer/` |
| `.shofer/skills/`       | Adds domain-specific skills                | Project or global `~/.shofer/` |
| `.shofer/mcp.json`      | Configures MCP tools for this project      | Workspace `.shofer/` directory |
| `AGENTS.md`             | Instructions injected into the AI's prompt | Workspace root                 |
| `~/.shofer/`            | Global config (applies to all projects)    | Your home directory            |

### Write-Protected Files

The AI **cannot modify** these files without your explicit approval, even if you've enabled auto-approval:

- `.shoferignore`
- `.shofermodes`
- Everything inside `.shofer/`
- `.vscode/settings.json` and friends
- `*.code-workspace` files
- `AGENTS.md`

### `.shoferignore` — Hiding Files from the AI

#### What it does

`.shoferignore` works like `.gitignore`, but instead of git, it controls what files the AI can **read, search, or write to**. Files matching the patterns are invisible to Shofer's tools.

#### Format

Same syntax as `.gitignore` — one pattern per line:

```gitignore
# Hide large binaries
*.zip
*.tar.gz

# Hide secrets
.env
*.key

# Hide generated code
dist/
node_modules/
```

#### What it affects

- **Read tools**: `read_file`, `grep_search`, `list_files`, `find_files` skip ignored files.
- **Write tools**: `write_to_file`, `apply_diff`, `sed` will refuse to touch ignored files.
- **Commands**: Shell commands like `cat`, `grep`, `head` that access ignored files are blocked.
- **File listings**: Ignored files won't appear in the file listing the AI sees each turn.

#### The "Show ignored files" setting

There is a UI toggle in Settings called **"Show .shoferignore'd files in lists and searches."**

- **On (default)**: Ignored files still appear in directory listings but with a 🔒 badge. The AI knows the file exists but can't read it.
- **Off**: Ignored files are completely hidden from listings.

<!-- XXX: Screenshot — Settings panel showing the "Show .shoferignore'd files in lists and searches" toggle, ideally with the 🔒 badge visible in a file listing behind it. -->

### `AGENTS.md` — Custom Instructions

#### What it does

Put an `AGENTS.md` file at the root of your project with instructions, conventions, or rules for the AI. Its contents are injected into the system prompt every time you start a task or switch modes.

#### Example

```markdown
# Project Rules

- Use TypeScript strict mode.
- Prefer async/await over raw Promises.
- Tests must live in `__tests__/` folders alongside source files.
- Never use `any` without a comment explaining why.
```

The AI sees this content under a heading like `# Agent Rules Standard (AGENTS.md)` in its system prompt.

#### File naming

Shofer looks for either `AGENTS.md` or `AGENT.md` (both work).

### `.shofer/rules/` — Mode-Agnostic Rules

#### What it does

Put any text files (`.md`, `.txt`, `.yaml`, etc.) in `.shofer/rules/` and their contents are loaded into the AI's system prompt. These rules apply to **all modes**.

#### Example structure

```
my-project/
└── .shofer/
    ├── rules/
    │   ├── coding-standards.md     ← Always loaded
    │   ├── api-conventions.md      ← Always loaded
    │   └── deployment/
    │       └── staging.md          ← Also loaded (recursive, up to 5 levels)
    └── rules-code/
        └── code-only-rule.md       ← Only in Code mode
```

#### Global vs project

- **Project rules** go in `<project>/.shofer/rules/`.
- **Global rules** go in `~/.shofer/rules/` (applied to every project).

Project rules **override** global rules. If both define the same thing, the project version wins.

### `.shofer/rules-<mode>/` — Mode-Specific Rules

#### What it does

Rules that only apply when a specific mode is active.

| Directory                       | Active in         |
| ------------------------------- | ----------------- |
| `.shofer/rules-code/`           | 💻 Code mode      |
| `.shofer/rules-architect/`      | 🏗️ Architect mode |
| `.shofer/rules-debug/`          | 🪲 Debug mode     |
| `.shofer/rules-ask/`            | ❓ Ask mode       |
| `.shofer/rules-reviewer/`       | 👀 Reviewer mode  |
| (and so on for any custom mode) |                   |

#### Example

Create `.shofer/rules-code/no-eval.md`:

```markdown
# Code Mode Rule

Never use `eval()` or `new Function()`. Use JSON.parse instead.
```

This rule **only** applies when the AI is in Code mode.

### `.shofer/commands/` — Slash Commands

#### What it does

Create `.md` files in `.shofer/commands/` and they become **slash commands** you can type in the chat input. The filename (without `.md`) is the command name.

#### Example

Create `.shofer/commands/deploy.md`:

```markdown
---
description: "Deploy the current project to staging"
argumentHint: "environment name (staging|production)"
mode: "code"
---

# Deploy Instructions

1. Run `npm run build` to compile.
2. Run `npm run deploy -- --env $ARGUMENTS` to push.
3. Verify the deployment by pinging the health endpoint.
```

Now type `/deploy staging` in chat and the AI will follow these steps.

#### Front matter fields

| Field          | Purpose                                                       |
| -------------- | ------------------------------------------------------------- |
| `description`  | What the command does (shown in the command picker)           |
| `argumentHint` | Hint for what arguments to type after the command name        |
| `mode`         | Automatically switch to this mode when the command is invoked |

<!-- XXX: Screenshot — Chat input bar with the slash command palette open, showing `/deploy` and `/lint` as available commands with their descriptions. -->

### `.shofer/skills/` — Project Skills

#### What it does

Skills are reusable instructions for specific tasks. Each skill is a subdirectory containing a `SKILL.md` file.

#### Example structure

```
my-project/
└── .shofer/
    └── skills/
        └── pdf-extractor/
            └── SKILL.md          ← Instructions for extracting data from PDFs
```

#### How they work

1. Shofer discovers skills at startup and lists them in the system prompt.
2. The AI can load a skill on-demand using the `skills` tool.
3. Mode-specific variants go in `.shofer/skills-<mode>/` (e.g., `.shofer/skills-code/`).

#### Global skills

You can also install skills globally at `~/.shofer/skills/` or `~/.agents/skills/` (the Agent Skills standard). Project skills take priority over global ones.

### `.shofer/mcp.json` — Project MCP Configuration

#### What it does

Defines MCP (Model Context Protocol) servers for this project. This file is **automatically git-ignored** by the Shofer extension to prevent committing API keys or credentials.

#### Example

```json
{
	"mcpServers": {
		"filesystem": {
			"command": "npx",
			"args": ["-y", "@anthropic/mcp-server-filesystem", "."],
			"disabled": false,
			"disabledTools": []
		}
	}
}
```

#### When to use

- You want MCP tools available in this specific project.
- You're installing an MCP server from the Shofer Marketplace.

For global MCP servers (available in all projects), use the Settings UI instead.

### `.shofermodes` — Custom Modes

#### What it does

Define your own AI modes for a project. Modes control which tools the AI can use, what instructions it follows, and how it behaves.

#### Example

```yaml
customModes:
    - slug: "documentation"
      name: "📝 Tech Writer"
      roleDefinition: "You are a technical writer producing clear, concise documentation."
      customInstructions: |
          Follow the Google Developer Documentation Style Guide.
          Use sentence case for headings.
      groups: ["read", ["write", { fileRegex: "\\.(md|txt)$", description: "Docs only" }]]
      tools_allowed: ["update_todo_list"]
```

#### Key fields

| Field                | Purpose                                            |
| -------------------- | -------------------------------------------------- |
| `slug`               | Unique ID (use `documentation`, not `📝 docs`)     |
| `name`               | Display name with emoji                            |
| `roleDefinition`     | Tells the AI what it is ("You are a tech writer…") |
| `groups`             | Which tool groups the mode can use                 |
| `tools_allowed`      | Extra tools beyond the groups                      |
| `tools_denied`       | Tools to explicitly block                          |
| `customInstructions` | Extra rules for this mode                          |

#### Global vs project

- **Project modes** defined in `.shofermodes` at the workspace root override global modes with the same slug.
- **Global modes** are managed through the Settings UI (stored as `custom_modes.yaml`).

The project file wins when both define a mode with the same slug.

### File Discovery Order

Shofer loads configuration in this order (later overrides earlier):

1. **Global** `~/.shofer/` (applies to all projects)
2. **Project** `<workspace>/.shofer/` (overrides global)
3. **Subfolder** `<workspace>/<subdir>/.shofer/` (when enabled, processed alphabetically)

### Legacy Files (Still Supported)

These older filenames still work but will be removed in the future. Migrate to the modern equivalents:

| Old File                  | Move To                 |
| ------------------------- | ----------------------- |
| `.rooignore`              | `.shoferignore`         |
| `.roorules`               | `.shofer/rules/`        |
| `.roorules-<mode>`        | `.shofer/rules-<mode>/` |
| `.clinerules`             | `.shofer/rules/`        |
| `.clinerules-<mode>`      | `.shofer/rules-<mode>/` |
| `cline_mcp_settings.json` | `.shofer/mcp.json`      |

---

## 32. Privacy & Telemetry

Shofer collects **anonymous usage data** to help us understand how you use the extension — which features are popular, where errors happen, and how to improve performance. **We never collect your code, prompts, or personally identifiable information.**

### What We Collect

Telemetry captures **anonymous product signals** only:

| Data                | Example                                 | Purpose                   |
| ------------------- | --------------------------------------- | ------------------------- |
| Machine ID          | `vscode.env.machineId`                  | Anonymous user counting   |
| App version         | `1.2.3`                                 | Feature adoption tracking |
| VS Code version     | `1.95.0`                                | Compatibility analysis    |
| Platform            | `linux`, `darwin`                       | OS usage distribution     |
| Language            | `en`, `ko`                              | Localization planning     |
| Mode                | `code`, `architect`                     | Mode usage patterns       |
| Provider & model    | `openrouter/claude-sonnet-4-5`          | Provider popularity       |
| Tool names          | `read_file`, `apply_diff`               | Tool usage patterns       |
| Token counts & cost | `input: 4200, output: 850, cost: $0.03` | Usage and cost analysis   |
| Error messages      | (sanitized)                             | Bug detection             |
| Task ID             | (opaque UUID)                           | Session correlation       |

### What We NEVER Collect

- **Code or file contents** — never sent
- **AI prompts or responses** — excluded
- **Repository URLs, names, or branch names** — filtered out
- **Personally identifiable information** — not collected
- **Your shell command output** — never included

### Opting In or Out

#### First Launch

When you first open Shofer, a **telemetry banner** appears at the top of the chat area:

<!-- XXX: Screenshot — Telemetry banner at the top of ChatView showing the privacy message with "Accept" and "Dismiss" buttons. -->

- **Accept** — telemetry is enabled. You can change your mind later.
- **Dismiss** — telemetry stays disabled. You can enable it later in Settings.

If you dismiss without choosing, telemetry remains **disabled** until you explicitly turn it on.

#### Changing Your Choice Later

Open **Settings** (gear icon in the Shofer title bar) and go to the **Notifications** section:

<!-- XXX: Screenshot — SettingsView scrolled to the Notification Settings section showing the "Telemetry" toggle with label "Share anonymous usage data to help improve Shofer". -->

Toggle **"Share anonymous usage data"** on or off. Changes take effect immediately — no restart needed.

#### VS Code Global Telemetry Level

Shofer also respects the **VS Code global telemetry level** (`telemetry.telemetryLevel` in VS Code settings). If you set this to anything other than `"all"`, Shofer telemetry is **fully disabled** regardless of the Shofer-specific toggle.

### How It Works

Shofer uses **PostHog** (`posthog-node` in the extension host, `posthog-js` in the webview) as its analytics backend. Events are sent to `https://ph.shofer.dev`.

<!-- XXX: Screenshot — Architecture diagram showing Extension Host (TelemetryService → PostHogTelemetryClient → ph.shofer.dev) and Webview (TelemetryClient → posthog-js → ph.shofer.dev) with a privacy-filter overlay on the extension host path. -->

#### The Kill Switch

A `TELEMETRY_ENABLED` environment variable acts as a **global kill switch**. When set to anything other than `true`, the entire telemetry subsystem is disabled at startup — no client is initialized, no data is collected, no network calls are made.

### What Events Are Tracked

We track a focused set of product events. Each event carries only the data described above — no code, no prompts, no file contents.

| Category            | Examples                                                                                                |
| ------------------- | ------------------------------------------------------------------------------------------------------- |
| **Task lifecycle**  | Task created, task completed                                                                            |
| **LLM usage**       | API completions (token counts, cost, provider/model)                                                    |
| **Tool usage**      | `read_file`, `execute_command`, `apply_diff`, etc.                                                      |
| **Mode changes**    | Switching between Code, Architect, Debug, etc.                                                          |
| **UI interactions** | Tab switches, title bar button clicks, marketplace installs                                             |
| **Errors**          | Schema validation errors, diff application errors, rate limits (402/429 are **not** reported as errors) |

### Errors & Crash Reporting

When things go wrong, Shofer captures **error type and context** only — never your code or prompts:

- **API errors**: provider name, model ID, HTTP status code, sanitized error message
- **Tool errors**: which tool failed and why (e.g., diff application error with mistake count)
- **Webview errors**: React error boundary catches with component stack traces (UI code only)

The following errors are **intentionally excluded** because they're normal:

- Payment/billing errors (HTTP 402)
- Rate limit errors (HTTP 429)
- Any error message containing "rate limit"

### Data Retention

Telemetry events are retained for product analytics purposes and are not shared with third parties. Telemetry is **off by default** and requires explicit opt-in.

---

## 33. Migrating from Roo-Code to Shofer

Roo-Code is [sunsetting its VS Code Extension, Cloud, and Router services on May 15, 2026](https://github.com/RooCodeInc/Roo-Code). Shofer is a major improvement over Roo-Code, with a significant architectural overhaul and dozens of new features.

This section helps Roo-Code users understand what changed and how to use the new capabilities. If you are new to both tools, start with [Section 1](#1-ui--concepts-guide).

### Quick Differences at a Glance

| Area                     | Roo-Code                              | Shofer                                                   |
| ------------------------ | ------------------------------------- | -------------------------------------------------------- |
| **Tasks**                | One task at a time                    | Multiple concurrent tasks in parallel                    |
| **Sub-tasks**            | Blocks parent until done              | Background tasks run independently; parent polls results |
| **Default mode**         | Architect                             | Code                                                     |
| **Auto-approval label**  | "BRRR" (YOLO)                         | "All"                                                    |
| **File change tracking** | Git shadow-repo                       | Working-directory snapshots (no git dependency)          |
| **Message queuing**      | Messages lost while busy              | Queue with Send Now button                               |
| **Checkpoints**          | Disabled with nested repos            | Works everywhere via `GIT_DIR` isolation                 |
| **Worktrees**            | Separate VS Code window per worktree  | Embedded worktree management in one window               |
| **Drag & Drop**          | Alt-key based (unreliable on Desktop) | Dedicated drop zone with removable tags                  |
| **Skills loading**       | Manual, forgets on switch             | Persisted per-task, auto-rehydrated                      |

### Parallel Tasks

<!-- XXX screenshot: TaskSelector dropdown showing 4 tasks — one running (green pulse), one paused (orange), one completed (green checkmark), one errored (red) — with parent-child indentation visible -->

Shofer supports multiple independent conversations running at the same time. Each task has its own LLM conversation, tool approvals, mode, and history — just like having multiple Copilot sessions open.

**What this means for you:**

- Start a new task without losing your current one. The current task moves to the background.
- Switch between tasks freely from the **TaskSelector** dropdown at the top of the chat. Background tasks keep running.
- Each task shows a colored state badge: green (running), orange (paused), blue (waiting), green checkmark (completed), red (error).
- When a background task needs your approval or finishes, you get a notification.

### Background (Async) Sub-tasks

The LLM can now delegate work to background children that run concurrently. The parent continues its own work and polls results via `wait_for_task` or `check_task_status`.

<!-- XXX screenshot: chat row showing a wait_for_task result with 3 subtask status badges (2 completed green, 1 running with spinner) -->

**Key tools:**

- **`new_task`** with `is_background: true` — spawns a child that runs independently
- **`check_task_status`** — query a child's current state without blocking
- **`wait_for_task`** — block until one or more children finish (supports `all` / `any` strategies)
- **`list_background_tasks`** — list all running children
- **`cancel_tasks`** — stop one or more children early

Canceling a parent automatically cancels all its background children.

### TaskSelector & Task Management

<!-- XXX screenshot: TaskSelector panel showing the parent-child tree with pinned task at top, archive toggle expanded, and state badges visible on every row -->

The TaskSelector (visible when no task is active) lets you organize your work:

| Action      | Description                                        |
| ----------- | -------------------------------------------------- |
| **Pin**     | Keep a task at the top of the list                 |
| **Archive** | Hide from main list (accessible via filter toggle) |
| **Export**  | Download as Markdown (`.md`) or JSON (`.json`)     |

### Message Queue & Send Now

When a task is busy processing an LLM response, typing another message no longer loses it. Instead, the message enters a FIFO queue.

<!-- XXX screenshot: QueuedMessages section visible above the chat input, showing "2 messages queued" with a Send Now button -->

- **Queue** — Messages typed while busy are enqueued and shown in a collapsible "Queued Messages" section.
- **Send Now** — Forces the current turn to cancel and immediately restarts with the queued message. The canceled output is preserved in chat history.
- **Per-task drafts** — Unsent text in the chat input is saved per task. Switching tasks restores that task's draft. New tasks start with a clean slate.

### File Changes Panel

<!-- XXX screenshot: FileChangesPanel expanded showing 3 modified files with Accept/Revert buttons per file and Accept All/Revert All at the top -->

Shofer tracks every file your task modifies. The **File Changes Panel** (collapsible, below the chat) shows all modified files with:

- **Accept** — promote the change to the persistent baseline
- **Revert** — restore the original content

There is no git shadow-repository dependency. File changes are stored as snapshots in the extension's storage directory, so nested repos, worktrees, and submodules never cause conflicts.

### Drag & Drop Context Files

<!-- XXX screenshot: chat input area with 3 file tags ("src/auth.ts", "README.md", "package.json") shown above the text input, each with an X button to remove -->

Drag files from your file explorer into the dedicated drop zone. They appear as removable tags above the chat input and are prepended as `@mentions` when sent, making file context explicit for the LLM.

### Auto-Approval & Tool Categories

Every tool belongs to exactly one of 9 categories: **read**, **write**, **execute**, **browser**, **mcp**, **mode**, **subtasks**, **questions**, or **uncategorized**.

<!-- XXX screenshot: AutoApproveDropdown expanded showing toggle switches for read, write, execute, browser, mcp — with read and mcp toggled on, the rest off -->

The **AutoApproveDropdown** in the chat input bar shows toggle switches for each category relevant to your current mode. Toggle a category on, and the LLM can use those tools without asking for approval.

### Skills System

<!-- XXX screenshot: SkillsButton popover showing 4 loaded skills with descriptions ("eauction-search — Search properties on eauction.gr"), each with an "Open SKILL.md" button, plus an "Available Skills" section below -->

Skills provide domain-specific instructions to the LLM. Access them via the **Skills** button (🎓) in the chat input bar.

- **Commands** and **Skills** buttons open popovers listing all available options.
- Loaded skills are persisted in task history. When you switch back to a task, its skills are re-loaded automatically.
- The SkillsButton shows which skills are currently active.

### Modes & Tool Access

<!-- XXX screenshot: ModeSelector dropdown showing all 5 built-in modes (Code, Architect, Ask, Debug, Orchestrator) plus any custom modes, with Code selected -->

Choose a mode from the **ModeSelector** dropdown in the chat input bar. Each mode controls which tool groups are available and the LLM's role definition.

- Each task has its own mode, sticky for its lifetime.
- Switching tasks restores that task's mode.
- Custom modes can be defined via `.shofermodes` files (project-level or global).

### Native Worktrees

Worktrees are managed within the same Shofer session — no need for separate VS Code windows.

<!-- XXX screenshot: WorktreeIndicator chip in the chat input bar showing branch name "feature/new-api", green "clean" status, and ahead/behind counts -->

A chip in the chat input bar shows the current worktree branch name and git status (dirty/clean, commits ahead/behind). Click it to open worktree management.

### Task Export

Export any task in two formats from the TaskActions menu:

<!-- XXX screenshot: TaskActions dropdown showing "Export as Markdown" and "Export as JSON" options -->

| Format               | Use case                                                    |
| -------------------- | ----------------------------------------------------------- |
| **Markdown** (`.md`) | Readable transcript with tool calls, results, and reasoning |
| **JSON** (`.json`)   | Machine-readable trace for programmatic analysis or replay  |

### Cost Tracking & Limits

<!-- XXX screenshot: TaskHeader showing "$0.42 / $5.00 limit" with a green ContextWindowProgress bar at 35% -->

Every API call's token usage and USD cost are tracked and shown in the **TaskHeader**. You can set a per-task USD spend cap. When reached, the task is automatically paused (asking you to raise the limit) or aborted.

Parent tasks show the cumulative cost of all descendant sub-tasks, not just their own API calls.

### Provider Improvements

#### Reasoning / Thinking Blocks

<!-- XXX screenshot: collapsible ReasoningBlock in chat showing "Thinking…" header, expanded to reveal model reasoning text -->

Models that support reasoning/thinking (including GitHub Copilot models via the VS Code LM API) now surface their reasoning as collapsible blocks in chat.

#### Tool Preparing Progress

<!-- XXX screenshot: ProgressIndicator spinner row in chat showing "Preparing apply_diff… 1.2 KB" while arguments stream in -->

While the LLM streams tool call arguments, an inline progress row shows the tool name and byte count. You know something is happening before the tool executes.

### Cancellation Flow

The Stop button is always responsive — even during streaming, reasoning, or tool execution. Stop propagates end-to-end: from the webview through the task loop, API handler, and all the way to MCP server tool executions, aborting them immediately.

### Submodule & Nested Git Support

Checkpoints work transparently in repositories with submodules or nested `.git` directories. Shofer uses `GIT_DIR` environment variable isolation instead of requiring a single top-level `.git` directory. The "nested git detected" warnings from Roo-Code are gone.

### UI/UX Changes from Roo-Code Defaults

| Change                                    | Why                                                            |
| ----------------------------------------- | -------------------------------------------------------------- |
| **Default mode: Architect → Code**        | Code mode is the primary use case                              |
| **BRRR → All auto-approval label**        | Clearer, more professional naming                              |
| **Background editing enabled by default** | Background diffs are now the standard editing experience       |
| **API request row auto-hides**            | Reduces chat clutter; only persists on errors or cancellations |

### External LM Tool Providers

Shofer supports tools from companion VS Code extensions (like `arkware-vscode-tools` and `arkware-browser-tools`). These tools are discovered dynamically, participate in the auto-approval system, and render in chat with the same visual treatment as native tools.

### Where to Go Next

- [Section 7: Native Tools Reference](#7-native-tools-reference) — all 50+ tools with parameters
- [Section 2: Settings](#2-settings) — VS Code settings
- [Section 27: Skills](#27-skills) — creating and using skills
- [Section 27: Skills](#27-skills) — creating and using skills
- [Section 20: Queued Messages](#20-queued-messages-send-now-and-per-task-drafts) — queue, Send Now, and drafts in detail

---

## 34. Migrating from GitHub Copilot

If you're coming from GitHub Copilot, Shofer offers everything Copilot does and much more — with full privacy and model autonomy.

### Key Differences

- **You own the models** — use Anthropic, OpenRouter, DeepSeek, or local models via Ollama
- **You own the infrastructure** — everything runs locally, including semantic indexing
- **Your code stays local** — or to the provider of your choice, no vendor lock-in
- **Higher degree of customization** — adjust every aspect exactly to your needs
- **Open-source and community-driven** — contribute and shape the future of Shofer
- **Cost control** — set per-task cost limits and monitor usage
- **Share context across sessions** — using Shofer's Assistant Agent feature
- **Git log indexing** — for better understanding of code history and rationale
- **Fine-grained tool access control** — via customizable modes and auto-approval settings
- **Leverage git worktrees** — to keep parallel tasks separate across multiple branches and PRs

### Quick Start for Copilot Users

Run the `/migrate-from-copilot` slash command to automatically migrate your existing Copilot configuration (`.github/copilot-instructions.md`, agents, skills, instructions) to Shofer equivalents.

[Read the full Copilot → Shofer guide](https://github.com/shofer-dev/shofer/blob/master/docs/shofer_for_copilot_users.md)

---

## 35. Community

- **[Discord](https://discord.gg/x39UEEQ2)** — Chat with the team, get help, share feedback
- **[Reddit](https://reddit.com/r/Shofer_dev)** — Community discussions and tips
- **[GitHub Discussions](https://github.com/shofer-dev/shofer/discussions)** — Feature requests and ideas
- **[GitHub Issues](https://github.com/shofer-dev/shofer/issues)** — Bug reports and tracking

Shofer is open source (Apache 2.0). Contributions are welcome — read [`CONTRIBUTING.md`](https://github.com/shofer-dev/shofer/blob/main/CONTRIBUTING.md) and check the [roadmap](https://github.com/orgs/shofer/projects/1).- [Section 20: Queued Messages](#20-queued-messages-send-now-and-per-task-drafts) — queue, Send Now, and drafts in detail
