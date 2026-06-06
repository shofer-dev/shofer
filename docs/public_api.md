# Shofer Public Extension API

Shofer exposes a public API surface that companion VSCode extensions can consume
to programmatically control tasks, subscribe to events, and manage configuration.
This is the **same API** returned by Shofer's `activate()` function and accessed
via [`vscode.extensions.getExtension('shoferdev.shofer').exports`](https://code.visualstudio.com/api/references/vscode-api#extensions).

The canonical source of truth for the interface is
[`packages/types/src/api.ts`](../packages/types/src/api.ts); the canonical
implementation is [`src/extension/api.ts`](../src/extension/api.ts).

## Quick Start

```typescript
import * as vscode from "vscode"

const shoferExtension = vscode.extensions.getExtension("shoferdev.shofer")
if (!shoferExtension) {
	throw new Error("Shofer extension not installed")
}

// Activate if not already active
if (!shoferExtension.isActive) {
	await shoferExtension.activate()
}

const shoferApi = shoferExtension.exports as ShoferAPI
```

## API Reference

### Task Management

| Method                                                    | Signature                                                | Description                                                                                              |
| --------------------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| [`startNewTask`](../packages/types/src/api.ts:18)         | `(options) => Promise<string>`                           | Creates a new task with an optional initial prompt. Returns the task ID.                                 |
| [`resumeTask`](../packages/types/src/api.ts:34)           | `(taskId: string) => Promise<void>`                      | Resumes a previously-created task by ID. Throws if not found.                                            |
| [`clearCurrentTask`](../packages/types/src/api.ts:49)     | `(lastMessage?: string) => Promise<void>`                | Dismisses the current task from the stack.                                                               |
| [`cancelCurrentTask`](../packages/types/src/api.ts:53)    | `() => Promise<void>`                                    | Cancels the currently active task (Stop button equivalent).                                              |
| [`sendMessage`](../packages/types/src/api.ts:59)          | `(message?: string, images?: string[]) => Promise<void>` | Sends a follow-up message to the active task. Images should be data URIs (`data:image/webp;base64,...`). |
| [`pressPrimaryButton`](../packages/types/src/api.ts:63)   | `() => Promise<void>`                                    | Presses the primary (Accept/Approve) button in the chat UI.                                              |
| [`pressSecondaryButton`](../packages/types/src/api.ts:67) | `() => Promise<void>`                                    | Presses the secondary (Reject/Cancel) button in the chat UI.                                             |
| [`isReady`](../packages/types/src/api.ts:71)              | `() => boolean`                                          | Returns `true` when the Shofer webview has launched and the API is usable.                               |
| [`deleteQueuedMessage`](../packages/types/src/api.ts:61)  | `(messageId: string) => void`                            | Removes a queued message by ID from the current task's message queue.                                    |

#### `startNewTask` Options

```typescript
{
    configuration?: ShoferSettings  // Partial settings to apply for this task
    text?: string                   // Initial prompt text
    images?: string[]               // Image data URIs
    newTab?: boolean                // Open in a new VS Code tab (vs. reusing sidebar)
}
```

### Task History Queries

| Method                                                   | Signature                              | Description                                                         |
| -------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------- |
| [`isTaskInHistory`](../packages/types/src/api.ts:40)     | `(taskId: string) => Promise<boolean>` | Checks whether a task with the given ID exists in the task history. |
| [`getCurrentTaskStack`](../packages/types/src/api.ts:45) | `() => string[]`                       | Returns the current task stack as an array of task IDs.             |

### Task History & Management (TaskSelector parity)

The following methods provide programmatic access to every action available in the
TaskSelector UI panel — listing, switching, renaming, archiving, pinning, and
deleting tasks.

| Method                                                | Signature                                     | Description                                                                                              |
| ----------------------------------------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| [`getTaskHistoryItems`](../packages/types/src/api.ts) | `() => HistoryItem[]`                         | Returns all task history items as a flat array (backing data for the TaskSelector panel).                |
| [`showTaskWithId`](../packages/types/src/api.ts)      | `(taskId, opts?) => Promise<void>`            | Switches the active task. In VSCode loads into the chat view; in headless creates on the internal stack. |
| [`renameTask`](../packages/types/src/api.ts)          | `(taskId, name) => Promise<void>`             | Renames a task by ID (updates the display name in TaskSelector and HistoryView).                         |
| [`archiveTask`](../packages/types/src/api.ts)         | `(taskId) => Promise<void>`                   | Archives a task (moves to the "Archived" collapsible section).                                           |
| [`unarchiveTask`](../packages/types/src/api.ts)       | `(taskId) => Promise<void>`                   | Unarchives a previously archived task.                                                                   |
| [`pinTask`](../packages/types/src/api.ts)             | `(taskId) => Promise<void>`                   | Pins a task (shows at the top of the task list).                                                         |
| [`unpinTask`](../packages/types/src/api.ts)           | `(taskId) => Promise<void>`                   | Unpins a previously pinned task.                                                                         |
| [`deleteTask`](../packages/types/src/api.ts)          | `(taskId, cascadeSubtasks?) => Promise<void>` | Deletes a task and (optionally) all its subtasks from history, disk, and memory.                         |

### Task Export (inline / data-returning)

These methods return the export content inline instead of saving to a file,
enabling programmatic consumption from CLI, companion extensions, and
orchestration workflows.

| Method                                                  | Signature                                      | Description                                                                                             |
| ------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| [`getTaskMarkdownExport`](../packages/types/src/api.ts) | `(taskId) => Promise<string>`                  | Returns the markdown-formatted task conversation as a string (same content as `exportTaskWithId` file). |
| [`getTaskJsonExport`](../packages/types/src/api.ts)     | `(taskId) => Promise<Record<string, unknown>>` | Returns the structured JSON trace (calls, cost, token usage, tool metadata) as an object.               |

### Logging

| Method                                          | Signature                       | Description                                                                                  |
| ----------------------------------------------- | ------------------------------- | -------------------------------------------------------------------------------------------- |
| [`getOutputLogs`](../packages/types/src/api.ts) | `(maxLines?: number) => string` | Returns the most recent lines from the extension's output channel buffer (up to 5000 lines). |

### Configuration Import/Export

| Method                                                | Signature                         | Description                                                                                                       |
| ----------------------------------------------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| [`exportConfiguration`](../packages/types/src/api.ts) | `() => string`                    | Exports the full Shofer configuration (except secrets) as a JSON string for transfer or backup.                   |
| [`importConfiguration`](../packages/types/src/api.ts) | `(json: string) => Promise<void>` | Imports a configuration from a JSON string (previously obtained via `exportConfiguration`). Applies and persists. |

### Configuration

| Method                                                | Signature                                   | Description                                                       |
| ----------------------------------------------------- | ------------------------------------------- | ----------------------------------------------------------------- |
| [`getConfiguration`](../packages/types/src/api.ts:76) | `() => ShoferSettings`                      | Returns the full current configuration (all non-secret settings). |
| [`setConfiguration`](../packages/types/src/api.ts:81) | `(values: ShoferSettings) => Promise<void>` | Applies configuration changes and persists them.                  |

### Provider Profile Management

| Method                                                 | Signature                                                    | Description                                           |
| ------------------------------------------------------ | ------------------------------------------------------------ | ----------------------------------------------------- |
| [`getProfiles`](../packages/types/src/api.ts:86)       | `() => string[]`                                             | Lists all configured provider profile names.          |
| [`getProfileEntry`](../packages/types/src/api.ts:92)   | `(name: string) => ProviderSettingsEntry \| undefined`       | Returns a single profile entry by name.               |
| [`createProfile`](../packages/types/src/api.ts:101)    | `(name, profile?, activate?) => Promise<string>`             | Creates a new profile. Throws if name already exists. |
| [`updateProfile`](../packages/types/src/api.ts:110)    | `(name, profile, activate?) => Promise<string \| undefined>` | Updates an existing profile. Throws if not found.     |
| [`upsertProfile`](../packages/types/src/api.ts:118)    | `(name, profile, activate?) => Promise<string \| undefined>` | Creates or updates a profile.                         |
| [`deleteProfile`](../packages/types/src/api.ts:124)    | `(name: string) => Promise<void>`                            | Deletes a profile by name. Throws if not found.       |
| [`getActiveProfile`](../packages/types/src/api.ts:129) | `() => string \| undefined`                                  | Returns the name of the currently active profile.     |
| [`setActiveProfile`](../packages/types/src/api.ts:135) | `(name: string) => Promise<string \| undefined>`             | Switches the active profile.                          |

## Events

The `ShoferAPI` extends Node.js `EventEmitter`. Subscribe with
`api.on(eventName, listener)` and unsubscribe with
`api.off(eventName, listener)`.

All event names are defined in the [`ShoferEventName`](../packages/types/src/events.ts:12) enum.
The payload for each event is typed via Zod schemas in
[`ShoferEvents`](../packages/types/src/events.ts:65).

### Task Provider Lifecycle

| Event                                               | Payload            | Description                                                                                                                        |
| --------------------------------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| [`taskCreated`](../packages/types/src/events.ts:14) | `[taskId: string]` | Emitted when a new task is created. **Subscribe to this to bind per-task events** (see [Per-Task Events](#per-task-events) below). |

### Task Lifecycle

| Event                                                   | Payload                                                  | Description                                                                             |
| ------------------------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| [`taskStarted`](../packages/types/src/events.ts:18)     | `[taskId: string]`                                       | Task has started executing.                                                             |
| [`taskCompleted`](../packages/types/src/events.ts:19)   | `[taskId, tokenUsage, toolUsage, { rating, isSubtask }]` | Task finished successfully.                                                             |
| [`taskAborted`](../packages/types/src/events.ts:21)     | `[taskId, { reason }]`                                   | Task was aborted. `reason` is one of `"user"`, `"completed"`, `"error"`, `"abandoned"`. |
| [`taskError`](../packages/types/src/events.ts:20)       | `[taskId, errorType]`                                    | Task encountered an error.                                                              |
| [`taskFocused`](../packages/types/src/events.ts:22)     | `[taskId: string]`                                       | Task gained focus.                                                                      |
| [`taskUnfocused`](../packages/types/src/events.ts:23)   | `[taskId: string]`                                       | Task lost focus.                                                                        |
| [`taskActive`](../packages/types/src/events.ts:24)      | `[taskId: string]`                                       | Task is actively running.                                                               |
| [`taskInteractive`](../packages/types/src/events.ts:25) | `[taskId: string]`                                       | Task is awaiting user interaction (ask/approval).                                       |
| [`taskResumable`](../packages/types/src/events.ts:26)   | `[taskId: string]`                                       | Task can be resumed.                                                                    |
| [`taskIdle`](../packages/types/src/events.ts:27)        | `[taskId: string]`                                       | Task is idle.                                                                           |

### Subtask Lifecycle

| Event                                                           | Payload                                | Description                           |
| --------------------------------------------------------------- | -------------------------------------- | ------------------------------------- |
| [`taskPaused`](../packages/types/src/events.ts:30)              | `[taskId: string]`                     | Parent task paused for delegation.    |
| [`taskUnpaused`](../packages/types/src/events.ts:31)            | `[taskId: string]`                     | Parent task resumed after delegation. |
| [`taskSpawned`](../packages/types/src/events.ts:32)             | `[parentTaskId, childTaskId]`          | A subtask was spawned.                |
| [`taskDelegated`](../packages/types/src/events.ts:33)           | `[parentTaskId, childTaskId]`          | Parent delegated work to a child.     |
| [`taskDelegationCompleted`](../packages/types/src/events.ts:34) | `[parentTaskId, childTaskId, summary]` | Delegated child completed.            |
| [`taskDelegationResumed`](../packages/types/src/events.ts:35)   | `[parentTaskId, childTaskId]`          | Parent resumed after delegation.      |

### Task Execution

| Event                                                         | Payload                         | Description                                                                                                                                      |
| ------------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`message`](../packages/types/src/events.ts:38)               | `[{ taskId, action, message }]` | A message was created or updated. `action` is `"created"` or `"updated"`. Contains the full [`ShoferMessage`](../packages/types/src/message.ts). |
| [`taskModeSwitched`](../packages/types/src/events.ts:39)      | `[taskId, mode]`                | Task mode changed.                                                                                                                               |
| [`taskAskResponded`](../packages/types/src/events.ts:40)      | `[taskId]`                      | User responded to an ask.                                                                                                                        |
| [`taskUserMessage`](../packages/types/src/events.ts:41)       | `[taskId]`                      | User sent a message.                                                                                                                             |
| [`queuedMessagesUpdated`](../packages/types/src/events.ts:42) | `[taskId, queuedMessages[]]`    | Queued messages for a task changed.                                                                                                              |

### Task Analytics

| Event                                                         | Payload                           | Description                   |
| ------------------------------------------------------------- | --------------------------------- | ----------------------------- |
| [`taskTokenUsageUpdated`](../packages/types/src/events.ts:45) | `[taskId, tokenUsage, toolUsage]` | Token usage counters updated. |
| [`taskToolFailed`](../packages/types/src/events.ts:46)        | `[taskId, toolName, error]`       | A tool execution failed.      |

### Configuration Changes

| Event                                                          | Payload                | Description                      |
| -------------------------------------------------------------- | ---------------------- | -------------------------------- |
| [`modeChanged`](../packages/types/src/events.ts:49)            | `[newMode: string]`    | Global mode changed.             |
| [`providerProfileChanged`](../packages/types/src/events.ts:50) | `[{ name, provider }]` | Active provider profile changed. |

### Per-Task Events

Most events are emitted on individual `Task` instances rather than the top-level
API. To receive per-task events, listen for `taskCreated` and then bind to the
created task:

```typescript
shoferApi.on("taskCreated", (taskId) => {
	// The task instance is accessible internally but not re-emitted
	// through the public API directly. Listen on the API for task-level
	// events which include taskId in the payload.
})

// Task-level events are re-emitted on the API with taskId:
shoferApi.on("taskStarted", (taskId) => {
	/* ... */
})
shoferApi.on("taskCompleted", (taskId, tokenUsage, toolUsage, info) => {
	/* ... */
})
shoferApi.on("message", ({ taskId, action, message }) => {
	/* ... */
})
```

## Reference Consumer: Arkware Orchestrator

The [`arkware-orchestrator`](../../orchestrator/) extension is the canonical
consumer of the public API. Its [`main.ts`](../../orchestrator/src/main.ts:96)
demonstrates:

- Acquiring the API via `vscode.extensions.getExtension('shoferdev.shofer')`
- Subscribing to all 27 events via `api.on(eventName, listener)`
- Starting tasks via `api.startNewTask({ text, configuration })`
- Sending follow-up messages via `api.sendMessage(text)`
- Cancelling tasks via `api.cancelCurrentTask()`
- Approving actions via `api.pressPrimaryButton()`

## Relationship to CLI

The [CLI (`apps/cli/`)](headless.md) and companion extensions **both use the same
`ShoferAPI` interface** as their control plane. The CLI calls `activate()` which
returns a `ShoferAPI` instance, then delegates all task management, configuration,
profile operations, and event subscriptions through it. Companion extensions
acquire the same API via `vscode.extensions.getExtension('shoferdev.shofer').exports`.

The ShoferAPI is the **single unified interface** for programmatically controlling
Shofer — regardless of whether the consumer is a headless CLI process, a companion
VSCode extension, or an external IPC client.

### CLI Log Access

The CLI (and any headless consumer) can read Shofer's runtime logs via
`api.getOutputLogs()`. The logs are sourced from the same in-memory ring buffer
that feeds the VSCode Output Channel panel, so the CLI sees the same diagnostics
that a VSCode user would see. The ring buffer holds up to 5000 lines of
human-readable log output.

### CLI Configuration Management

The CLI can export and import the full Shofer configuration:

```typescript
// Export current configuration (without secrets)
const configJson = api.exportConfiguration()
// → Save to file, transfer to another instance, etc.

// Import configuration
await api.importConfiguration(configJson)
```

The `importConfiguration` method validates the JSON and applies all settings
via the same `ContextProxy.setValues()` path used by the Settings UI.

### Workflow Management

| Method                                              | Signature                                       | Description                                                                                                                                                         |
| --------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`createWorkflow`](../packages/types/src/api.ts)    | `(slangSource, flowParams?) => Promise<string>` | Creates and starts a Slang workflow from a `.slang` source string. Parses, validates, and launches the WorkflowTask.                                                |
| [`discoverWorkflows`](../packages/types/src/api.ts) | `() => Promise<Map<string, string>>`            | Discovers available Slang workflows from the project's `.shofer/workflows/` and the user's `~/.shofer/workflows/` directories. Returns a map of flow name → source. |

### Consumer SDK

The CLI's [`ExtensionClient`](../apps/cli/src/agent/extension-client.ts) is
importable by other workspace packages as:

```typescript
import { ExtensionClient } from "@shofer/cli/client"
```

It provides a high-level state machine (`AgentLoopState`) over ShoferEvents and
WebviewMessage protocols. Companion extensions can use it instead of wiring
`api.on(event, ...)` listeners directly.

## Key Files

| File                                                                                    | Role                                                 |
| --------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| [`packages/types/src/api.ts`](../packages/types/src/api.ts)                             | `ShoferAPI` interface definition                     |
| [`packages/types/src/events.ts`](../packages/types/src/events.ts)                       | `ShoferEventName` enum + `ShoferEvents` type schemas |
| [`packages/types/src/global-settings.ts`](../packages/types/src/global-settings.ts)     | `ShoferSettings` type                                |
| [`packages/types/src/provider-settings.ts`](../packages/types/src/provider-settings.ts) | `ProviderSettings` / `ProviderSettingsEntry` types   |
| [`src/extension/api.ts`](../src/extension/api.ts)                                       | `API` class — implementation of `ShoferAPI`          |
| [`src/extension.ts`](../src/extension.ts:457)                                           | Returns `new API(...)` from `activate()`             |
| [`apps/cli/src/agent/extension-host.ts`](../apps/cli/src/agent/extension-host.ts)       | CLI consumer of `ShoferAPI`                          |
| [`apps/cli/src/agent/extension-client.ts`](../apps/cli/src/agent/extension-client.ts)   | Reusable state-machine SDK over ShoferEvents         |
| [`extensions/orchestrator/src/main.ts`](../../orchestrator/src/main.ts)                 | Reference consumer of the public API                 |

## Key Files

| File                                                                                    | Role                                                 |
| --------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| [`packages/types/src/api.ts`](../packages/types/src/api.ts)                             | `ShoferAPI` interface definition                     |
| [`packages/types/src/events.ts`](../packages/types/src/events.ts)                       | `ShoferEventName` enum + `ShoferEvents` type schemas |
| [`packages/types/src/global-settings.ts`](../packages/types/src/global-settings.ts)     | `ShoferSettings` type                                |
| [`packages/types/src/provider-settings.ts`](../packages/types/src/provider-settings.ts) | `ProviderSettings` / `ProviderSettingsEntry` types   |
| [`src/extension/api.ts`](../src/extension/api.ts)                                       | `API` class — implementation of `ShoferAPI`          |
| [`src/extension.ts`](../src/extension.ts:457)                                           | Returns `new API(...)` from `activate()`             |
| [`extensions/orchestrator/src/main.ts`](../../orchestrator/src/main.ts)                 | Reference consumer of the public API                 |
