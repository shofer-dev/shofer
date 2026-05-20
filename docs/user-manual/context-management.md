# Context Management & Condensation

When a conversation with Shofer goes on for many turns, the accumulated
messages eventually approach the model's **context window** limit — the
maximum number of tokens the model can process in a single API call.

Shofer handles this automatically so you don't have to worry about
running out of context space mid-task.

## What You See

### The Context Window Bar

At the top of every task, the [TaskHeader] bar shows a horizontal
**context window meter** that fills from left (empty) to right (full)
as tokens accumulate:

<!-- XXX: Screenshot — TaskHeader in ChatView showing the context window bar at approximately 50–70% full (yellow/orange zone), with the token count readable next to it: "32,400 / 64,000 tokens". -->

| Zone       | Meaning                                                                                       |
| ---------- | --------------------------------------------------------------------------------------------- |
| Green      | Plenty of room. No action needed.                                                             |
| Yellow     | Approaching the limit. Condensation will trigger soon.                                        |
| Red / full | Near or at the context window maximum. Condensation or truncation is imminent or in progress. |

Hovering over the bar shows the exact token numbers.

### The "Condensing Context" Indicator

When Shofer decides to condense, you may briefly see a **spinner** or
progress indicator in the chat before the next model response. This
means Shofer is summarizing older messages to free up space.

<!-- XXX: Screenshot — ChatView showing the "condensing context" spinner row in the chat, with the TaskHeader context window bar near 90% full. -->

The condensation completes automatically; after a few seconds, the
conversation continues normally.

### After Condensation

The older messages **are not deleted** — they're still visible in the
chat history. However, the model will only "see" the condensed summary
going forward. This is called the **fresh start** model: the model
starts each condensed turn with a clean slate, carrying forward only
the summary.

You can scroll up and read the full history at any time.

## What Happens Behind the Scenes

### Automatic Condensation

By default, Shofer triggers condensation when the conversation reaches
**90%** of the model's context window. You can adjust this threshold in
settings:

```
// settings.json
{
  "shofer.autoCondenseContextPercent": 85   // Trigger at 85% instead of 90%
}
```

The allowed range is **5–100%**. Setting it to 100 disables automatic
condensation (but a hard safety net still fires at ~90% — see below).

Even if you set the threshold to 100%, Shofer has a built-in safety net:
condensation or truncation **always** triggers when tokens exceed roughly
90% of the context window (minus the model's output reservation). This
prevents the conversation from ever exceeding the context window and
failing with an error.

### Per-Profile Thresholds

If you use multiple API configurations (e.g., one profile for Claude
and another for GPT-4), you can set **different thresholds per profile**
in the API Configuration settings:

<!-- XXX: Screenshot — SettingsView API Configuration section showing a profile row with an expanded "Advanced" subsection revealing the "Condense Threshold" field set to 75 for a profile called "claude-opus". -->

A value of `-1` means "use the global default."

### Manual Condensation

You can trigger condensation at any time via the **condense** slash
command or the corresponding button in the chat toolbar. This is useful
when you want to free up context proactively before a long operation.

Manual condensation does **not** include environment details in the
summary (since fresh ones are injected on the next turn).

### When Condensation Fails

If the condensation API call fails (network error, rate limit, empty
response), Shofer falls back to **sliding window truncation**: it hides
the oldest messages from the model's view without summarizing them. You
lose some conversation context, but the task continues without error.

## How Condensation Preserves Your Work

Shofer tries to be smart about what gets summarized:

| Preserved Element        | What It Keeps                                                                      |
| ------------------------ | ---------------------------------------------------------------------------------- |
| **Conversation Summary** | An LLM-generated summary of the condensed messages                                 |
| **Active Workflows**     | Any `<command>` blocks (e.g., from the orchestrator mode) are carried forward      |
| **File Structure**       | Signatures of files you've read (function names, class declarations) are preserved |
| **Environment Details**  | For automatic condensation, the current workspace state is included                |

This means that even after multiple rounds of condensation, the model
retains awareness of what you were doing and what files look like.

## Troubleshooting

| Symptom                                          | Likely Cause & Fix                                                                                                       |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| Condensation never triggers, then task errors    | Auto-condense is disabled (`autoCondenseContext = false`) or threshold set too high. Check settings.                     |
| "Failed to condense context" message appears     | The condensation API call failed. Shofer will fall back to truncation. If it keeps happening, check your API connection. |
| Task forgets earlier conversation details        | This is expected after condensation. The model works from a summary, not the full history.                               |
| Condensation happens too frequently              | Lower the `autoCondenseContextPercent` (e.g., from 90 to 80) so there's less room per condensation.                      |
| Condensation happens too late / too aggressively | Raise the `autoCondenseContextPercent` (e.g., from 90 to 95).                                                            |

## Related Settings

| Setting                      | Default | Description                                                      |
| ---------------------------- | ------- | ---------------------------------------------------------------- |
| `autoCondenseContext`        | `true`  | Enable automatic context condensation.                           |
| `autoCondenseContextPercent` | `90`    | Percentage of context window that triggers condensation (5–100). |
| Per-profile threshold        | `-1`    | Override the global threshold for a specific API profile.        |
