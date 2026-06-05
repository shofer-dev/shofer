# Inter-Task Peer Messaging

Design for direct communication between tasks sharing the same root task, enabling A2A-style collaboration without routing through the parent.

## Motivation

Today, tasks spawned under the same root task are isolated except for the parent→child orchestration path (`check_task_status`, `wait_for_task`, `cancel_tasks`). A background child analyzing `file1.ts` cannot discover that another child is analyzing `file2.ts`, share findings, or coordinate work. The parent must manually relay information — a bottleneck that doesn't scale.

Peer messaging enables:

- **Notification-style communication:** Task A sends a fire-and-forget message to task B (e.g., "I found a bug in the auth module — heads up").
- **Request-response coordination:** Task A asks task B for its findings on a shared dependency and blocks until B responds or times out.
- **Sibling discovery:** Any task can list and inspect all tasks under the same root, not just its own direct children.

## Scope: Same Root Task

Peer communication is scoped to tasks sharing the same [`rootTaskId`](parallelism.md#task). A task's `rootTaskId` is immutable — set at construction from [`TaskOptions.rootTask?.taskId`](../src/core/task/Task.ts:732) and persisted in [`HistoryItem`](../packages/types/src/history.ts). Tasks without a `rootTaskId` (top-level tasks not spawned via `new_task`) are not eligible for peer messaging.

The [`TaskManager`](../src/services/task-manager/TaskManager.ts) already maintains the centralized registry of all live tasks (`activeTasks` and `managedTasks` maps). Peer tools query this registry filtered by `rootTaskId`, removing the `backgroundChildren` gating that limits current tools to direct children only.

> **Background-task requirement:** sharing a `rootTaskId` makes a task _visible_ to the read-only peer tools (`list_background_tasks`, `check_task_status`, `wait_for_task`), but the **active** flow — `send_message_to_task` — additionally requires both participants to be **background (async) tasks**. A foreground/blocking subtask has a `rootTaskId` too, but its parent is hard-suspended awaiting it, so it is not a concurrent peer. See [Background-task precondition](#background-task-precondition).

```
Root Task (task-0)
├── task-1 (child, can message task-2, task-3)
├── task-2 (child, can message task-1, task-3)
│   └── task-4 (grandchild, can message task-1, task-2, task-3)
└── task-3 (child, can message task-1, task-2, task-4)
```

All four children are peers under the same root. Grandchildren are peers with their aunts/uncles.

## Tool Changes Summary

| Tool                          | Change                                                                                                                |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `list_background_tasks`       | Extended: optional `scope` parameter to filter "children" (default, backward compat) or "peers" (all same-root tasks) |
| `check_task_status`           | Gate relaxed: accepts any same-root task ID, not just direct children                                                 |
| `wait_for_task`               | Gate relaxed: same as above                                                                                           |
| `cancel_tasks`                | **No change** — remains parent-only                                                                                   |
| `send_message_to_task`        | **New** — async (fire-and-forget) or sync (blocking with timeout)                                                     |
| `peer_task_ids` on `new_task` | **New** — optional opt-in scope restrictor for the spawned child                                                      |

> **Naming note:** `list_background_tasks` is named for _background children_, but `scope="peers"` returns same-root siblings that are not necessarily this task's background children. The name is retained for backward compatibility, but the `scope` parameter and the tool's description string MUST make the broadened semantics explicit so the model does not assume the result is limited to its own children.

> **Plumbing note:** `send_message_to_task` is a new native tool. Adding it is a coordinated multi-file change (schema → `ToolName` → `BaseTool` subclass → router/parser → `ShoferSayTool` + `ChatRow` + i18n). See [Native Tool Plumbing](#native-tool-plumbing) below and follow [`docs/adding-new-tools.md`](adding-new-tools.md) rather than copying older tools.

---

## `list_background_tasks` — Extended

Existing tool (always available, auto-approved). Extended with an optional `scope` parameter.

### Parameters

| Param   | Type                              | Required | Description                                                                                                                              |
| ------- | --------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `scope` | `"children"` \| `"peers"` \| null | –        | `"children"` (default): direct children only, existing behavior. `"peers"`: all tasks sharing the caller's `rootTaskId`, excluding self. |

### Implementation

- **`scope = "children"` (default):** Unchanged — iterates `Task.backgroundChildren`.
- **`scope = "peers"`:** Filters [`TaskManager.getManagedTasks()`](../src/services/task-manager/TaskManager.ts:315) by `rootTaskId === caller.rootTaskId && taskId !== caller.taskId`. Enriches each entry with the title from `ManagedTask.name` and the status from `ManagedTask.state.lifecycle`.

### Returns (peers scope)

```json
[
	{ "task_id": "task-1", "title": "Analyze auth module", "status": "running", "created_at": 1717000000000 },
	{ "task_id": "task-3", "title": "Fix CSS layout", "status": "completed", "created_at": 1717000001000 }
]
```

---

## `check_task_status` — Gate Relaxed

Currently gated at [`CheckTaskStatusTool.ts:41`](../src/core/tools/CheckTaskStatusTool.ts:41) via `task.backgroundChildren.get(task_id)`. This rejects any task ID that isn't a direct child.

### Change

Replace the gate with a `rootTaskId` scope check:

1. If `task_id` is a direct child → proceed as before (fast path via `TaskHandle`).
2. Else if `task_id` shares `caller.rootTaskId` → proceed with the same status-resolution logic (persisted history → live instance fallback). No `TaskHandle` is consulted; status comes from [`TaskManager.getManagedTask(task_id)?.state.lifecycle`](../src/services/task-manager/TaskManager.ts:331) and persisted history.
3. Else → error: "Task not found or not a peer."

The opt-in `peer_task_ids` scope (if set on the caller) is checked at step 2 — if `task_id` is not in the allowed set, reject.

### Behavior unchanged

- `include_activity` still works (reads task messages from disk).
- Pending parent questions still surfaced.
- Completed/errored results still returned from persisted history.

---

## `wait_for_task` — Gate Relaxed

Same principle as `check_task_status`. Currently gated at [`WaitForTaskTool.ts:49`](../src/core/tools/WaitForTaskTool.ts:49) via `task.backgroundChildren.get(id)`.

### Change

Accept any `task_id` sharing the caller's `rootTaskId`. For non-child peers, the tool listens for [`TaskManager` events](../src/services/task-manager/TaskManager.ts:48-61) (`managedTask:completed`, `managedTask:error`) keyed on the target task ID, exactly as it does today for children.

### Non-terminal peers

Unlike a direct child — which a parent typically waits on through to completion — a peer may already be in a non-terminal _resting_ state (`idle`/`interactive`/`resumable`) that produces no further `managedTask:*` lifecycle transitions. The wait MUST therefore also resolve on the **current** peer state read from [`TaskManager.getManagedTask(task_id)?.state.lifecycle`](../src/services/task-manager/TaskManager.ts:331) at entry: if the peer is already terminal, return immediately; if it is in a resting state, the tool returns that status (it does not block forever waiting for a transition that will never come). Blocking is only meaningful while the peer is `running`.

### Cancellation

The blocking wait MUST be cancellable via an `AbortSignal` threaded from the caller's tool loop (per the repo Cooperative Cancellation Rule), so a Stop on the waiting task tears down the event listeners and timer instead of leaking them.

### Timeout

Unchanged — `timeout` parameter (default 120s) returns current statuses if the condition isn't met.

---

## `cancel_tasks` — No Change

`cancel_tasks` remains **parent-only**. Only direct children tracked in `backgroundChildren` can be cancelled. The rationale:

- A parent owns its children and is responsible for their lifecycle.
- Allowing a sibling to cancel another sibling introduces unexpected termination — task B could cancel task A without A's "consent."
- If a peer is genuinely stuck, the parent remains the natural escalation path.

---

## `send_message_to_task` — New

Always-available tool. Sends a message to a peer task. Two modes: async (fire-and-forget) and sync (blocking with mandatory timeout).

### Parameters

| Param         | Type            | Required | Description                                                                                           |
| ------------- | --------------- | -------- | ----------------------------------------------------------------------------------------------------- |
| `task_id`     | string          | ✅       | Target peer task ID (must share the caller's `rootTaskId`)                                            |
| `message`     | string          | ✅       | The message to deliver                                                                                |
| `wait`        | boolean \| null | –        | When `true`, block until the recipient responds or timeout expires. Default: `false` (async).         |
| `timeout_sec` | number \| null  | –        | Maximum seconds to wait when `wait=true`. Default: 120. **Mandatory for sync mode** — always applied. |

### Scope validation

1. `caller.rootTaskId` must be set (not a top-level task).
2. `target.rootTaskId === caller.rootTaskId`.
3. `target.taskId !== caller.taskId`.
4. If the caller has `knownPeers` set (opt-in scope from `peer_task_ids`), `task_id` must be in that set.
5. **Both `caller` and `target` must be background tasks** (`isBackgroundTask === true`). See [Background-task precondition](#background-task-precondition).

#### Background-task precondition

`send_message_to_task` requires **both** the caller and the target to be **background (async) tasks** (`isBackgroundTask === true`, set when spawned with `new_task(is_background=true)`). Sharing a `rootTaskId` is necessary but **not sufficient**: a _foreground/blocking_ subtask also has a `rootTaskId`, yet its parent is **hard-suspended inside the `new_task` await** for the entire duration of its run. That hard-suspension breaks the three flows peer messaging depends on:

- **Concurrency.** Peer messaging presupposes peers running _at the same time_. A foreground subtask is the single task its parent is blocked on — there is no concurrently-scheduled sibling to send to it or receive from it. The "siblings exchange messages while both run" model **is** the background-task model.
- **Escalation-up.** A foreground recipient cannot escalate an `ask_followup_question` to its (blocked) parent — the question falls through to the user (see [`ask_followup_question` from a task in a peer exchange](#ask_followup_question-from-a-task-in-a-peer-exchange)). A recipient that may need to consult its supervisor while serving a peer prompt MUST therefore be a background task.
- **No nested-block deadlocks.** A foreground sender issuing a _sync_ send blocks itself while its own parent is already blocked on it, stacking two suspensions and widening the deadlock surface — the sender can no longer be reached by anyone trying to unblock it.

The same `isBackgroundTask` flag that gates `ask_followup_question` routing-to-parent thus gates participation in peer messaging: a task that is not independently schedulable is neither a reachable recipient nor a safe sync sender. A caller or target failing this check is rejected synchronously — `Error: Peer messaging requires both tasks to be background tasks.`

### Async mode (`wait = false`, default)

Fire-and-forget from the **sender's** perspective: the tool returns immediately and never blocks. How the _recipient_ perceives the message depends only on whether the recipient is busy (see [Recipient delivery model](#recipient-delivery-model) below), **not** on the async/sync flag. Async and sync differ exclusively in whether the sender blocks awaiting a response.

1. The message is recorded as a `PendingPeerMessage` (resolved sender title from `TaskManager` at send time):
    ```typescript
    interface PendingPeerMessage {
    	senderTaskId: string
    	senderTitle: string
    	message: string
    	timestamp: number
    }
    ```
2. Delivery form is chosen by the recipient's runtime state per the Recipient delivery model. If the recipient is mid-turn, the message is injected into its system prompt as a lightweight notification:

    ```
    ====

    PEER MESSAGE from task <sender_task_id> ("<sender_title>"):
    <message>

    You may respond using send_message_to_task(task_id="<sender_task_id>", message=...).
    This is a notification — no response is required. If the message is not urgent,
    you may finish your current work first and respond later.
    ```

    If the recipient is **not** busy (`completed`/`idle`/`paused`), the same message is instead enqueued as an explicit annotated user-turn that wakes the task — identical in form to a sync `PEER PROMPT` (minus the "sender is blocked" line). From the recipient's point of view, an async message to a non-busy peer behaves exactly like a sync one.

3. Once delivered, the message is cleared (delivered once per message).

The sender receives immediate confirmation:

```
Message sent to task <task_id> ("<title>"). Delivery: on the recipient's next turn (resuming it if idle).
```

**Response mechanism differs by mode.** There is no `respond_to_peer` tool:

- **Async** has no blocking sender, so a "response" is optional and is just a fresh `send_message_to_task` notification from B back to A (the sender's `task_id` is in the delivered prompt, so B knows whom to address).
- **Sync** responses are **not** sent via `send_message_to_task`. The recipient answers by calling **`attempt_completion`**, and its result is routed back to **whoever initiated the prompt** — peer or parent — via the initiator-addressed result-resolver (see [Sync mode](#sync-mode-wait--true) and [Sync response routing](#sync-response-routing-initiator-addressed)).

#### Recipient delivery model

The async/sync flag is a **sender-side** property (does the sender block?). The **form** in which the recipient receives a message is decided independently, by whether the recipient is actively running a turn. This avoids the liveness trap where a passively system-prompt-injected message is never seen because the recipient never makes another API call. Resolve the recipient's state at send time from [`TaskManager.getManagedTask(task_id)`](../src/services/task-manager/TaskManager.ts:331):

| Recipient state at send time                           | Delivery form (same for async **and** sync)                                                                                                                                                                                                        |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `running` (live instance, mid-turn)                    | **System-prompt injection** for async (non-intrusive notification); **annotated user-turn** for sync (urgent). This is the _only_ row where async and sync differ in form, because there is already an in-flight turn to attach a notification to. |
| Not busy — `completed` / `idle` / `paused` (resumable) | **Explicit annotated user-turn** enqueued via the recipient's [`MessageQueueService`](../src/core/task/Task.ts:573), which wakes/resumes the task. Async and sync are identical here.                                                              |
| `error` (terminal, unrecoverable)                      | **Reject** for both modes — the tool returns `Error: Task <task_id> has errored.` An errored task cannot be meaningfully resumed, and the sender should know its recipient is broken rather than assume silent delivery.                           |
| No live instance AND no resumable history              | **Reject** for both modes — `Error: Task <task_id> is not reachable.`                                                                                                                                                                              |

> **Reject, don't drop:** when a recipient is unreachable (`error` or no resumable history), **both** async and sync `send_message_to_task` fail loud with an error result. Silently dropping an async message would leave the sender believing it was delivered; surfacing the error lets the sender react (retry a different peer, escalate to the parent, or adjust its plan).

> **Wake mechanism:** For any non-busy recipient, do **not** rely on system-prompt injection (which only lands on a turn that may never happen). Enqueue through the recipient's existing `MessageQueueService` — the same machinery user messages use (see [`message_queue.md`](message_queue.md)) — so delivery triggers the well-tested queue-drain → wake/resume → new-turn path. A `completed`/`paused` peer is resumed; an `idle` peer starts a fresh turn.

### Sync mode (`wait = true`)

Sync adds **sender-side blocking** on top of the same recipient delivery model. The sender blocks until the recipient explicitly responds or the timeout expires. The recipient always receives an explicit annotated user-turn (the `running` row's sync form, or the non-busy row — both are user-turns), so a sync request is never delivered as a silently-deferrable notification.

1. **Pre-check reachability** (Recipient delivery model). If the peer is in the `error` row or has no live instance and no resumable history, reject synchronously — never start the timeout clock for an undeliverable message.
2. **Timeout clock starts** once the message is queued, driven by an `AbortSignal`-backed timer (per the repo Cooperative Cancellation Rule) rather than a bare `setTimeout` reject.
3. The message is delivered as an **annotated user-turn** through the recipient's existing [`MessageQueueService`](../src/core/task/Task.ts:573), preserving sender metadata. Routing through the queue (instead of writing directly into the message array out-of-band) reuses the existing drain/`Task.ask()` machinery and avoids the dropped-message failure modes the Webview Send-Path Rule was written to prevent. **Capture the `QueuedMessage.id` returned by [`addMessage()`](../src/core/message-queue/MessageQueueService.ts:36)** so the sender can retract the prompt later. The queued user-turn reads:

    ```
    PEER PROMPT from task <sender_task_id> ("<sender_title>"):
    <message>

    This is a synchronous request. The sender is blocked waiting for your response.
    Provide your answer by calling attempt_completion — its result is returned to
    whoever initiated this prompt (the blocked sender, peer or parent). Calling
    attempt_completion completes this task.
    Timeout: <timeout_sec> seconds. If you do not respond in time, the request
    will be discarded and the sender will receive a timeout error.
    ```

4. If the recipient is not busy, enqueuing wakes/resumes it via the standard queue-drain path; if it is `running`, the prompt is consumed on its next turn boundary. Either way the recipient's LLM sees it as an immediate user-turn task to address.

5. The sender's `send_message_to_task` tool handler **awaits** a response promise stored alongside the message.

6. When the recipient calls **`attempt_completion`**, its result is delivered to **whoever initiated the prompt the recipient is currently answering** — the _initiator_ — which may be a **peer** (sync `send_message_to_task`) or the structural **parent** (`new_task`). The initiator is recorded per-prompt at delivery time and is routed by the recipient's `taskId`, **not** assumed to be `parentTaskId` (subject to `MAX_SUBTASK_RESULT_LENGTH`). The response promise resolves with that result, and the initiator's blocking tool handler returns it as `tool_result`. Because `attempt_completion` is a terminal, self-declared state (see [`task_states.md`](task_states.md)), answering a sync request **completes the recipient task** — so sync is naturally suited to peers that are idle/completed (resumed solely to serve the request) or spawned as dedicated responders. Sync-messaging a `running` peer will end that peer's in-flight work when it answers; prefer async for a peer you do not want to terminate. See [Sync response routing](#sync-response-routing-initiator-addressed) for the plumbing.

7. **On timeout or sender abort:** the `AbortSignal` fires and the sender attempts to retract the prompt via [`messageQueueService.removeMessage(id)`](../src/core/message-queue/MessageQueueService.ts:78) using the id captured in step 3:

    - **Still enqueued** (`removeMessage` returns `true`): the prompt is pulled from the queue and never reaches the recipient.
    - **Already consumed** (`removeMessage` returns `false`): `Task.ask()` already dequeued it and the recipient has seen the user-turn. It cannot be un-sent; if the recipient later replies, that reply is discarded because the sender's blocking call is gone.

    Either way the response promise is rejected and the sender receives:

    ```
    Error: No response from task <task_id> within <timeout_sec> seconds.
    ```

#### Why timeout discards the message

If the timeout fires, the sender has already moved on (the tool returned an error). Delivering the message anyway would be confusing — the recipient might respond to a request that is no longer relevant. Discarding is the safer default.

#### Sync response routing (initiator-addressed)

A sync request blocks its **initiator** until the recipient's next `attempt_completion`. The initiator may be a **peer** (sync `send_message_to_task`) or the structural **parent** (`new_task`); routing is uniform and keyed on the **recipient's `taskId`**, never on `parentTaskId`. The recipient's `attempt_completion` always delivers its result to whoever initiated the prompt it is currently answering.

**Existing plumbing (parent/child only).** Today the blocking-result path is:

- [`NewTaskTool`](../src/core/tools/NewTaskTool.ts:277) registers a resolver via `provider.registerBlockingChildResolver(child.taskId, resolve)` and `await`s the promise. The map [`blockingChildResolvers: Map<childTaskId, (result) => void>`](../src/core/webview/ShoferProvider.ts:178) is keyed by the **completing task's id** — already relationship-agnostic.
- On completion, [`AttemptCompletionTool.execute`](../src/core/tools/AttemptCompletionTool.ts:168) gates on `if (task.parentTaskId)` and calls [`resumeBlockingParent({ parentTaskId: task.parentTaskId, childTaskId, completionResult })`](../src/core/webview/ShoferProvider.ts:4339), which fires the resolver **and** rewrites `parentTaskId`'s history (`awaitingChildId`/`completedByChildId`) **and pops the child off `shoferStack`** to reveal the parent below it.

The resolver map already routes correctly to an arbitrary waiter; only the `parentTaskId` gate in `attempt_completion` and the stack/history bookkeeping in `resumeBlockingParent` assume the waiter is the structural parent sitting directly below the recipient in `shoferStack`.

**The human user is also a valid initiator.** A user can prompt or resume any task or subtask directly; that input flows through the **same Form B queue path** (`queueMessage` → `Task.ask()`) and does **not** register a sync resolver. Routing is therefore _presence-based_, not sender-identity-based: on `attempt_completion`, **if** a `pendingSyncResolvers[recipientTaskId]` entry exists, deliver the result to that task initiator (peer or parent); **otherwise** complete normally to the user via the existing completion UI (`say("completion_result")` + rating overlay). User input never registers, overrides, or clears a sync resolver, so a human prompting a task cannot hijack or break an outstanding peer/parent sync exchange, and a completion answering a user prompt always takes the no-resolver branch. See [User prompts a task involved in a sync exchange](#user-prompts-a-task-involved-in-a-sync-exchange).

**Generalization for peer initiators.** Three focused changes decouple routing from the parent/stack assumption — no second result-delivery mechanism is introduced:

1. **Record the initiator per prompt.** When a sync prompt is delivered — parent via `new_task`, or peer via sync `send_message_to_task` — register the resolver keyed by the **recipient's** `taskId` together with the **initiator's** `taskId`. Reuse the existing map, generalized to `pendingSyncResolvers: Map<recipientTaskId, { initiatorTaskId, resolve }>`. Exactly one sync prompt is in flight per recipient at a time (a second concurrent sync request to a busy-with-a-sync-prompt recipient is rejected, not queued).
2. **Route by recipient, not by parent.** `AttemptCompletionTool` looks up the pending resolver by **`task.taskId`** (the completing recipient) and fires it with the result. The `if (task.parentTaskId)` gate is replaced by "is there a pending sync resolver for my `taskId`?" — so a recipient whose structural parent is the Orchestrator can still return its verdict to a Coder **peer** that issued the prompt.
3. **Decouple bookkeeping from routing.** Run `resumeBlockingParent`'s stack-pop + parent-history rewrite **only when the initiator is the structural parent** (initiator `===` `parentTaskId`, and the recipient is the stack frame directly above it). For a **peer** initiator, skip the stack/history manipulation entirely and just fire the resolver — the peer initiator lives elsewhere in the task tree, not below the recipient in `shoferStack`.

---

## `peer_task_ids` on `new_task` — Opt-in Scope Restrictor

New optional parameter on [`NewTaskParams`](../src/core/tools/NewTaskTool.ts:16):

| Param           | Type             | Required | Description                                                                                                                                                                                                          |
| --------------- | ---------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `peer_task_ids` | string[] \| null | –        | If provided, restricts the spawned child's peer communication to only these task IDs (plus the parent and any tasks it itself spawns). If omitted/null, the child can communicate with any task under the same root. |

### Implementation

When set, the spawned child's `Task` instance stores `knownPeers: Set<string>` containing the union of:

- `peer_task_ids` (explicitly listed peers)
- The parent's `taskId` (always allowed)
- Any task the child itself spawns via `new_task` (dynamically added)

The "dynamically added" union member is mutated in the [`NewTaskTool`](../src/core/tools/NewTaskTool.ts) handler: when a task with a non-`undefined` `knownPeers` spawns a child, the new child's `taskId` is added to the spawner's `knownPeers` at spawn time. (Spawned children are also tracked in `backgroundChildIds`, but `knownPeers` is the scope-authority for peer tools and must be updated explicitly.)

`peer_task_ids` values SHOULD be validated at spawn time: each listed id must correspond to an existing task sharing the spawner's `rootTaskId`. Unknown ids are rejected (fail loud) rather than silently producing an over-restrictive scope that fails opaquely on a later `send_message_to_task`.

Peer tools (`check_task_status`, `wait_for_task`, `send_message_to_task`, `list_background_tasks` with `scope=peers`) consult `knownPeers` before allowing access. If `knownPeers` is `undefined`, no restriction applies (full peer access).

---

## Delivery Mechanics

Delivery form is chosen by the recipient's runtime state, **not** by the async/sync flag (see [Recipient delivery model](#recipient-delivery-model)). There are exactly two delivery forms.

### Form A: System-prompt injection (busy recipient, async only)

Used only when the recipient is mid-turn **and** the message is async. The message rides along in the recipient's system prompt on the in-flight/next API call — modeled after the existing subtask-constraints injection at [`Task.ts:5426-5471`](../src/core/task/Task.ts:5426).

Key properties:

- **Zero additional round-trips.** The message is present when the LLM reads context.
- **LLM-controlled prioritization.** The recipient sees the notification on its next thinking turn and may respond now, finish current work first, or ignore it.
- **Delivered once.** After injection, the message is cleared. If the API call fails, the message is re-queued for the retry.

### Form B: Annotated user-turn (sync, or any non-busy recipient)

Used for **all** sync messages, and for **any** message (async or sync) to a non-busy recipient (`completed`/`idle`/`paused`). The message enters the recipient's input as an explicit user-turn via the **same `queueMessage` → `Task.ask()` drain path** that user-typed messages use — concretely [`messageQueueService.addMessage(text, images)`](../src/core/message-queue/MessageQueueService.ts:36) (the enqueue behind the `queueMessage` webview message at [`webviewMessageHandler.ts:3560`](../src/core/webview/webviewMessageHandler.ts:3560)), drained by [`Task.ask()`](../src/core/task/Task.ts:2191). This deliberately reuses the existing, well-tested queue/ask machinery rather than writing into the message array out-of-band, and it wakes/resumes the task if needed. This signals urgency — the recipient's LLM treats it as an immediate task, like user input.

```
[user] PEER PROMPT from task task-2 ("Analyze auth module"):
        What tables does the UserService reference? I need this to finish my schema audit.
        Respond within 120s by calling attempt_completion.
```

For sync, the recipient answers by calling **`attempt_completion`**, whose result is delivered as the tool result to the **initiator's** blocking call (peer or parent — see [Sync response routing](#sync-response-routing-initiator-addressed)). For async-to-a-non-busy-peer, the "sender is blocked" line is omitted and no response is awaited.

### Injection / enqueue site

Form A injection happens during system prompt construction, near the subtask-constraints flow at [`Task.ts:5426`](../src/core/task/Task.ts:5426). **Important:** that block is guarded by `if (this.parentTaskId)`. Peer eligibility is keyed on `rootTaskId`, **not** `parentTaskId`, so the peer-message injection MUST run **independently of that guard** (a peer can be eligible without the constraints branch firing). Treat the peer block as its own append step.

Form B never touches the system prompt — it is enqueued as a user-turn via `messageQueueService.addMessage()` (the `queueMessage` path) and drained by `Task.ask()`.

```
System prompt construction (existing)
  → ... base system prompt ...
  → Subtask constraints (only if parentTaskId is set)
  → Form A: peer async notifications for a BUSY recipient
    (independent of parentTaskId; one block per message, cleared after injection)
  → [End of system prompt]

Message queue (Form B) — reuses the queueMessage/Task.ask() path
  → messageQueueService.addMessage(annotated PEER PROMPT user-turn)
  → Task.ask() drain wakes/resumes the task and feeds it to the LLM
```

---

## Deadlock Prevention

**Symmetrical deadlock risk:** Task A sends sync to task B, and task B sends sync to task A — both block waiting for each other.

### Mitigations

1. **Mandatory timeout on every sync `send_message_to_task`.** Default 120 seconds. No way to disable it — the `timeout_sec` parameter is always applied.

2. **Answering a sync request requires no approval.** The recipient answers via `attempt_completion`, which is always available and is the recipient's own terminal action — it has no auto-approval gate. The recipient can therefore complete and return its answer in the same turn it receives the `PEER PROMPT`. (Only _initiating_ a sync `send_message_to_task` is gated by `alwaysAllowSubtasks`.)

3. **The LLM is generally smart enough to avoid circular waits** — this is a well-understood pattern. The system prompt for sync messages explicitly states "The sender is blocked waiting" to encourage prompt response.

4. **If timeout fires, the message is discarded.** No stale messages linger. Both tasks can retry independently.

5. **The parent can always cancel stuck children** via `cancel_tasks` as a last resort.

---

## Auto-Approval

| Tool                            | Auto-Approved                  | Rationale                                                                                                                                      |
| ------------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_background_tasks` (peers) | ✅ Always                      | Read-only enumeration                                                                                                                          |
| `check_task_status` (peers)     | ✅ Always                      | Read-only query; no side effects                                                                                                               |
| `wait_for_task` (peers)         | ✅ Always                      | Blocking wait with timeout; no side effects on other tasks                                                                                     |
| `cancel_tasks`                  | Gated by `alwaysAllowSubtasks` | Destructive; parent-only (no change)                                                                                                           |
| `send_message_to_task` (async)  | ✅ Always                      | Fire-and-forget; no side effect on the sender, and the recipient controls whether/how it responds. No more privileged than a peer status read. |
| `send_message_to_task` (sync)   | Gated by `alwaysAllowSubtasks` | Blocking; ties up the sender's tool loop until the peer responds or times out.                                                                 |

---

## Data Model Additions

### `Task` class ([`Task.ts`](../src/core/task/Task.ts:199))

```typescript
/**
 * Async peer notifications awaiting Form A delivery (system-prompt injection)
 * to a BUSY recipient. Non-busy recipients are delivered via Form B
 * (messageQueueService.addMessage) and do not sit here.
 */
pendingPeerMessages: PendingPeerMessage[] = []

/**
 * Opt-in peer scope restriction. When set, peer tools only allow
 * communication with task IDs in this set (plus dynamically-added
 * children this task spawns). When undefined, full peer access
 * under the same rootTaskId.
 */
knownPeers?: Set<string>
```

### `PendingPeerMessage` type

```typescript
interface PendingPeerMessage {
	senderTaskId: string
	senderTitle: string
	message: string
	timestamp: number
}
```

Sync (`wait = true`) request/response state is **not** carried on `PendingPeerMessage`. Per the repo Cooperative Cancellation Rule, the sender's blocking wait is driven by an `AbortSignal`-backed timer: the sender creates an `AbortController`, races the response promise against `signal`, and on abort/timeout removes the still-queued Form B message from the recipient's `messageQueueService` and rejects the promise. The response itself arrives via the recipient's **`attempt_completion`** result, routed to the **initiator** of the prompt (peer or parent) through the initiator-addressed result-resolver (see [Sync response routing](#sync-response-routing-initiator-addressed)) — no bespoke `resolveFn`/`rejectFn`/`setTimeout` plumbing on the message object, and no reply `send_message_to_task`.

### `NewTaskParams` ([`NewTaskTool.ts:16`](../src/core/tools/NewTaskTool.ts:16))

```typescript
interface NewTaskParams {
	// ... existing fields ...
	peer_task_ids?: string[] // NEW: optional peer scope restriction
}
```

### `HistoryItem`

No changes needed. Peer relationships are runtime-only — `rootTaskId` and `parentTaskId` already capture the tree structure. `backgroundChildIds` continues to track direct children for the parent.

---

## State Restore

On extension restart:

1. `TaskManager.restoreManagedTasks()` rehydrates the managed-task map from persisted history.
2. Tasks are re-created with their `rootTaskId` from `HistoryItem`.
3. `pendingPeerMessages` are **not** persisted — undelivered Form A notifications are lost across restarts. This is acceptable: the sender's sync call would have aborted on timeout, and async notifications are fire-and-forget by nature.
4. `knownPeers` is **not** persisted — it's a runtime construct set at task creation. On restore, the task has full peer access unless explicitly re-restricted.

---

## Observability

All telemetry MUST go through typed `TelemetryService.instance.captureXxx(...)` wrappers (per the repo Telemetry Capture Rule); the names below are logical event kinds to add to `TelemetryEventName`, not raw Prometheus counters.

| Event kind                   | Description                                                              |
| ---------------------------- | ------------------------------------------------------------------------ |
| `task_peer_message_sent`     | labels: `mode` (async/sync), `status` (delivered/timeout/rejected/error) |
| `task_peer_message_received` | labels: `mode` (async/sync)                                              |
| `task_peer_discovery`        | `list_background_tasks` calls with `scope=peers`                         |

---

## Edge Cases

### Target task completes or errors before message delivery

Resolved by the [Recipient delivery model](#recipient-delivery-model) at send time:

- **`completed` / `idle` / `paused` (non-busy but resumable):** Delivered as a Form B annotated user-turn that resumes the task. For async, fire-and-forget; for sync, the sender awaits the response.
- **`error` (terminal, unrecoverable):** **Both** async and sync reject immediately (`Error: Task <task_id> has errored.`) so the sender learns its recipient is broken.
- **Race (peer goes terminal after queueing, before drain):** The queued Form B message is simply never drained; for sync the `AbortSignal` timeout fires and the sender gets a timeout error.

### Target task has no active instance

If the task has resumable persisted history, the Form B enqueue resumes it (the `queueMessage`/`Task.ask()` path rehydrates and drains). If there is neither a live instance nor resumable history, the message is undeliverable and **both** async and sync reject (`Error: Task <task_id> is not reachable.`). Messages are **not** durably persisted for a never-rehydrated task — see Gaps & Future Work.

### Sender aborts while waiting for sync response

The `send_message_to_task` tool handler's abort path fires the `AbortSignal`, which calls [`messageQueueService.removeMessage(id)`](../src/core/message-queue/MessageQueueService.ts:78) for the still-queued Form B message and rejects the pending response promise. If `removeMessage` returns `false` the recipient already consumed the prompt and is composing a response; that response is silently discarded (the sender is gone).

### User prompts a task involved in a sync exchange

The human user can prompt or resume any task at any time; this must not perturb the sync/async machinery. Because user input uses the **same Form B queue path** as a peer message and never touches `pendingSyncResolvers` (see [Sync response routing](#sync-response-routing-initiator-addressed)), all three sub-cases resolve cleanly:

- **User prompts the recipient** (a task currently serving a sync peer/parent prompt): the user message is appended **FIFO** to the recipient's `MessageQueueService` alongside the `PEER PROMPT`; it does not register or clear the outstanding resolver. The recipient's next `attempt_completion` still resolves the **task** initiator (and renders `completion_result` in the recipient's own chat, which the user sees). Caveat: since `attempt_completion` is terminal, a recipient serving a sync request returns to its sync initiator and **completes** on its next `attempt_completion` — a user redirecting such a task should expect it to terminate back to the peer/parent, not continue an open-ended conversation.
- **User prompts the blocked sender/initiator** (a task suspended inside `send_message_to_task` awaiting a sync response): the sender's agent loop is parked in the tool handler exactly like a blocking `new_task` parent, so the user's message simply **queues** and drains when the sender unblocks. No special handling, no resolver interaction.
- **User-initiated completion**: a task prompted only by the user has no `pendingSyncResolvers` entry, so its `attempt_completion` takes the **no-resolver branch** and completes to the user via the normal completion UI.

### `ask_followup_question` from a task in a peer exchange

**Routing rule:** `ask_followup_question` routes to the task's **parent** only when the parent is _able to answer_; otherwise it surfaces to the **user**. "Able to answer" means the parent is running its own agent loop (it can pick up the question and call `answer_subtask_question`) — **not** hard-suspended awaiting this child. Today's gate in [`AskFollowupQuestionTool`](../src/core/tools/AskFollowupQuestionTool.ts:56), `task.parentTaskId && task.isBackgroundTask`, already encodes exactly this and is **correct as-is**:

- **Background (async) subtask** → parent is alive and supervising → route the question **up to the parent**. The parent discovers it via the `managedTask:needs-parent-input` event (surfaced through `check_task_status` / `wait_for_task` as `waiting_for_parent`) and answers with `answer_subtask_question` → [`resolvePendingParentQuestion`](../src/core/task/Task.ts:3376).
- **Foreground/blocking subtask** → parent is **hard-suspended** inside the `new_task` await and cannot answer → routing the question there would **deadlock** (child waits for the parent's answer; parent waits for the child's completion). So the question correctly **falls through to the user**. `isBackgroundTask === false` is the proxy for "parent is blocked."
- **Root task** (no `parentTaskId`) → user, by definition.

**Two distinct destinations** (the key interaction with sync messaging):

- A task's **clarifying question** (`ask_followup_question`) goes **up to its parent** (when the parent can answer) — _not_ to the sync initiator/peer that prompted it. Supervision flows up the task tree.
- A task's **final answer** (`attempt_completion`) goes to the **initiator** of the current sync prompt — peer, parent, or user (see [Sync response routing](#sync-response-routing-initiator-addressed)). Results flow back to the requester.

So if a Coder sync-messages a Reviewer (an async/background recipient) and the Reviewer needs clarification, the Reviewer's question is fielded by the Reviewer's **parent** (e.g. the Orchestrator), while the Coder stays blocked awaiting the Reviewer's `attempt_completion`. If instead the Reviewer were a _foreground_ subtask of a now-suspended parent, its question would fall through to the user — the same `isBackgroundTask` gate that protects against the deadlock.

**Design implication for the workflow modes:** a supervisor (e.g. Orchestrator) that wants to answer its children's questions MUST drive them via **async `new_task` + `wait_for_task`** (whose `onNeedsParentInput` path wakes the supervisor to answer and re-enter the wait), _not_ via blocking `new_task`. Blocking `new_task` is for children that won't need to ask the parent anything — their questions go to the user.

### Self-messaging

Rejected at scope validation: `target.taskId !== caller.taskId`.

### Cross-root messaging

Rejected at scope validation: `target.rootTaskId !== caller.rootTaskId`.

---

## Gaps & Future Work

1. **Ephemerality of Form A notifications:** Async messages delivered to a _busy_ recipient via Form A (system-prompt injection) are not persisted in the recipient's message history — if the API call fails and retries, the message is re-injected, and if the recipient never generates another turn it is lost. (Form B deliveries do enter the message queue and are far more robust.) A future iteration could persist Form A notifications too.

2. **No broadcast mechanism.** Sending to multiple peers requires multiple `send_message_to_task` calls. A `broadcast_to_peers` variant could reduce round-trips but adds complexity (partial failures, fan-out semantics). Defer.

3. **No message TTL beyond sync timeout.** A Form B async message queued for a paused/idle peer that is never resumed could linger in the queue indefinitely. A TTL parameter (e.g., "discard if not drained within N seconds") would be useful for time-sensitive notifications.

4. **No read receipts.** The sender of an async message has no way to know if/when the recipient actually processed it. For fire-and-forget notifications this is fine; for coordination it may be desirable.

---

## Native Tool Plumbing

`send_message_to_task` is a new native tool and `peer_task_ids` / `scope` are new parameters on existing tools. Per the repo Native Tool Implementation Rule, this is a coordinated multi-file change — follow [`adding-new-tools.md`](adding-new-tools.md) rather than copying older tools. Checklist:

- **Schema-first types.** Declare the `send_message_to_task` params, `PendingPeerMessage`, the `scope` enum, and `peer_task_ids` as Zod schemas in `@shofer/types` (cross-boundary shapes), consumed via `z.infer<>`. No hand-written interfaces duplicated per consumer.
- **`ToolName` + group.** Add `"send_message_to_task"` to the `ToolName` union and assign it a `ToolGroup` in `TOOL_GROUPS` ([`packages/types/src/tool.ts`](../../packages/types/src/tool.ts)) — the single source of truth for mode filtering and auto-approval. Do **not** branch on `mode` inside `execute()`.
- **Handler.** Implement `SendMessageToTaskTool extends BaseTool<"send_message_to_task">`. Approval goes through `BaseTool.askToolApproval()` so even auto-approved (async) invocations render in chat.
- **Router / parser.** Wire the tool into the native-tool router and argument parser.
- **UI + i18n.** If the tool renders a chat row, add the `ShoferSayTool` case + `ChatRow` rendering, and add all user-facing strings (tool-result errors, confirmations) to the locale files — no hard-coded English literals (i18n String Rule). The injected `PEER MESSAGE` / `PEER PROMPT` bodies are agent-facing system text and are exempt.
- **Exhaustive switches.** Extend every discriminated-union switch over `ToolName` / `ShoferSay` with the new variant so the `never`-guarded `default` keeps compiling.
- **Telemetry.** Add the event kinds in [Observability](#observability) to `TelemetryEventName` with typed `captureXxx` wrappers.

---

## Related Documents

- [`parallelism.md`](parallelism.md) — Parent-child orchestration and `new_task` tool
- [`native_tools.md`](native_tools.md) — Complete tool reference with parameter schemas
- [`task_states.md`](task_states.md) — Task lifecycle state model
- [`todos/done/Shofer-parallel-tasks.md`](../../todos/done/Shofer-parallel-tasks.md) — Original parallel task execution design
