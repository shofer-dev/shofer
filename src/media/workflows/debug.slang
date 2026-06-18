-- ============================================================================
-- Flow: Debug
--
-- Two developers independently investigate the issue READ-ONLY (no fixes) —
-- both receive the same brief. Their findings go to the Orchestrator, who
-- consolidates them into a SINGLE fix plan and assigns it to one developer
-- (Developer1, the writer). Once Developer1 reports the fix done, Developer2
-- (the read-only reviewer) reviews the implementation; its feedback is relayed
-- back to Developer1, who revises — looping until the reviewer is satisfied.
--
-- Topology note: the review loop is COUNT-MATCHED. The Orchestrator drives it and
-- ends each peer's loop with a terminal structured stop signal — a boolean
-- field on the stake's output (`approved` for the writer, `complete` for the
-- reviewer) that the developer detects with a `when` check, so both sides exit
-- in lockstep and the message counts never desync.
-- ============================================================================

flow "debug" (issue: "string") {
  title: "Collaborative Debug"
  description: "Two developers independently investigate the issue (read-only); the Orchestrator consolidates their findings into one fix plan for the writer, then the other developer reviews the implementation — iterating until the reviewer is satisfied."
  icon: "bug"

  param issue {
    description: "Describe the issue in as much detail as possible: what you expected to happen, what actually happened, steps to reproduce, relevant error messages or logs, and any recent changes."
  }

  -- =========================================================================
  -- Orchestrator — dispatches investigation, consolidates the findings into a
  -- single fix plan, and drives the review loop. Does NOT write or review code.
  -- =========================================================================
  agent Orchestrator {
    mode: "architect"
    -- Pure coordinator: only `questions` (so it can still clarify with the user).
    -- NO read/write/execute (it consolidates from the developers' written
    -- findings; it does not investigate or fix), NO `mode` (cannot switch into
    -- code) and NO `subtasks` (the workflow spawns the developers). Always-available
    -- tools (attempt_completion, send_message_to_task, …) are retained regardless.
    tools: [questions]
    role: "Debug workflow orchestrator. You dispatch parallel read-only investigation to two developers, consolidate their independent findings into a single coherent fix plan, assign it to the writer, and drive the review loop to completion. You do NOT investigate, write, or review code yourself."

    -- Phase 1 — Parallel READ-ONLY investigation (the SAME brief to both).
    --
    -- NOTE: a stake declared here is executed by the ORCHESTRATOR; `-> @DeveloperN`
    -- only routes the *result* (the dispatch brief) to that developer's mailbox
    -- (consumed by its `await investigate_task <- @Orchestrator`). It does NOT make
    -- the developer run this stake. So the instruction is a DISPATCH addressed to
    -- the Orchestrator — "Produce the investigation brief…", never "investigate…",
    -- which would make the Orchestrator do the work itself (and stall in architect
    -- mode). Each developer does the real work via its own `investigate` stake.
    stake investigate_brief(
      issue: issue,
      user_description: issue,
      task: "Dispatch read-only investigation to this developer. You are the orchestrator: you do NOT investigate or modify anything yourself. Produce the investigation brief as your result, instructing the developer: STRICT READ-ONLY INVESTIGATION — investigate using read/search tools ONLY; do NOT modify, create, delete, move, or apply any change to any file (no apply_diff / write_to_file / insert_edit / sed) and do NOT run any command that mutates the workspace or git; examine the codebase, logs, and context; identify the root cause — what is actually broken and why; output analysis only — describe the proposed fix in words, do NOT implement it."
    ) -> @Developer1

    stake investigate_brief(
      issue: issue,
      user_description: issue,
      task: "Dispatch read-only investigation to this developer. You are the orchestrator: you do NOT investigate or modify anything yourself. Produce the investigation brief as your result, instructing the developer: STRICT READ-ONLY INVESTIGATION — investigate using read/search tools ONLY; do NOT modify, create, delete, move, or apply any change to any file (no apply_diff / write_to_file / insert_edit / sed) and do NOT run any command that mutates the workspace or git; examine the codebase, logs, and context; identify the root cause — what is actually broken and why; output analysis only — describe the proposed fix in words, do NOT implement it."
    ) -> @Developer2

    await dev1 <- @Developer1
    await dev2 <- @Developer2

    let dev1_analysis = dev1.analysis
    let dev1_root_cause = dev1.root_cause
    let dev2_analysis = dev2.analysis
    let dev2_root_cause = dev2.root_cause

    -- Phase 2 — Consolidate BOTH investigations into ONE fix plan for the writer.
    stake assign_fix(
      dev1_analysis: dev1_analysis,
      dev1_root_cause: dev1_root_cause,
      dev2_analysis: dev2_analysis,
      dev2_root_cause: dev2_root_cause,
      task: "Consolidate the two independent investigations (provided in your inputs) into a SINGLE, coherent fix plan and assign it to Developer1. You are the orchestrator: you do NOT write code yourself. Reconcile the two analyses — resolve any disagreement on the root cause, pick the best-supported diagnosis, and merge complementary findings. Produce the fix assignment as your result, instructing Developer1: implement the fix for the consolidated root cause, keep the changes minimal and targeted, then describe what was changed and why."
    ) -> @Developer1

    await fix_output <- @Developer1

    -- Phase 3 — Review loop (count-matched). Each round: ask Developer2 to review
    -- the latest fix; if not approved, relay the feedback to Developer1 and await
    -- the revised fix.
    let reviewer_happy = false
    repeat until reviewer_happy {
      stake ask_review(
        root_cause: dev1_root_cause,
        implementation: fix_output,
        task: "Ask Developer2 to review the latest fix (read-only) against the agreed root cause. This is a review request, NOT the terminal stop signal — set complete=false and put the fix to review in `details`."
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

    -- End both loops in lockstep with their terminal structured signals.
    stake fix_approved(task: "The reviewer accepted your fix; you are done. This IS the terminal signal — set approved=true.") -> @Developer1
      output: { approved: "boolean", details: "string" }
    stake review_done(task: "The fix is approved; no further reviews needed. This IS the terminal signal — set complete=true.") -> @Developer2
      output: { complete: "boolean", details: "string" }

    -- Phase 4 — Done
    stake report(
      issue: issue,
      consolidated_root_cause: dev1_root_cause,
      peer_root_cause: dev2_root_cause,
      fix_summary: fix_output
    ) -> @out

    commit
  }

  -- =========================================================================
  -- Developer1 — investigates (read-only), then implements & revises the fix
  -- =========================================================================
  agent Developer1 {
    mode: "code"
    role: "Senior developer specializing in debugging. CRITICAL RULE: during INVESTIGATION you are STRICTLY READ-ONLY — investigate and form hypotheses, but do NOT modify, create, or delete any file and do NOT run mutating commands. You may ONLY make changes when the orchestrator assigns you the FIX task (or fix-revision feedback). Implement precise, minimal fixes only in that fix stage."

    -- Phase A — Read-only investigation
    await investigate_task <- @Orchestrator
    stake investigate(task: investigate_task) -> @Orchestrator
      output: { analysis: "string", root_cause: "string" }

    -- Phase B — Implement the consolidated fix
    await fix_task <- @Orchestrator
    stake fix(task: fix_task) -> @Orchestrator
      output: { changes_summary: "string", files_changed: "string" }

    -- Phase C — Revise on review feedback (ends on the `approved` stop signal)
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
  -- Developer2 — investigates (read-only), then reviews the fix (read-only)
  -- =========================================================================
  agent Developer2 {
    mode: "reviewer"
    role: "Senior developer specializing in debugging and code review. You are READ-ONLY for the entire workflow: you investigate, form hypotheses, and rigorously review the other developer's fix for correctness and minimality — but you NEVER modify files yourself. Your `reviewer` mode has no write tools by design."

    -- Phase A — Read-only investigation
    await investigate_task <- @Orchestrator
    stake investigate(task: investigate_task) -> @Orchestrator
      output: { analysis: "string", root_cause: "string" }

    -- Phase B — Review loop (mirrors the Orchestrator; ends on the `complete` stop signal)
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
