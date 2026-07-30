---
name: second-brain-why
description: Show the Second Brain's recent advisories with their evidence and adjudicated verdicts, plus the ones the gate dropped and why. Use when the user asks what the Second Brain said, why it said it, or why it stayed silent.
---

# Second Brain — Why

Call the plugin request `why` (plugin `second-brain`, params `{ taskId? }`).
Relay, per task:

- **advisories** — detector, confidence, headline, body, cited evidence, and the
  adjudicated outcome (`adopted | partially_adopted | rejected | already_handled |
no_evidence | contradicted`, or `open`). Outcomes are self-reported by the
  detector from what it observed AFTER delivery, evidence-required, defaulting to
  `no_evidence` — uptake, never impact.
- **drops** — what the gate refused and the reason (`duplicate`, `rate_limited`,
  `stale`, `below_floor`, `suppressed`, `muted`, expiry). The gate's decisions
  must be inspectable or nobody will trust the channel.
