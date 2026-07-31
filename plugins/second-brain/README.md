# Second Brain — plugin

**A cheap background model that watches each task over its shoulder and, when — and
only when — it sees something worth saying, drops one short advisory into it:
asynchronously, without blocking, interrupting, or being asked.** It reads only the
agent's **emissions** — narration, tool-call arguments, asks, user prompts — never its
tool results, which is what makes it affordable to leave running on every task. It
cannot write, block, veto, or ask; the worst it can do is be wrong in a paragraph you
ignore.

> Silence is the success metric. Most passes produce nothing. A chatty Second Brain is
> a broken one.

The full design — including the mode/catalogue split, the fork economics, the gate,
and the evaluation record — is in [`DESIGN.md`](DESIGN.md). Known gaps are in
[`TODO.md`](TODO.md).

## How it works

Lifecycle hooks project each task's events into the **digest — a stripped-down
version of the complete conversation** (deterministic, no model, no I/O; nothing is
ever evicted or summarized away). A supervised background service periodically
**forks that digest across the enabled detectors** — each detector is a **private
mode** (`second-brain:<name>`) carrying its own system prompt and tool grant — all
sharing one byte-identical prefix so the provider's cache pays for the digest once per
pass. Almost every fork returns _silent_. What does not gets gated hard (evidence
required, deduplicated, rate-limited, re-checked for staleness at delivery), and what
survives is delivered **twice with the same words at the same moment**: injected
one-way beside the agent's next request, and rendered as a chat row for you.

## Enable

Ships bundled, `defaultEnabled`, and — per the platform rule — default-enabled implies
the billed-AI consent, revocable in **Settings → Plugins**. Point `profileRef` at a
cheap provider profile (empty = the host default profile). That is the whole setup.

## Detectors

Enabled out of the box (the tool-less ones): `repeat-failure` (the pilot),
`standard-questions`, `default`. Defined and **off**: `goal-drift`, `git-log`,
`prior-art`, `constraint-drift`, `static-analysis` (ships with an **empty** command
allowlist you must fill), `cross-task-collision` (structural). Flip one on — and
override any detector's prompt, tools, cadence, floor, exec allowlist or checklist —
in the workspace catalogue, keyed by mode slug:

```jsonc
// .shofer/second-brain/catalogue.json
{
	"static-analysis": { "enabled": true, "exec": ["go build ./..."] },
	"git-log": { "enabled": true },
	"standard-questions": {
		"config": { "questions": [{ "key": "migrations", "ask": "Was the migration written for both directions?" }] },
	},
}
```

A broken catalogue degrades to the bundled one, never to no observer. For a deep
one-off investigation, spawn a detector's private mode as a real task:
`new_task` with mode `second-brain:git-log`.

## What you will see

Mostly nothing. When it speaks, the advisory appears as a bordered chat row (and,
above the agent's confidence floor, as one-way context the agent also received —
identical text). Advice below the agent floor reaches **you only**. Every turn end
runs a pass whose per-detector verdicts reach you only, as a dimmed report row. The 🧠
badge in the chat toolbar shows watching/muted/needs-approval, passes, and cost; the
Second Brain sidebar panel shows the advisories with evidence and adjudicated
outcomes, plus what the gate dropped and why.

## Verifying it is actually cheap

The fan-out is only affordable if the shared digest is being read from the provider's
cache rather than re-sent every time, so that is measured rather than assumed.
`/second-brain:stats` (and the panel) report the provider's own cache read/write tokens
and a **hit ratio**; cost is computed with the cached-token rates, not the input rate.

Switch on `debug` in Settings → Plugins and every pass also lands on disk under the
plugin's storage (`stats` prints the exact directory):

| File             | Contents                                                                        |
| ---------------- | ------------------------------------------------------------------------------- |
| `digest.txt`     | the exact system block every fork of that pass received                         |
| `pass.json`      | trigger, pilot, sizes, and per-detector tokens / cost / duration                |
| `<detector>.txt` | that fork's whole loop — tail, replies, full tool results, final verdict, usage |

`diff` one pass's `digest.txt` against the next: the earlier one must be a strict
**prefix** of the later one. In the per-fork usage footers the pilot should show a
`cacheWrite` and the other detectors a comparable `cacheRead`. A steady state of
`cacheRead≈0` with a large `prompt` means the sharing is broken.

## Skills & commands

`/second-brain:stats` · `/second-brain:run` · `/second-brain:why` ·
`/second-brain:forget`, with matching agent-facing skills (`second-brain-stats`, …)
backed by the plugin's `handleRequest`.

## Development

```bash
npx tsgo -p plugins/second-brain                                  # typecheck
cd packages/core && npx vitest run --config vitest.plugins.config.ts second-brain
node plugins/second-brain/build-ui.mjs                            # rebuild UI bundles
```

The suite is fully offline: projection goldens, gate simulations, fork behavior
against a scripted client, and the observer end-to-end against scripted seams. The
host-side contract (manifest validity, namespaced private modes) is pinned in
`packages/core/src/plugins/__tests__/second-brain-plugin.spec.ts`.
