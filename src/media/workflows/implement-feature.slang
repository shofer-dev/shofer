-- ============================================================================
-- Flow: Implement a Feature
--
-- The Architect (top-level orchestrator) drives a feature from request to
-- completion by delegating to two specialist agents (Developer + Reviewer).
-- Codebase exploration is left to each agent's discretion — the orchestrator
-- does not explicitly route codebase-discovery stakes.
-- ============================================================================

flow "implement-feature" (feature: "string", design_path: "string") {
  title: "Implement a Feature"
  description: "Multi-agent feature implementation pipeline.\nThe Architect orchestrates exploration, design approval,\nimplementation, and review with two specialist agents (Developer + Reviewer)."
  icon: "wrench"

  param feature {
    description: "The feature to implement (e.g. `oauth-login`, `dark-mode`)."
  }

  param design_path {
    description: "Workspace-relative path to the design document (every agent creates/reads/writes exactly this file)."
    default: "plans/feature-design.md"
  }

  agent Architect {
    mode: "architect"
    role: "Senior software architect. You decompose feature requests into designs, coordinate exploration, gate-keep on user approval, and drive implementation through to completion. You do NOT write code yourself — you delegate to specialist agents. The design document for this run lives at EXACTLY ${design_path} — always create, reference, and route work against that exact path."

    stake create_design(
      feature: feature,
      instructions: "Create the design document and write it to EXACTLY this path: ${design_path} (create any parent directories if they do not exist). Use that exact path — every later step and the user are told the design lives there, so do NOT name it after the feature or place it elsewhere."
    )

    escalate @Human reason:
      "Please review the design document I've created at ${design_path}." form: {
      decision: "string" { widget: "radio", options: ["I approve", "Needs work"] }
      feedback: "string" { description: "What needs to change? (optional)" }
    }

    await response <- @Human

    -- NOTE: a stake declared here is executed by the ARCHITECT; `-> @Developer`
    -- only routes the *result* to the Developer's mailbox (consumed by its
    -- `await design <- @Architect`). It does NOT make the Developer run this
    -- stake. So these instructions are addressed to the Architect as a HAND-OFF
    -- — never "implement…"/"review…", which would make the Architect try to do
    -- the work itself (and stall in architect mode). The Developer/Reviewer do
    -- the actual work via their own stakes below.
    stake implement(
      design: feature,
      instructions: "Hand the approved design off to the Developer so it can begin implementing. You are the architect: you do NOT write code, do NOT switch modes, and will NOT be switched to code mode — the Developer implements. Produce a concise hand-off as your result: the design lives at EXACTLY ${design_path}; summarise the approved scope and any constraints the Developer must honour. The Developer will read ${design_path}, implement it slice by slice, and report back for review."
    ) -> @Developer

    stake prepare_to_review(
      design: feature,
      instructions: "Brief the Reviewer so it is ready to evaluate the Developer's work. You are the architect: do NOT review or edit code yourself. Produce a short standing brief as your result — the design is at EXACTLY ${design_path}; the Reviewer waits for per-round review requests and evaluates each one against it."
    ) -> @Reviewer

    let implementation_done = false
    repeat until implementation_done {
      await developer_signal <- @Developer

      when developer_signal.done {
        set implementation_done = true
      } otherwise {
        stake review_this_round(
          design: feature,
          implementation_summary: developer_signal.summary,
          instructions: "Forward this round's work to the Reviewer for evaluation. This is a review request, NOT the terminal stop signal — set complete=false and put the work to review in `details`."
        ) -> @Reviewer
          output: { complete: "boolean", details: "string" }

        await review_result <- @Reviewer

        when review_result.approved {
          stake reviewer_accepted(
            review: review_result,
            instructions: "The Reviewer ACCEPTED this round. Tell the Developer their latest slice passed — set accepted=true."
          ) -> @Developer
            output: { accepted: "boolean", details: "string" }
        } otherwise {
          stake fix_issues(
            issues: review_result.issues,
            review: review_result,
            instructions: "The Reviewer found issues. Relay them for the Developer to fix — set accepted=false and put the issues in `details`."
          ) -> @Developer
            output: { accepted: "boolean", details: "string" }
        }
      }
    }

    -- Final review gate before committing
    stake final_review(
      design: feature,
      instructions: "Request a FINAL comprehensive review of the complete implementation against the design at ${design_path}. This is still a review request, NOT the stop signal — set complete=false."
    ) -> @Reviewer
      output: { complete: "boolean", details: "string" }

    await final_verdict <- @Reviewer

    -- Release the Reviewer's loop (count-matched signal) so it commits cleanly.
    stake review_complete(
      instructions: "Terminal signal: the final review is recorded and no further reviews are needed. Set complete=true so the Reviewer stops looping and commits."
    ) -> @Reviewer
      output: { complete: "boolean", details: "string" }

    when final_verdict.approved {
      commit
    } otherwise {
      escalate @Human reason:
        "Final review found issues. Please review and decide how to proceed." form: {
        decision: "string" { widget: "radio", options: ["ACK — commit anyway", "I'll provide fix instructions"] }
        instructions: "string" { description: "Your fix instructions (optional)" }
      }
      await human_decision <- @Human
      commit
    }
  }

  agent Developer {
    mode: "code"
    role: "Feature implementation specialist. You implement the design document at EXACTLY ${design_path} (read it from that path; do not look elsewhere) by writing, modifying, and refactoring code. Do NOT commit changes to git — you will be instructed when to commit. After each slice, report progress (done=false) so the Reviewer can evaluate; when ALL work is complete and accepted, set done=true."

    await design <- @Architect

    let work_complete = false
    repeat until work_complete {
      stake progress_update(
        instructions: "Implement the next slice of the design, then request a review. You are NOT finished — set done=false and summarise this slice in `summary`."
      ) -> @Architect
        output: { done: "boolean", summary: "string" }

      await directive <- @Architect

      when directive.accepted {
        set work_complete = true
      }
    }

    stake done_signal(
      instructions: "All design items are implemented and the Reviewer has accepted them. This is the terminal completion signal — set done=true."
    ) -> @Architect
      output: { done: "boolean", summary: "string" }

    commit
  }

  agent Reviewer {
    mode: "reviewer"
    role: "Code reviewer. Evaluate implementations against the design document at EXACTLY ${design_path}. Approve work that meets the spec. For issues, provide specific, actionable feedback. You have final authority on whether the implementation is satisfactory."

    await init <- @Architect

    let review_done = false
    repeat until review_done {
      await review_request <- @Architect

      when review_request.complete {
        set review_done = true
      } otherwise {
        stake review_verdict(
          implementation_summary: review_request.details,
          task: "Evaluate the implementation against the design at ${design_path}. Decide whether it satisfies the design; if not, give specific, actionable feedback. Set approved=true/false."
        ) -> @Architect
          output: { approved: "boolean", issues: "string" }
      }
    }

    commit
  }

  converge when: @Architect.committed
  budget: rounds(30)
}
