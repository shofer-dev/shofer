# File Changes Panel

> Source: [src/core/file-changes/ChangedFilesService.ts](../src/core/file-changes/ChangedFilesService.ts)
> Source: [webview-ui/src/components/chat/FileChangesPanel.tsx](../webview-ui/src/components/chat/FileChangesPanel.tsx)
> Source: [src/core/context-tracking/FileContextTracker.ts](../src/core/context-tracking/FileContextTracker.ts)
> Source: [src/services/checkpoints/ShadowCheckpointService.ts](../src/services/checkpoints/ShadowCheckpointService.ts)

The File Changes Panel (rendered above the chat input) is the per-task view
of "files Roo edited and what is their net effect on the workspace." It is
backed by a single host-side service and is the only UI surface the user
needs in order to inspect, revert, or redo Roo's filesystem mutations
within the active task.

## Scope

The panel and the `get_changed_files` tool show **only files Roo edited at
least once during the current Task**. Files modified solely by the user
(detected via `FileContextTracker`'s `user_edited` events, or files
appearing in the checkpoint diff that Roo never touched) are excluded.

Consequences:

- The candidate paths come from `FileContextTracker.getFilesEditedByRoo()`
  (authoritative for "who touched what").
- The checkpoint diff is used only to compute **net state** for those
  candidate paths — it answers "is this file currently different from task
  start?", not "which files changed?".
- A file Roo edited but whose disk content currently matches the task's
  base is **kept** in the list as `state: "reverted"` whenever a final
  snapshot still exists (so Redo remains reachable). It is dropped only
  when no final snapshot exists.
- A file Roo edited that the user _also_ edited stays in the list (Roo
  touched it); the per-file revert flow surfaces a user-edits warning.

## Unified source of truth

All consumers go through one async API:
[`src/core/file-changes/ChangedFilesService.ts`](../src/core/file-changes/ChangedFilesService.ts).

```ts
type ChangedFileEntry = {
    path: string                  // workspace-relative POSIX path
    insertions: number            // 0 if binary, unknown, or reverted
    deletions: number             // 0 if binary, unknown, or reverted
    binary: boolean
    state: "modified" | "added" | "deleted" | "reverted"
    source: "checkpoint" | "tracker"
    hasOriginalContent: boolean   // diff/revert against original is possible
    hasFinalContent: boolean      // a "Roo-produced" final snapshot exists -> Redo possible
}

type ChangedFilesPayload = {
    taskId: string
    entries: ChangedFileEntry[]
    backend: "checkpoint" | "tracker" | "none"
    degraded: boolean
    reason?: string
}

getChangedFiles(task): Promise<ChangedFilesPayload>
getOriginalContent(task, relPath): Promise<string | null>
getFinalContent(task, relPath): Promise<string | null>
restoreFile(task, relPath): Promise<void>
restoreAll(task): Promise<void>
redoFile(task, relPath): Promise<void>
```

### Backend selection

Both backends start from the same candidate set
(`FileContextTracker.getFilesEditedByRoo(taskId)`). They differ only in how
they compute _net state_.

1. **Preferred — checkpoint backend.** When `getCheckpointService(task)`
   returns an initialized service with a valid `baseHash`, call
   `service.getDiffStat({ from: baseHash })` and intersect with the
   candidate set.
2. **Fallback — tracker backend.** When checkpoints are unavailable
   (disabled, nested-git error, no `git` binary, protected workspace path),
   compare current disk content of each candidate against the per-task
   original snapshot. If hashes match (or both indicate "absent") the
   candidate is treated as matching base.

In **both** backends, candidates whose current disk state matches base are
emitted as `state: "reverted"` when a final snapshot exists, and dropped
otherwise.

`backend` and `degraded` are surfaced to the UI so it can show a "limited
mode" badge in the panel header when `backend === "tracker"`.

### Original- and final-content capture

`FileContextTracker` keeps two per-task snapshots per path under
`<globalStorage>/tasks/<taskId>/{originals,finals}/<sha1(relPath)>.json`:

- `original` — the first observed pre-Roo content for the path. Captured
  on the first `roo_edited` event in the task and never overwritten.
- `final` — the latest "Roo-produced" content for the path. Captured after
  every Roo write, including writes via the native `file` tool's `rm`/`mv`
  subcommands. Importantly, **revert does _not_ recapture `final`**, so
  Redo always re-applies the last Roo state, not the just-reverted base.

Snapshot format: `{ kind: "absent" | "text", content?: string, hash?: string }`
where `hash` is sha256 of `content`.

`getOriginalContent` returns:

1. The text snapshot (or `""` for `kind: "absent"`, so the diff editor
   shows additions cleanly), if present.
2. Otherwise, when the checkpoint backend is active and initialized,
   `git show <baseHash>:<path>` from the shadow git, returning `""` when
   the path did not exist at base.
3. `null` only when neither source has any base content.

This makes click-to-diff and revert work uniformly across backends, and
crucially also works for files Roo edited via tool paths that bypass
`DiffViewProvider`'s snapshot hook (e.g. plain `write_to_file` for new
files, or the `file` tool's `rm`/`mv`).

## IPC

Single bidirectional channel between webview and extension host:

| Direction      | Message                  | Payload               |
| -------------- | ------------------------ | --------------------- |
| Webview → host | `changedFiles/get`       | –                     |
| Webview → host | `changedFiles/showDiff`  | `text: relPath`       |
| Webview → host | `changedFiles/revert`    | `text: relPath`       |
| Webview → host | `changedFiles/revertAll` | –                     |
| Webview → host | `changedFiles/redo`      | `text: relPath`       |
| Host → webview | `changedFiles/update`    | `ChangedFilesPayload` |

The host pushes `changedFiles/update` debounced ~500 ms after each
`roo_edited` event and after every revert/redo. The panel also pulls on
mount and on task switch to recover from missed pushes.

## Behaviour by feature

### Net-change accounting

A file Roo created and later deleted (or whose lines were added then
removed) collapses to either `state: "reverted"` (if a final snapshot
exists for Redo) or is dropped entirely. A file Roo edited that the user
later restored by hand drops out automatically.

### Click-to-diff

Clicking a row opens a VS Code diff editor in the main area, comparing the
**original** content (left, virtual `roo-original:` URI, read-only)
against the **current on-disk** content (right). The intent is to show
_Roo's cumulative effect on this file_, not the working-tree diff.

Implementation: `roo-original:` is a `TextDocumentContentProvider`
registered in `extension.ts`; the body is base64-encoded into the URI
query. The host handler resolves original content via
`getOriginalContent`, which transparently falls back to the checkpoint
shadow git as described above.

The row's click is disabled only when `!entry.hasOriginalContent`, which
in practice means tracker backend with a missing snapshot — checkpoint
entries always advertise `hasOriginalContent: true` because the shadow
git can always serve the base.

### Per-file Revert / Accept / Redo

**Revert.** On click, the host:

1. Reads current disk content; if it differs from the last captured
   `final` content the user has edited the file after Roo, so a modal
   warning is shown and the action proceeds only on confirmation.
2. Calls `ChangedFilesService.restoreFile(task, path)`:
    - Checkpoint backend: per-file checkout from `baseHash` via the shadow
      git, plus an explicit `unlink` when the path did not exist at base.
    - Tracker backend: writes the snapshot back to disk, or `unlink`s when
      the snapshot says "absent".
3. Does **not** recapture `final` — the last Roo-produced state is
   preserved so Redo can re-apply it.
4. Triggers a debounced `changedFiles/update` push; the entry reappears
   with `state: "reverted"`.

**Redo.** Visible only when `state === "reverted"`. Re-applies the last
captured `final` content (deterministic, no patch replay) and triggers a
push; the entry returns to `state: "modified"` (or `added`/`deleted`).

**Accept.** Per-row checkmark. Session-only UI state in the webview (not
persisted, not pushed). Marks the row as reviewed: dims it and moves it
to a "Reviewed (N)" subsection at the bottom of the panel. No effect on
revert/redo semantics.

**Active-task guard.** Revert/redo are blocked with a toast when
`task.isStreaming` is true: the user must pause or cancel the task first.

### Accept-all & Revert-all

Two header buttons next to the file count.

- **Accept all** marks every active row as reviewed (session-only).
- **Revert all** shows a modal confirmation. On confirm:
    - Checkpoint backend: single `service.restoreCheckpoint(baseHash)` —
      atomic, fast.
    - Tracker backend: iterate `restoreFile` over all candidates.

After revert-all the panel does not empty: every still-tracked entry
shifts to `state: "reverted"` so Redo remains reachable for each.

## Operating without a git repo / without checkpoints

The shadow checkpoint service does **not** require the workspace to be a
git repo — it creates its own shadow `.git` under
`<globalStorage>/checkpoints/<taskId>/`. So "no git repo in workspace" is
**not** a blocker on its own. Real blockers for the checkpoint backend:

1. `git` binary missing on PATH.
2. Workspace path is a protected location (`$HOME`, Desktop, Documents,
   Downloads).
3. Workspace contains a nested `.git` directory.
4. User disabled checkpoints in settings.

When any of these holds, the unified API automatically falls back to the
tracker backend.

| Feature                       | Checkpoint backend                                                               | Tracker backend                                                            |
| ----------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Net file list                 | full (creates+deletes cancel, renames detected)                                  | partial (renames appear as add+delete; binary detection by extension only) |
| Scrollable list               | identical                                                                        | identical                                                                  |
| Click-to-diff                 | original from `git show baseHash:<path>`                                         | original from per-task snapshot                                            |
| Per-file revert               | per-file checkout from `baseHash` + workspace unlink for "did not exist at base" | overwrite file with snapshot, or unlink if snapshot says "absent"          |
| Per-file redo                 | re-apply `final` snapshot                                                        | identical                                                                  |
| Revert-all                    | single `restoreCheckpoint(baseHash)`                                             | iterate `restoreFile`                                                      |
| `state: "reverted"` retention | yes (final snapshot drives it)                                                   | yes                                                                        |

The only meaningfully degraded feature is rename tracking. The UI shows a
small "limited mode" badge when `backend === "tracker"`.

## Files

- New: [src/core/file-changes/ChangedFilesService.ts](../src/core/file-changes/ChangedFilesService.ts)
- [src/core/context-tracking/FileContextTracker.ts](../src/core/context-tracking/FileContextTracker.ts) — `captureOriginal()`, `captureFinal()`, snapshot getters.
- [src/core/webview/webviewMessageHandler.ts](../src/core/webview/webviewMessageHandler.ts) — `changedFiles/*` IPC handlers.
- [src/core/webview/ClineProvider.ts](../src/core/webview/ClineProvider.ts) — `scheduleChangedFilesUpdate(taskId)` debouncer and `pushChangedFilesUpdate()`.
- [src/integrations/editor/RooOriginalContentProvider.ts](../src/integrations/editor/RooOriginalContentProvider.ts) — virtual `roo-original:` documents.
- [src/extension.ts](../src/extension.ts) — registers the content provider scheme.
- [webview-ui/src/components/chat/FileChangesPanel.tsx](../webview-ui/src/components/chat/FileChangesPanel.tsx) — consumes `changedFiles/update`, renders rows, dispatches IPC actions.
- [packages/types/src/vscode-extension-host.ts](../packages/types/src/vscode-extension-host.ts) — `ChangedFileEntry`, `ChangedFilesPayload` shape.

## i18n keys

Webview (`webview-ui/src/i18n/locales/<lang>/chat.json`):

- `chat:fileChangesInConversation.header`
- `chat:fileChanges.acceptAll`, `chat:fileChanges.revertAll`
- `chat:fileChanges.accept`, `chat:fileChanges.revert`, `chat:fileChanges.redo`
- `chat:fileChanges.diffUnavailable`, `chat:fileChanges.diffTitle`
- `chat:fileChanges.reviewedSection`
- `chat:fileChanges.limitedMode`, `chat:fileChanges.limitedModeTooltip`

Host (`src/i18n/locales/<lang>/common.json`):

- `common:fileChanges.blockedTaskRunning`
- `common:fileChanges.revertConfirmUserEdits`, `common:fileChanges.revertConfirmYes`
- `common:fileChanges.revertAllConfirm`

The split is deliberate: keys consumed by the webview live in `chat.json`;
keys consumed by host code (modal dialogs, toasts shown by
`webviewMessageHandler.ts`) live in `common.json` because the host
i18next instance loads the `common` namespace, not `chat`.
