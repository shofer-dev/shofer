# Chat Scrolling — How Messages Stay in View

Shofer's chat panel keeps new messages visible automatically so you can
watch the AI work without manually scrolling. When you scroll up to review
older messages, Shofer pauses the auto-follow and shows a button to jump
back to the latest message.

---

## Auto-Follow During Streaming

When a task is running, Shofer pins the chat viewport to the bottom:

- **New messages appear immediately** — the panel scrolls down as text,
  tool calls, and results stream in.
- **Growing messages stay visible** — when a message row expands (a tool
  result loading, code block rendering), the viewport adjusts automatically.

You don't need to do anything — just watch the conversation unfold.

XXX: Screenshot showing the chat panel mid-streaming with a tool call
expanding. Annotations: "Viewport stays pinned to bottom", "New messages
appear without scrolling".

---

## Browsing History While Streaming

You can scroll up at any time to read earlier messages without interrupting
the task:

- **Scroll up** (mouse wheel, touchpad drag, or keyboard PageUp/ArrowUp)
  to enter "browse mode."
- Shofer **keeps streaming** in the background — new messages arrive
  normally, but the viewport stays where you are.
- A **↓ scroll-to-bottom button** appears in the bottom-right corner of
  the chat area.

XXX: Screenshot of the chat panel scrolled up mid-streaming. Annotation
highlighting the ↓ button in the bottom-right corner. Callout: "Click to
return to the latest message."

This also triggers when you **expand a collapsed row** (like a reasoning
block or a long tool result) — expanding something above the viewport
enters browse mode so the expanded content stays in view.

---

## Returning to the Latest Message

Click the **↓** (chevron-down) button to re-engage auto-follow:

1. The viewport scrolls to the bottom immediately.
2. A second scroll fires on the next animation frame to absorb any
   pending layout changes.
3. Auto-follow resumes — new messages will scroll into view automatically.

XXX: Screenshot of the ↓ button being clicked, with an arrow showing the
viewport snapping to the bottom. Or a short animated GIF.

---

## Task Switching

When you switch to a different task (via the TaskSelector dropdown or by
creating a new task):

- The chat panel scrolls to the bottom of the new task's messages.
- If the viewport doesn't reach the bottom on the first attempt (e.g., the
  virtualized list is still measuring), Shofer retries up to 3 times
  automatically.
- The scroll-to-bottom button is **hidden** during this brief "hydration"
  window — even if the viewport momentarily reports not-at-bottom, Shofer
  knows you didn't intentionally scroll up.

---

## Session Search (Ctrl+F)

Press **Ctrl+F** (or **⌘F** on macOS) to search the current task's message
history. When you jump to a search result:

- Shofer scrolls to center the matching message in the viewport.
- Browsing/search navigation does **not** change the auto-follow state —
  if you were in browse mode you stay there; if you were auto-following
  you stay auto-following.

XXX: Screenshot of the SessionSearch overlay with a search term entered
and a match count. Annotation: "Search jumps to message without changing
scroll mode."

---

## Summary

| Situation                          | Behavior                                    |
| ---------------------------------- | ------------------------------------------- |
| Task running, you're at the bottom | Auto-follow — new messages scroll into view |
| You scroll up during streaming     | Browse mode — ↓ button appears              |
| You click the ↓ button             | Re-engages auto-follow, scrolls to bottom   |
| You switch tasks                   | Auto-scroll to bottom with retry logic      |
| You use Ctrl+F session search      | Scrolls to match, preserves scroll mode     |
