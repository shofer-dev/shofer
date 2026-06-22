# Worktree `.worktreeinclude` Sync

## Status

**Not implemented.** Design only. No `syncWorktreeInclude` handler, IPC message, or UI hook
exists in the codebase yet — verified by `grep -r syncWorktreeInclude` returning no matches.

## Priority

**Medium-low.** The Shofer UI's "Create worktree" button already runs the copy via
[`handleCreateWorktree`](../extensions/Shofer/src/core/webview/worktree/handlers.ts#L151),
so the **happy path is covered**. This feature is only needed for repair/refresh.

### When it actually breaks

In rough order of likelihood:

1. **CLI-created worktrees.** Anyone who runs `git worktree add …/.shofer/worktrees/foo`
   (or migrates an existing worktree from before the copy mechanism existed) gets a
   worktree with no `.shofer/`, no `.vscode/`, no `node_modules/`, no `.env`. Symptom:
   the agent in that worktree has **zero skills, zero custom modes, zero commands**,
   and any tool resolving a path against `.shofer/` silently fails or behaves like a
   fresh install. This is the original report.
2. **Stale `.shofer/` after a master-side change.** A teammate (or you) commits new
   skills/modes/commands to `.shofer/` on master. All pre-existing worktrees keep the
   old copy forever — no notification, no diff. Tasks in those worktrees use the
   stale skill set, which is **silent and easy to miss** (the skill the agent calls
   just doesn't exist, or — worse — runs the old version).
3. **Stale `node_modules/` / `.env`.** Master bumps a dep or adds an env var, the
   worktree still has the old tree → builds fail in unobvious ways inside the
   worktree, or runtime config drifts.
4. **Partial/failed copy at create time.** `copyWorktreeIncludeFiles` swallows
   individual item errors (read-only fs, permission, disk-full, interrupted) and
   the worktree is left in a half-copied state with no retry path other than
   "destroy + recreate".
5. **Worktree outlives a `.worktreeinclude` change.** Add `.docker/` to the include
   list on master → existing worktrees never get it.

### Why it's not P0

- The default workflow (UI-created worktree, used for the duration of one feature)
  **never trips this**.
- Workaround is trivial: `cp -r .shofer .shofer/worktrees/<id>/` from master.
- No data loss, no security impact — only "agent is missing capabilities" or
  "build is stale".

### Why it's not P3 either

- Symptom #2 (stale skills after a master update) is **silent**. The agent doesn't
  know a skill exists if the file isn't there, so the failure is "the model didn't
  choose to use that capability" — almost impossible to attribute. As `.shofer/`
  becomes the canonical place for project knowledge, this gets steadily worse.
- Symptom #1 will hit any user who experiments with `git worktree` outside the UI
  — a normal thing for power users to do.

### Suggested triage

- **Phase 1 (manual workaround):** zero-effort, do it now whenever it bites.
- **Phase 2 (handler + `worktree sync` CLI subcommand):** small, self-contained,
  makes the problem trivially fixable from the agent itself. Worth doing **before**
  anyone else hits symptom #2 in the wild.
- **Phase 3 (auto-repair on task spawn):** nice-to-have. Adds latency to first
  message; gate behind a setting.
- **Phase 4 (UI badges):** only valuable once `.shofer/` actually changes frequently
  across worktrees. Defer.

Bottom line: not blocking, but Phase 2 is cheap insurance and should land before the
silent-stale-skills failure mode starts costing debugging time.

## Problem

When a task runs in a non-master embedded worktree (`<repo>/.shofer/worktrees/<id>`), Shofer
skills, commands, modes, and other `.worktreeinclude`-listed items (`.shofer/`, `node_modules/`,
`.vscode/`, `.env`, `.docker/`) may be missing or stale because the copy mechanism only fires
once, at worktree-creation time.

### Root Cause

The `.worktreeinclude` copy mechanism runs only inside
[`handleCreateWorktree`](../extensions/Shofer/src/core/webview/worktree/handlers.ts#L151)
via `worktreeIncludeService.copyWorktreeIncludeFiles(...)`. After that point there is no
re-sync, so:

- Worktrees created via plain CLI (`git worktree add`) never get the copy at all.
- Worktrees created via the UI before a `.worktreeinclude` change on master (e.g. a PR that
  updates `.shofer/skills/`) keep stale copies forever.
- A failed/partial copy at create time is never retried.

Both `.shofer/` and the other entries are present in **both** `.worktreeinclude` and `.gitignore`
(the intersection required for copying), so config is correct — the mechanism just never re-runs.

## Context: Embedded Worktree Model

Note for anyone updating this design: separate-window worktrees were dropped in commit
`097b4d911` ("Drop separate-window worktree mode; document native worktree tool"). Today:

- All worktrees live at `<repoRoot>/.shofer/worktrees/<id>` (not `~/.shofer/worktrees/...`).
- A single VS Code window hosts every worktree; tasks are scoped to a worktree via
  `task.cwd`. There is **no** `handleSwitchWorktree` and no per-worktree window activation
  hook to piggy-back on.
- Worktree selection happens in
  [`WorktreeIndicator`](../extensions/Shofer/webview-ui/src/components/chat/WorktreeIndicator.tsx)
  before the first message; once a task starts, its `cwd` is locked.

This means Phase 3's "auto-repair on switch/activation" needs different hooks than the doc
originally assumed — see Phase 3 below.

## Existing Building Block

[`worktreeIncludeService.copyWorktreeIncludeFiles(sourceDir, targetDir, progressCallback?)`](../extensions/Shofer/packages/core/src/worktree/worktree-include.ts#L117)
already implements the copy logic (intersection of `.worktreeinclude` ∩ `.gitignore`, recursive
copy with size + progress reporting). The sync feature just needs to:

1. Add a "skip if exists / overwrite if force" mode on top.
2. Expose it through an IPC handler.
3. Trigger it from the right places.

## Design

### Phase 1 — Immediate Workaround (manual)

For the worktrees that are currently broken, copy `.shofer/` (and any other missing
`.worktreeinclude` entries) from the main worktree into each affected worktree by hand.

### Phase 2 — On-Demand Sync Handler

Add `syncWorktreeIncludeFiles(sourceDir, targetDir, { force })` to
`WorktreeIncludeService` and a `handleSyncWorktreeInclude` handler.

**Logic:**

1. Resolve the main worktree from `worktreeService.listWorktrees(cwd)` (the entry whose branch
   matches `worktreeService.detectBaseBranch(cwd)` — the unified default-branch detection
   landed in commit `0f57c0b24` and replaces the old hardcoded `main`/`master` checks).
2. Read `.worktreeinclude` from the main worktree.
3. For each item in `.worktreeinclude` ∩ `.gitignore`:
    - **Missing** in target → copy from main.
    - **Exists** in target and `force=false` → skip; record a "stale?" hint if the source
      mtime/hash differs from target.
    - **Exists** in target and `force=true` → overwrite.
4. Return a structured report: `{ copied: string[], skipped: string[], stale: string[], errors }`.

### Phase 3 — Auto-Repair Hooks

Replace the original "switch / activation" hooks with the ones that actually exist in the
embedded model:

- **Task spawn in a worktree.** When `ChatView.handleSendMessage` (or the parallel-task
  spawn path) attaches a `worktreeDir` to a new task, run a missing-only sync first so the
  task starts with a complete `.shofer/`. Make it non-blocking — surface a notification on failure.
- **`worktree create` tool / CLI rescue.** Extend `WorktreeTool.list` (or add a `worktree sync`
  subcommand) so the agent can repair existing worktrees. CLI-created worktrees benefit from
  this too.
- **Optional: extension activation.** On extension activation, enumerate
  `<repoRoot>/.shofer/worktrees/*` and warn (don't auto-copy) when any are missing
  `.worktreeinclude` items, with a "Sync now" action.

### Phase 4 — UI Integration

The post-097b4d911 UX is the [`WorktreeIndicator`](../extensions/Shofer/webview-ui/src/components/chat/WorktreeIndicator.tsx)
chip in the chat input bar; there is no longer a `WorktreesView` panel. So:

- In the indicator's popover, badge each worktree row with "N items missing" / "N stale"
  when applicable.
- Add a per-row "Sync .worktreeinclude" action (icon button or context menu) that invokes
  the handler with `force=false`; chord with Shift to pass `force=true`.
- Reflect progress via the existing `worktreeCopyProgress` message.

## Files to Modify

| File                                                                                                 | Change                                                                                                              |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| [`worktree-include.ts`](../extensions/Shofer/packages/core/src/worktree/worktree-include.ts)         | Add `syncWorktreeIncludeFiles(sourceDir, targetDir, { force })` on top of existing `copyWorktreeIncludeFiles`       |
| [`handlers.ts`](../extensions/Shofer/src/core/webview/worktree/handlers.ts)                          | Add `handleSyncWorktreeInclude(provider, worktreePath, force)`; resolve main via `worktreeService.detectBaseBranch` |
| [`vscode-extension-host.ts`](../extensions/Shofer/packages/types/src/vscode-extension-host.ts)       | Add `"syncWorktreeInclude"` to the `WebviewMessage` discriminator (message types live here, not in `worktree.ts`)   |
| [`webviewMessageHandler.ts`](../extensions/Shofer/src/core/webview/webviewMessageHandler.ts)         | Add `case "syncWorktreeInclude"` wiring                                                                             |
| [`WorktreeIndicator.tsx`](../extensions/Shofer/webview-ui/src/components/chat/WorktreeIndicator.tsx) | Phase 4: stale/missing badges + sync action per row                                                                 |
| [`ChatView.tsx`](../extensions/Shofer/webview-ui/src/components/chat/ChatView.tsx)                   | Phase 3: pre-spawn missing-only sync when a task is created with `worktreeDir`                                      |
| [`WorktreeTool.ts`](../extensions/Shofer/src/core/tools/WorktreeTool.ts)                             | Phase 3: `worktree sync` subcommand for the agent / CLI-rescue case                                                 |

## IPC Messages

### Request (webview → extension)

```ts
{ type: "syncWorktreeInclude", worktreeDir: string, force?: boolean }
```

Reuse the existing `worktreeDir?: string` field already on `WebviewMessage` (added at
[`vscode-extension-host.ts:802`](../extensions/Shofer/packages/types/src/vscode-extension-host.ts#L802))
so no new envelope field is required. `force=true` overwrites existing items in the target
worktree with the main worktree's version; defaults to `false` (skip if exists).

### Response (extension → webview)

```ts
{
  type: "worktreeResult",
  success: boolean,
  text: string,           // human-readable summary
  copied?: string[],
  skipped?: string[],
  stale?: string[],       // exist in target but differ from main (info only when force=false)
  errors?: { item: string; error: string }[],
}
```

### Progress (extension → webview)

```ts
{ type: "worktreeCopyProgress", copyProgressBytesCopied: number, copyProgressItemName: string }
```

(Already wired by `copyWorktreeIncludeFiles`.)

## Edge Cases

- **No main worktree found** (detached repo, branch deleted): error "No main worktree found
  to sync from." Use `detectBaseBranch` so this works for repos whose default is neither
  `main` nor `master`.
- **No `.worktreeinclude` in main**: nothing to sync; report 0 items.
- **Target is the main worktree**: skip — no-op.
- **Read-only target** / individual copy failure: report per-item errors; continue with
  the rest.
- **Deeply nested patterns** (`**/node_modules/`): handled by the `ignore` library inside
  `findMatchingItems`.
- **Large dirs** (`node_modules/`): rely on the existing `CopyProgressCallback`.
- **PR updates `.shofer/` on master while worktrees hold stale copies**: default skip leaves
  them stale. The `stale[]` field in the response and the Phase 4 badge surface this; the
  `force=true` flag (or Shift-click on the sync action) overwrites.
- **Concurrent syncs on the same worktree**: serialise per-target with a small in-memory
  lock map in the handler to avoid half-copied trees.
