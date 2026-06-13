-- ============================================================================
-- Flow: Debug
--
-- The Orchestrator clarifies the issue with the user, then dispatches two
-- developers for independent triage. The developers iterate a peer-review
-- consensus loop (brokered by the Orchestrator) until both agree on the root
-- cause. After user sign-off, Developer1 implements the fix and Developer2
-- reviews it, iterating until the reviewer is satisfied.
--
-- Topology note: every loop is COUNT-MATCHED. The Orchestrator drives each
-- loop and ends it with a terminal signal word (PROCEED_TO_FIX / FIX_APPROVED /
-- REVIEW_COMPLETE) that the corresponding agent's loop detects via `contains`,
-- so both sides exit in lockstep and the message counts never desync.
-- ============================================================================

flow "debug" (issue: "string") {
  title: "Collaborative Debug"
  description: "Two developers independently triage, converge on the root cause through peer review, get user sign-off, then one fixes and the other reviews — iterating until both are satisfied."
  icon: "bug"

  -- =========================================================================
  -- Orchestrator — drives every loop in lockstep with the developers
  -- =========================================================================
  agent Orchestrator {
    mode: "architect"
    role: "Debug workflow orchestrator. You clarify the issue with the user, coordinate parallel investigation by two developers, broker consensus between them, and drive the fix-and-review loop to completion. You do NOT write or review code yourself."

    -- Phase 1 — Clarify the issue with the user
    escalate @Human reason:
      "Please describe the issue you are experiencing in as much detail as possible: what you expected to happen, what actually happened, steps to reproduce, relevant error messages or logs, and any recent changes."

    await user_description <- @Human

    -- Phase 2 — Parallel triage
    stake triage(
      issue: issue,
      user_description: user_description,
      task: "Investigate the issue thoroughly. Examine the codebase, logs, and any relevant context. Identify the root cause — what is actually broken and why. Do NOT fix anything yet. Provide a detailed analysis."
    ) -> @Developer1

    stake triage(
      issue: issue,
      user_description: user_description,
      task: "Investigate the issue thoroughly. Examine the codebase, logs, and any relevant context. Identify the root cause — what is actually broken and why. Do NOT fix anything yet. Provide a detailed analysis."
    ) -> @Developer2

    await dev1 <- @Developer1
    await dev2 <- @Developer2

    let dev1_analysis = dev1.analysis
    let dev1_verdict = dev1.root_cause
    let dev2_analysis = dev2.analysis
    let dev2_verdict = dev2.root_cause
    let dev1_agrees = false
    let dev2_agrees = false

    -- Phase 3 — Consensus loop (count-matched: each round the Orchestrator
    -- sends one `share` to BOTH developers and awaits one reply from each).
    let converged = false
    repeat until converged {
      stake share(
        my_root_cause: dev1_verdict,
        peer_analysis: dev2_analysis,
        peer_root_cause: dev2_verdict,
        task: "Review the peer developer's analysis and root-cause verdict alongside your own. Consider their evidence and reasoning. Produce your renewed analysis and indicate whether you now agree with their root cause."
      ) -> @Developer1

      stake share(
        my_root_cause: dev2_verdict,
        peer_analysis: dev1_analysis,
        peer_root_cause: dev1_verdict,
        task: "Review the peer developer's analysis and root-cause verdict alongside your own. Consider their evidence and reasoning. Produce your renewed analysis and indicate whether you now agree with their root cause."
      ) -> @Developer2

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

    -- End both consensus loops in lockstep with the terminal signal word.
    stake proceed(task: "PROCEED_TO_FIX. Consensus reached on the root cause; stop reconsidering.") -> @Developer1
    stake proceed(task: "PROCEED_TO_FIX. Consensus reached on the root cause; stop reconsidering.") -> @Developer2

    -- Phase 4 — User sign-off on the agreed root cause
    escalate @Human reason:
      "The developers reached consensus on the root cause. Review their analysis below.\n\nReply 'Agree' to proceed with the fix, or provide guidance."

    await user_signoff <- @Human

    -- Phase 5 — Developer1 implements the fix
    stake assign_fix(
      root_cause: dev1_verdict,
      analysis: dev1_analysis,
      task: "Implement the fix for the agreed-upon root cause. Write the necessary code changes. Keep changes minimal and targeted. After implementing, describe what was changed and why."
    ) -> @Developer1

    await fix_output <- @Developer1

    -- Phase 6 — Review loop (count-matched). Each round: ask Developer2 to
    -- review the latest fix; if not approved, send feedback to Developer1 and
    -- await the revised fix.
    let reviewer_happy = false
    repeat until reviewer_happy {
      stake ask_review(
        root_cause: dev1_verdict,
        implementation: fix_output,
        task: "Review the fix against the agreed-upon root cause. Verify the changes are correct, minimal, and don't introduce new issues. Approve or provide specific, actionable feedback."
      ) -> @Developer2

      await review_outcome <- @Developer2

      when review_outcome.approved {
        set reviewer_happy = true
      } otherwise {
        stake send_feedback(
          feedback: review_outcome.feedback,
          task: "Address the reviewer's feedback. Update the implementation based on their specific suggestions. Keep changes minimal."
        ) -> @Developer1

        await fix_output <- @Developer1
      }
    }

    -- End both fix/review loops in lockstep with their terminal signal words.
    stake fix_approved(task: "FIX_APPROVED. The reviewer accepted your fix; you are done.") -> @Developer1
    stake review_done(task: "REVIEW_COMPLETE. The fix is approved; no further reviews needed.") -> @Developer2

    -- Phase 7 — Done
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
    role: "Senior developer specializing in debugging. You investigate issues, form hypotheses about root causes, collaborate with a peer to reach consensus, and implement precise fixes."

    -- Phase A — Initial triage
    await triage_task <- @Orchestrator
    stake investigate(task: triage_task) -> @Orchestrator
      output: { analysis: "string", root_cause: "string" }

    -- Phase B — Consensus loop (mirrors the Orchestrator; ends on PROCEED_TO_FIX)
    let consensus_done = false
    repeat until consensus_done {
      await peer_round <- @Orchestrator

      when peer_round contains "PROCEED_TO_FIX" {
        set consensus_done = true
      } otherwise {
        stake reconsider(task: peer_round) -> @Orchestrator
          output: { analysis: "string", root_cause: "string", agrees_with_peer: "boolean" }
      }
    }

    -- Phase C — Implement the fix
    await fix_task <- @Orchestrator
    stake fix(task: fix_task) -> @Orchestrator
      output: { changes_summary: "string", files_changed: "string" }

    -- Phase D — Revise on review feedback (mirrors the review loop; ends on FIX_APPROVED)
    let fix_done = false
    repeat until fix_done {
      await fix_directive <- @Orchestrator

      when fix_directive contains "FIX_APPROVED" {
        set fix_done = true
      } otherwise {
        stake revise(task: fix_directive) -> @Orchestrator
          output: { changes_summary: "string", files_changed: "string" }
      }
    }

    commit
  }

  -- =========================================================================
  -- Developer2 — investigates, reaches consensus, then reviews the fix
  -- =========================================================================
  agent Developer2 {
    mode: "code"
    role: "Senior developer specializing in debugging and code review. You investigate issues, form hypotheses about root causes, collaborate with a peer to reach consensus, and rigorously review fixes for correctness and minimality."

    -- Phase A — Initial triage
    await triage_task <- @Orchestrator
    stake investigate(task: triage_task) -> @Orchestrator
      output: { analysis: "string", root_cause: "string" }

    -- Phase B — Consensus loop (mirrors the Orchestrator; ends on PROCEED_TO_FIX)
    let consensus_done = false
    repeat until consensus_done {
      await peer_round <- @Orchestrator

      when peer_round contains "PROCEED_TO_FIX" {
        set consensus_done = true
      } otherwise {
        stake reconsider(task: peer_round) -> @Orchestrator
          output: { analysis: "string", root_cause: "string", agrees_with_peer: "boolean" }
      }
    }

    -- Phase C — Review loop (mirrors the Orchestrator; ends on REVIEW_COMPLETE)
    let review_done = false
    repeat until review_done {
      await review_task <- @Orchestrator

      when review_task contains "REVIEW_COMPLETE" {
        set review_done = true
      } otherwise {
        stake review(task: review_task) -> @Orchestrator
          output: { approved: "boolean", feedback: "string" }
      }
    }

    commit
  }

  -- =========================================================================
  -- Flow constraints
  -- =========================================================================
  converge when: @Orchestrator.committed
  budget: rounds(40), tokens(400000)
}
