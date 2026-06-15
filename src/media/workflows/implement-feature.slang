-- ============================================================================
-- Flow: Implement a Feature
--
-- The Architect (top-level orchestrator) drives a feature from request to
-- completion by delegating to two specialist agents (Developer + Reviewer).
-- Codebase exploration is left to each agent's discretion — the orchestrator
-- does not explicitly route codebase-discovery stakes.
-- ============================================================================

flow "implement-feature" (feature: "string") {
  title: "Implement a Feature"
  description: "Multi-agent feature implementation pipeline.\nThe Architect orchestrates exploration, design approval,\nimplementation, and review with two specialist agents (Developer + Reviewer)."
  icon: "wrench"

  param feature {
    description: "The feature to implement (e.g. `oauth-login`, `dark-mode`)."
  }

  agent Architect {
    mode: "architect"
    role: "Senior software architect. You decompose feature requests into designs, coordinate exploration, gate-keep on user approval, and drive implementation through to completion. You do NOT write code yourself — you delegate to specialist agents."

    stake create_design(
      feature: feature,
      instructions: "Create the design document and write it to EXACTLY this path: plans/feature-design.md (create the plans/ directory if it does not exist). Use that exact filename — later steps and the user are told the design lives there, so do NOT name it after the feature or place it elsewhere."
    )

    escalate @Human reason:
      "Please review the design document I've created at plans/feature-design.md. Reply with 'ACK' to approve and proceed to implementation, or provide feedback for revision."

    await response <- @Human

    stake implement(
      design: feature,
      instructions: "Implement the design document at plans/feature-design.md. After each significant change, signal READY_FOR_REVIEW. When ALL work is complete, signal DONE. Do NOT commit any changes to git — you will be instructed when to commit. Ask clarification questions if you are not sure about something."
    ) -> @Developer

    stake prepare_to_review(
      design: feature,
      instructions: "You will review the Developer's implementation against the design at plans/feature-design.md. Wait for review requests and evaluate each one."
    ) -> @Reviewer

    let implementation_done = false
    repeat until implementation_done {
      await developer_signal <- @Developer

      when developer_signal contains "DONE" {
        set implementation_done = true
      } otherwise {
        stake review_this_round(
          design: feature,
          implementation_summary: developer_signal
        ) -> @Reviewer

        await review_result <- @Reviewer

        when review_result.approved {
          stake reviewer_accepted(review: review_result) -> @Developer
        } otherwise {
          stake fix_issues(
            issues: review_result.issues,
            review: review_result
          ) -> @Developer
        }
      }
    }

    -- Final review gate before committing
    stake final_review(
      design: feature,
      instructions: "Perform a final comprehensive review of the complete implementation against the design at plans/feature-design.md. Confirm everything is correct before the commit."
    ) -> @Reviewer

    await final_verdict <- @Reviewer

    -- Release the Reviewer's loop (count-matched signal) so it commits cleanly.
    stake review_complete(
      instructions: "REVIEW_COMPLETE — the final review is recorded; no further reviews needed."
    ) -> @Reviewer

    when final_verdict.approved {
      commit
    } otherwise {
      escalate @Human reason:
        "Final review found issues. Please review and decide how to proceed. Reply ACK to commit anyway, or provide instructions for fixes."
      await human_decision <- @Human
      commit
    }
  }

  agent Developer {
    mode: "code"
    role: "Feature implementation specialist. You implement the design document by writing, modifying, and refactoring code. Do NOT commit changes to git — you will be instructed when to commit. After each significant change, signal READY_FOR_REVIEW so the Reviewer can evaluate. When ALL work is complete, signal DONE."

    await design <- @Architect

    let work_complete = false
    repeat until work_complete {
      stake progress_update(
        status: "READY_FOR_REVIEW",
        summary: "Implemented the next slice of the design; requesting review."
      ) -> @Architect

      await directive <- @Architect

      when directive contains "ACCEPTED" {
        set work_complete = true
      }
    }

    stake done_signal(
      status: "DONE",
      summary: "All design items implemented and accepted by the Reviewer."
    ) -> @Architect

    commit
  }

  agent Reviewer {
    mode: "reviewer"
    role: "Code reviewer. Evaluate implementations against the design document. Approve work that meets the spec. For issues, provide specific, actionable feedback. You have final authority on whether the implementation is satisfactory."

    await init <- @Architect

    let review_done = false
    repeat until review_done {
      await review_request <- @Architect

      when review_request contains "REVIEW_COMPLETE" {
        set review_done = true
      } otherwise {
        stake review_verdict(
          implementation_summary: review_request,
          task: "Evaluate the implementation against the design at plans/feature-design.md. Decide whether it satisfies the design; if not, give specific, actionable feedback."
        ) -> @Architect
          output: { approved: "boolean", issues: "string" }
      }
    }

    commit
  }

  converge when: @Architect.committed
  budget: rounds(30), tokens(300000)
}
