BUG: Settings->Worktrees : when a new worktree is created to deleted, the panel is closed. No, it should stay open and refresh the list of worktrees.

BUG: Sometimes when exporting a workflow json file, the UI becomes unresponsive.

FR: Add the submodule structure of the current repo (if workspace is a git) in system-prompt context (see extensions/shofer/docs/system_prompt.md)

FR: When a task or subtask uses ask_followup_question, its state should transition to "waiting" or similar. Today is still `running`.

BUG: extensions/shofer/docs/performance_optimizations.md the implementation of "Load older messages..." is working per se, but is causing the ChatView to jump at the very top first, and then down to the very button, with every message posted.

BUG: ask_followup_question `follow_up` param should be optional, since we introduced the `form` param (also optional). But one of them should be present (not both).

BUG: I run a workflow and got two different "active time" values, one in Stats (38m13s) and one in TaskHeader (18m55s). They should be measuring the same, no?

- Announce https://gemini.google.com/app/bc25f481142e4161
  https://www.reddit.com/r/opensource/comments/1rqryee/slang_a_declarative_language_for_multiagent/#:~:text=The%20syntax%20is%20simple%20enough,%2C%20OpenRouter%2C%20MCP%20Sampling).

* DEV default system prompt update to let the model know all these (native tools, capabilities, conventions)
    - project documentation standarization/structure
    - Do not double answer: both with a regular message and with attempt_completion. The latter is the way you should provide your final answer/conclusion.
    -
    - set title
    - environment_details
    - use tools instead of executing cli commands
    - git structure (submodules etc)
    - do not cut corners; do not use bandaids or hacks; always pick the cleanest and most future-proof/sustaninable solution/approach/design/implementation.
    - do not disable or deactivate unit tests, lint checks, or anything else that is there for checking quality, just for comiting code, or for accomblishing your goals
    - TERMINOLOGY.md
    - when you assign a subtask a task, you should not do it yourself, but wait for it to complete, or terminate first and then do it.
      only spawn subtasks if you have other work to do in parallel, that can be parallelized.

=== P2

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

- test the migration commands

- test pasting images
