# Exporting Task History

Shofer lets you export your task conversations so you can review them offline, share them with your team, or run your own analysis. Two formats are available: **Markdown** for reading and **JSON** for data crunching.

## What Gets Exported

The export captures the **full conversation** — every message you sent, every response the model gave, every tool it called, and every reasoning step it took. It is a complete transcript of everything that happened in that task.

## Exporting a Task

### From the task header

1. Open the task you want to export.
2. Click the task title bar at the top of the chat to expand it.
    <!-- XXX: Screenshot — ChatView task header bar expanded, showing the action row with Export (download icon) and Export JSON (file icon) buttons highlighted. -->
3. Click one of the two export buttons:
    - **Export** (download icon) — saves a `.md` Markdown transcript.
    - **Export JSON** (file icon) — saves a `.json` structured trace.
4. Choose where to save the file in the file dialog that appears.

### From the History panel

You can also export completed tasks from the History panel:

1. Open the **History panel** (clock icon in the VS Code title bar).
2. Find the task you want to export.
3. Click the **Export** or **Export JSON** button in that task's row.
    <!-- XXX: Screenshot — HistoryView showing a task row with Export and Export JSON buttons highlighted. -->

## Choosing a Format

| You want to…                     | Use Markdown (`.md`)          | Use JSON (`.json`)               |
| -------------------------------- | ----------------------------- | -------------------------------- |
| Read the conversation            | ✅ Yes — open in any editor   | ❌ Needs a JSON viewer/formatter |
| Share with a colleague           | ✅ Easy to read               | ❌ Hard to skim                  |
| Track token usage and cost       | ❌ Not included               | ✅ Per-call + totals             |
| See which model was used         | ❌ Not included               | ✅ Per call                      |
| Run scripts or build dashboards  | ❌ Free-form text             | ✅ Schema'd and predictable      |
| Compare reasoning vs final reply | ✅ Inline `[Reasoning]` block | ✅ Dedicated `reasoning` field   |

## Markdown Export

The Markdown file is a plain-text transcript. Each exchange between you and the model is separated by `---` and labelled with the role.

```
**User:**

Fix the bug in the login handler.

---

**Assistant:**

[Reasoning]
The login handler has a missing null check on line 42…

[Tool Use: read_file]
Path: src/auth/login.ts
Offset: 35
Limit: 20

[Tool{ (Error)}]
Error: file not found
…
```

### What the annotations mean

| What you see       | What it means                                                                                                   |
| ------------------ | --------------------------------------------------------------------------------------------------------------- |
| `[Reasoning]`      | The model's internal reasoning before it wrote the response.                                                    |
| `[Tool Use: name]` | The model called a tool (e.g., `read_file`, `execute_command`). The block below shows the parameters it passed. |
| `[Tool]`           | The tool returned a result (shown below the label).                                                             |
| `[Tool (Error)]`   | The tool call failed (error message shown below).                                                               |
| `[Image]`          | An image was attached at this point in the conversation.                                                        |

## JSON Export

The JSON file is designed for programmatic use. Every API call the model made is a separate entry with detailed metadata.

### What's in it

- **`calls[]`** — one entry per API request, in chronological order.
- **Token counts** — input tokens, output tokens, cache read/write tokens.  
  If the provider didn't report token usage, Shofer estimates it and marks the call with `"_tokensEstimated": true`.
- **Cost in USD** — per call and total.
- **`apiProtocol`** and **`model`** — tells you which provider and model handled each request.
- **`toolCalls[]`** — every tool the model called, including the input and result.
- **`reasoning`** — the model's thinking, extracted into its own field.
- **`error`** — structured error info for failed calls (message, type, HTTP status code).
- **`wireRequest`** — a snapshot of what was about to be sent to the provider, useful for debugging.
- **`retryAttempt`** — 0 for the first try, 1 for the first retry, etc.

Error-only calls (network failures, rate limits, empty streams) are included too — with empty `messages` and `toolCalls` but a populated `error` object. This way you can see every attempt, not just the successful ones.

<!-- XXX: Screenshot — JSON file opened in VS Code, with the top-level object expanded to show version, taskId, totalTokens, and the first element of calls[] expanded to show index, model, token counts, and toolCalls[]. -->

## Edge Cases

- **Empty tasks** — tasks with no messages export an empty `calls[]` array (JSON) or an empty file (Markdown).
- **Very large tasks** — the export includes all messages; long conversations produce large files.
- **Tasks with images** — images are marked as `[Image]` in Markdown exports. JSON exports do not embed the image data.
- **Estimated tokens** — if your provider doesn't report token usage during streaming, Shofer uses a character-count estimate. The JSON export flags these calls with `"_tokensEstimated": true`.
- **Cancelled tasks** — a task that was stopped mid-response is exported up to the point it was cancelled. Cancelled calls are marked with `"cancelled": true` and a `cancelReason`.
- **Failed API calls** — calls that never received a response (network error, rate limit) still appear in the JSON export with an `error` object and empty messages, so you have a complete audit trail.
