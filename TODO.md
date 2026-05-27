
- Update: CODE_OF_CONDUCT.md, CONTRIBUTING.md, PRIVACY.md, SECURITY.md

- public web site

- publish in marketplace

- replace images in /home/alsterg/Projects/arkware.ai/extensions/shofer/apps/web-shofer/public

=== P1

- TEST RAG indexer for code changes

- TEST without llm-provider

- FIX pasting images

- DEV project documentation standarization/structure

- DEV default system prompt update to let the model know all these (native tools, capabilities, conventions) 
  - environment_details
  - use tools instead of executing cli commands
  - git structure (submodules etc)
  - do not cut corners; do not use bandaids or hacks; always pick the cleanest and most future-proof/sustaninable solution/approach/design/implementation.
  - do not disable or deactivate unit tests, lint checks, or anything else that is there for checking quality, just for comiting code, or for accomblishing your goals
  - TERMINOLOGY.md
  - when you assign a subtask a task, you should not do it yourself, but wait for it to complete, or terminate first and then do it.
  only spawn subtasks if you have other work to do in parallel, that can be parallelized.

=== P2

- pick a new logo

- DEV set limit on the number of parallel tasks

- Move these out of settings.json:
| Setting                          | Purpose                                  | Default           |
| -------------------------------- | ---------------------------------------- | ----------------- |
| `shofer.defaultCostLimit`        | Per-task USD budget cap                  | `null` (disabled) |
| `shofer.disabledTools`           | Globally disable specific tools          | `[]`              |
| `shofer.useAgentRules`           | Load `AGENTS.md` rule files from project | `true`            |
| `shofer.commandExecutionTimeout` | Max seconds for command execution        | `0` (no timeout)  |
| `shofer.commandTimeoutAllowlist` | Commands exempt from timeout             | `[]`              |


=== Test

- /rebase-worktree
- /merge-worktree

- /migrate-from-copilot
- /migrate-from-roocode

=== P2

- ISSUE: on rehydration of subtasks, the last state of it is not preserved (instead Idle is used)
- ISSUE: scrolling is bouncing in ChatView when you move away from the bottom while text is being streamed
- ISSUE: TaskNotification is shown even if already in the target Task
- DEV Simplify the Settings overlay (use VScode's own settings.json)
    - "Global Settings (JSON-only, no settings UI)" expose these settings on the Settings UI
- DEV memories (copilot_memory, copilot_resolveMemoryFileUri) (filter by age)
- preemptive summarization (in the background)
