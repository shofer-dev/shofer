# The Stop Button — Interrupting Shofer

Shofer processes your requests through a loop: it streams a response, runs tools,
waits for MCP servers, and asks you for approvals. The **Stop** button lets you
interrupt this cycle at any point — whether you want to change direction, stop a
runaway tool, or simply pause and rethink.

## When Stop Is Available

Stop is shown in the chat input bar whenever Shofer could be doing work on your
behalf. Specifically:

1. **Shofer is streaming a response** — text is appearing in the chat. Stop
   is shown in place of the Send button.

2. **Shofer is running a tool** — even if no text is streaming (e.g., a
   long-running browser action or an MCP tool call), the Stop button stays
   visible so you can interrupt the operation immediately.

3. **Shofer has asked you a question** — any approval prompt (tool
   approval, command execution, follow-up question) shows the Stop button
   as a "never mind" escape.

Stop is hidden when the task is effectively idle: no work is in flight, the
task is waiting for you to type a new message in an empty input, or the task
has completed.

<!-- XXX: Screenshot — ChatView with an active streaming response. The Stop button (a red square icon) is visible in the chat input bar. Above, Shofer is mid-response with streaming text. The task is in "running" state. -->

## What Happens When You Click Stop

Clicking Stop does the following, near-instantly:

1. **Cancels the current API request** — Shofer stops waiting for the LLM
   response immediately. Any partially-streamed text stays visible in the
   chat as-is.

2. **Aborts in-flight tools** — if Shofer is running an MCP tool (browser
   action, HTTP request, Kubernetes query, etc.), the tool is cancelled
   right away instead of running to its built-in timeout.

3. **Stops the task loop** — the task transitions to an idle state. The
   conversation history up to this point is preserved.

4. **You regain control** — the input area re-enables, and you can type a
   new message to continue the task, or switch to a different task.

<!-- XXX: Screenshot — ChatView immediately after clicking Stop. The streaming response is truncated mid-sentence (with an ellipsis or partial text visible). The input is active and ready for typing. The TaskHeader shows the task as "idle" or no longer streaming. -->

> **Note:** Stop does NOT delete anything. Your conversation history, context,
> and any files Shofer has already modified are left exactly as they were.

## Stop vs. Send Now

Stop is **not** the same as sending a queued message with **Send Now**.
They serve different purposes:

|              | Stop button                        | Send Now (on queued message)        |
| ------------ | ---------------------------------- | ----------------------------------- |
| **Goal**     | Stop and wait for new instructions | Cancel + immediately send a message |
| **Result**   | Task goes idle                     | Task restarts with your message     |
| **Use case** | "Wrong direction, let me think"    | "Wrong direction — here's a fix"    |

If you have a queued message (you typed while Shofer was busy), clicking the
Stop button leaves that message in the queue. Shofer will send it when you
next interact with the task.

If you want to **both cancel and immediately redirect** Shofer, use **Send Now**
on a queued message instead.

<!-- XXX: Screenshot — Side-by-side comparison. Left: The chat input with just the Stop button visible (no queued messages). Right: A queued message bubble with the "Send Now" button highlighted, the Streaming response visible above. -->

## Stopping Long-Running Tools

When Shofer is running a tool that takes a long time (e.g., a browser action
that navigates a multi-page form, or a Kubernetes query timing out), Stop
cancels the tool immediately rather than letting it run to its own timeout.
This is especially important for MCP tools that may have 60-second server
timeouts — without Stop, you'd be stuck waiting.

<!-- XXX: Screenshot — ChatView showing an active MCP tool call (a tool status indicator or "Running: browser_navigate" card). The Stop button is visible even though no text is streaming. A caption: "Stop is available during tool execution — you don't have to wait for the timeout." -->

## Keyboard Shortcut

In the Shofer webview, you can also press **Escape** to trigger Stop when the
task is running.

## What Stop Does Not Do

- **Does not close the task.** Your conversation stays open. The same task
  instance continues — you can type a new message right away.
- **Does not undo file changes.** Any files Shofer wrote or modified before
  you clicked Stop are left as-is. You can review them in the
  [File Changes Panel](file-changes-panel.md) and revert if needed.
- **Does not cancel background tasks.** If you have parallel background
  tasks running, Stop only affects the task you're looking at. Background
  children continue independently.

## Related Topics

- [Queued Messages and Send Now](message-queue.md) — for typing while Shofer
  is busy and skipping the queue.
- [Task States](task-states.md) — understanding the lifecycle of a Shofer
  task.
- [Parallel Tasks](parallel-tasks.md) — running multiple tasks at once.
