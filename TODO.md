migration guide for claude code
migration guide for opencode
Finalize the UI aspect of the workflows (visualization, etc)
fix workflows
- "Running" commands don't seem to have the ability to kill
- parent can give title (workflow does) and then the agent should not change it
- Maybe update the HistoryView for Workflows
- new_task can have a name param for each task

- Improve README, walkthrough, and video (update changelog)

- Announce https://gemini.google.com/app/bc25f481142e4161
  https://www.reddit.com/r/opensource/comments/1rqryee/slang_a_declarative_language_for_multiagent/#:~:text=The%20syntax%20is%20simple%20enough,%2C%20OpenRouter%2C%20MCP%20Sampling).

- make the dir name same as worktree & branch:
  alsterg@laptop:~/Projects/arkware.ai/.shofer/worktrees/arkware.ai-kom7c$ git branch


* DEV default system prompt update to let the model know all these (native tools, capabilities, conventions)
    - project documentation standarization/structure
    - Do not double answer: both with a regular message and with attempt_completion. The latter is the way you should provide your final answer/conclusion.
    - submodule structure
    - set title
    - environment_details
    - use tools instead of executing cli commands
    - git structure (submodules etc)
    - do not cut corners; do not use bandaids or hacks; always pick the cleanest and most future-proof/sustaninable solution/approach/design/implementation.
    - do not disable or deactivate unit tests, lint checks, or anything else that is there for checking quality, just for comiting code, or for accomblishing your goals
    - TERMINOLOGY.md
    - when you assign a subtask a task, you should not do it yourself, but wait for it to complete, or terminate first and then do it.
      only spawn subtasks if you have other work to do in parallel, that can be parallelized.

=== P1

- new logo

- TEST pasting images

=== P2

- test: /migrate-from-copilot /migrate-from-roocode

- DEV set limit on the number of parallel tasks by limitting who can use new_task (limit on depth of task tree, and number of active tasks per parent task)

- "Global Settings (JSON-only, no settings UI)" expose these settings on the Settings UI. Move these out of settings.json:
  | Setting | Purpose | Default |
  | -------------------------------- | ---------------------------------------- | ----------------- |
  | `shofer.defaultCostLimit` | Per-task USD budget cap | `null` (disabled) |
  | `shofer.disabledTools` | Globally disable specific tools | `[]` |
  | `shofer.useAgentRules` | Load `AGENTS.md` rule files from project | `true` |
  | `shofer.commandExecutionTimeout` | Max seconds for command execution | `0` (no timeout) |
  | `shofer.commandTimeoutAllowlist` | Commands exempt from timeout | `[]` |

- DEV Simplify the Settings overlay (use VScode's own settings.json)

- DEV memories (copilot_memory, copilot_resolveMemoryFileUri) (filter by age)

- preemptive summarization (in the background)
