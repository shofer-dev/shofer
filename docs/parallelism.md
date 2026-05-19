# Parallelism & Sub-Task Execution

Design of parallel task execution in Shofer, including the `new_task` tool (sync/async delegation), background task orchestration, and the TaskManager service.

## Overview

Shofer supports **parallel task execution**: multiple AI-powered tasks run concurrently within a single window. One task is **focused** (visible in the UI) while others continue processing in the background. This is analogous to Copilot's session model — each "task" is an independent conversation with its own history, mode, and tool loop.

Parallelism is exposed to the LLM via the `new_task` tool, which can spawn child tasks in either **synchronous** (blocking) or **asynchronous/background** (non-blocking) mode. The parent task manages background children through three supporting tools: `check_task_status`, `wait_for_task`, and `list_background_tasks`.

## Core Concepts

### Task

A **Task** ([`extensions/shofer/src/core/task/Task.ts`](../src/core/task/Task.ts)) is an active in-process conversation instance. It owns the API loop, tool execution, message history, and an in-memory `backgroundChildren` map tracking async child tasks it has spawned. Multiple `Task` instances can be alive concurrently.

### HistoryItem

A **HistoryItem** ([`@shofer/types/src/history.ts`](../../types/src/history.ts)) is the persisted record of a task, written to disk as `history_item.json` inside the task's storage directory. It holds metadata: `id`, `name`, `task` (first message text), `tokensIn`, `tokensOut`, `totalCost`, `workspace`, `mode`, `taskExecutionState`, `isBackground`, `backgroundChildIds`, etc.

### TaskManager

The **TaskManager** ([`extensions/shofer/src/services/task-manager/TaskManager.ts`](../src/services/task-manager/TaskManager.ts)) is a runtime-only service that tracks all live `Task` instances and provides a metadata overlay (`ManagedTask`) for the UI. It is the single source of truth for task lifecycle state and notifications.

```
HistoryItem (disk / sidebar)
    ↕ load/save (name field synced)
ManagedTask (TaskManager, in-memory)   ← title & runtime state live here
    ↑ registered by
Task (active instance)
    └─ backgroundChildren: Map<taskId, TaskHandle>  ← lightweight lifecycle tracking
```

### ManagedTask

A **ManagedTask** is the runtime descriptor `TaskManager` keeps for each managed task:

```typescript
interface ManagedTask {
	id: string // Task UUID
	name: string // Human-readable title
	taskId: string // Same as id
	workspace: string
	createdAt: number
	lastActiveAt: number
	state: TaskExecutionState // "idle" | "running" | "waiting_input" | "paused" | "error"
}
```

### TaskHandle

A **TaskHandle** ([`@shofer/types/src/task.ts`](../../types/src/task.ts)) is a lightweight in-memory reference the parent `Task` holds for each background child it spawned. Intentionally minimal — identity, lifecycle status, and timing only. No title.

```typescript
interface TaskHandle {
	taskId: string
	status: BackgroundTaskStatus // "starting" | "running" | "waiting" | "completed" | "error"
	createdAt: number
	parentTaskId: string
}
```

### Task Execution State

The lifecycle of a task is represented by `TaskExecutionState`:

| State           | Color  | Pulse | Trigger                                                                    |
| --------------- | ------ | ----- | -------------------------------------------------------------------------- |
| `idle`          | Gray   | No    | `attempt_completion`, `resume_completed_task`                              |
| `running`       | Green  | Yes   | `TaskStarted`, `TaskActive`                                                |
| `waiting_input` | Yellow | Yes   | `TaskInteractive` (needs user approval)                                    |
| `paused`        | Orange | No    | User pressed Stop, `TaskAborted`                                           |
| `error`         | Red    | No    | `api_req_failed`, `mistake_limit_reached`, `auto_approval_max_req_reached` |

See [`task_states.md`](task_states.md) for the full state model including completion ratings.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                          TaskManager                             │
├─────────────────────────────────────────────────────────────────┤
│  focusedTaskId: "task-1"                                        │
│                                                                  │
│  activeTasks:                                                    │
│    "task-1" → Task (focused, running)     ←── UI connected      │
│    "task-2" → Task (background, running)  ←── auto-approve      │
│    "task-3" → Task (background, waiting)  ←── needs input       │
│                                                                  │
│  notifications:                                                  │
│    [{ taskId: "task-3", type: "needs_input", ... }]             │
└─────────────────────────────────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                     ShoferProvider (webview)                      │
├─────────────────────────────────────────────────────────────────┤
│  Shows focused task's messages                                  │
│  Task selector shows all tasks + state indicators               │
│  Notification badge for tasks needing input                     │
└─────────────────────────────────────────────────────────────────┘
```

### Stack vs. activeTasks

Two orthogonal concepts govern which task runs where:

- **`shoferStack`** (in ShoferProvider): what the user is **observing**. The top of the stack is the focused task whose messages are rendered in the chat panel.
- **`TaskManager.activeTasks`**: what is **executing**. Background tasks (including delegated subtasks) execute without stealing focus.

Non-destructive task switching uses `popFromStackWithoutAborting()` to remove a task from the UI stack without aborting it, allowing it to continue in the background.

### Invariant: At most one live `Task` per `taskId`

`createTaskWithHistoryItem()` enforces this invariant. If a live, non-abandoned, non-aborted instance already exists in `TaskManager.activeTasks` for the requested `taskId`, that instance is swapped back into the focused stack position instead of constructing a duplicate. This prevents "zombie" instances that race the original on the same history files.

---

## `new_task` Tool

The [`new_task`](native_tools.md#new_task) tool creates a child task in a chosen mode. It supports two execution models controlled by the `is_background` parameter.

### Synchronous mode (`is_background` omitted or `false`, default)

The parent **blocks** until the child completes. The child result is returned as the tool's output, and the parent resumes where it left off.

```
Parent calls new_task(mode="code", message="Fix bug in foo.ts")
  → Parent enters "delegated" status
  → Child created, focused in stack
  → Child runs its tool loop
  → Child calls attempt_completion
  → reopenParentFromDelegation() restores parent
  → Parent receives child result as tool_result
  → Parent continues
```

**Constraint:** Must be called **alone** in a turn — no other tools in the same message. The model instruction: "CRITICAL: This tool MUST be called alone. Do NOT call this tool alongside other tools in the same message turn."

### Background mode (`is_background=true`)

The child starts immediately and runs **concurrently**. The parent receives the child's `task_id` in the tool result and continues **without blocking**.

```
Parent calls new_task(is_background=true, mode="code", message="Analyze file1.ts")
  → Child created, registered in TaskManager, started in background
  → Parent receives: "Child task started: <task_id>\nStatus: starting"
  → Parent continues its own tool loop immediately

Parent calls new_task(is_background=true, mode="code", message="Analyze file2.ts")
  → Second child started in background
  → Parent continues

Parent calls wait_for_task(task_ids=["<id1>", "<id2>"])
  → Blocks until both children complete
  → Returns results from both
```

#### Key differences from synchronous mode

| Aspect                                   | Sync                               | Async (Background)                 |
| ---------------------------------------- | ---------------------------------- | ---------------------------------- |
| Parent status                            | `delegated`                        | Remains `active`                   |
| Parent blocks?                           | Yes                                | No                                 |
| Parent history saved?                    | Yes (delegation metadata)          | No (parent keeps running)          |
| Child completion triggers parent resume? | Yes (`reopenParentFromDelegation`) | No (parent explicitly polls/waits) |
| Can start multiple children?             | No                                 | Yes (in parallel)                  |
| Stack behavior                           | Child becomes focused              | Focused task unchanged             |

#### Parameters

| Param              | Type    | Required | Description                                                                                                                                |
| ------------------ | ------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `mode`             | string  | ✅       | Mode slug (e.g., `code`, `debug`, `architect`)                                                                                             |
| `message`          | string  | ✅       | Initial instructions for the child task                                                                                                    |
| `todos`            | string  | –        | Initial markdown checklist for the child                                                                                                   |
| `is_background`    | boolean | –        | When `true`, run child concurrently and return `task_id` immediately                                                                       |
| `softResultLength` | number  | ✅       | Soft suggestion for max characters of the subtask's completion result. Hard safety cap: 100000 characters (results beyond this truncated). |
| `softTimeoutSec`   | number  | ✅       | Soft guidance (in seconds) for how long the parent expects to wait. Informational only — not enforced.                                     |

### Delegation from background tasks

When a **background task** (not the focused task) calls `new_task`:

1. Parent is resolved via `TaskManager.getManagedTaskInstance(taskId)` — not from the stack top.
2. The current focused UI task is **not** popped or aborted.
3. The child is created with `openInStack: false` (no focus steal).
4. The child is registered in `TaskManager` for state tracking and notifications.

This preserves the invariant: background tasks should execute without stealing focus.

---

## Background Task Orchestration Tools

Five tools manage the parent-child relationship for background tasks. All are **always available** (bypass mode filtering) and **auto-approved** (no user prompt).

### `check_task_status`

Check the current status of a background child task. Returns the task's status and, if it has completed or errored, its result or error message. When `include_activity` is `true`, also returns the child's most recent tool calls and messages.

```typescript
// Parameters
{ task_id: string, include_activity?: boolean }

// Returns (when completed)
{ task_id: string, task_title?: string, status: "completed", result: string }

// Returns (when errored)
{ task_id: string, task_title?: string, status: "error", error: string }

// Returns (when still running)
{ task_id: string, task_title?: string, status: "running" | "waiting" }

// When include_activity=true and child is running:
// "... Recent activity: [tool] read_file, [say:text] Found 5 occurrences..."
```

**Implementation:** Reads the parent's `backgroundChildren` handle map for known status, then checks `TaskManager` for live instances. If no live instance exists, falls back to reading the child's persisted history. The title is fetched from `TaskManager.getManagedTask(taskId)?.name` at read time — no duplication into `TaskHandle`. When `include_activity` is set, reads the last 3 messages from the child's persisted message history.

If the child has a pending parent question (see `ask_followup_question` routing below), the question text and suggestions are surfaced in the output.

### `wait_for_task`

Block until one or more background child tasks reach a terminal state, then return their results. **Event-driven** — does not poll.

```typescript
// Parameters
{
  task_ids: string[],             // One or more task IDs
  wait?: "all" | "any",          // "all" (default): wait for all tasks; "any": return on first completion
  timeout?: number               // Max seconds to wait (default: 120)
}

// Returns
{
  task_ids: string[],             // Completed task IDs
  task_titles: string[],          // Corresponding titles
  // Per-task status and result/error text
}
```

**Implementation:** Creates a promise that resolves when each tracked child reaches `completed`, `error`, or `cancelled` status. On timeout, returns current statuses for all tasks without error. The `wait` parameter controls the resolution strategy:

- `"all"` (default): resolves when every listed task reaches a terminal state.
- `"any"`: resolves as soon as at least one task completes successfully.

### `list_background_tasks`

List all background child tasks started by the current task via `new_task` with `is_background=true`.

```typescript
// Parameters: none

// Returns
[
  { task_id: string, title?: string, status: string, created_at: number },
  ...
]
```

**Implementation:** Iterates over `Task.backgroundChildren` and enriches each entry with the title from `TaskManager.getManagedTask(taskId)?.name`.

### `cancel_tasks`

Stop one or more background child tasks. Already-completed or errored tasks are unaffected (no-op).

```typescript
// Parameters
{ task_ids: string[] }

// Returns per-task status:
// "Canceled: 2 task(s)\nchild-1: stopped\nchild-2: already completed"
```

**Implementation:** Iterates over `task_ids`, resolves each from `Task.backgroundChildren`, fetches the live instance from `TaskManager`, and calls `abortTask(false)`. Already-terminal tasks are skipped. Results reported with per-task status.

### `answer_subtask_question`

Answer a question that a background child task asked via `ask_followup_question`. When a background child needs clarification, its question is routed to the parent instead of the user. Use this tool to provide the answer and unblock the child.

```typescript
// Parameters
{ task_id: string, answer: string }
```

**Implementation:** Resolves the child's `_pendingParentQuestion` promise with the parent's answer, allowing the child's `ask_followup_question` tool handler to continue.

### `ask_followup_question` routing

When a background child calls `ask_followup_question`, the question is automatically routed to the parent:

1. The child stores the question as `_pendingParentQuestion` on its `Task` instance.
2. The child blocks on a promise awaiting the parent's answer.
3. The parent discovers the question via `check_task_status` (which shows `status: "waiting"` and the question text) or `wait_for_task`.
4. The parent answers via `answer_subtask_question`, resolving the child's promise.
5. The child continues as if the user had answered.

---

## Abort Propagation

### Parent abort → children abort

When a parent task is aborted (user presses Stop, or the task encounters a fatal error), background children are aborted via `Task.abortBackgroundChildren()`. This method iterates over `backgroundChildren`, fetches each live instance from `TaskManager`, and calls `abortTask(true)`.

### Child abort

If a background child aborts (error, user intervention), the parent is **not** automatically notified. The parent discovers this through `check_task_status` or `wait_for_task`, which will return `status: "error"`.

### Auto-abort on parent completion

`AttemptCompletionTool` calls `task.abortBackgroundChildren()` before emitting `TaskCompleted` and setting `task.abort = true`. This ensures that no background children outlive their parent. The abort is all-or-nothing — all children are stopped.

---

## Auto-Approval

Background task orchestration tools are registered as always-approved in [`src/core/auto-approval/index.ts`](../src/core/auto-approval/index.ts):

| Tool                      | Reason                                                               |
| ------------------------- | -------------------------------------------------------------------- |
| `check_task_status`       | Read-only query; no side effects                                     |
| `wait_for_task`           | Blocking wait with timeout; no side effects on other tasks           |
| `list_background_tasks`   | Read-only enumeration                                                |
| `cancel_tasks`            | Parent owns its children; stopping is non-destructive to other tasks |
| `answer_subtask_question` | Parent answering its own child's question; no external side effects  |

The `tool` string in the JSON payload uses camelCase (`checkTaskStatus`, `waitForTask`, `listBackgroundTasks`) and must match the `ClineSayTool.tool` union and the `ChatRow` switch case.

### ChatRow rendering

Each tool shows a dedicated `ChatRow` entry with:

- A codicon (e.g., `codicon-check`, `codicon-clock`, `codicon-list-unordered`)
- A label describing the operation
- Relevant detail (task_id, title, task list)

Titles are rendered as `title ?? task_id` — the UI gracefully handles missing titles.

---

## Resource Limits

```typescript
interface TaskResourceLimits {
	maxConcurrentActive: number // Default: 3 (prevent API rate limits)
	maxConcurrentStreaming: number // Default: 2 (memory/bandwidth)
}
```

- `maxConcurrentActive` caps the number of simultaneously running tasks (focused + background).
- Background tasks yield to the focused task for API throughput.
- Background tasks use 0ms `statusMutationTimeout` (immediate state changes) vs. 2000ms for focused tasks, ensuring responsive state indicators.

---

## Background Task Behavior

When a task is **not focused** but **active**:

1. **Auto-approve mode**: If the task has `alwaysAllow*` settings, it continues autonomously.
2. **Needs input**: Emits `TaskInteractive` event → notification badge appears in the UI.
3. **API streaming**: Continues receiving chunks, updating task state.
4. **Tool execution**: Runs tools that don't require approval.
5. **State persistence**: Saves progress continuously (crash recovery).

### `statusMutationTimeout` debouncing

To prevent UI flickering, `Task.ts` uses a timeout before emitting state change events:

- **Focused tasks**: 2000ms delay (avoids rapid state toggles during streaming).
- **Background tasks**: 0ms delay (immediate) for responsive TaskSelector indicators.

---

## Edge Cases

### Parent completes before child

If the parent calls `attempt_completion` while background children are running, all pending children are aborted automatically. Children cannot outlive their parent.

### Parent aborted while child running

Children are aborted automatically (see Abort Propagation above).

### Child needs user input

The child emits `TaskInteractive`, which `TaskManager` catches and translates into a notification. `check_task_status` returns `status: "waiting"`. The parent must either switch focus to the child (to approve/reject) or let it time out.

### Orphaned children

Children are aborted when the parent completes (via `Task.abortBackgroundChildren()` called by `AttemptCompletionTool`) or when the parent is aborted (via `TaskManager`'s abort handler). If a parent is force-killed (crash), children tracked by `TaskManager` continue running independently until they complete or the user intervenes — they will be marked as errored on next restore if still alive.

### Duplicate `attempt_completion` after delegation resume

When a parent resumes from synchronous delegation, the LLM may generate multiple `attempt_completion` calls in a single streaming response. A `didExecuteAttemptCompletion` flag on `Task` ensures only the first one executes; subsequent ones are skipped with an error `tool_result`.

### `switch_mode` from background tasks

`switch_mode` is task-scoped via [`handleModeSwitch`](../src/core/webview/ShoferProvider.ts) — it updates only the calling task's `_taskMode` and history item. It does not emit `ModeChanged` on the provider, switch API profiles, or call `postStateToWebview`. User-driven mode switches (from the UI mode picker) use [`handleUserModeSwitch`](../src/core/webview/ShoferProvider.ts), which retains the full provider-level behavior including API profile switching and webview updates.

---

## State Restore on Restart

On extension restart:

1. `TaskManager.restoreManagedTasks(history)` rehydrates the managed-task map from persisted history.
2. `sanitizeRestoredState` downgrades any transient lifecycle (`running`, `waiting_input`) to `idle` — those values can never be true after a restart since no live `Task` instance exists.
3. A private `restored` flag gates methods that depend on restoration having completed (`registerBackgroundTask`, etc.).

Task instances are **not** automatically rehydrated — tasks remain idle until the user explicitly loads them.

---

## Design Decisions

1. **`TaskHandle` stays minimal.** Identity + status + timing only. No title, no result caching. Title is read from `TaskManager` at query time; result is read from the child's persisted history.

2. **`backgroundChildren` lives on `Task`, not `TaskManager`.** Each parent tracks its own children. This keeps the parent-child relationship scoped and avoids global bookkeeping.

3. **Background children are always registered in `TaskManager`.** Even though tracking lives on `Task`, `TaskManager` registration ensures state indicators and notifications propagate to the UI.

4. **No automatic parent resume for background children.** The parent explicitly polls via `check_task_status` or blocks via `wait_for_task`. This gives the LLM full control over when to collect results.

5. **Sync `new_task` must be called alone.** The model instruction enforces single-tool-per-turn for synchronous delegation to prevent the parent from issuing conflicting tool calls while the child runs.

6. **`alwaysAllow*` inheritance.** Background children inherit the parent's `alwaysAllow*` settings. Mode is specified by the caller; if not provided, defaults to the parent's current mode.

7. **Children are aborted when parent terminates.** `AttemptCompletionTool` explicitly calls `Task.abortBackgroundChildren()` before completing the parent. `TaskManager`'s abort handler similarly cleans up children when a parent is stopped. No child outlives its parent in normal operation.

---

## Related Documents

- [`native_tools.md`](native_tools.md) — Complete tool reference with parameter schemas
- [`task_states.md`](task_states.md) — Task lifecycle state model and visual mapping
- [`todos/done/Shofer-async-newtask.md`](../../../todos/done/Shofer-async-newtask.md) — Original async `new_task` design proposal
- [`todos/done/Shofer-parallel-tasks.md`](../../../todos/done/Shofer-parallel-tasks.md) — Parallel task execution implementation plan
- [`todos/done/shofer-background-task-titles.md`](../../../todos/done/shofer-background-task-titles.md) — Title propagation design for background task tools
