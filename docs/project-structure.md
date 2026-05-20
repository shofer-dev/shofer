# Shofer Extension Structure

## Overview

Shofer is a VS Code extension that provides an AI coding assistant. It uses a pnpm monorepo structure with TypeScript for the extension and React for the webview UI.

**Project root**: `/home/alsterg/Projects/arkware.ai/extensions/shofer/`

## Directory Structure

```
extensions/shofer/
├── src/                          # Main extension source (shofer package)
│   ├── activate/                 # Extension activation & command registration
│   ├── core/
│   │   ├── task/                 # Task execution logic
│   │   │   └── Task.ts           # Main Task class - runs LLM conversations
│   │   └── webview/
│   │       ├── ShoferProvider.ts  # Main provider - manages tasks, state, webview
│   │       └── webviewMessageHandler.ts  # Handles messages from webview
│   ├── services/
│   │   └── task-manager/
│   │       └── TaskManager.ts    # Parallel task management
│   └── package.json              # Extension manifest (version here)
├── packages/
│   ├── types/                    # Shared TypeScript types
│   │   └── src/
│   │       ├── history.ts        # HistoryItem, TaskNotification schemas
│   │       └── vscode-extension-host.ts  # ExtensionState interface
│   └── ...                       # Other shared packages
├── webview-ui/                   # React webview (vscode-webview package)
│   └── src/
│       ├── components/chat/
│       │   ├── TaskSelector.tsx  # Task dropdown with state indicators
│       │   ├── TaskHeader.tsx    # Task header with selector
│       │   └── ChatView.tsx      # Main chat interface
│       └── context/
│           └── ExtensionStateContext.tsx  # Global state from extension
└── apps/
    └── cli/                      # CLI version of Shofer
```

## Key Components

### Task.ts (`src/core/task/Task.ts`)

The main task execution class that:

- Manages LLM conversation loop
- Emits events for state changes (TaskStarted, TaskInteractive, TaskIdle, etc.)
- Handles tool execution and user approval
- Contains `statusMutationTimeout` for debouncing state change events

**Key events emitted:**

- `TaskStarted` - First API call begins
- `TaskInteractive` - Needs user input (approval/question)
- `TaskActive` - Resumed after user input
- `TaskIdle` - Reached idle state (completion_result, api_req_failed)
- `TaskCompleted` - Task finished with token/tool usage

### ShoferProvider.ts (`src/core/webview/ShoferProvider.ts`)

The main VS Code webview provider that:

- Manages the task stack (multiple tasks, one visible)
- Creates and destroys Task instances
- Posts state to webview via `postStateToWebview()`
- Handles parallel task operations

**Key methods:**

- `createTask()` - Creates new task, optionally preserving current
- `createManagedTask()` - Creates task preserving current in background
- `popFromStackWithoutAborting()` - Removes task from UI without killing it
- `getStateToPostToWebview()` - Builds ExtensionState for webview

### TaskManager.ts (`src/services/task-manager/TaskManager.ts`)

Manages parallel task execution:

- Tracks managed tasks (background tasks with live instances)
- Maintains task lifecycle states (idle, running, waiting_input, waiting, paused, completed, error)
- `registerBackgroundTask()` - Registers a Task instance with TaskManager
- Creates notifications for background tasks needing attention
- Emits events for state changes

**Key data structures:**

- `managedTasks: Map<taskId, ManagedTask>` - All tracked tasks
- `activeTasks: Map<taskId, Task>` - Tasks with live instances
- `notifications: ManagedTaskNotification[]` - Pending notifications
- `focusedTaskId: string | null` - Currently visible task

**Key events emitted:**

- `tasks:updated` - Task list changed
- `managedTask:state-changed` - Task state updated
- `managedTask:needs-input` - Background task needs attention

### TaskSelector.tsx (`webview-ui/src/components/chat/TaskSelector.tsx`)

React component for task switching:

- Shows dropdown of all tasks
- Displays state indicator (colored dot)
- Shows notification badge count (yellow circle)

**State indicators** (rendered via codicons with VSCode CSS variable colors):

- DescriptionForeground (`codicon-circle-large-outline`) - idle
- Charts Green (`codicon-sync` with spin) - running (pulse animation)
- Charts Yellow (`codicon-question`) - waiting_input (pulse animation)
- Charts Blue (`codicon-watch`) - waiting (pulse animation)
- Charts Orange (`codicon-debug-pause`) - paused
- Charts Green (`codicon-pass`) - completed (rating overlays vary)
- Error Red (`codicon-error`) - error

### ExtensionStateContext.tsx (`webview-ui/src/context/ExtensionStateContext.tsx`)

React context providing global state:

- Receives state from extension via `window.postMessage`
- Handles incremental updates (parallelTasksUpdated, taskNotification, etc.)
- Provides state to all webview components

**Key state fields:**

- `parallelTasks: ManagedTask[]` - Runtime state overlay
- `taskNotifications: TaskNotification[]` - Pending notifications
- `taskHistory: HistoryItem[]` - All tasks (source of truth)
- `currentTaskId: string` - Currently displayed task

## Communication Flow

```
Extension (Node.js)              Webview (React)
─────────────────────────────────────────────────
ShoferProvider                    ExtensionStateContext
     │                                  │
     │  postMessageToWebview()          │
     │  ───────────────────────────►    │
     │  {type: "state", ...}            │
     │  {type: "parallelTasksUpdated"}  │
     │  {type: "taskNotification"}      │
     │                                  │
     │  ◄───────────────────────────    │
     │  vscode.postMessage()            │
     │  {type: "focusParallelTask"}     │
     │  {type: "createParallelTask"}    │
```

## Event Flow for Parallel Tasks

1. **Task needs input** (TaskInteractive event):

    - Task.ts emits `TaskInteractive` after `statusMutationTimeout`
    - TaskManager catches event, calls `updateTaskExecutionState("waiting_input")`
    - If background task, calls `addNotification()` → emits `managedTask:needs-input`
    - ShoferProvider catches event, posts `taskNotification` to webview
    - ExtensionStateContext updates `taskNotifications`
    - TaskSelector shows yellow badge with count

2. **Task completes** (TaskIdle event):
    - Task.ts emits `TaskIdle` (from attempt_completion tool)
    - TaskManager catches event, calls `updateTaskExecutionState("idle")`
    - Emits `tasks:updated` → ShoferProvider posts `parallelTasksUpdated`
    - TaskSelector shows gray indicator

## Version Management

- Version in `src/package.json`
- Bump Z for backward-compatible patches
- Bump Y for breaking changes
- Bump X only when explicitly asked

## Build & Deploy

```bash
# Build extension
deploy.sh dev build shofer-code

# Install in code-server
deploy.sh dev install-extensions
```

---

## Gaps, Issues & Improvement Areas

Issues discovered during factual-accuracy verification of this document.

### Directory tree omissions

The tree shows a simplified subset of the monorepo. Missing from the diagram:

- `packages/types/src/events.ts` — ShoferEventName enum (TaskStarted, TaskCompleted, etc.), referenced in Key Components.
- `packages/core/` — shared worktree, task-history, custom-tools, debug-log, and message-utils packages.
- `packages/telemetry/` — TelemetryService, PostHogTelemetryClient.
- `packages/ipc/` — IPC client/server for CLI ↔ extension communication.
- `src/core/tools/` — 15+ native tool implementations (ApplyDiffTool.ts, AskAssistantAgentTool.ts, AttemptCompletionTool.ts, etc.).
- `src/core/auto-approval/` — AutoApprovalHandler, per-group approval policies.
- `src/services/code-index/` — RAG codebase indexing (embedders, file-watcher, git-ignore-filter).
- `src/services/assistant-agent/` — persistent LLM-based codebase Q&A service.
- `src/services/mcp/` — MCP server hub and server manager.
- `src/services/skills/` — skills discovery, caching, and lifecycle management.
- `webview-ui/src/components/chat/` — ~50+ React components, not just the 3 listed.

### Task events section is incomplete

The "Key events emitted" block under Task.ts lists only 5 events. The [`events.ts`](extensions/shofer/packages/types/src/events.ts) `ShoferEventName` enum defines 25+ events. Missing categories:

- **Subtask lifecycle**: `TaskPaused`, `TaskUnpaused`, `TaskSpawned`, `TaskDelegated`, `TaskDelegationCompleted`, `TaskDelegationResumed`
- **Execution**: `TaskModeSwitched`, `TaskAskResponded`, `TaskUserMessage`, `QueuedMessagesUpdated`
- **Analytics**: `TaskTokenUsageUpdated`, `TaskToolFailed`
- **Configuration**: `ModeChanged`, `ProviderProfileChanged`

### TaskCompleted event description is imprecise

The doc says "Task finished with token/tool usage". In the actual schema, `TaskCompleted` carries a tuple of `[string (taskId), TokenUsage, ToolUsage, { rating: CompletionRating, isSubtask: boolean }]`. Token/tool usage is a separate tuple position from the review metadata.

### TaskManager events list is incomplete

The "Key events emitted" block lists 3 events. The actual [`TaskManagerEvents`](extensions/shofer/src/services/task-manager/TaskManager.ts:46) interface defines 7 events. Missing:

- `managedTask:needs-parent-input` — background child routes a question to its parent
- `managedTask:completed` — task reached completed lifecycle
- `managedTask:error` — task reached error lifecycle
- `managedTask:tool-error` — a tool invocation in the task failed irrecoverably

### Communication flow message types are approximated

The diagram shows `{type: "state", ...}`, `{type: "parallelTasksUpdated"}`, `{type: "taskNotification"}` as `ExtensionMessage` discriminants. While conceptually accurate, the exact TypeScript type discriminants in the source differ. This should be verified against `ExtensionMessageSchema` in `@shofer/types` at next review.

### Event flow: "gray indicator" for idle after completion is ambiguous

The doc describes completed/idle tasks as "gray indicator" but the actual `LIFECYCLE_VISUAL` renders terminal states (`completed`, `error`) with color: `completed` uses `var(--vscode-charts-green,#16a34a)` and `error` uses `var(--vscode-errorForeground,#ef4444)`. Only `idle` (no lifecycle yet) uses `var(--vscode-descriptionForeground)`.

### Sections that would improve the doc

1. **Tool architecture overview** — how native tools, MCP tools, and private LM tools are dispatched.
2. **Auto-approval flow** — how `checkAutoApproval` gates tool execution.
3. **Message persistence layout** — where `ui_messages.json`, `api_conversation_history.json`, and `history_item.json` live on disk.
4. **Checkpoint (shadow-git) model** — how `ShadowCheckpointService` provides undo/redo.
5. **Context management** — condense, truncation, FileContextTracker.
