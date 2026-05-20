# Queued Messages, Send Now, and Per-Task Drafts

When Shofer is busy working on your request, you can keep typing — your
messages are queued and sent as soon as Shofer is ready. You can also
force-send a queued message immediately with **Send Now**, and your
half-typed drafts stay with the task you were writing in.

## Typing While Shofer Is Busy

When Shofer is streaming a response, running a tool, or waiting for an
API reply, you'll see the Send button change to a **Stop** button. If
you type a message and press **Enter** (or click **Send**), the message
doesn't get sent immediately. Instead, it appears in the **Queued
Messages** section — a collapsible bar that shows up above the chat
input:

<!-- XXX: Screenshot — ChatView showing a streaming response in progress. The chat input bar has a queued message visible in the "Queued Messages" section (collapsed bar showing "1 message waiting…"), and the Stop button is active. Above the input, Shofer is mid-response with streaming text visible. -->

Once Shofer finishes the current turn (the streaming response completes
and any tool approvals are resolved), the queued message is
automatically sent as your next input. No need to re-type it.

If you type multiple messages while Shofer is busy, they queue up in
**FIFO order** — first typed, first sent. The Queued Messages section
shows a count:

<!-- XXX: Screenshot — ChatView with Queued Messages section expanded, showing 3 queued message bubbles in chronological order. Each bubble shows the message text preview. The oldest message has a "Send Now" button on its right. -->

### When Messages Queue

Messages are queued in three situations:

1. **Shofer is streaming a response** — you'll see text appearing in the
   chat. Any message you type during this time is queued.
2. **Shofer is running a tool** — the chat shows a tool call or
   approval prompt. Your message is queued until the tool finishes and
   Shofer resumes listening.
3. **Between asks** — there's a brief window between Shofer finishing
   one thing and posting the next ask. If you type during this window,
   your message is queued.

In all cases, your message is **not lost**. You'll see it appear as a
queued bubble, and it will be delivered when Shofer is ready.

## Send Now — Skip the Wait

If you don't want to wait for Shofer to finish its current response, you
can click **Send Now** on any queued message bubble. This will:

1. **Cancel** the current API request (stop streaming).
2. **Keep** the conversation context — Shofer doesn't lose any of your
   conversation history.
3. **Send** the queued message immediately as your next turn.
4. **Continue** — Shofer processes your new message just like a normal
   message.

<!-- XXX: Screenshot — A queued message bubble with a "Send Now" button highlighted/circled. Below it, a brief animation frame or second screenshot showing the same chat after Send Now was clicked: the old streaming response stopped mid-sentence, and Shofer is now responding to the newly-sent message. -->

> **Tip:** Send Now is perfect when Shofer is going down a wrong path
> and you want to redirect it immediately. Instead of waiting for the
> response to finish, type your correction and hit Send Now.

Send Now does **not** create a new task or reset your conversation. It
stops the current turn only, and the same task instance continues with
your new message.

### Cancelling Queued Messages

To remove a queued message you no longer want to send, hover over the
bubble and click the **×** (delete) icon. The message is removed from
the queue. Other queued messages keep their original order.

## Per-Task Drafts

If you switch between tasks while you have unsent text in the chat
input, Shofer saves your draft for each task separately:

<!-- XXX: Screenshot — Two ChatView windows side by side (from task switching). Left side: Task A ("Fix login bug") with a half-typed message "The issue is in the auth middleware where…" in the input. Right side: Task B ("Add unit tests") with an empty input. The TaskSelector dropdown is open, showing both tasks. -->

1. **Switch away**: When you switch to a different task (or start a new
   one via the pencil icon), the text, images, and dropped files in the
   input area are saved for the task you're leaving.
2. **Switch back**: When you return to that task, your draft is
   restored — text, images, and context files.

This means you can start composing a question for one task, switch to
check something in another, and come back to find your draft exactly
where you left it.

<!-- XXX: Screenshot — Before-and-after: ChatView showing Task A with input containing "Can you explain how…" → TaskSelector click to switch to Task B with empty input → TaskSelector click back to Task A showing "Can you explain how…" restored in the input. Ideally a 3-panel sequence. -->

### What Gets Preserved

- **Text** — your typed message
- **Images** — any images you've attached
- **Context files** — files dropped into the chat area (`@file/path`
  and `@folder/path` mentions)

### When Drafts Are NOT Preserved

- Drafts are cleared when you **send** the message. The input area
  resets for your next message, which is the normal flow.
- If you **delete** a task, its draft is also deleted permanently.

## Related Features

- **Task switching** — use the tree-list icon in the VS Code title bar
  or the TaskSelector dropdown in the chat header to switch between
  running background tasks and view past conversations.
- **Parallel tasks** — you can have multiple tasks running at the same
  time. Each has its own message queue and its own draft. See the
  [Parallel Tasks](task-states.md) guide.
