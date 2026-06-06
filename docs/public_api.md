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

The [CLI (`apps/cli/`)](headless.md) does **not** use the public extension API.
It loads the entire Shofer extension bundle headlessly via a vscode-shim mock
layer and calls `activate()` directly. Companion extensions (like the
orchestrator) use `vscode.extensions.getExtension('shoferdev.shofer').exports`
and the `ShoferAPI` interface documented here.

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
