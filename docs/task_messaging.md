# Inter-Task Peer Messaging

> **Status:** ✅ Implemented in Shofer v1.0.84. The core `send_message_to_task` tool, scope-relaxed peer tools (`check_task_status`, `wait_for_task`, `list_background_tasks` with `scope=peers`), `peer_task_ids` opt-in restrictor, and telemetry are all wired and compile clean.  
> ✅ **Least-privilege `knownPeers` default** (Shofer v1.0.85): `knownPeers` is always set for background tasks; `undefined` means deny-all (was: full same-root access). Baseline at spawn: `{ parentTaskId }` only — siblings require an explicit grant via `peer_task_ids` on `new_task`, or the `peers: [@Ref]` meta field in a slang agent declaration.  
> See [Remaining & Future Items](#remaining--future-items) for known gaps.

Design for direct communication between tasks sharing the same root task, enabling A2A-style collaboration without routing through the parent.

## Motivation

Today, tasks spawned under the same root task are isolated except for the parent→child orchestration path (`check_task_status`, `wait_for_task`, `cancel_tasks`). A background child analyzing `file1.ts` cannot discover that another child is analyzing `file2.ts`, share findings, or coordinate work. The parent must manually relay information — a bottleneck that doesn't scale.

Peer messaging enables:

- **Notification-style communication:** Task A sends a fire-and-forget message to task B (e.g., "I found a bug in the auth module — heads up").
- **Request-response coordination:** Task A asks task B for its findings on a shared dependency and blocks until B responds or times out.
- **Sibling discovery:** Any task can list and inspect all tasks under the same root, not just its own direct children.

## Scope: Same Root Task

Peer communication is scoped to tasks sharing the same [`rootTaskId`](parallelism.md#task). A task's `rootTaskId` is immutable — set at construction from [`TaskOptions.rootTask?.taskId`](../src/core/task/Task.ts:732) and persisted in [`HistoryItem`](../packages/types/src/history.ts). The root task (created directly by the user, no `rootTaskId`) is eligible for peer messaging — it can message any task in its tree using its own `taskId` as the effective root. Sub-tasks require `knownPeers` grants.

The [`TaskManager`](../src/services/task-manager/TaskManager.ts) already maintains the centralized registry of all live tasks (`activeTasks` and `managedTasks` maps). Peer tools query this registry filtered by `rootTaskId`, removing the `backgroundChildren` gating that limits current tools to direct children only.

> **Note:** The `isBackgroundTask` restriction was removed (commit `e640a4578`). Any task sharing the root task — foreground or background — can use `send_message_to_task`. The root task itself (no `rootTaskId`) can message any task in its tree.

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
- **`scope = "peers"`:** Filters [`TaskManager.getManagedTasks()`](../src/services/task-manager/TaskManager.ts:342) by `rootTaskId === caller.rootTaskId && taskId !== caller.taskId` using the `ManagedTask.rootTaskId` field (set at registration time, available for both live and terminal tasks). Enriches each entry with the title from `ManagedTask.name` and the status from `ManagedTask.state.lifecycle`. No async history lookups — terminal (`completed`/`error`/`paused`) tasks that are no longer live are included because `ManagedTask` entries are never evicted on completion/abort.

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

Always-available tool. Sends a message to a peer task. Two modes: async (fire-and-forget) and sync (blocking with mandatory timeout). Messages to BUSY targets (`running`, `waiting`, `waiting_input`) are REJECTED immediately — they never queue behind in-progress work. Only idle, completed, or paused tasks can receive messages.

### Parameters

| Param         | Type            | Required | Description                                                                                           |
| ------------- | --------------- | -------- | ----------------------------------------------------------------------------------------------------- |
| `task_id`     | string          | ✅       | Target peer task ID (must share the caller's `rootTaskId`)                                            |
| `message`     | string          | ✅       | The message to deliver                                                                                |
| `wait`        | boolean \| null | –        | When `true`, block until the recipient responds or timeout expires. Default: `false` (async).         |
| `timeout_sec` | number \| null  | –        | Maximum seconds to wait when `wait=true`. Default: 120. **Mandatory for sync mode** — always applied. |

### Scope validation

> ⚠️ See also: [`peer_task_ids` grants are unidirectional](#peer_task_ids-on-new_task----opt-in-scope-restrictor) — having a task ID does not mean that task can message you back. Each direction requires its own grant.

1. `caller.rootTaskId` must be set (not a top-level task), unless the caller is the root task itself — the root can message any task in its tree.
2. `target.rootTaskId === caller.rootTaskId`.
3. `target.taskId !== caller.taskId`.
4. `task_id` must be in the caller's `knownPeers` set — unless the caller is the root task (no `rootTaskId`), which is omnipotent within its tree. For sub-tasks, `knownPeers` is **always set**; when the set does not contain `task_id`, the call is rejected regardless of same-root membership. **Receiving a PEER MESSAGE from a task does NOT add that sender to your `knownPeers`.** The reply path requires its own independent grant.
    > **Removed (commit `e640a4578`):** Scope validation rule #5 (`isBackgroundTask` check) was removed. Any task — foreground or background, root or subtask — can send and receive peer messages. Rules #1–#4 are sufficient.

> **Removed (commit `e640a4578`):** The `isBackgroundTask` restriction was removed from `send_message_to_task`. Any task — foreground or background — can be caller or target. The parent/child sync routing table below is retained for historical reference; the `pendingSyncResolvers` map now serves all initiators uniformly, keyed by recipient `taskId`.

### Async mode (`wait = false`, default)

Fire-and-forget from the **sender's** perspective: the tool returns immediately and never blocks. How the _recipient_ perceives the message depends only on whether the recipient is busy (see [Recipient delivery model](#recipient-delivery-model) below), **not** on the async/sync flag. Async and sync differ exclusively in whether the sender blocks awaiting a response. Note that a response to an async message is optional — the recipient uses a fresh `send_message_to_task` call back (see [Response mechanism](#response-mechanism-differs-by-mode) below).

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

> **Yielding while awaiting an async reply.** Because async never blocks the sender, a sender that has nothing left to do until the recipient replies should call **[`wait`](native_tools.md#wait)** to yield its turn rather than spin or fabricate busywork. `wait` is an alias for `attempt_completion` — it ends the current turn as a terminal state — and the recipient's eventual reply arrives as a Form B annotated user-turn that **wakes the sender back up** (the same `MessageQueueService` path that resumes any idle task). This is the intended idiom for message-driven coordination: send → `wait` → resume on reply.

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

> \*\*Busy-target fail-fast:\*\* Messages to busy (`running`, `waiting`, `waiting_input`) recipients are REJECTED immediately — they never queue behind in-progress work. Only idle, completed, or paused tasks can receive messages.

\*\*Reject, don't drop:\*\* when a recipient is unreachable (`error` or no resumable history), **both** async and sync `send_message_to_task` fail loud with an error result. Silently dropping an async message would leave the sender believing it was delivered; surfacing the error lets the sender react (retry a different peer, escalate to the parent, or adjust its plan).

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

6. When the recipient calls **`attempt_completion`**, its result is delivered to **whoever initiated the prompt the recipient is currently answering** — the _initiator_ — which may be a **peer** (sync `send_message_to_task`) or the structural **parent** (`new_task`). The initiator is recorded per-prompt at delivery time and is routed by the recipient's `taskId`, **not** assumed to be `parentTaskId` (subject to `MAX_SUBTASK_RESULT_LENGTH`). The response promise resolves with that result, and the initiator's blocking tool handler returns it as `tool_result`.

    > **⚠️ Sync-to-running-peer terminates the peer's in-flight work.** Because `attempt_completion` is a terminal, self-declared state (see [`task_states.md`](task_states.md)), the recipient answers a sync request by **completing itself** — the result goes to the initiator and the recipient task ends. If the recipient was `running` (actively working on its own task), that work is aborted. Only sync-message a `running` peer if you intend to interrupt and redirect it. For non-interrupting coordination:
    >
    > - Prefer **async** `send_message_to_task` — the recipient sees the message as a notification and can finish its own work before deciding whether to respond.
    > - Prefer targeting peers that are **idle/completed** (resumed solely to serve the request) or spawned as **dedicated responders** whose whole purpose is to answer prompts.
    >
    > Sync is naturally suited to idle/completed peers and dedicated responders; sync-messaging a busy worker is a sharp tool. See [Sync response routing](#sync-response-routing-initiator-addressed) for the plumbing.

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

- [`NewTaskTool`](../src/core/tools/NewTaskTool.ts:277) registers a resolver via `provider.registerBlockingChildResolver(child.taskId, resolve)` and `await`s the promise. The map [`blockingChildResolvers: Map<childTaskId, (result) => void>`](../src/core/webview/ShoferProvider.ts:180) is keyed by the **completing task's id** — already relationship-agnostic.
- On completion, [`AttemptCompletionTool.execute`](../src/core/tools/AttemptCompletionTool.ts:168) gates on `if (task.parentTaskId)` and calls [`resumeBlockingParent({ parentTaskId: task.parentTaskId, childTaskId, completionResult })`](../src/core/webview/ShoferProvider.ts:4518), which fires the resolver **and** rewrites `parentTaskId`'s history (`awaitingChildId`/`completedByChildId`) **and pops the child off `shoferStack`** to reveal the parent below it.

The resolver map already routes correctly to an arbitrary waiter; only the `parentTaskId` gate in `attempt_completion` and the stack/history bookkeeping in `resumeBlockingParent` assume the waiter is the structural parent sitting directly below the recipient in `shoferStack`.

**The human user is also a valid initiator.** A user can prompt or resume any task or subtask directly; that input flows through the **same Form B queue path** (`queueMessage` → `Task.ask()`) and does **not** register a sync resolver. Routing is therefore _presence-based_, not sender-identity-based: on `attempt_completion`, **if** a `pendingSyncResolvers[recipientTaskId]` entry exists, deliver the result to that task initiator (peer or parent); **otherwise** complete normally to the user via the existing completion UI (`say("completion_result")` + rating overlay). User input never registers, overrides, or clears a sync resolver, so a human prompting a task cannot hijack or break an outstanding peer/parent sync exchange, and a completion answering a user prompt always takes the no-resolver branch. See [User prompts a task involved in a sync exchange](#user-prompts-a-task-involved-in-a-sync-exchange).

**Generalization for peer initiators.** Three focused changes decouple routing from the parent/stack assumption — no second result-delivery mechanism is introduced:

1. **Record the initiator per prompt.** When a sync prompt is delivered — parent via `new_task`, or peer via sync `send_message_to_task` — register the resolver keyed by the **recipient's** `taskId` together with the **initiator's** `taskId`. Reuse the existing map, generalized to `pendingSyncResolvers: Map<recipientTaskId, { initiatorTaskId, resolve }>`. Exactly one sync prompt is in flight per recipient at a time — enforce this at registration:
    - **Sync `send_message_to_task` handler:** before registering, check `pendingSyncResolvers.has(target.taskId)`. If occupied, reject: `Error: Task <task_id> is already serving a sync request and cannot accept another until it completes.`
    - **`NewTaskTool` (foreground path):** before calling `provider.registerBlockingChildResolver`, check `pendingSyncResolvers.has(child.taskId)` and reject if occupied — a task cannot simultaneously be a blocking child of its parent AND the target of a peer sync exchange.
    - **`resumeBlockingParent`:** already deletes the resolver by `childTaskId` unconditionally after firing, so a previously-child task that becomes free can then be targeted by a peer sync. No extra enforcement needed at deletion time.
2. **Route by recipient, not by parent.** `AttemptCompletionTool` looks up the pending resolver by **`task.taskId`** (the completing recipient) and fires it with the result. The `if (task.parentTaskId)` gate is replaced by "is there a pending sync resolver for my `taskId`?" — so a recipient whose structural parent is the Orchestrator can still return its verdict to a Coder **peer** that issued the prompt.
3. **Decouple bookkeeping from routing.** Run `resumeBlockingParent`'s stack-pop + parent-history rewrite **only when the initiator is the structural parent** (initiator `===` `parentTaskId`, and the recipient is the stack frame directly above it). For a **peer** initiator, skip the stack/history manipulation entirely and just fire the resolver — the peer initiator lives elsewhere in the task tree, not below the recipient in `shoferStack`.

---

> ⚠️ **CRITICAL: `peer_task_ids` is a PER-TASK, UNIDIRECTIONAL allowlist. It does NOT establish a mutual-pairing relationship between tasks.**
>
> **What this means in practice:**
>
> - Granting task A access to task B lets A send messages **TO** B, discover B in `list_background_tasks(scope="peers")`, and check B's status.
> - It does **NOT** grant B access to A in return. The `peer_task_ids` granted to A are invisible to B.
> - **Receiving a PEER MESSAGE from a task does NOT auto-add that task to your `knownPeers` set.** You cannot reply unless YOU were also granted the sender's ID at spawn time.
>
> **Bidirectional communication table:**
>
> | Grant configuration   | A → B (A sends to B) | B → A (B sends to A) | A sees B in `peers` | B sees A in `peers` |
> | --------------------- | -------------------- | -------------------- | ------------------- | ------------------- |
> | Only A has B's ID     | ✅                   | ❌                   | ✅                  | ❌                  |
> | Only B has A's ID     | ❌                   | ✅                   | ❌                  | ✅                  |
> | Both have each other  | ✅                   | ✅                   | ✅                  | ✅                  |
> | Neither has the other | ❌                   | ❌                   | ❌                  | ❌                  |
>
> **Common pitfall — "I sent a message, why can't they reply?":**
>
> 1. You send `send_message_to_task(task_id="peer-123", message="Hello")` to a sibling.
> 2. Your message is delivered via a PEER MESSAGE notification — it includes YOUR task ID in the sender field.
> 3. The recipient tries to reply with `send_message_to_task(task_id="<your-id>", ...)`.
> 4. **It fails with `"not in your allowed peer set"`** — because the recipient was never granted your ID.
>
> This is working as designed. The PEER MESSAGE notification text says "You may respond using `send_message_to_task`" — but this is only a prompt suggestion; it doesn't override the `knownPeers` scope check. **If you need bidirectional communication, both tasks must mutually grant each other's task IDs at spawn time.** Pre-spawn both children, collect their IDs, and pass each child the other's ID via `peer_task_ids`.

## `peer_task_ids` on `new_task` — Opt-in Scope Restrictor

New optional parameter on [`NewTaskParams`](../src/core/tools/NewTaskTool.ts:16):

| Param           | Type             | Required | Description                                                                                                                                                                                                                                                                           |
| --------------- | ---------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `peer_task_ids` | string[] \| null | –        | If provided, extends the spawned child's peer grant to include these task IDs (in addition to the parent and any tasks it itself spawns). If omitted/null, the child defaults to **least-privilege scope**: parent + own children only — no sibling access unless explicitly granted. |

### Implementation

When set, the spawned child's `Task` instance stores `knownPeers: Set<string>` (runtime-only; this is a `Set<string>` field on the `Task` class, NOT a persisted `@shofer/types` cross-boundary schema — see [Data Model Additions](#data-model-additions)) containing the union of:

- `peer_task_ids` (explicitly listed peers)
- The parent's `taskId` (always allowed)
- Any task the child itself spawns via `new_task` (dynamically added)

The "dynamically added" union member is mutated in the [`NewTaskTool`](../src/core/tools/NewTaskTool.ts) handler: when a task with a non-`undefined` `knownPeers` spawns a child, the new child's `taskId` is added to the spawner's `knownPeers` at spawn time. (Spawned children are also tracked in `backgroundChildIds`, but `knownPeers` is the scope-authority for peer tools and must be updated explicitly.)

`peer_task_ids` values SHOULD be validated at spawn time: each listed id must correspond to an existing task sharing the spawner's `rootTaskId`. Unknown ids are rejected (fail loud) rather than silently producing an over-restrictive scope that fails opaquely on a later `send_message_to_task`.

Peer tools (`check_task_status`, `wait_for_task`, `send_message_to_task`, `list_background_tasks` with `scope=peers`) consult `knownPeers` before allowing access. `knownPeers` is **always set** (never `undefined`) for any background task participating in peer messaging; when `undefined`, all peer-tool access is denied. The guard is `if (!task.knownPeers || !task.knownPeers.has(id))` — always enforced.

> **Slang workflows:** within a `.slang` flow, the canonical way to grant sibling access is the `peers: [@Ref]` agent meta field — the executor resolves refs to live task IDs at spawn time and sets `knownPeers` accordingly. `peer_task_ids` on `new_task` remains the mechanism for non-workflow or programmatic use.

---

## Delivery Mechanics

Delivery form is chosen by the recipient's runtime state, **not** by the async/sync flag (see [Recipient delivery model](#recipient-delivery-model)). There are exactly two delivery forms.

### Form A: System-prompt injection (busy recipient, async only)

Used only when the recipient is mid-turn **and** the message is async. The message rides along in the recipient's system prompt on the next API call — modeled after the existing subtask-constraints injection at [`Task.ts:5493`](../src/core/task/Task.ts:5493).

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

Form A injection happens during system prompt construction, near the subtask-constraints flow at [`Task.ts:5493`](../src/core/task/Task.ts:5493). **Important:** that block is guarded by `if (this.parentTaskId)`. Peer eligibility is keyed on `rootTaskId`, **not** `parentTaskId`, so the peer-message injection MUST run **independently of that guard** (a peer can be eligible without the constraints branch firing). Treat the peer block as its own append step.

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

4. **If timeout fires, the message is discarded.** No stale messages linger. Both tasks can retry independently — the sender unblocks with a timeout error and may retry the same peer (if the recipient is still reachable) or escalate to a different peer. Note that the recipient may still be mid-work on a now-orphaned prompt (the queued message was already consumed before the timeout fired), but that work completes silently and does not block the sender.

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
 * Least-privilege peer scope. Always set for background tasks participating
 * in peer messaging. Peer tools only allow communication with task IDs
 * present in this set. When undefined, all peer-tool access is denied.
 *
 * Baseline at spawn: { parentTaskId } only. Children are added dynamically
 * as they are spawned (NewTaskTool / WorkflowTask.spawnAgentTask). Sibling
 * grants require explicit peer_task_ids (new_task) or peers: [@Ref] (slang).
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
4. `knownPeers` is **not** persisted — it is a runtime construct set at spawn time by `NewTaskTool` (for `new_task`) or `WorkflowTask.spawnAgentTask` (for slang agents). On restore, a task's `knownPeers` is `undefined` (deny-all) until the task is re-spawned. Tasks rehydrated from history into an existing peer tree must have their `knownPeers` re-established by whoever spawns them.

---

## Observability

All telemetry MUST go through typed `TelemetryService.instance.captureXxx(...)` wrappers (per the repo Telemetry Capture Rule); the names below are logical event kinds to add to `TelemetryEventName`, not raw Prometheus counters.

| Event kind                   | Capture point / description                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `task_peer_message_sent`     | Captured in `send_message_to_task` handler after delivery completes (or fails). Labels: `mode` (async/sync), `status` (delivered/timeout/rejected/error)                                                                                                                                                                                                                                                                     |
| `task_peer_message_received` | Captured at **injection/enqueue time** for Form B (message enters the recipient's queue — the recipient _will_ see it on its next turn) and at **system-prompt construction time** for Form A (message is appended to prompt — the recipient may see it on the next API call). The event records the peer message was **presented**, not that the LLM acted on it (unobservable). Labels: `mode` (async/sync), `form` (A/B). |
| `task_peer_discovery`        | `list_background_tasks` calls with `scope=peers`                                                                                                                                                                                                                                                                                                                                                                             |

---

## Edge Cases

### Target task completes or errors before message delivery

Resolved by the [Recipient delivery model](#recipient-delivery-model) at send time:

- **`completed` / `idle` / `paused` (non-busy but resumable):** Delivered as a Form B annotated user-turn that resumes the task. For async, fire-and-forget; for sync, the sender awaits the response.
- **`error` (terminal, unrecoverable):** **Both** async and sync reject immediately (`Error: Task <task_id> has errored.`) so the sender learns its recipient is broken.
- **Race (peer goes terminal after queueing, before drain):** The queued Form B message is simply never drained; for sync the `AbortSignal` timeout fires and the sender gets a timeout error.

### Target task has no active instance

When the target has no live `Task` instance but **resumable persisted history** (non-`error` lifecycle), the [`SendMessageToTaskTool`](../src/core/tools/SendMessageToTaskTool.ts) handler **rehydrates** the target via [`provider.createTaskWithHistoryItem(historyItem, { keepCurrentTask: true })`](../src/core/webview/ShoferProvider.ts:1490) — the same pattern used by [`WorkflowTask.resumeAgentTask`](../src/core/workflow/WorkflowTask.ts:859). The freshly rehydrated instance gets a live `MessageQueueService` and the message is enqueued/queued normally.

- **Sync** — always delivered as Form B (annotated user-turn + `cancelAndProcessQueuedMessages` wake). The sender blocks until the recipient's `attempt_completion` or timeout.
- **Async to a non-busy peer** (`completed`/`idle`/`paused`) — delivered as Form B (annotated user-turn + wake).
- **Async to a busy peer** (`running`) — delivered as Form A (system-prompt injection via `peerNotificationQueue`) for a rehydrated instance; for a non-rehydratable task it would be rejected below.

If there is **neither** a live instance **nor** resumable persisted history, **both** async and sync reject with `Error: Task <task_id> is not reachable.` Messages are **not** durably persisted for a never-rehydrated task.

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

## Remaining & Future Items

### Known gaps (v1.0.84 → fixed in v1.0.86)

1. ~~**Async messages to resumable-but-unloaded peers are lost.**~~ ✅ **Fixed.** Both async and sync `send_message_to_task` now rehydrate resumable-but-unloaded recipients via `createTaskWithHistoryItem({ keepCurrentTask: true })` before delivery. Sync additionally fails-fast when the recipient is busy (`running` lifecycle). Async to a non-busy recipient is delivered as Form B (waking it); async to a busy recipient is delivered as Form A. A truly unreachable task (no history) is rejected with an error — async no longer silently drops and reports "Message sent".

2. **No broadcast mechanism.** Sending to multiple peers requires multiple `send_message_to_task` calls. A `broadcast_to_peers` variant could reduce round-trips but adds complexity (partial failures, fan-out semantics). Defer.

3. **No message TTL beyond sync timeout.** A Form B async message queued for a paused/idle peer that is never resumed could linger in the queue indefinitely. A TTL parameter (e.g., "discard if not drained within N seconds") would be useful for time-sensitive notifications.

4. **No read receipts.** The sender of an async message has no way to know if/when the recipient actually processed it. For fire-and-forget notifications this is fine; for coordination it may be desirable.

5. **Ephemerality of Form A notifications (unchanged).** Form A messages are not persisted — if the recipient never generates another API call, the notification is silently lost. Form B deliveries are more robust.

### Implementation notes

- **`ShoferSayTool` + `ChatRow` (native_tools.md Steps 8-9):** Not implemented — `send_message_to_task` uses the raw `askApproval("tool", JSON.stringify({tool: "sendMessageToTask", …}))` path, which produces a generic chat row. A custom `ChatRow` renderer would be a UX improvement.
- **i18n:** Tool-result error/confirmation strings use `formatResponse.toolError()` — consistent with all other tool handlers. The PEER MESSAGE / PEER PROMPT body text is agent-facing system text and is exempt per the design.

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
