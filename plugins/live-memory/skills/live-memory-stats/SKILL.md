---
name: live-memory-stats
description: Show the Live Memory plugin's current status for this workspace — agent state, context-window fill, retained observations and Q&A pairs, session token cost, and the pending question queue. Use when the user asks how Live Memory is doing, how full its context is, how much it has cost, or what it has accumulated.
---

# Live Memory — Status

Live Memory is a persistent, LLM-backed codebase companion contributed by the
`live-memory` plugin. It observes the files Shofer edits and reads (and external
edits, via a filesystem watch), accumulates a per-workspace knowledge log, and
answers investigative questions through the `ask_live_memory` tool.

## Where the status comes from

You do not need to run anything special — the current status is already surfaced
in two places:

- **The system prompt.** The plugin appends a `Live Memory` section to the prompt
  each turn (via `transformSystemPrompt`). It shows: whether the memory LLM is
  ready (AI granted **and** billed-calls consent given), the active model label,
  the number of retained observations and Q&A pairs, and — once the memory agent
  has run at least one question — the context-window fill (`current / max` tokens
  and a nearly-full marker).
- **The chat panel** (the plugin's `sidebar-panel` UI). It streams the live agent
  state header (Standby / Ready / Busy / Error), the context-usage bar, and the
  full typed conversation (text / reasoning / tool_call parts).

## What the numbers mean

| Field            | Meaning                                                                                                                                     |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **State**        | `Standby` (no agent yet) · `Ready` · `Busy` (a question is in flight) · `Error`                                                             |
| **Observations** | Recent file-activity markers retained (capped by `maxObservations`).                                                                        |
| **Q&A retained** | Recent question/answer pairs retained (capped by `maxQuestions`).                                                                           |
| **Context**      | Estimated tokens in the memory agent's context window vs. its budget (`maxContextTokens`); flagged nearly-full past `contextFillThreshold`. |
| **Cost**         | Running session estimate (USD) accumulated across `ask_live_memory` calls.                                                                  |
| **Queue**        | Pending questions waiting on the single-in-flight serializer.                                                                               |

To read the accumulated knowledge itself, ask a question with the
`ask_live_memory` tool rather than re-reading files yourself.
