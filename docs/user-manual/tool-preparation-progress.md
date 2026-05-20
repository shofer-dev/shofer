# Tool Preparation Progress Indicator

When Shofer invokes a tool with a large payload — for example, writing a
multi-kilobyte file with `write_to_file` or applying a complex `apply_diff` —
the arguments must stream from the AI provider before the tool call can begin.
This can take several seconds of silence in the chat.

The **Tool Preparation Progress Indicator** shows you what's happening during
this wait. Instead of a blank chat panel, you'll see an inline row with a
spinner, the tool name, and a live byte count that updates as data arrives.

<!-- XXX screenshot: the progress row visible in the chat, showing the spinner,
     tool name in monospace, and right-aligned byte count (e.g., "1.4 KB").
     Capture during a large write_to_file operation. -->

## What you'll see

While tool arguments are streaming in, a row appears in the chat:

```
┌──────────────────────────────────────────────┐
│ ◌  Preparing write_to_file…        1.4 KB   │
└──────────────────────────────────────────────┘
```

| Element        | Description                                                                          |
| -------------- | ------------------------------------------------------------------------------------ |
| **Spinner**    | Rotating ring indicator, signaling the tool call is not yet ready                    |
| **Tool name**  | The function being prepared (e.g., `write_to_file`, `apply_diff`, `execute_command`) |
| **Byte count** | How many bytes of arguments have arrived so far — formatted as `B` or `KB`           |

The row **updates in place** — the byte count increases and the spinner
continues rotating until the full tool call arrives. Once the tool actually
starts executing, the progress row disappears and is replaced by the normal
tool call and result display.

## When this appears

The progress indicator shows up whenever a tool call has a non-trivial
argument size. This commonly happens during:

- **`write_to_file`** — writing large file contents
- **`apply_diff`** — applying complex patches
- **`execute_command`** — long command strings
- **`new_task`** — detailed subtask instructions

If the tool call arguments are tiny (a few bytes), the row may appear and
disappear so quickly you won't notice it. The indicator is designed to be
useful precisely when the wait would otherwise be confusing.

<!-- XXX screenshot: side-by-side comparison showing (a) chat with no progress
     indicator during a long wait vs (b) chat with the progress indicator
     active. This shows the "before and after" improvement. -->

## What to expect

The progress row is purely informational — it does not require any action
from you. If something goes wrong (e.g., the AI provider disconnects), the
row simply disappears when the tool call fails, and an error message appears
instead.
