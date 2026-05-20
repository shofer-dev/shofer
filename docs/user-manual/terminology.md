# Shofer UI & Concepts Guide

This guide explains the names and purposes of every part of Shofer's interface so you can navigate it confidently and communicate clearly about what you see.

---

## The Main Chat Screen

When you open Shofer and start a new task, the main chat screen fills the sidebar or editor tab.

<!-- XXX: Full screenshot of the chat screen with the header, message list, and input bar visible. Annotate each labeled element with a numbered callout matching the sections below. -->

### 1. Task Header (Top Bar)

The **Task Header** sits above your conversation. It shows:

| Element                      | What It Does                                                                                                                                                  |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Task Selector** (dropdown) | Lists all your tasks. Colored dots show each task's current state (green = running, yellow = waiting for you, gray = idle). Use this to switch between tasks. |
| **Task Actions** (buttons)   | Archive, pin, export (JSON or Markdown), or delete the current task.                                                                                          |
| **Context Window Bar**       | A horizontal progress bar that fills up as your conversation approaches the model's token limit.                                                              |
| **Todo List**                | The current task's checklist of steps (if one was created). Check off items as they're completed.                                                             |

<!-- XXX: Close-up of the Task Header, highlighting: the Task Selector dropdown with colored dots, the context window bar, and a sample todo list. -->

### 2. Chat Input Bar (Bottom)

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

<!-- XXX: Close-up of the Chat Input Bar with all controls annotated. Show the Mode Selector expanded to reveal all 9 built-in modes. -->

### 3. Message History

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

---

## Modes

The **Mode** determines what Shofer is allowed to do and how it behaves. You select a mode via the **Mode Selector** in the Chat Input Bar.

| Mode             | Icon | Best For                                                         |
| ---------------- | ---- | ---------------------------------------------------------------- |
| **Code**         | 💻   | Writing, modifying, and refactoring code.                        |
| **Architect**    | 🏗️   | Planning and designing before writing any code.                  |
| **Ask**          | ❓   | Getting explanations, answers, or recommendations.               |
| **Debug**        | 🪲   | Troubleshooting errors and diagnosing root causes.               |
| **Reviewer**     | 👀   | Reviewing code for issues without making changes.                |
| **Search**       | 🔎   | Searching the codebase for specific information.                 |
| **Opinion**      | 💭   | Getting an expert opinion on technology choices or architecture. |
| **Browser**      | 🌐   | Web browsing, research, and data extraction.                     |
| **Orchestrator** | 🪃   | Coordinating complex multi-step work by delegating to sub-tasks. |

Custom modes can be created via [`.shofermodes` files](#special-workspace-files).

<!-- XXX: Screenshot of the Mode Selector dropdown showing all modes with their icons. -->

---

## Task States

Every task has a **lifecycle state** shown as a colored dot next to the task name in the **Task Selector**.

| Dot Color | State         | Meaning                                                              |
| --------- | ------------- | -------------------------------------------------------------------- |
| Gray      | **Idle**      | The task is not currently active.                                    |
| Green     | **Running**   | Shofer is actively processing — an API call or tool is in progress.  |
| Yellow    | **Waiting**   | Shofer needs your input — an approval dialog or question is waiting. |
| Orange    | **Paused**    | You manually paused the task. It will not resume until unpaused.     |
| ✅ Green  | **Completed** | The task finished successfully.                                      |
| ⚠️ Red    | **Error**     | The task stopped due to an error.                                    |

<!-- XXX: Screenshot of the Task Selector dropdown showing multiple tasks with different colored dots, annotated with the state name next to each dot. -->

### Cost Limits

You can set a USD budget cap on any root task. When the cap is reached, Shofer will:

- **Pause** — hold the task and ask if you want to increase the limit.
- **Abort** — stop the task gracefully.
- **Kill** — stop the task immediately.

---

## Queued Messages

If you type a message while Shofer is still processing, your message goes into a **message queue** (shown as a collapsible section above the input bar). When Shofer finishes its current work, it automatically reads the next message from the queue.

You can also click **Send Now** to cancel Shofer's current work and jump to your queued message immediately.

<!-- XXX: Screenshot showing the QueuedMessages section with two messages waiting, and the "Send Now" button visible. -->

---

## Files Changed Panel

When Shofer modifies files in your workspace, the **File Changes Panel** appears above the input bar. It lists each modified file with:

- **+N / -N** line counts
- **Accept** button — keep the change.
- **Revert** button — undo the change.
- **Show Diff** — open a side-by-side diff view.

You can also **Accept All** or **Revert All** at once.

<!-- XXX: Screenshot of the File Changes Panel showing three modified files with diff stats, and the Accept/Revert buttons per file. -->

---

## Panel Title Bar Buttons

The VS Code title bar of the Shofer panel has these native icons (not part of the webview):

| Button               | Icon          | What It Does                                                                   |
| -------------------- | ------------- | ------------------------------------------------------------------------------ |
| **Plus**             | ✏️ Edit       | Start a new task (current task moves to background).                           |
| **Tasks**            | 🌳 Tree       | Open the parallel-tasks drawer.                                                |
| **Settings**         | ⚙️ Gear       | Open the settings panel.                                                       |
| **Marketplace**      | 🧩 Extensions | Open the marketplace (if enabled).                                             |
| **⋯ (More Actions)** | —             | Opens a menu containing **History** and **Popout** (open in a new editor tab). |

---

## Special Workspace Files

Drop these files into your project's root to customize Shofer's behavior:

| File               | Purpose                                                                                         |
| ------------------ | ----------------------------------------------------------------------------------------------- |
| `.shoferignore`    | Tell Shofer to never read, search, or index specific files or folders. Works like `.gitignore`. |
| `.shofermodes`     | Define custom modes with their own tool permissions and instructions. Supports YAML or JSON.    |
| `.shoferprotected` | Mark files/directories that Shofer needs explicit approval to modify.                           |
| `.shofer/rules/`   | Additional rules and prompts loaded into Shofer's system prompt.                                |
| `.shofer/skills/`  | Skill definition files (`SKILL.md`) for specialized per-domain instructions.                    |

<!-- XXX: File-tree screenshot showing a project root with .shoferignore, .shofermodes, and .shofer/rules/ directory highlighted. -->

---

## API Provider Profiles

An **API Provider Profile** bundles your API key, model selection, and endpoint URL into a named configuration. You can create multiple profiles (e.g., "openrouter", "deepseek", "local-ollama") and switch between them via the **API Config Selector** dropdown.

| Concept                | What It Means                                                                                                                 |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **Sticky Profile**     | Each task remembers the profile it was started with. Switching tasks restores that task's profile.                            |
| **Sticky Mode**        | Each task remembers the mode it was started with. Switching tasks restores that task's mode.                                  |
| **Lock API Config**    | Prevents Shofer from switching profiles on its own (feature flag).                                                            |
| **Prompt Enhancement** | The ✨ button next to the chat input sends your draft through a quick LLM pass to improve clarity before Shofer processes it. |

<!-- XXX: Screenshot of the API Config Selector dropdown showing multiple saved profiles, with one marked as active. -->

---

## Quick Reference

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
