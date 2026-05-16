# Shofer Terminology

This document establishes canonical names for the Shofer extension's UI components, architectural concepts, data types, and protocols. Use these names when communicating about the codebase so that references are unambiguous.

---

## Table of Contents

1. [UI Components — Chat Area](#1-ui-components--chat-area)
2. [UI Components — Task Management](#2-ui-components--task-management)
3. [UI Components — Sidebar & Navigation](#3-ui-components--sidebar--navigation)
4. [UI Components — Panels & Overlays](#4-ui-components--panels--overlays)
5. [Architecture — Extension Host (Backend)](#5-architecture--extension-host-backend)
6. [Architecture — Webview (Frontend)](#6-architecture--webview-frontend)
7. [Data Types & Schemas](#7-data-types--schemas)
8. [IPC Protocol](#8-ipc-protocol)
9. [Tools — Canonical Names](#9-tools--canonical-names)
10. [Tool Groups (Categories)](#10-tool-groups-categories)
11. [Modes](#11-modes)
12. [Task States & Lifecycle](#12-task-states--lifecycle)
13. [Special Files & Directories](#13-special-files--directories)
14. [API Provider Concepts](#14-api-provider-concepts)

---

## 1. UI Components — Chat Area

The chat area is the primary interface shown when a task is active. It occupies the main area of the Shofer sidebar or editor tab.

| Canonical Name              | File                                                                                           | Description                                                                                                         |
| --------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| **ChatView**                | [`ChatView.tsx`](../webview-ui/src/components/chat/ChatView.tsx)                               | The main chat container. Owns message history (`shoferMessages`), scroll position, image state, and dialog state.   |
| **ChatTextArea**            | [`ChatTextArea.tsx`](../webview-ui/src/components/chat/ChatTextArea.tsx)                       | The chat input bar at the bottom. Contains the text input, Send/Stop buttons, and all toolbar controls.             |
| **ChatRow**                 | [`ChatRow.tsx`](../webview-ui/src/components/chat/ChatRow.tsx)                                 | A single message row rendered in the chat history. Handles all message types: say, ask, tool calls, reasoning, etc. |
| **TaskHeader**              | [`TaskHeader.tsx`](../webview-ui/src/components/chat/TaskHeader.tsx)                           | The header bar above the chat messages. Shows task name, token usage, cost, context window bar, and todo list.      |
| **ModeSelector**            | [`ModeSelector.tsx`](../webview-ui/src/components/chat/ModeSelector.tsx)                       | Dropdown in the chat input bar for selecting/switching the current mode (e.g., Code, Architect, Debug).             |
| **ApiConfigSelector**       | [`ApiConfigSelector.tsx`](../webview-ui/src/components/chat/ApiConfigSelector.tsx)             | Dropdown in the chat input bar for choosing the API provider profile (e.g., "openrouter", "deepseek").              |
| **AutoApproveDropdown**     | [`AutoApproveDropdown.tsx`](../webview-ui/src/components/chat/AutoApproveDropdown.tsx)         | Dropdown in the chat input bar that shows auto-approval category toggles scoped to the current mode.                |
| **CommandsButton**          | [`CommandsButton.tsx`](../webview-ui/src/components/chat/CommandsButton.tsx)                   | Button in the chat input bar that opens a popover listing slash commands.                                           |
| **SkillsButton**            | [`SkillsButton.tsx`](../webview-ui/src/components/chat/SkillsButton.tsx)                       | Button (🎓) in the chat input bar that opens a popover showing loaded and available skills.                         |
| **WorktreeIndicator**       | [`WorktreeIndicator.tsx`](../webview-ui/src/components/chat/WorktreeIndicator.tsx)             | Chip in the chat input bar showing the current worktree branch and git status (dirty/clean).                        |
| **IndexingStatusBadge**     | [`IndexingStatusBadge.tsx`](../webview-ui/src/components/chat/IndexingStatusBadge.tsx)         | Badge in the chat input bar showing code index status (Standby/Indexing/Indexed/Error).                             |
| **HelperAgentStatusBadge**  | [`HelperAgentStatusBadge.tsx`](../webview-ui/src/components/chat/HelperAgentStatusBadge.tsx)   | Badge showing helper agent status.                                                                                  |
| **ContextWindowProgress**   | [`ContextWindowProgress.tsx`](../webview-ui/src/components/chat/ContextWindowProgress.tsx)     | Horizontal bar in TaskHeader showing how much of the model's context window is used.                                |
| **ReasoningBlock**          | [`ReasoningBlock.tsx`](../webview-ui/src/components/chat/ReasoningBlock.tsx)                   | A collapsible block showing the model's reasoning/thinking content (streamed before the final response).            |
| **Markdown**                | [`Markdown.tsx`](../webview-ui/src/components/chat/Markdown.tsx)                               | Markdown-to-HTML renderer used for all message content. Handles code blocks, tables, and syntax highlighting.       |
| **ProgressIndicator**       | [`ProgressIndicator.tsx`](../webview-ui/src/components/chat/ProgressIndicator.tsx)             | "Tool preparing…" spinner shown while the LLM streams tool call arguments.                                          |
| **ErrorRow**                | [`ErrorRow.tsx`](../webview-ui/src/components/chat/ErrorRow.tsx)                               | Chat row rendered for errors.                                                                                       |
| **WarningRow**              | [`WarningRow.tsx`](../webview-ui/src/components/chat/WarningRow.tsx)                           | Chat row rendered for warnings (e.g., retired provider, profile violations).                                        |
| **ProfileViolationWarning** | [`ProfileViolationWarning.tsx`](../webview-ui/src/components/chat/ProfileViolationWarning.tsx) | Warning row shown when profile thresholds are violated (tool count, cost, requests).                                |
| **CheckpointWarning**       | [`CheckpointWarning.tsx`](../webview-ui/src/components/chat/CheckpointWarning.tsx)             | Warning indicator when checkpoint initialization times out.                                                         |
| **TodoListDisplay**         | [`TodoListDisplay.tsx`](../webview-ui/src/components/chat/TodoListDisplay.tsx)                 | Todo list rendered in the TaskHeader, showing current task's todos with completion toggles.                         |
| **TodoChangeDisplay**       | [`TodoChangeDisplay.tsx`](../webview-ui/src/components/chat/TodoChangeDisplay.tsx)             | Inline display of a todo list change (add/remove/update) as a chat message.                                         |
| **Mention**                 | [`Mention.tsx`](../webview-ui/src/components/chat/Mention.tsx)                                 | Renders `@file/path` and `@folder/path` mentions as clickable links that open the referenced resource.              |
| **ContextMenu**             | [`ContextMenu.tsx`](../webview-ui/src/components/chat/ContextMenu.tsx)                         | Autocomplete/mention suggestion dropdown triggered by typing `@` in the chat input.                                 |
| **Thumbnails**              | [`Thumbnails.tsx`](../webview-ui/src/components/common/Thumbnails.tsx)                         | Image thumbnail strip shown above the chat input when images are attached. Supports delete.                         |
| **Announcement**            | [`Announcement.tsx`](../webview-ui/src/components/chat/Announcement.tsx)                       | Dismissible announcement banner shown at the top of ChatView.                                                       |

---

## 2. UI Components — Task Management

Components related to viewing, switching, and managing multiple tasks.

| Canonical Name              | File                                                                                                                       | Description                                                                                                                                                     |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **TaskSelector**            | [`TaskSelector.tsx`](../webview-ui/src/components/chat/TaskSelector.tsx)                                                   | Dropdown in TaskHeader that lists all tasks with state indicators (colored dots), notification badges, parent-child hierarchy, archive toggle, and pin support. |
| **TaskActions**             | [`TaskActions.tsx`](../webview-ui/src/components/chat/TaskActions.tsx)                                                     | Action buttons in the TaskHeader: archive, pin, export (JSON/Markdown), delete.                                                                                 |
| **TaskNotification**        | [`TaskNotification.tsx`](../webview-ui/src/components/tasks/TaskNotification.tsx)                                          | Popup/toast notification shown when a background task needs input, completes, or errors.                                                                        |
| **QueuedMessages**          | [`QueuedMessages.tsx`](../webview-ui/src/components/chat/QueuedMessages.tsx)                                               | Collapsible section showing queued messages waiting to be sent (when task is busy processing).                                                                  |
| **HistoryView**             | [`HistoryView.tsx`](../webview-ui/src/components/history/HistoryView.tsx)                                                  | Full task history view with search, batch delete, copy, and export.                                                                                             |
| **HistoryPreview**          | [`HistoryPreview.tsx`](../webview-ui/src/components/history/HistoryPreview.tsx)                                            | Collapsed preview of recent task history shown when no task is active.                                                                                          |
| **TaskItem**                | [`TaskItem.tsx`](../webview-ui/src/components/history/TaskItem.tsx)                                                        | Single task row in HistoryView.                                                                                                                                 |
| **TaskGroupItem**           | [`TaskGroupItem.tsx`](../webview-ui/src/components/history/TaskGroupItem.tsx)                                              | Grouping row in HistoryView (e.g., "Today", "Yesterday").                                                                                                       |
| **SubtaskRow**              | [`SubtaskRow.tsx`](../webview-ui/src/components/history/SubtaskRow.tsx)                                                    | Indented subtask row in HistoryView.                                                                                                                            |
| **SubtaskCollapsibleRow**   | [`SubtaskCollapsibleRow.tsx`](../webview-ui/src/components/history/SubtaskCollapsibleRow.tsx)                              | Collapsible parent row showing its subtasks underneath.                                                                                                         |
| **BatchDeleteTaskDialog**   | [`BatchDeleteTaskDialog.tsx`](../webview-ui/src/components/history/BatchDeleteTaskDialog.tsx)                              | Confirmation dialog for batch-deleting tasks.                                                                                                                   |
| **DeleteTaskDialog**        | [`DeleteTaskDialog.tsx`](../webview-ui/src/components/history/DeleteTaskDialog.tsx)                                        | Confirmation dialog for deleting a single task.                                                                                                                 |
| **DeleteMessageDialog**     | [`MessageModificationConfirmationDialog.tsx`](../webview-ui/src/components/chat/MessageModificationConfirmationDialog.tsx) | Dialog confirming deletion of a message (may offer checkpoint restore).                                                                                         |
| **EditMessageDialog**       | [`MessageModificationConfirmationDialog.tsx`](../webview-ui/src/components/chat/MessageModificationConfirmationDialog.tsx) | Dialog for editing a user message.                                                                                                                              |
| **CheckpointRestoreDialog** | [`CheckpointRestoreDialog.tsx`](../webview-ui/src/components/chat/CheckpointRestoreDialog.tsx)                             | Dialog asking whether to restore a checkpoint when deleting/editing a message that has one.                                                                     |
| **BudgetLimitDialog**       | [`BudgetLimitDialog.tsx`](../webview-ui/src/components/chat/BudgetLimitDialog.tsx)                                         | Dialog for configuring a per-task USD cost limit (max amount + action on exceed).                                                                               |
| **SessionSearch**           | [`SessionSearch.tsx`](../webview-ui/src/components/chat/SessionSearch.tsx)                                                 | Search bar for finding text within the current task's message history.                                                                                          |

---

## 3. UI Components — Sidebar & Navigation

Components in the Shofer sidebar (or editor tab header) for top-level navigation.

| Canonical Name      | File                                                                                  | Description                                                                         |
| ------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| **SettingsView**    | [`SettingsView.tsx`](../webview-ui/src/components/settings/SettingsView.tsx)          | The settings panel with sections for API configs, auto-approval, modes, tools, etc. |
| **WelcomeView**     | [`WelcomeView.tsx`](../webview-ui/src/components/welcome/WelcomeView.tsx)             | Welcome/splash screen shown on first launch or when no task history exists.         |
| **MarketplaceView** | [`MarketplaceView.tsx`](../webview-ui/src/components/marketplace/MarketplaceView.tsx) | Marketplace for installing MCP servers, modes, and other extensions.                |

The top-level tabs are: **chat**, **history**, **settings**, **marketplace** (feature-flagged).

---

## 4. UI Components — Panels & Overlays

| Canonical Name               | File                                                                                             | Description                                                                                                                  |
| ---------------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| **FileChangesPanel**         | [`FileChangesPanel.tsx`](../webview-ui/src/components/chat/FileChangesPanel.tsx)                 | Collapsible panel showing files modified by the current task, with Accept/Revert buttons per file and Accept All/Revert All. |
| **CodeIndexPopover**         | [`CodeIndexPopover.tsx`](../webview-ui/src/components/chat/CodeIndexPopover.tsx)                 | Popover showing code indexing status and controls.                                                                           |
| **HelperAgentPopover**       | [`HelperAgentPopover.tsx`](../webview-ui/src/components/chat/HelperAgentPopover.tsx)             | Popover for interacting with the helper agent.                                                                               |
| **ShareButton**              | [`ShareButton.tsx`](../webview-ui/src/components/chat/ShareButton.tsx)                           | Button for sharing a task (if sharing is enabled).                                                                           |
| **BatchDiffApproval**        | [`BatchDiffApproval.tsx`](../webview-ui/src/components/chat/BatchDiffApproval.tsx)               | UI for reviewing and approving multiple diffs as a batch.                                                                    |
| **BatchFilePermission**      | [`BatchFilePermission.tsx`](../webview-ui/src/components/chat/BatchFilePermission.tsx)           | UI for granting write permission to multiple files at once.                                                                  |
| **BatchListFilesPermission** | [`BatchListFilesPermission.tsx`](../webview-ui/src/components/chat/BatchListFilesPermission.tsx) | UI for granting read permission to multiple directories at once.                                                             |

---

## 5. Architecture — Extension Host (Backend)

These components run in the VS Code extension host (Node.js process).

| Canonical Name                   | File                                                                                          | Description                                                                                                                                                            |
| -------------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Task**                         | [`Task.ts`](../src/core/task/Task.ts)                                                         | The main task execution class. Runs the LLM conversation loop, executes tools, emits lifecycle events (`TaskStarted`, `TaskInteractive`, `TaskIdle`, `TaskCompleted`). |
| **ShoferProvider**               | [`ShoferProvider.ts`](../src/core/webview/ShoferProvider.ts)                                  | The VS Code `WebviewViewProvider`. Manages the task stack, creates/destroys `Task` instances, posts state to the webview, and handles parallel task operations.        |
| **TaskManager**                  | [`TaskManager.ts`](../src/services/task-manager/TaskManager.ts)                               | Manages parallel task execution. Tracks `ManagedTask` instances, runtime state (`idle`/`running`/`waiting_input`/`paused`), and background task notifications.         |
| **webviewMessageHandler**        | [`webviewMessageHandler.ts`](../src/core/webview/webviewMessageHandler.ts)                    | Central dispatch for all webview → host messages. Every `WebviewMessage.type` is handled here.                                                                         |
| **MessageQueueService**          | [`MessageQueueService.ts`](../src/core/message-queue/MessageQueueService.ts)                  | Manages the per-task message queue. When a task is busy, user messages are enqueued; "Send Now" dequeues and sends immediately.                                        |
| **MessageManager**               | [`message-manager/index.ts`](../src/core/message-manager/index.ts)                            | Manages adding/removing/editing messages within a task conversation. Handles checkpoint integration on edits/deletes.                                                  |
| **ContextDropZoneProvider**      | [`ContextDropZoneProvider.ts`](../src/core/webview/ContextDropZoneProvider.ts)                | Native VS Code `TreeView` + `TreeDragAndDropController` for drag-and-drop context files into the chat.                                                                 |
| **FileContextTracker**           | [`FileContextTracker.ts`](../src/core/context-tracking/FileContextTracker.ts)                 | Tracks which files have been read or modified during a task for context management.                                                                                    |
| **ShoferIgnoreController**       | [`ShoferIgnoreController.ts`](../src/core/ignore/ShoferIgnoreController.ts)                   | Reads and enforces `.shoferignore` rules, filtering files from tool operations and context.                                                                            |
| **ShoferProtectedController**    | [`ShoferProtectedController.ts`](../src/core/protect/ShoferProtectedController.ts)            | Reads and enforces `.shoferprotected` rules, controlling which files can be modified.                                                                                  |
| **ChangedFilesService**          | [`ChangedFilesService.ts`](../src/core/file-changes/ChangedFilesService.ts)                   | Tracks all files modified by Shofer tools, maintains working-directory snapshots for diff/revert/accept.                                                               |
| **AutoApprovalHandler**          | [`AutoApprovalHandler.ts`](../src/core/auto-approval/AutoApprovalHandler.ts)                  | Decides whether a tool call can be auto-approved based on tool group, mode, and user settings.                                                                         |
| **CustomModesManager**           | [`CustomModesManager.ts`](../src/core/config/CustomModesManager.ts)                           | Reads `.shofermodes` files and manages custom mode definitions.                                                                                                        |
| **ProviderSettingsManager**      | [`ProviderSettingsManager.ts`](../src/core/config/ProviderSettingsManager.ts)                 | Manages API provider configurations (API keys, endpoints, model selections).                                                                                           |
| **ContextProxy**                 | [`ContextProxy.ts`](../src/core/config/ContextProxy.ts)                                       | Provides a typed view of VS Code extension context for use across the extension.                                                                                       |
| **McpHub**                       | [`McpHub.ts`](../src/services/mcp/McpHub.ts)                                                  | Central MCP (Model Context Protocol) hub. Manages MCP server connections, tool discovery, and resource access.                                                         |
| **McpServerManager**             | [`McpServerManager.ts`](../src/services/mcp/McpServerManager.ts)                              | Manages individual MCP server lifecycle (start, stop, restart).                                                                                                        |
| **CheckpointService**            | [`checkpoints/index.ts`](../src/core/checkpoints/index.ts)                                    | Interface for shadow-git checkpoint operations (`checkpointSave`, `checkpointRestore`, `checkpointDiff`).                                                              |
| **RepoPerTaskCheckpointService** | [`RepoPerTaskCheckpointService`](../src/services/checkpoints/RepoPerTaskCheckpointService.ts) | Per-task shadow-git repository implementation for checkpoints.                                                                                                         |
| **DiffViewProvider**             | [`DiffViewProvider.ts`](../src/integrations/editor/DiffViewProvider.ts)                       | Opens VS Code diff editors for reviewing file changes.                                                                                                                 |
| **TerminalRegistry**             | [`TerminalRegistry.ts`](../src/integrations/terminal/TerminalRegistry.ts)                     | Manages terminal processes spawned by `execute_command`.                                                                                                               |
| **OutputInterceptor**            | [`OutputInterceptor.ts`](../src/integrations/terminal/OutputInterceptor.ts)                   | Captures terminal output for display in chat.                                                                                                                          |
| **ToolRepetitionDetector**       | [`ToolRepetitionDetector.ts`](../src/core/tools/ToolRepetitionDetector.ts)                    | Detects consecutive identical tool calls (a common LLM loop pattern) and triggers corrective action.                                                                   |
| **NativeToolCallParser**         | [`NativeToolCallParser.ts`](../src/core/assistant-message/NativeToolCallParser.ts)            | Parses tool call blocks from LLM streaming responses, mapping deprecated tool names to canonical forms.                                                                |
| **CodeIndexManager**             | _(created during extension activation)_                                                       | Manages the RAG codebase index (background indexing, querying).                                                                                                        |
| **HelperAgent**                  | (in `services/helper-agent/`)                                                                 | Persistent agent that maintains long-term codebase context, answerable via `ask_helper_agent` tool.                                                                    |

---

## 6. Architecture — Webview (Frontend)

These components run in the React webview (iframe in VS Code).

| Canonical Name            | File                                                                               | Description                                                                                                                  |
| ------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **App**                   | [`App.tsx`](../webview-ui/src/App.tsx)                                             | Root component. Renders one of WelcomeView, HistoryView, SettingsView, MarketplaceView, or ChatView based on the active tab. |
| **ExtensionStateContext** | [`ExtensionStateContext.tsx`](../webview-ui/src/context/ExtensionStateContext.tsx) | React context that receives state pushes from the extension host and provides them to all child components.                  |
| **useExtensionState**     | _(hook from ExtensionStateContext)_                                                | React hook for accessing global `ExtensionState`.                                                                            |
| **vscode**                | [`vscode.ts`](../webview-ui/src/utils/vscode.ts)                                   | Thin wrapper around `acquireVsCodeApi()` for posting `WebviewMessage`s to the extension host.                                |
| **telemetryClient**       | [`TelemetryClient.ts`](../webview-ui/src/utils/TelemetryClient.ts)                 | Client-side telemetry reporter using PostHog (feature-flagged).                                                              |
| **useSelectedModel**      | [`useSelectedModel.ts`](../webview-ui/src/components/ui/hooks/useSelectedModel.ts) | Hook that resolves the current model's metadata (ID, context window, pricing) from the API configuration.                    |

---

## 7. Data Types & Schemas

Defined in [`packages/types/src/`](../packages/types/src/). Always refer to the canonical type name.

### Core Task Types

| Type                 | File         | Description                                                                                                                                                                                |
| -------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------- | ------------------------------------- | --------------------------------------- |
| **HistoryItem**      | `history.ts` | Persisted task record. Contains `id`, `ts`, `task` (description), `tokensIn`, `tokensOut`, `totalCost`, `taskState`, `parentTaskId`, `childIds`, `mode`, `cwd`, `pinned`, `archived`, etc. |
| **TaskState**        | `history.ts` | The full execution state: `{ lifecycle: TaskLifecycle, rating?: CompletionRating }`.                                                                                                       |
| **TaskLifecycle**    | `history.ts` | Enum: `"idle"`, `"running"`, `"waiting_input"`, `"paused"`, `"completed"`, `"error"`.                                                                                                      |
| **CompletionRating** | `history.ts` | Agent self-assessment: `"poor"`, `"well"`, `"excellent"`. Only set when `lifecycle === "completed"`.                                                                                       |
| **TaskNotification** | `history.ts` | `{ taskId, type: "needs_input"                                                                                                                                                             | "completed" | "error"                               | "file_conflict", message, timestamp }`. |
| **CostLimit**        | `history.ts` | `{ maxUsd: number, action: "pause"                                                                                                                                                         | "abort"     | "kill" }` — per-root-task budget cap. |

### Chat Message Types

| Type              | File         | Description                                                                                                 |
| ----------------- | ------------ | ----------------------------------------------------------------------------------------------------------- |
| **ShoferMessage** | `message.ts` | A single message in a task conversation. Union of `ShoferSay`, `ShoferAsk`, and tool-related message types. |
| **ShoferSay**     | `message.ts` | A statement from the model (text, reasoning, tool call, etc.). Includes `say` type discriminant.            |
| **ShoferAsk**     | `message.ts` | A question/approval request from the model (e.g., `followup`, `tool`, `command`, `completion_result`).      |
| **QueuedMessage** | `message.ts` | A user message waiting in the queue: `{ id, text, images?, timestamp }`.                                    |
| **TodoItem**      | `todo.ts`    | `{ id: string, content: string, completed: boolean }`.                                                      |

### Tool-Related Types

| Type                | File      | Description                                                                                                                      |
| ------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------- |
| **ToolName**        | `tool.ts` | Union of all canonical tool names (see [§9](#9-tools--canonical-names)).                                                         |
| **ToolGroup**       | `tool.ts` | Tool category: `"read"`, `"write"`, `"execute"`, `"browser"`, `"mcp"`, `"mode"`, `"subtasks"`, `"questions"`, `"uncategorized"`. |
| **ToolGroupConfig** | `tool.ts` | `{ tools: ToolName[], alwaysAvailable?: boolean, customTools?: ToolName[] }`.                                                    |

### State & Configuration Types

| Type                    | File                       | Description                                                                                                                                                             |
| ----------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | --------- | ---------------------------------------------------------------------- |
| **ExtensionState**      | `vscode-extension-host.ts` | Full state object sent from extension host to webview. Contains `shoferMessages`, `taskHistory`, `apiConfiguration`, `mode`, `parallelTasks`, `taskNotifications`, etc. |
| **ProviderSettings**    | `provider-settings.ts`     | API provider configuration: `apiProvider`, `apiModelId`, `apiKey`, `baseUrl`, etc.                                                                                      |
| **ModeConfig**          | `mode.ts`                  | Custom mode definition: `slug`, `name`, `roleDefinition`, `groups`, `customInstructions`, `tools_allowed`, `tools_denied`.                                              |
| **WebviewMessage**      | `vscode-extension-host.ts` | Union of all messages sent from webview → extension host. Every message has a `type` discriminant.                                                                      |
| **ExtensionMessage**    | `vscode-extension-host.ts` | Union of all messages sent from extension host → webview.                                                                                                               |
| **ManagedTask**         | `vscode-extension-host.ts` | (via `TaskManager`) Runtime task descriptor: `{ id, name, taskId, workspace, createdAt, lastActiveAt, state }`.                                                         |
| **ChangedFileEntry**    | `vscode-extension-host.ts` | `{ path, insertions, deletions, binary, state: "modified"                                                                                                               | "added"    | "deleted" | "reverted", source: "working", hasOriginalContent, hasFinalContent }`. |
| **ChangedFilesPayload** | `vscode-extension-host.ts` | `{ taskId, entries: ChangedFileEntry[], backend: "working"                                                                                                              | "none" }`. |

---

## 8. IPC Protocol

Communication between the webview (React) and extension host (Node.js) uses typed discriminated unions.

### Extension → Webview (`ExtensionMessage`)

The extension host posts messages via `ShoferProvider.postMessageToWebview()`. Key types:

| `type`                         | Purpose                                                                          |
| ------------------------------ | -------------------------------------------------------------------------------- |
| `"state"`                      | Full or partial `ExtensionState` push.                                           |
| `"action"`                     | Actions like tab switches, input focus, auto-approve toggles.                    |
| `"taskHistoryUpdated"`         | The task history list changed.                                                   |
| `"parallelTasksUpdated"`       | The parallel task runtime state changed.                                         |
| `"taskNotification"`           | A background task needs attention.                                               |
| `"changedFiles/update"`        | Updated list of files modified by the current task.                              |
| `"condenseTaskContextStarted"` | Context condensation has begun (triggered when context window is near capacity). |
| `"indexingStatusUpdate"`       | Code index status changed.                                                       |
| `"helperAgentStatusUpdate"`    | Helper agent status changed.                                                     |
| `"addContextFiles"`            | Files were dropped onto the drop zone; webview should add them as context tags.  |

### Webview → Extension (`WebviewMessage`)

The webview posts messages via `vscode.postMessage()`. Key types:

| `type`                    | Purpose                                                                                   |
| ------------------------- | ----------------------------------------------------------------------------------------- |
| `"sendMessage"`           | User clicked Send. Carries `text`, `images`, and `mode`.                                  |
| `"cancelTask"`            | User clicked Stop.                                                                        |
| `"focusParallelTask"`     | User switched to a different task via TaskSelector.                                       |
| `"createParallelTask"`    | User created a new parallel task (via task sidebar drawer).                               |
| `"enqueueMessage"`        | User typed a message while the task is busy; enqueue instead of sending.                  |
| `"sendNow"`               | User clicked Send Now to cancel the current turn and send the queued message immediately. |
| `"deleteMessageConfirm"`  | User confirmed deletion of a message.                                                     |
| `"editMessageConfirm"`    | User confirmed editing of a message.                                                      |
| `"changedFiles/showDiff"` | User clicked a file in FileChangesPanel to view the diff.                                 |
| `"changedFiles/accept"`   | User clicked Accept on a changed file.                                                    |
| `"changedFiles/revert"`   | User clicked Revert on a changed file.                                                    |
| `"webviewDidLaunch"`      | Webview initialized and ready to receive state.                                           |
| `"requestWorkspaceFiles"` | Request file listing for @mention autocomplete.                                           |

---

## 9. Tools — Canonical Names

Defined in [`tool.ts`](../packages/types/src/tool.ts) as the `toolNames` const. Always use these exact strings when referring to a tool:

### File Operations

- `read_file` — Read file contents with offset/limit or indentation-based extraction.
- `write_to_file` — Write complete file content (creates directories automatically).
- `apply_diff` — Apply targeted modifications via search/replace blocks.
- `edit` / `edit_file` / `search_and_replace` / `search_replace` / `apply_patch` — Legacy/compatibility edit tool aliases.
- `insert_edit` — Insert text at a specific line/column position.
- `sed` — Regex find-and-replace on files.
- `file` — Filesystem operations via `rm`/`mv` subcommands.

### Search & Exploration

- `rag_search` — Semantic search using the vector index (RAG).
- `lsp_search` — Symbol search via LSP workspace symbols (fallback to text search).
- `grep_search` — Regex/literal search across files with context display.
- `list_files` — List directory contents (optional recursive).
- `find_files` — Find files by glob pattern.
- `list_code_usages` — Find all references to a symbol via LSP.
- `read_project_structure` — Tree view of workspace directory structure.
- `get_errors` — Get diagnostics from language servers.
- `get_project_setup_info` — Analyze project for languages, frameworks, build systems.
- `get_changed_files` — List files Shofer has changed in the current session.

### Command Execution

- `execute_command` — Run CLI commands with configurable cwd and timeout.
- `read_command_output` — Retrieve full output from a truncated command execution.

### Task Lifecycle

- `attempt_completion` — Signal task completion with self-assessment rating.
- `new_task` — Spawn a child task (synchronous or background).
- `check_task_status` — Query status of a background task.
- `wait_for_task` — Block until background tasks complete (`all` or `any` strategy).
- `list_background_tasks` — List all background child tasks.
- `switch_mode` — Switch to a different mode.
- `set_task_title` — Set a descriptive title for the current task.
- `ask_followup_question` — Ask the user a multiple-choice question.
- `ask_helper_agent` — Query the persistent helper agent.
- `give_feedback` — Send feedback to the Shofer.Dev developers.

### Content

- `fetch_web_page` — Download and extract text from web pages.
- `view_image` — View an image file.
- `generate_image` — Generate an image via AI.

### Workspace & Management

- `create_directory` — Create a new directory.
- `create_new_workspace` — Create a new workspace/project structure.
- `rename_symbol` — Rename a symbol and all its references via LSP.
- `skills` — Load a skill by name.
- `update_todo_list` — Replace the TODO list.
- `sleep` — Pause execution for a specified duration.
- `run_slash_command` — Execute a slash command.

### MCP

- `use_mcp_tool` — Invoke a tool from an MCP server.
- `access_mcp_resource` — Access a resource from an MCP server.

### Deprecated Tool Names

Mapping from old names to canonical names (auto-translated by `NativeToolCallParser`):

| Old Name     | Canonical Name |
| ------------ | -------------- |
| `skill_load` | `skills`       |

---

## 10. Tool Groups (Categories)

Every tool belongs to exactly one tool group (defined in [`tool.ts`](../packages/types/src/tool.ts)). Tool groups are used for mode access control and auto-approval toggles.

| Group             | Description                                                 |
| ----------------- | ----------------------------------------------------------- |
| **read**          | Read-only data access (files, search, diagnostics).         |
| **write**         | Content mutations (`apply_diff`, `write_to_file`, etc.).    |
| **execute**       | System command execution (`execute_command`, `sleep`).      |
| **browser**       | Browser/web automation tools.                               |
| **mcp**           | MCP protocol tools (`use_mcp_tool`, `access_mcp_resource`). |
| **mode**          | Mode switching and task lifecycle tools.                    |
| **subtasks**      | Background/delegated task management tools.                 |
| **questions**     | User-facing question tools (`ask_followup_question`).       |
| **uncategorized** | Fallback for tools without explicit classification.         |

### Renamed Groups (auto-translated by schema validation)

| Old Name  | Canonical Name |
| --------- | -------------- |
| `edit`    | `write`        |
| `command` | `execute`      |
| `modes`   | `mode`         |

---

## 11. Modes

Built-in modes (defined in `shared/modes.ts`):

| Slug           | Display Name    | Description                                                   |
| -------------- | --------------- | ------------------------------------------------------------- |
| `code`         | 💻 Code         | Default mode. Write, modify, refactor code.                   |
| `architect`    | 🏗️ Architect    | Plan, design, strategize before implementation.               |
| `ask`          | ❓ Ask          | Explanations, documentation, technical questions.             |
| `debug`        | 🪲 Debug        | Troubleshooting, diagnostics, root cause analysis.            |
| `reviewer`     | 👀 Reviewer     | Code review without making changes.                           |
| `search`       | 🔎 Search       | Search codebase for specific information.                     |
| `opinion`      | 💭 Opinion      | Technology choices, architectural decisions, recommendations. |
| `browser`      | 🌐 Browser      | Web browsing, research, data extraction.                      |
| `orchestrator` | 🪃 Orchestrator | Complex multi-step coordination, fan-out to sub-tasks.        |

Custom modes can be defined via [`.shofermodes`](#13-special-files--directories) files.

**Custom Mode Fields**: `slug`, `name`, `roleDefinition`, `groups` (tool groups), `tools_allowed`, `tools_denied`, `customInstructions`, `whenToUse`, `description`, `rulesFiles`, `source` (`"project"` | `"global"`).

---

## 12. Task States & Lifecycle

See also [`task_states.md`](task_states.md).

### State Resolution

The icon for a task (in `TaskSelector` and `TaskHeader`) is resolved as:

1. `runtime.state` — live execution state from `ManagedTask` (in-memory), always wins if present.
2. `item.taskState` — persisted state from `HistoryItem` (survives restarts).
3. `{ lifecycle: "idle" }` — default fallback.

### State Indicator Colors

| State         | Color  | Class            | Effect |
| ------------- | ------ | ---------------- | ------ |
| idle          | Gray   | `bg-gray-400`    | –      |
| running       | Green  | `bg-green-500`   | Pulse  |
| waiting_input | Yellow | `bg-yellow-500`  | Pulse  |
| paused        | Orange | `bg-orange-500`  | –      |
| completed     | Green  | (checkmark icon) | –      |
| error         | Red    | (warning icon)   | –      |

### Key Task Events (emitted by `Task`)

| Event             | When                                            |
| ----------------- | ----------------------------------------------- |
| `TaskStarted`     | First API call begins.                          |
| `TaskInteractive` | Needs user input (approval/question).           |
| `TaskActive`      | Resumed after user input.                       |
| `TaskIdle`        | Reached idle state (completion, error, cancel). |
| `TaskCompleted`   | Finished with token/tool usage summary.         |
| `TaskPaused`      | Manually paused by user.                        |
| `TaskResumed`     | Resumed from pause.                             |

### Cost Limit States

When a task reaches its `CostLimit.maxUsd`:

| Action  | Behavior                                    |
| ------- | ------------------------------------------- |
| `pause` | Pause the task, ask user to increase limit. |
| `abort` | Abort the task without completion.          |
| `kill`  | Kill the task immediately.                  |

---

## 13. Special Files & Directories

| File / Directory   | Purpose                                                                                               |
| ------------------ | ----------------------------------------------------------------------------------------------------- |
| `.shoferignore`    | Gitignore-style file listing paths Shofer should not access (index, read, search).                    |
| `.shofermodes`     | YAML/JSON file defining custom modes. Supports project-level and global locations.                    |
| `.shoferprotected` | File defining protected files/directories that require explicit approval to modify.                   |
| `.shofer/rules/`   | Additional rules/prompts loaded into the system prompt.                                               |
| `.shofer/skills/`  | Skill definitions (`SKILL.md` files) for domain-specific instructions.                                |
| `SKILL.md`         | A single skill definition file containing instructions, mode restrictions, and optional linked files. |
| `AGENTS.md`        | Developer-facing documentation about the extension's architecture and conventions.                    |

---

## 14. API Provider Concepts

| Term                          | Description                                                                                                                             |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| **Provider Profile**          | A named API configuration (e.g., "openrouter", "deepseek") stored in VS Code settings. Selected via `ApiConfigSelector`.                |
| **Sticky Profile**            | Each task remembers its `apiConfigName`; switching tasks restores that task's provider profile.                                         |
| **Sticky Mode**               | Each task remembers its `mode`; switching tasks restores that task's mode.                                                              |
| **Lock API Config**           | Feature that prevents the model from switching API profiles.                                                                            |
| **Provider Name**             | The canonical provider identifier: `"openrouter"`, `"anthropic"`, `"openai"`, `"deepseek"`, `"gemini"`, `"vscode-lm"`, `"ollama"`, etc. |
| **Router Provider**           | The Shofer Router API (`"router-provider"`) which proxies to upstream providers (OpenRouter, Anthropic, OpenAI, etc.).                  |
| **Context Window**            | The maximum number of tokens a model can process in a single request. Displayed in `ContextWindowProgress`.                             |
| **Consecutive Mistake Limit** | Maximum number of consecutive errors (no tools used, tool repetition) before the task is auto-aborted.                                  |
| **Prompt Enhancement**        | The ✨ button that sends the user's draft to a separate LLM call for improvement before sending to the main model.                      |

---

## Appendix: Quick Reference

When communicating about the UI, use these names:

- The **task dropdown** at the top of the chat → **TaskSelector** (not "task switcher" or "task menu")
- The **chat input bar** at the bottom → **ChatTextArea** (not "input box" or "composer")
- The **mode dropdown** in the input bar → **ModeSelector** (not "mode picker" or "mode switcher")
- The **API config dropdown** in the input bar → **ApiConfigSelector** (not "provider dropdown")
- The **auto-approve settings** in the input bar → **AutoApproveDropdown**
- The **file changes panel** → **FileChangesPanel** (not "changed files list" or "diff panel")
- The **queued messages section** → **QueuedMessages** (not "message queue")
- The **context window bar** in the header → **ContextWindowProgress** (not "context usage bar")
- The **task title in the header** → **TaskHeader** (not "task info bar")
- The **history panel** → **HistoryView** (not "task list" or "history page")
- The **settings panel** → **SettingsView** (not "settings page" or "config page")
- The **welcome screen** → **WelcomeView** (not "splash screen" or "landing page")
