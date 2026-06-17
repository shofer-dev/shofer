-- ============================================================================
-- Flow: Debug
--
-- The Orchestrator dispatches two developers for independent triage, then
-- runs a peer-review consensus loop until both agree on the root cause.
-- After user sign-off, Developer1 implements the fix and Developer2
-- reviews it, iterating until the reviewer is satisfied.
--
-- Topology note: every loop is COUNT-MATCHED. The Orchestrator drives each
-- loop and ends it with a terminal structured stop signal — a boolean field on
-- the stake's output (`proceed` for the consensus loop, `approved` for the fix
-- loop, `complete` for the review loop) that the corresponding agent detects
-- with a `when` check, so both sides exit in lockstep and the message counts
-- never desync.
-- ============================================================================

flow "debug" (issue: "string") {
  title: "Collaborative Debug"
  description: "Two developers independently triage, converge on the root cause through peer review, get user sign-off, then one fixes and the other reviews — iterating until both are satisfied."
  icon: "bug"

  param issue {
    description: "Describe the issue in as much detail as possible: what you expected to happen, what actually happened, steps to reproduce, relevant error messages or logs, and any recent changes."
  }

  -- =========================================================================
  -- Orchestrator — drives every loop in lockstep with the developers
  -- =========================================================================
  agent Orchestrator {
    mode: "architect"
    -- Pure coordinator: NO read/write/execute (so it cannot triage or fix the
    -- issue itself — its only job is to dispatch, relay, and signal), NO `mode`
    -- (cannot switch into code) and NO `subtasks` (cannot spawn its own
    -- children — the workflow spawns the two developers). Only `questions`, so
    -- it can still escalate/clarify with the user. Always-available tools
    -- (attempt_completion, send_message_to_task, …) are retained regardless.
    tools: [questions]
    role: "Debug workflow orchestrator. You clarify the issue with the user, coordinate parallel investigation by two developers, broker consensus between them, and drive the fix-and-review loop to completion. You do NOT write or review code yourself."

    -- Phase 1 — Parallel triage
    --
    -- NOTE: a stake declared here is executed by the ORCHESTRATOR; `-> @DeveloperN`
    -- only routes the *result* to that developer's mailbox (consumed by its
    -- `await triage_task <- @Orchestrator`). It does NOT make the developer run
    -- this stake. So the instruction is a DISPATCH addressed to the Orchestrator
    -- — never "investigate…"/"implement…", which would make the Orchestrator do
    -- the work itself (and, for writes, stall in architect mode). Each developer
    -- does the real work via its own `investigate` / `fix` / `review` stake.
    stake triage(
      issue: issue,
      user_description: issue,
      task: "Dispatch read-only triage to this developer. You are the orchestrator: you do NOT investigate or modify anything yourself. Produce the triage assignment as your result, instructing the developer: STRICT READ-ONLY TRIAGE — investigate using read/search tools ONLY; do NOT modify, create, delete, move, or apply any change to any file (no apply_diff / write_to_file / insert_edit / sed / file) and do NOT run any command that mutates the workspace or git; examine the codebase, logs, and context; identify the root cause — what is actually broken and why; output analysis only — describe the proposed fix in words, do NOT implement it."
    ) -> @Developer1

    stake triage(
      issue: issue,
      user_description: issue,
      task: "Dispatch read-only triage to this developer. You are the orchestrator: you do NOT investigate or modify anything yourself. Produce the triage assignment as your result, instructing the developer: STRICT READ-ONLY TRIAGE — investigate using read/search tools ONLY; do NOT modify, create, delete, move, or apply any change to any file (no apply_diff / write_to_file / insert_edit / sed / file) and do NOT run any command that mutates the workspace or git; examine the codebase, logs, and context; identify the root cause — what is actually broken and why; output analysis only — describe the proposed fix in words, do NOT implement it."
    ) -> @Developer2

    await dev1 <- @Developer1
    await dev2 <- @Developer2

    let dev1_analysis = dev1.analysis
    let dev1_verdict = dev1.root_cause
    let dev2_analysis = dev2.analysis
    let dev2_verdict = dev2.root_cause
    let dev1_agrees = false
    let dev2_agrees = false

    -- Phase 2 — Consensus loop (count-matched: each round the Orchestrator
    -- sends one `share` to BOTH developers and awaits one reply from each).
    let converged = false
    repeat until converged {
      stake share(
        my_root_cause: dev1_verdict,
        peer_analysis: dev2_analysis,
        peer_root_cause: dev2_verdict,
        task: "Relay the peer developer's analysis and root-cause verdict to Developer1 for reconsideration. This is a consensus round, NOT the terminal stop signal — set proceed=false and put the peer's analysis/verdict in `details`."
      ) -> @Developer1
        output: { proceed: "boolean", details: "string" }

      stake share(
        my_root_cause: dev2_verdict,
        peer_analysis: dev1_analysis,
        peer_root_cause: dev1_verdict,
        task: "Relay the peer developer's analysis and root-cause verdict to Developer2 for reconsideration. This is a consensus round, NOT the terminal stop signal — set proceed=false and put the peer's analysis/verdict in `details`."
      ) -> @Developer2
        output: { proceed: "boolean", details: "string" }

      await renewed1 <- @Developer1
      await renewed2 <- @Developer2

      set dev1_analysis = renewed1.analysis
      set dev1_verdict = renewed1.root_cause
      set dev1_agrees = renewed1.agrees_with_peer

      set dev2_analysis = renewed2.analysis
      set dev2_verdict = renewed2.root_cause
      set dev2_agrees = renewed2.agrees_with_peer

      when dev1_agrees && dev2_agrees {
        set converged = true
      }
    }

    -- End both consensus loops in lockstep with the terminal structured signal.
    stake proceed(task: "Consensus reached on the root cause; stop reconsidering. This IS the terminal signal — set proceed=true.") -> @Developer1
      output: { proceed: "boolean", details: "string" }
    stake proceed(task: "Consensus reached on the root cause; stop reconsidering. This IS the terminal signal — set proceed=true.") -> @Developer2
      output: { proceed: "boolean", details: "string" }

    -- Phase 3 — User sign-off on the agreed root cause
    escalate @Human reason:
      "The developers reached consensus on the root cause. Review their analysis below." form: {
      decision: "string" { widget: "radio", options: ["Agree — proceed with fix", "I'll provide guidance"] }
      guidance: "string" { description: "Your guidance (optional)" }
    }

    await user_signoff <- @Human

    -- Phase 4 — Developer1 implements the fix
    stake assign_fix(
      root_cause: dev1_verdict,
      analysis: dev1_analysis,
      task: "Assign the fix to Developer1. You are the orchestrator: you do NOT write code yourself. Produce the fix assignment as your result, instructing the developer: implement the fix for the agreed-upon root cause, write the necessary code changes, keep them minimal and targeted, then describe what was changed and why."
    ) -> @Developer1

    await fix_output <- @Developer1

    -- Phase 5 — Review loop (count-matched). Each round: ask Developer2 to
    -- review the latest fix; if not approved, send feedback to Developer1 and
    -- await the revised fix.
    let reviewer_happy = false
    repeat until reviewer_happy {
      stake ask_review(
        root_cause: dev1_verdict,
        implementation: fix_output,
        task: "Ask Developer2 to review the latest fix against the agreed-upon root cause. This is a review request, NOT the terminal stop signal — set complete=false and put the fix to review in `details`."
      ) -> @Developer2
        output: { complete: "boolean", details: "string" }

      await review_outcome <- @Developer2

      when review_outcome.approved {
        set reviewer_happy = true
      } otherwise {
        stake send_feedback(
          feedback: review_outcome.feedback,
          task: "Relay the reviewer's feedback to Developer1 to address. The fix is NOT yet approved — set approved=false and put the feedback in `details`."
        ) -> @Developer1
          output: { approved: "boolean", details: "string" }

        await fix_output <- @Developer1
      }
    }

    -- End both fix/review loops in lockstep with their terminal structured signals.
    stake fix_approved(task: "The reviewer accepted your fix; you are done. This IS the terminal signal — set approved=true.") -> @Developer1
      output: { approved: "boolean", details: "string" }
    stake review_done(task: "The fix is approved; no further reviews needed. This IS the terminal signal — set complete=true.") -> @Developer2
      output: { complete: "boolean", details: "string" }

    -- Phase 6 — Done
    stake report(
      issue: issue,
      root_cause: dev1_verdict,
      fix_summary: fix_output
    ) -> @out

    commit
  }

  -- =========================================================================
  -- Developer1 — investigates, reaches consensus, then implements the fix
  -- =========================================================================
  agent Developer1 {
    mode: "code"
    role: "Senior developer specializing in debugging. CRITICAL RULE: you have TWO distinct stages. During TRIAGE and CONSENSUS you are STRICTLY READ-ONLY — investigate and form hypotheses, but do NOT modify, create, or delete any file and do NOT run mutating commands. You may ONLY make changes when the orchestrator explicitly assigns you a FIX task (or fix-revision feedback). Implement precise, minimal fixes only in that fix stage."

    -- Phase A — Initial triage
    await triage_task <- @Orchestrator
    stake investigate(task: triage_task) -> @Orchestrator
      output: { analysis: "string", root_cause: "string" }

    -- Phase B — Consensus loop (mirrors the Orchestrator; ends on the `proceed` stop signal)
    let consensus_done = false
    repeat until consensus_done {
      await peer_round <- @Orchestrator

      when peer_round.proceed {
        set consensus_done = true
      } otherwise {
        stake reconsider(task: peer_round.details) -> @Orchestrator
          output: { analysis: "string", root_cause: "string", agrees_with_peer: "boolean" }
      }
    }

    -- Phase C — Implement the fix
    await fix_task <- @Orchestrator
    stake fix(task: fix_task) -> @Orchestrator
      output: { changes_summary: "string", files_changed: "string" }

    -- Phase D — Revise on review feedback (mirrors the review loop; ends on the `approved` stop signal)
    let fix_done = false
    repeat until fix_done {
      await fix_directive <- @Orchestrator

      when fix_directive.approved {
        set fix_done = true
      } otherwise {
        stake revise(task: fix_directive.details) -> @Orchestrator
          output: { changes_summary: "string", files_changed: "string" }
      }
    }

    commit
  }

  -- =========================================================================
  -- Developer2 — investigates, reaches consensus, then reviews the fix
  -- =========================================================================
  agent Developer2 {
    mode: "reviewer"
    role: "Senior developer specializing in debugging and code review. You are READ-ONLY for the entire workflow: you investigate, form hypotheses, reach consensus with your peer, and rigorously review the other developer's fix for correctness and minimality — but you NEVER modify files yourself. Your `reviewer` mode has no write tools by design."

    -- Phase A — Initial triage
    await triage_task <- @Orchestrator
    stake investigate(task: triage_task) -> @Orchestrator
      output: { analysis: "string", root_cause: "string" }

    -- Phase B — Consensus loop (mirrors the Orchestrator; ends on the `proceed` stop signal)
    let consensus_done = false
    repeat until consensus_done {
      await peer_round <- @Orchestrator

      when peer_round.proceed {
        set consensus_done = true
      } otherwise {
        stake reconsider(task: peer_round.details) -> @Orchestrator
          output: { analysis: "string", root_cause: "string", agrees_with_peer: "boolean" }
      }
    }

    -- Phase C — Review loop (mirrors the Orchestrator; ends on the `complete` stop signal)
    let review_done = false
    repeat until review_done {
      await review_task <- @Orchestrator

      when review_task.complete {
        set review_done = true
      } otherwise {
        stake review(task: review_task.details) -> @Orchestrator
          output: { approved: "boolean", feedback: "string" }
      }
    }

    commit
  }

  -- =========================================================================
  -- Flow constraints
  -- =========================================================================
  converge when: @Orchestrator.committed
  budget: rounds(40)
}
