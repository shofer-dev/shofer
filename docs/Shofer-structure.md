# Shofer Extension Structure

## Overview

Shofer is a VS Code extension (fork of Shofer/Shofer) that provides an AI coding assistant. It uses a pnpm monorepo structure with TypeScript for the extension and React for the webview UI.

**Project root**: `/home/alsterg/Projects/shofer.dev/extensions/shofer/`

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
- `registerBackgroundTask()` - Registers task with TaskManager
- `getStateToPostToWebview()` - Builds ExtensionState for webview

### TaskManager.ts (`src/services/task-manager/TaskManager.ts`)

Manages parallel task execution:

- Tracks managed tasks (background tasks with live instances)
- Maintains task execution states (idle, running, waiting_input, paused)
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

**State indicator colors:**

- Gray (`bg-gray-400`) - idle
- Green (`bg-green-500`) + pulse - running
- Yellow (`bg-yellow-500`) + pulse - waiting_input
- Orange (`bg-orange-500`) - paused

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
