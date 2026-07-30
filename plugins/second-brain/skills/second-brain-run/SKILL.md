---
name: second-brain-run
description: Ask the Second Brain to look now — runs one observer pass immediately over the focused task and reports each detector's verdict plus any advisory. Bypasses the pass throttle, not the mute or the budget. The fastest way to see it work.
---

# Second Brain — Run a pass now

Call the plugin request `run` (plugin `second-brain`, params `{ taskId? }` — omit
taskId for the most recent observed task). It runs one pass immediately: every
enabled detector forks over the shared observation window and returns a verdict.

Relay each detector's verdict line verbatim (`detector → silent | advise |
resolved | still_open | timeout`). An `advise` verdict may still be gated
(deduplicated, rate-limited, stale) — the note says so.

This bypasses the two limits that pace **cost** (the clock floor and the volume
trigger) and neither of the ones that mean something: a mute still silences it,
an exhausted budget still degrades to silence.

For a DEEP one-off investigation by a single detector, spawn its private mode as
a real task instead: `new_task` with mode `second-brain:<detector>` (e.g.
`second-brain:git-log`).
