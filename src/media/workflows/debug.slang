-- ============================================================================
-- Flow: Debug
--
-- Orchestrator clarifies the issue with the user, then dispatches two
-- developer agents in parallel for independent triage and root-cause
-- analysis.  The developers exchange their findings and iterate until
-- they reach consensus.  Developer1 then implements the fix while
-- Developer2 reviews.  The fix‑and‑review loop repeats until Developer2
-- is satisfied.
-- ============================================================================

flow "debug" (issue: "string") {
  title: "Collaborative Debug"
  description: "Two developers independently triage, converge on the root cause through peer review, get user sign-off, then one fixes and the other reviews — iterating until both are satisfied."
  icon: "bug"

  -- =========================================================================
  -- Orchestrator
  -- =========================================================================
  agent Orchestrator {
    mode: "architect"
    role: "Debug workflow orchestrator. You clarify the issue with the user, coordinate parallel investigation by two developers, broker consensus between them, and drive the fix‑and‑review loop to completion. You do NOT write or review code yourself."

    -- ------------------------------------------------------------------
    -- Phase 1 — Clarify the issue with the user
    -- ------------------------------------------------------------------
    escalate @Human reason:
      "Please describe the issue you are experiencing in as much detail as possible: what you expected to happen, what actually happened, steps to reproduce, relevant error messages or logs, and any recent changes."

    await user_description <- @Human

    -- ------------------------------------------------------------------
    -- Phase 2 — Parallel triage
    -- ------------------------------------------------------------------
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

    -- ------------------------------------------------------------------
    -- Phase 3 — Consensus loop: exchange opinions until both agree
    -- ------------------------------------------------------------------
    let converged = false
    repeat until converged {
      when dev1_agrees == false {
        stake consider_peer(
          my_original_analysis: dev1_analysis,
          my_root_cause: dev1_verdict,
          peer_analysis: dev2_analysis,
          peer_root_cause: dev2_verdict,
          task: "Review the peer developer's analysis and root-cause verdict alongside your own. Consider their evidence and reasoning. Produce your renewed analysis and indicate whether you agree with their root cause."
        ) -> @Developer1
      }

      when dev2_agrees == false {
        stake consider_peer(
          my_original_analysis: dev2_analysis,
          my_root_cause: dev2_verdict,
          peer_analysis: dev1_analysis,
          peer_root_cause: dev1_verdict,
          task: "Review the peer developer's analysis and root-cause verdict alongside your own. Consider their evidence and reasoning. Produce your renewed analysis and indicate whether you agree with their root cause."
        ) -> @Developer2
      }

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

    -- ------------------------------------------------------------------
    -- Phase 4 — User approval loop (re-runs consensus on feedback)
    -- ------------------------------------------------------------------
    let user_approved = false
    repeat until user_approved {
      escalate @Human reason:
        "The developers have reached consensus on the root cause. Review their analysis below.\n\nReply 'Agree' to proceed with the fix, or provide feedback to refine the analysis."

      await user_input <- @Human

      when user_input contains "Agree" {
        set user_approved = true
      } otherwise {
        -- Feed user feedback to both developers
        stake incorporate_feedback(
          feedback: user_input,
          task: "The user reviewed the developer consensus and provided the following feedback. Incorporate it into your analysis and update your root cause verdict if needed."
        ) -> @Developer1

        stake incorporate_feedback(
          feedback: user_input,
          task: "The user reviewed the developer consensus and provided the following feedback. Incorporate it into your analysis and update your root cause verdict if needed."
        ) -> @Developer2

        await renewed1 <- @Developer1
        await renewed2 <- @Developer2

        set dev1_analysis = renewed1.analysis
        set dev1_verdict = renewed1.root_cause
        set dev2_analysis = renewed2.analysis
        set dev2_verdict = renewed2.root_cause

        -- Re-run consensus loop so developers re-converge on the new analysis
        set dev1_agrees = false
        set dev2_agrees = false
        let re_converged = false
        repeat until re_converged {
          when dev1_agrees == false {
            stake consider_peer(
              my_original_analysis: dev1_analysis,
              my_root_cause: dev1_verdict,
              peer_analysis: dev2_analysis,
              peer_root_cause: dev2_verdict,
              task: "Review the peer developer's analysis and root-cause verdict alongside your own. Consider their evidence and reasoning. Produce your renewed analysis and indicate whether you agree with their root cause."
            ) -> @Developer1
          }

          when dev2_agrees == false {
            stake consider_peer(
              my_original_analysis: dev2_analysis,
              my_root_cause: dev2_verdict,
              peer_analysis: dev1_analysis,
              peer_root_cause: dev1_verdict,
              task: "Review the peer developer's analysis and root-cause verdict alongside your own. Consider their evidence and reasoning. Produce your renewed analysis and indicate whether you agree with their root cause."
            ) -> @Developer2
          }

          await renewed1 <- @Developer1
          await renewed2 <- @Developer2

          set dev1_analysis = renewed1.analysis
          set dev1_verdict = renewed1.root_cause
          set dev1_agrees = renewed1.agrees_with_peer

          set dev2_analysis = renewed2.analysis
          set dev2_verdict = renewed2.root_cause
          set dev2_agrees = renewed2.agrees_with_peer

          when dev1_agrees && dev2_agrees {
            set re_converged = true
          }
        }
      }
    }

    -- ------------------------------------------------------------------
    -- Phase 5 — Developer1 implements the fix
    -- ------------------------------------------------------------------
    stake implement_fix(
      root_cause: dev1_verdict,
      analysis: dev1_analysis,
      task: "Implement the fix for the agreed-upon root cause. Write the necessary code changes. Keep changes minimal and targeted. After implementing, describe what was changed and why."
    ) -> @Developer1

    await implementation <- @Developer1

    -- ------------------------------------------------------------------
    -- Phase 6 — Developer2 reviews; iterate until approved
    -- ------------------------------------------------------------------
    let reviewer_happy = false
    let fix_output = implementation
    repeat until reviewer_happy {
      stake review_fix(
        root_cause: dev1_verdict,
        implementation: fix_output,
        task: "Review the fix against the agreed-upon root cause. Verify the changes are correct, minimal, and don't introduce new issues. Approve or provide specific, actionable feedback."
      ) -> @Developer2

      await review_outcome <- @Developer2

      when review_outcome.approved {
        set reviewer_happy = true
      } otherwise {
        stake address_review_feedback(
          feedback: review_outcome.feedback,
          task: "Address the reviewer's feedback. Update the implementation based on their specific suggestions. Keep changes minimal."
        ) -> @Developer1

        await fix_output <- @Developer1
      }
    }

    -- ------------------------------------------------------------------
    -- Phase 7 — Done
    -- ------------------------------------------------------------------
    stake report(
      issue: issue,
      root_cause: dev1_verdict,
      fix_summary: fix_output
    ) -> @out

    commit
  }

  -- =========================================================================
  -- Developer1 — investigates, reaches consensus, then fixes
  -- =========================================================================
  agent Developer1 {
    mode: "code"
    role: "Senior developer specializing in debugging. You investigate issues, form hypotheses about root causes, collaborate with peers to reach consensus, and implement precise fixes."

    -- Phase A — Initial triage
    await triage_task <- @Orchestrator
    stake investigate(task: triage_task) -> @Orchestrator
      output: { analysis: "string", root_cause: "string" }

    -- Phase B — Consensus loop: consider peer's analysis
    await peer_data <- @Orchestrator
    stake reconsider(task: peer_data) -> @Orchestrator
      output: { analysis: "string", root_cause: "string", agrees_with_peer: "boolean" }

    -- Phase C — Incorporate user feedback on the consensus
    await user_feedback <- @Orchestrator
    stake incorporate_feedback(task: user_feedback) -> @Orchestrator
      output: { analysis: "string", root_cause: "string" }

    -- Phase D — Implement the fix
    await fix_task <- @Orchestrator
    stake fix(task: fix_task) -> @Orchestrator
      output: { changes_summary: "string", files_changed: "string" }

    -- Phase E — Address review feedback (loop)
    await review_feedback <- @Orchestrator
    stake revise(task: review_feedback) -> @Orchestrator
      output: { changes_summary: "string", files_changed: "string" }

    commit
  }

  -- =========================================================================
  -- Developer2 — investigates, reaches consensus, then reviews
  -- =========================================================================
  agent Developer2 {
    mode: "code"
    role: "Senior developer specializing in debugging and code review. You investigate issues, form hypotheses about root causes, collaborate with peers to reach consensus, and rigorously review fixes for correctness and minimality."

    -- Phase A — Initial triage
    await triage_task <- @Orchestrator
    stake investigate(task: triage_task) -> @Orchestrator
      output: { analysis: "string", root_cause: "string" }

    -- Phase B — Consensus loop: consider peer's analysis
    await peer_data <- @Orchestrator
    stake reconsider(task: peer_data) -> @Orchestrator
      output: { analysis: "string", root_cause: "string", agrees_with_peer: "boolean" }

    -- Phase C — Incorporate user feedback on the consensus
    await user_feedback <- @Orchestrator
    stake incorporate_feedback(task: user_feedback) -> @Orchestrator
      output: { analysis: "string", root_cause: "string" }

    -- Phase D — Review the fix
    await review_task <- @Orchestrator
    stake review(task: review_task) -> @Orchestrator
      output: { approved: "boolean", feedback: "string" }

    commit
  }

  -- =========================================================================
  -- Flow constraints
  -- =========================================================================
  converge when: @Orchestrator.committed
  budget: rounds(40), tokens(400000)
}
