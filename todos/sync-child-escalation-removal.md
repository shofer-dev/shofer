# Delete the sync-child question-escalation machinery

**Status: owed.** The code is live and correct, and nothing in the tool surface
can reach it. `new_task` is concurrent-only since the mailbox landed
([`docs/task_messaging.md`](../docs/task_messaging.md)), so a child whose
`parentTaskId` is set and whose `isBackgroundTask` is `false` — the only shape
this path serves — is no longer produced by anything an agent can call. It
survives because a HOST can still construct one directly through the task APIs,
which is a capability nobody uses.

Keeping it is not free. It is one of the larger rules in
[`AGENTS.md`](../AGENTS.md) (the Sync-Child Question Escalation Rule), a section
of [`docs/parallelism.md`](../docs/parallelism.md) with its own sequence diagram,
two tuning constants, and a probe every new blocking primitive is told to honour
— so every future author pays to read it before concluding it cannot fire.

## What to delete

| Symbol                                                                                                                                  | Where                                                                                      |
| --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `API.escalateFollowupToConversation`                                                                                                    | `src/extension/api.ts`                                                                     |
| `confirmNoConversationDriver`, `DRIVER_ATTACH_RECHECK_MS`                                                                               | `packages/core/src/transport/conversation-driver.ts`                                       |
| `isConversationDriverAttached` probe registration, `StreamSubscribers.mightReach`, `SUBSCRIBER_REATTACH_GRACE_MS` and its detach ledger | `packages/core/src/transport/http-server.ts`                                               |
| the escalation branch and the no-audience fail-fast                                                                                     | `packages/core/src/tools/AskFollowupQuestionTool.ts`                                       |
| the tests covering all of the above                                                                                                     | `src/extension/__tests__/api-sync-child-ask.spec.ts` and the adjacent `__tests__/` folders |

`StreamSubscribers.has` stays — it is the exact instantaneous fact and has other
callers.

## What to check before deleting

1. **Nothing else reads the probe.** `isConversationDriverAttached` is registered
   on the ShoferApi transport; confirm no plugin or host uses it for anything
   but this refusal. If one does, that consumer decides whether the census
   survives on its own.
2. **`resolveAskTarget` / `Task.isAwaitingAsk` are NOT part of this.** They serve
   the ordinary ask path (an answer addressed at the conversation reaching the
   task actually parked on it) and must stay.
3. **The republished `message` event has no external consumer.** A controller
   that renders a child's question off the root stream would lose it; the wire
   shape is indistinguishable from a root task's own question, so grep the
   integrator side for `sourceTaskId` before removing the publication.

## Docs to update in the same change

- [`AGENTS.md`](../AGENTS.md) — delete the Sync-Child Question Escalation Rule
  outright (its "unreachable, removal owed" preamble goes with it).
- [`docs/parallelism.md`](../docs/parallelism.md) — the section
  "A child with no concurrent parent escalates to the conversation", its
  "Provably is a claim about an interval" subsection, the two-window table and
  the sequence diagram.
- [`docs/task_messaging.md`](../docs/task_messaging.md) — roadmap step 6 stops
  naming this as owed.

The integrator's own `docs/ask_followup_question.md` (parent repo, not this one)
carries the per-path register and its path 5b; note the removal there on that
repo's cadence.
