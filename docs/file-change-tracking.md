# File Change Tracking — Design

> **Status:** Implemented (v3.65.0+)
> **Goal:** Per-task tracking of Roo's file edits with diff, revert, redo, and accept — backed by a single unified working-directory approach.

The File Changes Panel (rendered above the chat input) is the per-task view
of "files Roo edited and what is their net effect on the workspace." It is
backed by a single host-side service (`ChangedFilesService`) and is the only UI
surface the user needs in order to inspect, revert, or redo Roo's filesystem
mutations within the active task.

## Architecture overview

A single unified backend replaces the old two-backend (checkpoint shadow-git + tracker JSON snapshots) design.

### Per-task working directory

Each task stores verbatim file copies under its own `<taskDir>/`:

```
<globalStorage>/tasks/<taskId>/
├── base/                     # Original content before Roo's first edit (idempotent)
│   └── src/
│       └── utils.ts          # verbatim copy at capture time
├── final/                    # Last Roo-produced state (overwritten after every roo_edited)
│   └── src/
│       └── utils.ts
├── originals/                # Lightweight metadata snapshots (kind + hash only)
│   └── <sha1(relPath)>.json
├── finals/                   # Lightweight final metadata snapshots
│   └── <sha1(relPath)>.json
└── ...
```

### Snapshot metadata

Minimal JSON per file — no inline content. The actual content lives in `base/` and `final/`.

```ts
interface FileSnapshot {
	kind: "absent" | "text" | "binary"
	hash?: string // sha256 of base content (quick identity check)
}
```

### Diff computation

Insertions/deletions are computed via unified diff ([`diff`](https://npmjs.com/package/diff) package) comparing `base/<relPath>` against current on-disk content. This replaces the old line-count heuristic.

### Lifecycle

- **Creation:** `getTaskDirectoryPath()` in [`storage.ts`](../src/utils/storage.ts) creates the per-task directory lazily. [`FileContextTracker.captureOriginal()`](../src/core/context-tracking/FileContextTracker.ts) writes `base/<relPath>` + `originals/<sha1>.json` on first Roo edit (idempotent). [`captureFinal()`](../src/core/context-tracking/FileContextTracker.ts) writes `final/<relPath>` + `finals/<sha1>.json` after every Roo write.
- **Deletion:** When the user deletes a task, [`ClineProvider.deleteTaskWithId()`](../src/core/webview/ClineProvider.ts) removes the entire `<globalStorage>/tasks/<taskId>/` directory with `fs.rm({ recursive: true, force: true })` and deletes the shadow git branch `roo-<taskId>`. All child subtasks are cleaned up recursively.
- **Partial deletion:** `removeFinalSnapshot()` deletes individual `final/` and `finals/` entries when the user accepts a file change. `overwriteOriginalBase()` promotes the final state to the new baseline.

## Scope & filtering rules

The panel and the `get_changed_files` tool show **only files Roo edited at
least once during the current Task**. Files modified solely by the user
(`user_edited` events, or files appearing in the checkpoint diff that Roo
never touched) are excluded.

Consequences:

- The candidate paths come from `FileContextTracker.getFilesEditedByRoo()`
  (authoritative for "who touched what").
- The checkpoint diff is used only to compute **net state** for those
  candidate paths — it answers "is this file currently different from task
  start?", not "which files changed?".
- A file Roo edited but whose disk content currently matches the task's
  base is **dropped** from the list regardless of whether a final
  snapshot exists. Files with zero net change (+0/−0) have no effective
  diff to surface and are filtered out.
- A file Roo edited that the user _also_ edited stays in the list (Roo
  touched it); the per-file revert flow surfaces a user-edits warning.

## Unified source of truth

All consumers go through one async API:
[`ChangedFilesService`](../src/core/file-changes/ChangedFilesService.ts).

```ts
type ChangedFileEntry = {
    path: string                  // workspace-relative POSIX path
    insertions: number            // 0 if binary, unknown, or reverted
    deletions: number             // 0 if binary, unknown, or reverted
    binary: boolean
    state: "modified" | "added" | "deleted" | "reverted"
    source: "checkpoint" | "tracker"
    hasOriginalContent: boolean   // diff/revert against original is possible
    hasFinalContent: boolean      // a "Roo-produced" final snapshot exists → Redo possible
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
acceptFile(task, relPath): Promise<void>
acceptAll(task): Promise<void>
```

### Operation primitives

| Operation            | Mechanism                                                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `getChangedFiles`    | Hash disk content vs. `base/` copy; compute unified diff for insertions/deletions                                         |
| `getOriginalContent` | Read `base/<relPath>` (returns "" for absent, null for missing)                                                           |
| `getFinalContent`    | Read `final/<relPath>`                                                                                                    |
| `restoreFile`        | Copy `base/<relPath>` → workspace (or delete if absent)                                                                   |
| `restoreAll`         | Iterate `restoreFile` over all candidates                                                                                 |
| `acceptFile`         | Copy `final/<relPath>` → `base/<relPath>`, update originals hash, then `removeFinalSnapshot` — file disappears from panel |
| `acceptAll`          | Iterate `acceptFile` over all candidates                                                                                  |

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

`FileContextTracker` keeps two per-task snapshots per path:

- `original` — the first observed pre-Roo content for the path. Captured
  on the first `roo_edited` event in the task and never overwritten.
- `final` — the latest "Roo-produced" content for the path. Captured after
  every Roo write, including writes via the native `file` tool's `rm`/`mv`
  subcommands. **Revert does _not_ recapture `final`**, so Redo always
  re-applies the last Roo state, not the just-reverted base.

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

## Capture points

`captureOriginal` is called from every edit path:

- **`DiffViewProvider.open()`** — called by all tools that show a diff view ([`apply_diff`](../src/core/tools/ApplyDiffTool.ts), `search_replace`, `edit`, `edit_file`, `apply_patch`, `write_to_file`)
- **`DiffViewProvider.saveDirectly()`** — called by the same tools when `preventFocusDisruption` experiment is enabled (no diff view shown)
- **`InsertEditTool`** — manually reads the file and calls `captureOriginal` + `trackFileContext("roo_edited")` since it uses `vscode.WorkspaceEdit` directly
- **`FileTool`** (`rm`/`mv`) — captures originals for both source and destination paths

## Behaviour by feature

### Net-change accounting

A file Roo created and later deleted (or whose lines were added then
removed) is **always dropped** from the list — zero net change means no
effective diff to show. A file Roo edited that the user later restored by
hand also drops out automatically.

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

**Accept.** Copies `final/<relPath>` → `base/<relPath>`, updates the
originals hash, then calls `removeFinalSnapshot` — the file disappears
from the panel. This is a persistent operation that promotes Roo's changes
as the new accepted baseline.

**Active-task guard.** Revert/redo are blocked with a toast when
`task.isStreaming` is true: the user must pause or cancel the task first.

### Accept-all & Revert-all

Two header buttons next to the file count.

- **Accept all** copies all finals → base and removes all final snapshots
  (persistent).
- **Revert all** shows a modal confirmation. On confirm:
    - Checkpoint backend: single `service.restoreCheckpoint(baseHash)` —
      atomic, fast.
    - Tracker backend: iterate `restoreFile` over all candidates.

After revert-all the panel does not empty: every still-tracked entry
shifts to `state: "reverted"` so Redo remains reachable for each.

## IPC

Single bidirectional channel between webview and extension host:

| Direction      | Message                  | Payload               |
| -------------- | ------------------------ | --------------------- |
| Webview → host | `changedFiles/get`       | –                     |
| Webview → host | `changedFiles/showDiff`  | `text: relPath`       |
| Webview → host | `changedFiles/revert`    | `text: relPath`       |
| Webview → host | `changedFiles/revertAll` | –                     |
| Webview → host | `changedFiles/accept`    | `text: relPath`       |
| Webview → host | `changedFiles/acceptAll` | –                     |
| Host → webview | `changedFiles/update`    | `ChangedFilesPayload` |

The host pushes `changedFiles/update` debounced ~500 ms after each
`roo_edited` event and after every revert/accept. The panel also pulls on
mount and on task switch via `changedFiles/get`.

## Operating without a git repo / without checkpoints

The shadow checkpoint service does **not** require the workspace to be a
git repo — it creates its own shadow `.git` under
`<globalStorage>/checkpoints/<workspaceHash>/`. So "no git repo in workspace"
is **not** a blocker on its own. Real blockers for the checkpoint backend:

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
| `state: "reverted"` retention | no (zero-net-change files are dropped)                                           | no                                                                         |

The only meaningfully degraded feature is rename tracking. The UI shows a
small "limited mode" badge when `backend === "tracker"`.

## Multi-task same-file editing

Each task has its own `base/` and `final/`, so parallel tasks don't interfere:

- Task B's `base/` captures whatever is on disk when it first edits the file — which may include Task A's modifications
- Task B revert → reverts to Task A's version
- Task A revert → reverts to the pre-both-tasks original

The `FileChangesPanel` only shows changes for the focused foreground task.

## Checkpoint restore interaction

When the user restores a checkpoint via the chat UI, the workspace files are reverted to the shadow-git commit at that point in the conversation. The `base/` and `final/` working directories for the current task are **not** automatically cleared — they still reflect the pre-restore state.

**Known gap:** After a checkpoint restore, the FileChangesPanel may show stale diffs (comparing current workspace files against old `base/` copies that no longer represent the actual pre-edit baseline). Revert would restore to the wrong baseline. New edits after restore will also skip `captureOriginal` because the snapshot for the path already exists.

**Mitigation:** Checkpoint restore rewinds the entire task — messages are deleted or replayed — so the user is typically working in a restarted conversation context where the stale `base/`/`final/` state is less visible. A future improvement would be to clear `<taskDir>/base/`, `<taskDir>/final/`, `<taskDir>/originals/`, and `<taskDir>/finals/` after a successful checkpoint restore, so the next edits start with fresh baselines.

## What was removed

The old shadow-git checkpoint backend and its dual-backend architecture:

- All `getCheckpointService` / `CheckpointDiffStat` imports from `ChangedFilesService.ts`
- `checkoutSingleFileFromBase()` helper
- `"checkpoint"` source/backend values from types
- `degraded` flag from `ChangedFilesPayload`
- "limited mode" badge from `FileChangesPanel.tsx`
- `restoreCheckpoint()` call path in `restoreAll()`

The shadow-git checkpoint service itself is **preserved** — it still powers user-initiated "restore to checkpoint" from the chat UI. Only `ChangedFilesService`'s dependency on it was removed.

## Key files

| File                                                                                        | Role                                                                                                                                                            |
| ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`ChangedFilesService.ts`](../src/core/file-changes/ChangedFilesService.ts)                 | Public API: `getChangedFiles`, `getOriginalContent`, `getFinalContent`, `restoreFile`, `restoreAll`, `acceptFile`, `acceptAll`                                  |
| [`FileContextTracker.ts`](../src/core/context-tracking/FileContextTracker.ts)               | Snapshot capture: `captureOriginal`, `captureFinal`, `getBaseContent`, `getFinalContent`, `overwriteOriginalBase`, `removeFinalSnapshot`, `getFilesEditedByRoo` |
| [`FileChangesPanel.tsx`](../webview-ui/src/components/chat/FileChangesPanel.tsx)            | Webview UI: scrollable file list with diff/revert/accept buttons                                                                                                |
| [`DiffViewProvider.ts`](../src/integrations/editor/DiffViewProvider.ts)                     | Edit infrastructure: `open()` and `saveDirectly()` both call `captureOriginal` before mutation                                                                  |
| [`webviewMessageHandler.ts`](../src/core/webview/webviewMessageHandler.ts)                  | `changedFiles/*` IPC handlers                                                                                                                                   |
| [`ClineProvider.ts`](../src/core/webview/ClineProvider.ts)                                  | `scheduleChangedFilesUpdate(taskId)` debouncer, `pushChangedFilesUpdate()`, and task deletion with directory cleanup                                            |
| [`RooOriginalContentProvider.ts`](../src/integrations/editor/RooOriginalContentProvider.ts) | Virtual `roo-original:` documents for click-to-diff                                                                                                             |
| [`extension.ts`](../src/extension.ts)                                                       | Registers the `roo-original:` content provider scheme                                                                                                           |
| [`storage.ts`](../src/utils/storage.ts)                                                     | `getTaskDirectoryPath()` — resolves and creates `<globalStorage>/tasks/<taskId>/`                                                                               |
| [`ShadowCheckpointService.ts`](../src/services/checkpoints/ShadowCheckpointService.ts)      | Shadow git repo management, `deleteTask()` for branch cleanup on task deletion                                                                                  |
| [`vscode-extension-host.ts`](../packages/types/src/vscode-extension-host.ts)                | Types: `ChangedFileEntry`, `ChangedFilesPayload`                                                                                                                |

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

## TODO / Future work

- Clear `<taskDir>/base/`, `<taskDir>/final/`, `<taskDir>/originals/`, and `<taskDir>/finals/` after a successful checkpoint restore so the next edits start with fresh baselines (see [Checkpoint restore interaction](#checkpoint-restore-interaction)).
