# Workflow Abstraction — Design Document

Design for the **Workflow** abstraction in Shofer: a container for coordinated Tasks executed by a formal, non-LLM-driven executor following a `.slang` specification.

> **Implementation Status**: ✅ Slang parser (vendored from @riktar/slang, MIT) — [`src/core/workflow/slang-lexer.ts`](../../extensions/shofer/src/core/workflow/slang-lexer.ts), [`slang-parser-upstream.ts`](../../extensions/shofer/src/core/workflow/slang-parser-upstream.ts), [`slang-resolver.ts`](../../extensions/shofer/src/core/workflow/slang-resolver.ts)  
> ✅ WorkflowTask class — [`src/core/workflow/WorkflowTask.ts`](../../extensions/shofer/src/core/workflow/WorkflowTask.ts)  
> ✅ .slang file discovery (`discoverWorkflows()`)  
> ✅ `+` button dropdown (QuickPick: New Task / New Workflow → workflow picker) — [`registerCommands.ts`](../../extensions/shofer/src/activate/registerCommands.ts#L82)  
> ✅ `escalate @Human` support  
> ✅ Agent-to-task dispatch (spawn + resume via message queue)  
> ✅ Stake routing + mailbox routing  
> ✅ FlowState persistence via HistoryItem (`isWorkflow`, `slangSource`, `flowState` fields)  
> ✅ i18n (`plus.json` locale)  
> ✅ Example workflow — [`.shofer/workflows/implement-feature.slang`](../../.shofer/workflows/implement-feature.slang)  
> 🔜 **Deferred**: Welcome View Redesign (Section §"Welcome View Redesign" below)  
> 🔜 **Deferred**: TaskSelector/HistoryView WorkflowTask-aware adaptations

## Table of Contents

1. [Motivation](#motivation)
2. [The Slang Specification for "Implement a Feature"](#the-slang-specification-for-implement-a-feature)
3. [Architecture Overview](#architecture-overview)
4. [Slang → Shofer Mapping](#slang--shofer-mapping)
    - Full language reference: [`slang_specs.md`](slang_specs.md)
5. [Workflow Executor Design](#workflow-executor-design)
6. [New Mode: "Implement a Feature"](#new-mode-implement-a-feature)
7. [Agent-to-Task Dispatch](#agent-to-task-dispatch)
8. [User Interaction](#user-interaction)
9. [Open Design Questions](#open-design-questions)
10. [Implementation Status](#implementation-status)
11. [Related Documents](#related-documents)

---

## Motivation

Today, Shofer's Orchestrator mode uses an **LLM-driven** approach: the Orchestrator agent itself decides when to spawn sub-tasks, what mode they should use, and how to coordinate them. This works, but it has limitations:

- **Non-deterministic coordination.** The LLM may forget steps, skip the review loop, or terminate early.
- **No provable correctness.** There's no way to statically verify that a workflow will complete correctly.
- **The Orchestrator IS the bottleneck.** It must hold the entire workflow in its context window while juggling multiple children.

The **Workflow** abstraction introduces a **formal, non-LLM-driven executor** that reads a `.slang` specification and dispatches agents as Shofer background Tasks. The executor is a deterministic state machine — it makes zero LLM calls itself. All "intelligence" lives inside the agent Tasks, which are standard Shofer `Task` instances with full tool access.

---

## The Slang Specification for "Implement a Feature"

Below is the `.slang` specification for the user's requested workflow. This file would live at `.shofer/workflows/implement-feature.slang`:

```slang
-- ============================================================================
-- Flow: Implement a Feature
--
-- When the user wants to implement a feature, they select "Implement a Feature"
-- from the mode selector. This activates the Architect (top-level orchestrator),
-- which:
--   a) Creates an "Explore codebase" task to investigate the codebase
--   b) Creates a design document
--   c) Asks the user to review the design and waits for ACK
--   d) Re-reads the design doc (manual edits possible) and integrates feedback,
--      iterating until the user approves
--   e) Creates two more sub-tasks: "Developer" and "Reviewer"
--   f) Prompts the Developer to implement, telling it to ask the Reviewer to
--      review repeatedly until both are happy
--   g) Once Developer reports DONE, asks Reviewer for final confirmation
--   h) If Reviewer is not satisfied, prompts Developer again
--   i) Otherwise, reports completion to the user and exits
-- ============================================================================

flow "implement-feature" (feature: "string") {

  -- =========================================================================
  -- Agent: Architect (top-level orchestrator)
  --
  -- This agent runs as a Shofer Task. Mode: "orchestrator"
  -- Role: decomposes feature requests, coordinates exploration,
  -- gate-keeps on user approval, drives the implementation loop.
  -- NB: The Architect agent IS part of the workflow, not the Workflow Task
  -- itself. The Workflow Task's slangLoop() dispatches all agents including
  -- this one.
  -- =========================================================================
  agent Architect {
    mode: "orchestrator"
    model: "claude-sonnet"
    role: "Senior software architect. You decompose feature requests into designs, coordinate exploration, gate-keep on user approval, and drive implementation through to completion. You do NOT write code yourself — you delegate to specialist agents."

    -- ------------------------------------------------------------------
    -- Phase 1: Explore the codebase
    -- Spawn an Codebase agent with read-only + search tools to understand
    -- the existing code and identify relevant modules.
    -- ------------------------------------------------------------------
    stake explore(
      task: "Investigate the codebase to understand architecture, relevant modules, and integration points for the requested feature.",
      feature: feature
    ) -> @Codebase

    await findings <- @Codebase

    -- ------------------------------------------------------------------
    -- Phase 2: Create the design document
    -- Synthesize exploration findings into a concrete design with
    -- implementation plan, affected files, and architecture decisions.
    -- The design is written to the workspace (e.g., plans/feature-design.md)
    -- and also emitted as structured output.
    -- ------------------------------------------------------------------
    let design = stake create_design(
      feature: feature,
      codebase_context: findings
    ) -> @out
      output: { title: "string", overview: "string", plan: "string", files: "string" }

    -- ------------------------------------------------------------------
    -- Phase 3: User review loop
    -- Present the design to the user. Iterate on feedback until the user
    -- acknowledges with "ACK". Each iteration re-reads the design file
    -- to pick up any manual edits the user made directly.
    -- ------------------------------------------------------------------
    let approved = false
    repeat until approved {
      escalate @Human reason:
        "Please review the design document I've created at plans/feature-design.md. Reply with 'ACK' to approve and proceed to implementation, or provide feedback for revision."

      await response <- @Human

      when response contains "ACK" {
        set approved = true
      } otherwise {
        -- Re-read the design document to pick up any manual edits the user made
        let updated_design = stake reread_design_and_integrate_feedback(
          design_path: "plans/feature-design.md",
          user_feedback: response
        )
        let revised = stake revise_design(
          original: updated_design,
          feedback: response
        ) -> @out
          output: { title: "string", overview: "string", plan: "string", files: "string" }
        set design = revised
      }
    }

    -- ------------------------------------------------------------------
    -- Phase 4: Kick off implementation
    -- Spawn the Developer (code mode) and Reviewer (reviewer mode).
    -- The Developer is given the approved design.
    -- The Reviewer receives context so it's ready to evaluate.
    -- ------------------------------------------------------------------
    stake implement(
      design: design,
      instructions: "Implement the design document at plans/feature-design.md. After each significant change, signal READY_FOR_REVIEW. When ALL work is complete, signal DONE."
    ) -> @Developer

    stake prepare_to_review(
      design: design,
      instructions: "You will review the Developer's implementation against the design at plans/feature-design.md. Wait for review requests and evaluate each one."
    ) -> @Reviewer

    -- ------------------------------------------------------------------
    -- Phase 5: Developer ↔ Reviewer handshake loop
    --
    -- The Architect monitors the Developer. Each time the Developer signals
    -- READY_FOR_REVIEW, the Reviewer evaluates the changes. If issues
    -- exist, the Developer fixes them. The loop continues until the
    -- Developer reports DONE.
    -- ------------------------------------------------------------------
    let implementation_done = false
    repeat until implementation_done {
      await developer_signal <- @Developer

      when developer_signal contains "READY_FOR_REVIEW" {
        stake review_this_round(
          design: design,
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

      when developer_signal contains "DONE" {
        set implementation_done = true
      }
    }

    -- ------------------------------------------------------------------
    -- Phase 6: Final Reviewer confirmation
    --
    -- The Developer says it's done. Now ask the Reviewer directly: "Are you
    -- satisfied?" If not, send the Developer back for fixes and ask again.
    -- ------------------------------------------------------------------
    let reviewer_satisfied = false
    repeat until reviewer_satisfied {
      stake confirm_final_satisfaction(
        design: design
      ) -> @Reviewer

      await final_verdict <- @Reviewer

      when final_verdict.satisfied {
        set reviewer_satisfied = true
      } otherwise {
        stake fix_remaining_issues(
          issues: final_verdict.issues,
          design: design
        ) -> @Developer

        await developer_fix_done <- @Developer
      }
    }

    -- ------------------------------------------------------------------
    -- Phase 7: Report completion to the user
    -- ------------------------------------------------------------------
    stake report_completion(
      feature: feature,
      design: design,
      implementation: "Feature implementation is complete. Both Developer and Reviewer are satisfied with the result."
    ) -> @out

    commit
  }

  -- =========================================================================
  -- Agent: Codebase
  --
  -- Shofer mode: "search" (read-only with RAG, LSP, grep, file access)
  -- =========================================================================
  agent Codebase {
    mode: "search"
    role: "Codebase explorer. Investigate the existing code to understand architecture, relevant modules, dependencies, and integration points. Do NOT write code — only report what exists."

    await task <- @any
    stake explore(task: task) -> @any
      output: {
        architecture: "string",
        relevant_modules: "string",
        integration_points: "string",
        constraints: "string"
      }
    commit
  }

  -- =========================================================================
  -- Agent: Internet
  --
  -- Shofer mode: "browser" (browser automation + read)
  -- Shared resource: Architect, Developer, and Reviewer can all query it
  -- directly via send_message_to_task to fetch fresh info from external sources.
  -- =========================================================================
  agent Internet {
    mode: "browser"
    role: "Web research specialist. Fetch fresh information from external/internet sources — latest library versions, API docs, changelogs, best practices. Do NOT write code — only retrieve and summarize information."

    await task <- @any
    stake fetch(task: task) -> @any
      output: {
        query: "string",
        findings: "string",
        sources: "string"
      }
    commit
  }

  -- =========================================================================
  -- Agent: Developer
  --
  -- Shofer mode: "code" (full write + execute + read access)
  -- Can peer-message Codebase and Internet for codebase context and external info.
  -- =========================================================================
  agent Developer {
    mode: "code"
    role: "Feature implementation specialist. You implement the design document by writing, modifying, and refactoring code. After each significant change, signal READY_FOR_REVIEW so the Reviewer can evaluate. When ALL work is complete, signal DONE. You have access to shared resources: use send_message_to_task to query the Codebase (codebase context) and Internet (external info)."
    tools: [write_to_file, apply_diff, sed, insert_edit, execute_command,
            read_file, grep_search, lsp_search, find_files, list_files]

    await design <- @Architect

    let work_complete = false
    repeat until work_complete {
      let result = stake work_on_implementation(design: design)
        output: { signal: "string", summary: "string", changed_files: "string" }

      when result.signal == "READY_FOR_REVIEW" {
        stake ready_for_review(
          summary: result.summary,
          changed_files: result.changed_files
        ) -> @Architect

        await feedback <- @Architect

        when feedback contains "fix_issues" {
          stake address_review_feedback(feedback: feedback)
        }
      }

      when result.signal == "DONE" {
        set work_complete = true
        stake done(design: design, final_summary: result.summary) -> @Architect
      }

      when result.signal == "FIXING" {
        stake fix_and_report(design: design, issues: result) -> @Architect
        set work_complete = true
      }
    }

    commit
  }

  -- =========================================================================
  -- Agent: Reviewer
  --
  -- Shofer mode: "reviewer" (read-only; evaluates code against design)
  -- =========================================================================
  agent Reviewer {
    mode: "reviewer"
    role: "Code reviewer. Evaluate implementations against the design document. Approve work that meets the spec. For issues, provide specific, actionable feedback. You have final authority on whether the implementation is satisfactory."

    await init <- @Architect

    let work_done = false
    repeat until work_done {
      await request <- @any

      when request contains "review_this_round" {
        let review = stake review(code: request, against: init) -> @Architect
          output: { approved: "boolean", issues: "string", suggestions: "string" }
      }

      when request contains "confirm_final_satisfaction" {
        let final = stake confirm_satisfaction(implementation: request) -> @Architect
          output: { satisfied: "boolean", issues: "string" }

        when final.satisfied {
          set work_done = true
          commit
        }
      }
    }
  }

  -- =========================================================================
  -- Flow constraints
  -- =========================================================================
  converge when: @Architect.committed
  budget: rounds(30), tokens(300000)
}
```

---

## Architecture Overview

### The Core Insight: Workflow IS a Task (for Convenience & Reusability)

The Workflow **is** a Shofer [`Task`](../src/core/task/Task.ts) — but its **loop is slang-driven, not LLM-driven**. It is a task for convenience: it reuses `backgroundChildren`, `HistoryItem` persistence, `TaskManager` lifecycle, `TaskSelector` hierarchy, `abortTask()`, and cost tracking. But it has no mode, no system prompt, and makes zero LLM API calls.

```
┌──────────────────────────────────────────────────────────────┐
│              Workflow Task                                     │
│              (mode: "implement-feature" — the flow name)       │
│                                                               │
│  Extends Task. Stores:                                        │
│   - .slang source (flow specification)                        │
│   - FlowState (current state-machine position)                │
│                                                               │
│  Main loop: slangLoop() ← REPLACES recursivelyMakeShoferReq() │
│  ┌──────────────────────────────────────────────────────┐    │
│  │ 1. Identify ready agents (dependency resolution)     │    │
│  │ 2. Dispatch ready agents in PARALLEL                 │    │
│  │    → via new_task(is_background=true, mode: <agent>) │    │
│  │ 3. Wait for results → wait_for_task(task_ids)        │    │
│  │ 4. Route results to mailboxes, evaluate converge      │    │
│  │ 5. Check budget, checkpoint, repeat                   │    │
│  └──────────────────────────────────────────────────────┘    │
│                                                               │
│  Reuses existing Task infra (no new service):                 │
│   - backgroundChildren map → tracks spawned agents            │
│   - HistoryItem → persists .slang + FlowState                 │
│   - TaskManager → lifecycle & state                           │
│   - TaskSelector → tree hierarchy for user inspection         │
│   - abortTask() → cancels all agents via abortBkgChildren()   │
│   - Cost tracking → aggregates descendant agent costs         │
│                                                               │
│  Does NOT use:                                                │
│   - LlmLoop / recursivelyMakeShoferRequests()                 │
│   - this.api.createMessage()                                  │
│   - System prompt / mode roleDefinition                       │
│   - ask/say for user chat (escalate @Human is the exception)  │
└──────────────────────────────────────────────────────────────┘
             │          backgroundChildren
             │   ┌──────────┼──────────┬──────────┬──────────┐
             ▼   ▼          ▼          ▼          ▼          ▼
        ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐
        │Architect │ │Developer │ │ Reviewer │ │ Codebase │ │ Internet  │
        │  Task    │ │  Task    │ │  Task    │ │  Task    │ │  Task    │
        │(bg task) │ │(bg task) │ │(bg task) │ │(bg task) │ │(bg task) │
        │orchestr. │ │ code mode│ │reviewer  │ │search    │ │browser   │
        │  mode    │ │          │ │  mode    │ │  mode    │ │  mode    │
        └──────────┘ └──────────┘ └──────────┘ └──────────┘ └──────────┘
```

### Why This Is Elegant

| Concern                       | How It's Addressed                                                                                                                                                               |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Task tree visible in UI**   | `TaskSelector` already shows `backgroundChildren` hierarchy. The Workflow Task is the root; agents are children. User can inspect every agent's messages.                        |
| **User↔LLM chat**            | Happens in **agent Tasks** (Developer, Reviewer, Codebase) — each is a regular LLM-driven Task with full chat UI. The Workflow Task has no chat UI except for `escalate @Human`. |
| **Persistence & restore**     | `HistoryItem` already persists task state. The `.slang` source and `FlowState` are stored as additional fields. On restart, the Workflow Task resumes from the last checkpoint.  |
| **Abort & cleanup**           | `Task.abortBackgroundChildren()` already propagates cancel to all children. Stopping the Workflow Task stops everything.                                                         |
| **Cost tracking**             | `HistoryItem.totalCost` already aggregates descendant costs. Each agent Task tracks its own cost; the Workflow sees the sum.                                                     |
| **No new "executor" service** | The "executor" is the Workflow Task's [`slangLoop()`](../src/core/task/Task.ts) method — no separate process, no new service class hierarchy.                                    |

### Key Design Decisions

1. **The main loop is slang-driven, not LLM-driven.** The Workflow Task's `slangLoop()` replaces `recursivelyMakeShoferRequests()`. It never calls `this.api.createMessage()`. The Workflow Task itself makes zero LLM API calls.

2. **Workflows are orthogonal to modes.** The Workflow Task has no mode — its `mode` field is the flow name from the `.slang` spec (e.g., `"implement-feature"`). Modes apply to the **agent Tasks** that the Workflow spawns, giving them their identity (system prompt, API configuration, model, tool access).

3. **Slang agents link to existing modes.** The `.slang` spec declares which mode each agent uses:

    ```slang
    agent Developer {
      mode: "code"          ← maps directly to an existing Shofer mode
      model: "claude-sonnet" ← selects API profile within that mode
    }
    ```

    No virtual mode composition needed — the `.slang` agent simply references a mode by slug.

4. **`escalate @Human` is the only user interaction on the Workflow Task.** The slang loop pauses, renders the question, and blocks on an `ask_followup_question` promise. Regular user↔LLM chat happens in the agent Tasks.

5. **Agent Tasks create their own subtasks independently.** If a Developer agent spawns a helper via `new_task`, that's invisible to the Workflow — it only cares about `attempt_completion` from its direct children.

6. **Agent Tasks are resumed, not recreated.** Each agent maps to one Task for its lifetime. After `attempt_completion`, the Workflow re-prompts the same Task via programmatic `queueMessage` for the next `stake`.

7. **`.slang` files are discovered from `.shofer/workflows/`** (project) and `~/.shofer/workflows/` (global), merged with project-level taking priority on name collision.

---

## Slang → Shofer Mapping

### Concepts

| Slang Concept                 | Shofer Execution                                                                                                                                                                                                 |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `flow "name"`                 | A **Workflow Task** (extends `Task`). Mode string = the flow name. Loop: `slangLoop()`, not `recursivelyMakeShoferRequests()`.                                                                                   |
| `agent Name { mode: "code" }` | Agent is a background Task spawned via `new_task(is_background=true, mode: "code")`. The linked mode provides the system prompt, tool access, and API configuration.                                             |
| `agent Name { tools: [...] }` | ToolGroup names mapped directly to the mode's `groups:` at spawn time. Only the 9 group names (`read`, `write`, `execute`, `browser`, `mcp`, `mode`, `subtasks`, `questions`, `uncategorized`) are valid values. |
| `agent Name { model: "x" }`   | (Parsed, not yet wired) Would override the mode's default API Configuration profile.                                                                                                                             |
| `agent Name { role: "..." }`  | (Parsed, not yet wired) Would override the mode's `roleDefinition`. Currently used only for peer resource descriptions.                                                                                          |
| `stake func(args) -> @Target` | Workflow: (1) resumes/prompts agent Task, (2) blocks via `wait_for_task`, (3) validates output against schema (retries on failure), (4) routes result to `@Target`'s mailbox.                                    |
| `stake func(args)` (local)    | Workflow prompts agent; result stored in `FlowState.bindings`, not routed.                                                                                                                                       |
| `await binding <- @Source`    | Workflow blocks until `@Source`'s result in mailbox, resumes awaiting agent.                                                                                                                                     |
| `commit`                      | Agent calls `attempt_completion`. Workflow marks agent `committed`.                                                                                                                                              |
| `escalate @Human`             | Workflow Task handles this directly. Slang loop pauses, blocks on `ask_followup_question`. Agent never knows it was escalated.                                                                                   |
| `let / set`                   | Stored in `FlowState.bindings` (Workflow memory).                                                                                                                                                                |
| `repeat until / when`         | Workflow Task's `slangLoop()` evaluates and branches.                                                                                                                                                            |
| `converge when:`              | Workflow checks condition each round; on true → `attempt_completion` on the Workflow Task itself.                                                                                                                |
| `budget:`                     | Aggregate descendant costs. On exhaustion → `abortBackgroundChildren()` + `attempt_completion(error)`.                                                                                                           |
| `output: { ... }`             | Injected into agent Task's system prompt as structured-output directive. Validated against schema on completion; malformed JSON or missing fields trigger retry (max 3).                                         |

### Execution Flow (Round Model)

A **round** is one pass through the Workflow Task's `slangLoop()`:

```
Round N:
  1. Workflow identifies ready agents (current op is `stake`/`commit`,
     no unsatisfied `await`)
  2. Workflow dispatches ready agents in PARALLEL:
     - Each agent gets prompted via programmatic queueMessage (resuming
       its Task if dormant, creating if first stake)
     - Workflow calls wait_for_task(all agent IDs, wait: "all")
  3. Each agent runs its Task loop independently (LLM + tools)
  4. Each agent calls attempt_completion(result)
  5. Workflow captures results, routes to target mailboxes,
     evaluates commit status, checks converge
  6. If converge satisfied → Workflow Task calls attempt_completion
  7. If budget exceeded → cancel_tasks all agents, Workflow completes
     with budget_exceeded
  8. Otherwise → Round N+1
```

### Stake Routing (Detailed)

When the Workflow processes `stake func(args) -> @B` for Agent A:

1. **Prompt Agent A:** Workflow enqueues a prompt via `messageQueueService.addMessage()` on Agent A's Task (same path as Form B in [task_messaging.md](task_messaging.md)). The prompt includes `func(args)`, current bindings, and output schema.
2. **Wait:** Workflow calls `wait_for_task(AgentA.taskId)` — blocks the `slangLoop()`.
3. **Capture:** Agent A runs its tool loop, calls `attempt_completion(result)`.
4. **Route:** Workflow stores the result in Agent B's mailbox slot.
5. **Unblock:** If Agent B was blocked on `await <- @A`, Agent B is now ready — its next prompt includes "Here is the output from @A: <result>."

### Welcome View Redesign

The Welcome View changes from a task-history list to a **workflow launcher**:

```
┌──────────────────────────────────────────┐
│  Shofer                                  │
│                                          │
│  Workflows:                              │
│  ┌────────────────────────────────────┐  │
│  │ 🚀 Implement a Feature             │  │
│  │    Explore → Design → Review →     │  │
│  │    Implement → Verify              │  │
│  │                         [Run ▶]    │  │
│  ├────────────────────────────────────┤  │
│  │ 🔍 Code Review                     │  │
│  │    Analyze → Report → Approve      │  │
│  │                         [Run ▶]    │  │
│  ├────────────────────────────────────┤  │
│  │ 📝 Create Documentation            │  │
│  │    Extract → Write → Review        │  │
│  │                         [Run ▶]    │  │
│  └────────────────────────────────────┘  │
│                                          │
│  ── or ──                                │
│                                          │
│  [Start New Task]  (manual mode)         │
└──────────────────────────────────────────┘
```

No text input is needed to start a workflow. Clicking **[Run ▶]** creates a Workflow Task with the `.slang` spec loaded and starts the `slangLoop()`. The user can interact with each agent Task via the TaskSelector (standard chat UI). The Workflow Task surfaces `escalate @Human` interactions. Regular ad-hoc Tasks are still available via **[Start New Task]**.

---

## Workflow Task Design

The "executor" is not a separate service — it is the Workflow Task's `slangLoop()` method, replacing `recursivelyMakeShoferRequests()`.

### Class Hierarchy

```typescript
// WorkflowTask extends the existing Task class.
// It overrides only the main loop — everything else is inherited.
class WorkflowTask extends Task {
  // Stored in HistoryItem (additional fields)
  private slangSource: string           // the .slang file content
  private flowState: FlowState          // current state-machine position

  // ── REPLACES recursivelyMakeShoferRequests() ──
  // The Workflow Task NEVER calls this.api.createMessage().
  protected async slangLoop(): Promise<void> { ... }
}
```

### Core Types (subset — same as existing Slang runtime types)

```typescript
interface FlowState {
	flowName: string
	params: Record<string, unknown>
	agents: Map<string, AgentState>
	round: number
	tokensUsed: number
	status: "running" | "converged" | "budget_exceeded" | "escalated" | "deadlock"
	mailbox: MailboxEntry[]
}

interface AgentState {
	name: string
	taskId: string
	status: "idle" | "running" | "committed" | "blocked"
	opIndex: number
	bindings: Map<string, unknown>
	output?: unknown
}
```

### `slangLoop()` — The Core Algorithm

```
async slangLoop():
  1. Parse .slang source → AST
  2. Resolve dependency graph, validate for deadlocks
  3. For each agent in the flow:
     - Determine mode from agent's tools/model declarations
     - Spawn background Task: this.newTask(is_background=true, mode, prompt)
     - Store taskId in AgentState and this.backgroundChildren
  4. Loop until converge | budget_exceeded | escalated | deadlock:
     a. Identify ready agents (current op is stake/commit, no unsatisfied await)
     b. For each ready agent: resume/prompt its Task
        → agentTask.messageQueueService.addMessage(prompt)
        → Task's LLM loop wakes up and processes it
     c. Call wait_for_task(all ready agent taskIds)
     d. Collect attempt_completion results
     e. Route results to mailboxes (satisfy awaiting agents)
     f. Evaluate converge condition
     g. Check budget (aggregate descendant token costs)
     h. Persist FlowState checkpoint to HistoryItem
     i. If escalated: this.ask("followup", question) → block →
        feed user response as await result → continue loop
  5. On converge → this.attempt_completion(result)
  6. On budget_exceeded/deadlock → this.abortBackgroundChildren() →
     this.attempt_completion with error status
```

### Integration with Existing Task Infrastructure

| What the WorkflowTask Needs          | How It's Done (Reuses Existing Infrastructure)                                                                                                      |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Spawn agent Tasks**                | `this.newTask(is_background=true, mode, message)` — same as `NewTaskTool` but called programmatically. Registered in `this.backgroundChildren`.     |
| **Resume agent Task for next stake** | `agentTask.messageQueueService.addMessage(prompt)` — standard queue-drain path wakes/resumes the Task's LLM loop.                                   |
| **Wait for agent completion**        | Internal `wait_for_task(taskId)` — same mechanism as `WaitForTaskTool`, called directly.                                                            |
| **`escalate @Human`**                | `this.ask("followup", question, suggestions)` on the Workflow Task. Renders in the Workflow's chat panel. User response unblocks the `slangLoop()`. |
| **Agent-to-agent routing**           | Enqueue prompt via recipient agent's `messageQueueService.addMessage()`.                                                                            |
| **Cancel all agents**                | `this.abortBackgroundChildren()` — existing method.                                                                                                 |
| **Persist .slang + FlowState**       | Additional fields on `HistoryItem` or sidecar JSON file in the task's storage directory.                                                            |
| **Track aggregate cost**             | `costSummary.totalCost` already aggregates descendant costs.                                                                                        |
| **TaskSelector visibility**          | Standard `backgroundChildren` tree — Workflow Task is the root; agents are children.                                                                |

### Mode Selection for Agent Tasks

When spawning an agent Task, the Workflow selects a mode by slug:

```slang
agent Developer {
  mode: "code"               → uses the "code" Shofer mode (required)
  tools: [write, execute,     → ToolGroup names → mode's groups at spawn
          read, mcp]
  model: "claude-sonnet"     → (parsed, not yet wired)
  role: "Feature implementer" → (parsed, not yet wired; used for peer descriptions)
  context: {                  → controls what context the agent receives
    include_agents_md: true   → (planned) inject AGENTS.md rules
  }
}
```

The mapping is:

1. `tools: [...]` → each value is a **ToolGroup name** (one of `read`, `write`, `execute`, `browser`, `mcp`, `mode`, `subtasks`, `questions`, `uncategorized`). These become the mode's `groups:` at spawn time, restricting the agent to only those tool groups.
2. `model: "..."` → not yet wired; would select the API Configuration profile by name.
3. `role: "..."` → not yet wired; would override the mode's `roleDefinition`.
4. `context: {...}` → (not yet wired) controls what context the agent receives from the project. Initial knob: `include_agents_md` (boolean) to inject AGENTS.md rules into the agent's system prompt.

For simple agents (e.g., Reviewer: read-only tools), existing modes work directly. For specialized agents, the Workflow restricts the mode's tool groups via the `tools:` field at spawn time — no persisted `.shofermodes` entry needed.

---

## Shofer Extensions (Shofermodes Capabilities)

The `.slang` `agent` block extends the vendored Slang specification with Shofer-specific capabilities. These map directly to Shofer mode features defined in `.shofermodes` and the mode schema at [`packages/types/src/mode.ts`](../packages/types/src/mode.ts).

### Implemented (current execution)

| `.slang` key   | Status                   | Shofermode field        | Description                                                                                                                                                                                        |
| -------------- | ------------------------ | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mode: "code"` | ✅ Wired                 | Maps to the mode `slug` | Spawns agent as a background Task in the named Shofer mode. The mode provides `roleDefinition`, `customInstructions`, `groups`, and API configuration.                                             |
| `tools: [...]` | ⚙️ Parsed, not yet wired | Maps to `groups:`       | Each value is a ToolGroup name (`read`, `write`, `execute`, `browser`, `mcp`, `mode`, `subtasks`, `questions`, `uncategorized`). When wired, restricts the spawned Task to only the listed groups. |

### Planned (parsed but not yet consumed by execution)

| `.slang` key                | Status               | Shofermode field               | Description                                                                                                                                                                                                                                                                                        |
| --------------------------- | -------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model: "profile"`          | Parsed, not consumed | API Configuration profile name | Overrides the mode's default API profile. Allows different agents in the same workflow to use different models (e.g., Architect uses Claude, Developer uses GPT-4).                                                                                                                                |
| `role: "..."`               | Parsed, not consumed | `roleDefinition`               | Overrides the mode's system-prompt role definition. Currently used only for peer resource descriptions.                                                                                                                                                                                            |
| `retry: <n>`                | Parsed, not consumed | N/A                            | Max LLM-call retries per `stake`. Default: 1. Would override the mode's implicit retry behavior.                                                                                                                                                                                                   |
| `context: { ... }`          | Parsed, not consumed | N/A (new concept)              | Controls what ambient context the agent receives from the project. Initial knob:                                                                                                                                                                                                                   |
| `context.include_agents_md` | Planned              | —                              | When `true`, injects the project's AGENTS.md rules (agent behavior conventions) into the agent's system prompt. Useful for agents that need to follow project-specific conventions (Developer, Reviewer). Default: `false` for shared resources (Codebase, Internet), `true` for execution agents. |

### Context block design

The `context:` block is an extensible container for future context-control knobs:

```slang
agent Developer {
  mode: "code"
  context: {
    include_agents_md: true     ← inject AGENTS.md rules
    // Future knobs (not yet designed):
    // include_readme: true     ← inject README.md summary
    // include_shofertools: true ← inject .shoferrules
    // max_file_context: 20     ← limit @-mentioned file references
  }
}
```

Each knob controls a specific category of ambient context injected into the agent's system prompt at Task spawn time. The default values are agent-role-aware: shared-resource agents (Codebase, Internet) get minimal context; execution agents (Developer, Reviewer) get richer project context.

## Reusable Code from `@riktar/slang`

The [`@riktar/slang`](https://github.com/riktar/slang) npm package (MIT-licensed, v0.8.0) provides parsing, static analysis, and a reference runtime. We can reuse the **parser + resolver + AST types** directly (~70% of the runtime logic) and replace only the **execution layer** with Shofer Task dispatch (~30%).

### Package Exports (Public API)

```typescript
// From @riktar/slang:
export { parse, parseWithRecovery } from "./parser.js";
export { tokenize, TokenType } from "./lexer.js";
export { resolveDeps, detectDeadlocks, analyzeFlow } from "./resolver.js";
export { runFlow, testFlow, serializeFlowState, deserializeFlowState } from "./runtime.js";
export { createOpenAIAdapter, createAnthropicAdapter, createOpenRouterAdapter,
         createEchoAdapter, createMockAdapter, createRouterAdapter } from "./adapter.js";
export type { FlowState, AgentState, RuntimeOptions, RuntimeEvent, ... } from "./runtime.js";
export type { FlowDecl, AgentDecl, StakeOp, AwaitOp, CommitOp, ... } from "./ast.js";
```

### What We Reuse Directly

| Component                                                      | Reuse?      | Notes                                                                                                                                                                   |
| -------------------------------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Parser** (`parse`, `parseWithRecovery`)                      | ✅ Full     | Converts `.slang` source → typed AST. Error recovery for IDE integration.                                                                                               |
| **Lexer** (`tokenize`)                                         | ✅ Full     | Tokenization with line/column info.                                                                                                                                     |
| **Resolver** (`resolveDeps`, `detectDeadlocks`, `analyzeFlow`) | ✅ Full     | Builds dependency graph from `stake → @Target` / `await ← @Source`. Detects circular waits. Static analysis (missing converge, unknown recipients, no-commit warnings). |
| **AST types**                                                  | ✅ Full     | `FlowDecl`, `AgentDecl`, `StakeOp`, `AwaitOp`, `CommitOp`, `EscalateOp`, `WhenBlock`, `RepeatBlock`, etc. with source spans.                                            |
| **`FlowState` / `AgentState`**                                 | ✅ Extended | Base shape works. Add `taskId` field to `AgentState` for Shofer integration.                                                                                            |
| **`serializeFlowState` / `deserializeFlowState`**              | ✅ Full     | Handles `Map`↔JSON conversion for checkpoint persistence into `HistoryItem`.                                                                                           |
| **`resolveExprValue` / `evalCondition` / `extractJSON`**       | ✅ Full     | Evaluates `when`/`converge` conditions. Parses structured output JSON from LLM `attempt_completion` results.                                                            |

### What We Replace

| Slang Default                                                       | Shofer Replacement                                                                         |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `runFlow()` — calls LLM via `adapter.call()`                        | `WorkflowTask.slangLoop()` — same algorithm, dispatches via `new_task(is_background=true)` |
| `executeStake()` — single `adapter.call()` + `TOOL_CALL:` tool loop | Spawn/resume Shofer Task → `wait_for_task` → capture `attempt_completion`                  |
| `buildAgentPrompt()` — builds system+user messages per `stake`      | Agent Task's **mode** (system prompt, role definition, tool access)                        |
| `TOOL_CALL:` text-parsing tool execution                            | Shofer native tools in the agent Task's tool loop                                          |
| Adapters (`createOpenAIAdapter`, etc.) — direct HTTP calls          | Not used — Shofer Tasks handle LLM calls natively                                          |

### How `slangLoop()` Maps to Slang's `runFlow()`

```typescript
// Slang runtime (adapter.call):
const response = await adapter.call(messages, model) // DIRECT LLM CALL
agentState.output = response.content

// Shofer's slangLoop() equivalent:
const childTask = await this.spawnAgentTask(agentDecl, prompt) // SPAWN TASK
const result = await this.waitForTask(childTask.taskId) // WAIT
agentState.output = result.completionResult // CAPTURE
```

The loop structure (findExecutableAgents, parallel dispatch, mailbox routing, converge/budget check, checkpoint) is identical — only the execution primitive changes from `adapter.call()` to Shofer Task dispatch.

### What We Write (~200 lines new code)

| New Code                 | Purpose                                                                                   |
| ------------------------ | ----------------------------------------------------------------------------------------- |
| `WorkflowTask` class     | Extends `Task`. Stores `.slang` source + `FlowState`. Override `start()` → `slangLoop()`. |
| `spawnAgentTask()`       | Creates background Task from `.slang` agent declaration. Maps `mode:`/`model:`/`role:`.   |
| `promptAgentTask()`      | Enqueues next `stake` prompt via `messageQueueService.addMessage()`.                      |
| `HistoryItem` extensions | `slangSource: string`, `flowState: FlowState` in Zod schema.                              |

---

## Slang Language Reference

The full Slang language specification — lexical elements, reserved keywords,
grammar (EBNF), operations, control flow, expressions, static-analysis warnings,
runtime semantics, and the list of parsed-but-not-executed constructs — lives in
its own document:

➡️ **[`slang_specs.md`](slang_specs.md)**

That document is the authoritative reference for the **Shofer implementation** of
Slang (the vendored lexer/parser/resolver plus the `WorkflowTask` interpreter),
which is what `.slang` workflow files are validated and executed against.

---

## Workflows and Modes — Orthogonal Concepts

**Workflows and modes are orthogonal.** Modes give `.slang` agents their identity (system prompt, API configuration, model, tool access). A workflow is a separate concept — a `.slang` specification executed by a Workflow Task.

- **The Workflow Task itself** has no mode — its mode string is the flow name (e.g., `"implement-feature"`).
- **Agent Tasks** run in modes referenced by slug in the `.slang` agent declaration.
- No new custom modes are needed for workflows. The flow specification IS the workflow definition.

---

## Agent-to-Task Dispatch

### How `stake` becomes a Task prompt

When the slang loop processes a `stake` operation for an agent:

1. The Workflow constructs a prompt message from the `stake func(args)`:

    ```
    Execute: func(args)

    Context: [agent's current bindings and variables]

    [If output contract defined]:
    OUTPUT CONTRACT:
    Your attempt_completion result MUST be ONLY a valid JSON object
    (no markdown, no extra text) with exactly these fields:
      - fieldName: fieldType
      - ...
    Example: {"fieldName": ..., ...}
    The result will be validated against this schema. Missing fields or
    non-JSON will cause a retry (max 3 retries before the agent is
    marked as error).
    ```

2. The prompt is enqueued via `agentTask.messageQueueService.addMessage(prompt)` — the standard queue-drain path.

3. If the agent Task is dormant (`completed` state from a previous stake), the queue-drain wakes/resumes it.

4. If this is the agent's first stake, the Workflow spawns the Task with this prompt.

5. The Workflow calls `wait_for_task(agent.taskId)` to block `slangLoop()` until `attempt_completion`.

### `escalate @Human` — Parent Routing via Existing Mechanism

`escalate @Human` leverages Shofer's existing `ask_followup_question` → parent routing:

1. The Workflow Task is the **parent** of all agent Tasks (via `backgroundChildren` / `parentTaskId`).
2. When the slang loop reaches an `escalate @Human` operation, the Workflow Task calls `this.ask("followup", question, suggestions)` on **itself**.
3. The user sees the question and responds.
4. The Workflow's slang loop captures the response and feeds it as the `await` result.
5. The agent Task **never knows** it was escalated — from its perspective, it receives the user's response as its next prompt.

If an **agent Task** itself calls `ask_followup_question` (e.g., the Developer needs clarification), the existing [subtask question routing rule](../AGENTS.md#L26) applies: background children route to parent (the Workflow Task). The Workflow Task can answer via the existing `answer_subtask_question` mechanism.

### Agent lifecycle

```
Agent created → Task spawned (idle)
  ↓
First stake → Task receives first prompt → Task runs (running)
  ↓
Task calls attempt_completion → slang loop captures result
  ↓
Next operation is await → Task is dormant, slang loop waits for mailbox delivery
  ↓
Mailbox delivery via queueMessage → Task wakes/resumes → Task runs (running)
  ↓
... repeat until commit ...
  ↓
Agent committed → Task completed
```

---

## Executor↔Task Communication Model

### The Fundamental Asymmetry

The Executor and agent Tasks have an asymmetric communication channel:

| Direction           | Mechanism                                                       | Notes                                                                                                                                                                  |
| ------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Executor → Task** | The Task's prompt (system prompt injection or queued user-turn) | The Executor can **ask** the Task to do something but cannot **force** it. The Task's LLM may ignore or misinterpret the request.                                      |
| **Task → Executor** | `attempt_completion` result                                     | The only explicit, programmatically-captured signal from a Task back to the Executor. Everything else (tool calls, streaming text, etc.) is invisible to the Executor. |

### No New Native Tool Needed

A new native tool (e.g., `signal_workflow`) is **not** necessary because:

1. **Each `stake` is a discrete, terminal operation.** The Slang model is turn-based: an agent receives a prompt, does work (potentially across multiple LLM turns within its Task loop), and calls `attempt_completion(result)` when done. The Executor captures the result and routes it. The Task is then **resumed** (not restarted) for its next `stake`, preserving conversation history.

2. **`attempt_completion` IS the turn-boundary signal.** The Executor blocks on `wait_for_task(taskId)` and unblocks when the Task completes. The completion result carries the structured output that drives the Executor's branching logic:

    | Slang Operation        | Task Behavior                             | Executor Action                                                             |
    | ---------------------- | ----------------------------------------- | --------------------------------------------------------------------------- |
    | `stake X -> @B`        | Task calls `attempt_completion(result)`   | Executor captures result, routes to @B's mailbox                            |
    | `commit`               | Task calls `attempt_completion()`         | Executor marks agent as `committed`                                         |
    | `let x = stake Y(...)` | Task calls `attempt_completion(result)`   | Executor binds result to variable `x`                                       |
    | `await x <- @A`        | Task is **dormant** — no active Task loop | Executor waits for @A's result, then resumes Task with the result as prompt |

3. **Structured output contracts provide signal conventions.** The `.slang` spec's `output:` block tells the Task what shape its `attempt_completion` result should have. Example from the Developer agent:

    ```slang
    let result = stake work_on_implementation(design: design)
      output: { signal: "string", summary: "string", changed_files: "string" }

    when result.signal == "READY_FOR_REVIEW" { ... }
    when result.signal == "DONE" { ... }
    ```

    The Executor parses the JSON result against the output schema and branches in the state machine.

### Cross-Agent Verification

The Executor gains confidence in outcomes through **cross-agent verification**, not self-reporting:

- The **Developer** reports `signal: "DONE"` — but that's just a claim.
- The **Reviewer** independently evaluates the implementation and reports `satisfied: true/false` — this is the Executor's degree of confidence.
- If the Reviewer reports `satisfied: false`, the Executor loops: prompt the Developer to fix → wait → ask Reviewer again.

This is the same pattern that makes peer messaging viable: trust but verify through a second pair of eyes.

### Task Resumption (Not Restart)

Each agent maps to **one** Shofer Task for its entire lifetime. The Task is:

- **Created** when the agent is first dispatched
- **Prompted** for each `stake` operation (the Executor sends the prompt, the Task runs its LLM tool loop, calls `attempt_completion`)
- **Resumed** (not recreated) for subsequent stakes — same Task, same conversation history, same context
- **Discarded** when the agent commits (the Task is completed)

This means earlier `stake` results are visible in the Task's message history as context for later stakes. The Developer remembers what it built in the first round when addressing review feedback in the second round.

### What the Executor Controls

| Aspect                                   | Who Controls                                                  |
| ---------------------------------------- | ------------------------------------------------------------- |
| **What the agent is asked to do**        | Executor — via the prompt text                                |
| **When the agent is asked**              | Executor — rounds, dependency resolution                      |
| **Who receives the result**              | Executor — mailbox routing                                    |
| **Whether the flow loops or terminates** | Executor — converge/budget evaluation                         |
| **What mode/tools the agent has**        | Executor — set at Task creation time                          |
| **How the agent does its work**          | **The Task's LLM** — fully autonomous within its tool loop    |
| **What tools the agent calls**           | **The Task's LLM** — within the mode's tool restrictions      |
| **What result the agent produces**       | **The Task's LLM** — the Executor only enforces output schema |

### What the Executor NEVER Does

- The Executor never makes LLM API calls. It is a pure state machine.
- The Executor never inspects Task internals (tool calls, intermediate messages). It only reads `attempt_completion` results.
- The Executor never forces a Task to use a specific tool or follow a specific path.
- The Executor never rewrites a Task's message history.

---

## User Interaction

### `escalate @Human` Flow — Reuses Existing `ask_followup_question` → Parent Routing

`escalate @Human` is handled **entirely by the Workflow Task** — the agent Task never sees it.

The mechanism reuses Shofer's existing [`ask_followup_question` routing](../AGENTS.md#L26): when a child (non-root) Task calls `ask_followup_question`, it is routed to the parent if the parent can answer. The Workflow Task is the parent of all agent Tasks — so:

1. **The slang loop reaches** an `escalate @Human` operation for an agent.
2. **The Workflow Task pauses** the slang loop.
3. **The Workflow Task calls** `this.ask("followup", question, suggestions)` on **itself**.
4. **The user sees the question** and responds.
5. **The slang loop captures** the user's response.
6. **The slang loop feeds** the response as the `await` result into the agent's mailbox.
7. **The slang loop resumes** the agent at its next operation.

The agent Task has no awareness that it was "escalated." From its perspective, it simply receives the user's response as its next prompt when resumed. This is intentional: the Workflow Task owns the control flow, not the LLM.

Additionally, if an **agent Task** itself calls `ask_followup_question` (e.g., the Developer needs clarification), the [Subtask Question Routing Rule](../AGENTS.md#L26) applies: background children route questions to the parent. The Workflow Task can answer via the existing `answer_subtask_question` mechanism. This is separate from `escalate @Human` — which is a flow-level operation, not an agent-level question.

### User Prompt During a Workflow

If the user directly prompts a workflow agent Task (e.g., types a message to the Developer), the message is queued and delivered like any other user input. The Workflow Task does not intercept or block direct user↔Task communication. However:

- The agent's `attempt_completion` still routes to the Workflow, not the user.
- The agent is not "free" — it operates within its mode's tool restrictions.
- A user redirecting the Developer mid-implementation does not break the workflow, but may surprise the user when the Developer's next response goes to the Workflow/Reviewer instead of the chat.

### Visualizing the Workflow

The Shofer Task Selector shows the workflow's task hierarchy:

```
implement-feature (workflow)                [running]
├── 🏗️ Architect (orchestrator mode)        [running]
├── 🔍 Codebase (search mode)               [completed]
├── 🌐 Internet (browser mode)               [completed]
├── 💻 Developer (code mode)                [running]
└── 👀 Reviewer (reviewer mode)             [waiting]
```

The user can click any agent Task to inspect its full chat history. Agent Tasks are regular LLM-driven Tasks — the user can even type messages directly to them.

The Workflow Task itself has no chat UI except for `escalate @Human` interactions, which surface in the Workflow Task's panel or as VS Code notifications.

---

## Resolved Design Questions

| #   | Question                       | Resolution                                                                                                                                                                                                                                                           |
| --- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Executor location              | The "executor" is the Workflow Task's `slangLoop()` method. No separate service.                                                                                                                                                                                     |
| 2   | Task lifecycle ownership       | The Workflow Task OWNS all agent Tasks via `backgroundChildren`. `abortBackgroundChildren()` cancels everything.                                                                                                                                                     |
| 3   | Parallel stake dispatch        | **Parallel** (`Promise.all`-style). Independent agents run concurrently.                                                                                                                                                                                             |
| 4   | Task resumption                | **Programmatic `queueMessage`.** `messageQueueService.addMessage(prompt)` on the agent Task's queue. Standard queue-drain path wakes/resumes the Task's LLM loop.                                                                                                    |
| 5   | User visibility                | User sees **ALL** agent Tasks in TaskSelector (same as today's tree hierarchy).                                                                                                                                                                                      |
| 6   | `.slang` file location         | `.shofer/workflows/` (project) + `~/.shofer/workflows/` (global), **merged**, project-level priority.                                                                                                                                                                |
| 7   | Workflow ↔ Mode orthogonality | Workflows are orthogonal to modes. Agent Tasks use existing modes by slug reference. The Workflow Task's mode string is the flow name. WelcomeView becomes a workflow launcher.                                                                                      |
| 8   | Slang parser                   | **Yes, bundle `@riktar/slang`** (MIT-licensed, ~88% TypeScript).                                                                                                                                                                                                     |
| 9   | Agent-to-Task mode mapping     | Resolved by #7 — agents reference existing mode slugs. No custom tool mapping needed.                                                                                                                                                                                |
| 10  | Structured output contracts    | Enforced at the **system-prompt level**, not API JSON-schema level. The Workflow injects the `output:` schema into the agent Task's system prompt. The slang loop parses and validates the `attempt_completion` result. On malformed JSON, the agent is re-prompted. |
| 11  | Non-terminal agent signaling   | Not needed. Each `stake` is an atomic unit of work terminated by `attempt_completion`. `escalate @Human` reuses the existing `ask_followup_question` → parent routing and is handled by the Workflow Task, not the agent.                                            |

## Additional Resolved Design Questions

| #   | Question                             | Resolution                                                                                                                                                                                                                                                                                                                                                                                    |
| --- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 12  | `slangLoop()` lifecycle              | **`WorkflowTask` subclass** with its own `start()` override. `WorkflowTask.start()` calls `slangLoop()` instead of `recursivelyMakeShoferRequests()`. On resume from history, `resumeTaskFromHistory()` detects the subclass and routes to `slangLoop()`.                                                                                                                                     |
| 13  | FlowState persistence                | **Additional fields on `HistoryItem`** — extend the Zod schema in `@shofer/types` with `slangSource` (string), `flowState` (JSON blob). Backward compatible: regular Tasks have `undefined` for these fields.                                                                                                                                                                                 |
| 14  | Backward compatibility / Coexistence | Workflow Tasks and regular Tasks **coexist**. A root can be a `Task` or a `WorkflowTask`. The WelcomeView shows workflows as launcher cards + a **[Start New Task]** button for ad-hoc chat. Workflow agents are `Task` instances with `parentTaskId = workflowTaskId` — same tree structure as today.                                                                                        |
| 15  | TaskSelector & HistoryView remodel   | Both need to handle `WorkflowTask` at the root of a tree hierarchy. `TaskSelector` already supports parent-child trees. Key adaptations: (a) render a workflow icon/badge for `WorkflowTask` entries, (b) show the `.slang` flow name as the title, (c) `HistoryView` groups children under the workflow root. No schema change needed for tree structure — `parentTaskId` already covers it. |

## Restart/Resume Semantics (Resolved)

On VS Code restart:

1. `TaskManager.restoreManagedTasks()` rehydrates the Workflow Task from `HistoryItem`.
2. The Workflow Task's `FlowState` is restored from `HistoryItem.flowState`.
3. Agent Tasks from `HistoryItem.childIds`/`backgroundChildIds` are re-registered. Any that were `running` at restart are sanitized to `idle` (existing `sanitizeRestoredState` behavior).
4. The Workflow Task appears with a "Continue" button — the user must explicitly click it.
5. On continue, `WorkflowTask.start()` detects the restored `FlowState` and resumes the `slangLoop()` from the last checkpoint:
    - Re-prompt agents **in parallel** whose `attempt_completion` was never captured
    - **Reuse** existing agent Tasks (resume via `queueMessage`, same Task instance across stakes)
    - Skip agents that already reached `committed` or terminal state
    - Continue from the last completed round

This is the same pattern as today's task resumption — the user controls when work restarts.

## WelcomeView, TaskSelector & HistoryView

**WelcomeView** changes from task history to a workflow launcher showing configured workflows (discovered from `.shofer/workflows/`) plus a **[Start New Task]** button for ad-hoc chat.

**TaskSelector** and **HistoryView** stay where they are — their layout and navigation do not change. They become `WorkflowTask`-aware:

| UI Component     | Adaptation                                                                                                                                                             |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **WelcomeView**  | Workflow launcher cards + **[Start New Task]** button.                                                                                                                 |
| **TaskSelector** | Already supports parent-child trees. Adds: workflow icon/badge for `WorkflowTask` entries, flow name as title. Does not move or change layout.                         |
| **HistoryView**  | Stays in place. Becomes `WorkflowTask`-aware — groups agent children under the workflow root, shows workflow badge. `parentTaskId` already handles the tree structure. |

---

## Compatibility with `task_messaging.md`

The peer messaging design in [`task_messaging.md`](task_messaging.md) and this Workflow design are **fully compatible**:

| `task_messaging.md` Concept                                                      | How It Maps to Workflows                                                                                |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| **Same-root scope** (`rootTaskId`)                                               | The Workflow Task is the root. All agent Tasks share `rootTaskId = workflowTaskId`.                     |
| **Background-task requirement**                                                  | All agent Tasks are background Tasks (`isBackground=true`). ✅ Satisfied.                               |
| **`send_message_to_task` (async)**                                               | Agents can fire-and-forget notify each other via system-prompt injection or queue-drain.                |
| **`send_message_to_task` (sync)**                                                | Agents can request-response with timeout. `attempt_completion` routes result to the initiator.          |
| **`check_task_status` / `list_background_tasks` / `wait_for_task` (peer scope)** | Agents can inspect and wait on siblings under the same workflow root.                                   |
| **`ask_followup_question` → parent routing**                                     | Agent questions route to the Workflow Task (parent). Workflow can answer via `answer_subtask_question`. |
| **`cancel_tasks` (parent-only)**                                                 | Workflow Task owns the lifecycle — `abortBackgroundChildren()` cancels all agents.                      |

**Key interaction:** The Workflow Task's `slangLoop()` uses `wait_for_task` and `queueMessage` programmatically — these are the same mechanisms that `send_message_to_task` and `check_task_status` expose to agent LLMs. There is no conflict. Agent-to-agent peer messaging (via `send_message_to_task`) happens **within** agent Tasks, independently of the Workflow's control loop. The Workflow only cares about `attempt_completion` results from its direct children.

### WorkflowTask → Agent Notifications

The Workflow Task can send notifications to its agent children using the same `queueMessage` mechanism used for `stake` dispatch. This enables use cases like:

- Broadcasting a state change (e.g., "Codebase has finished — findings are available").
- Sending async messages without blocking the slang loop.
- Injecting context updates into agent Tasks mid-run.

### Shared Codebase (Peer-Accessible Agent)

Some agents are useful to **multiple** siblings. For example, the Codebase (codebase context) and Internet (external/web info) are shared resources that the Architect, Developer, and Reviewer can all query directly via `send_message_to_task`:

```
implement-feature (WorkflowTask)
├── 🏗️ Architect (orchestrator mode)    ← can peer-message Codebase & Internet
├── 🔍 Codebase (search mode)          ← shared: codebase context
├── 🌐 Internet (browser mode)          ← shared: external/web info
├── 💻 Developer (code mode)           ← can peer-message Codebase & Internet
└── 👀 Reviewer (reviewer mode)        ← can peer-message Codebase & Internet
```

This works because:

1. All agents share the same `rootTaskId` (the Workflow Task).
2. All agents are background Tasks (`isBackground=true`).
3. The Codebase and Internet are peers under the `task_messaging.md` model.
4. The `scope="peers"` parameter on `list_background_tasks` lets any agent discover them.

The Workflow Task should also notify all agents when shared resources become available (via `queueMessage` notification).

**Explicit prompt instructions:** The Workflow Task's dispatch prompt to each agent MUST make the shared resources explicit. For example, the Developer's initial prompt should include:

```
PEER RESOURCES available to you:
- Codebase (task ID: <explorerTaskId>) — provides codebase architecture,
  module structure, and integration point analysis.
  Use send_message_to_task(task_id="<explorerTaskId>", message=...)
  to query it directly.

To discover all available peers, use list_background_tasks(scope="peers").
```

This ensures agents know about shared resources without needing to discover them through trial-and-error. The Workflow Task constructs these peer-resource listings from the `FlowState.agents` map at dispatch time.

**`peer_task_ids` on spawn:** When the Workflow Task spawns the Developer and Reviewer, it can pass `peer_task_ids: [explorerTaskId]` to explicitly scope their peer communication to include the Codebase. This is the same `peer_task_ids` parameter from the `task_messaging.md` design — no new mechanism needed.

---

## Related Documents

- [`parallelism.md`](../parallelism.md) — Parent-child orchestration and background Tasks
- [`task_states.md`](../task_states.md) — Task lifecycle state model
- [`task_messaging.md`](task_messaging.md) — Peer-to-peer task messaging (future foundation for agent communication)
- [Slang Specification v0.7.5](https://github.com/riktar/slang/blob/master/SPEC.md) — Full Slang language spec
- [Slang Grammar](https://github.com/riktar/slang/blob/master/GRAMMAR.md) — Formal EBNF grammar
- [`todos/done/Shofer-parallel-tasks.md`](../../../todos/done/Shofer-parallel-tasks.md) — Original parallel task design
- [`todos/done/Shofer-async-newtask.md`](../../../todos/done/Shofer-async-newtask.md) — Async `new_task` design
