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
