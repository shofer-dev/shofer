# File Change Tracking — Design

> **Status:** Implemented (v3.65.0+)
> **Goal:** Per-task tracking of Shofer's file edits with diff, revert, redo, and accept — backed by a single unified working-directory approach.

The File Changes Panel (rendered above the chat input) is the per-task view
of "files Shofer edited and what is their net effect on the workspace." It is
backed by a single host-side service (`ChangedFilesService`) and is the only UI
surface the user needs in order to inspect, revert, or redo Shofer's filesystem
mutations within the active task.

## Architecture overview

A single unified backend replaces the old two-backend (checkpoint shadow-git + tracker JSON snapshots) design.

### Per-task working directory

Each task stores verbatim file copies under its own `<taskDir>/`:

```
<globalStorage>/tasks/<taskId>/
├── base/                     # Original content before Shofer's first edit (idempotent)
│   └── src/
│       └── utils.ts          # verbatim copy at capture time
├── final/                    # Last Shofer-produced state (overwritten after every roo_edited)
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

Insertions/deletions are computed via unified diff ([`diff`](https://npmjs.com/package/diff) package) comparing `base/<relPath>` against `final/<relPath>` — both task-owned copies. This replaces the old line-count heuristic. (It is **not** computed against the live workspace file; see [Concurrency isolation](#concurrency-isolation).)

### Lifecycle

- **Creation:** `getTaskDirectoryPath(globalStoragePath, taskId)` in [`storage.ts`](../src/utils/storage.ts) creates the per-task directory. [`FileContextTracker.captureOriginal()`](../src/core/context-tracking/FileContextTracker.ts) writes `base/<relPath>` + `originals/<sha1>.json` on first Shofer edit (idempotent). [`captureFinal()`](../src/core/context-tracking/FileContextTracker.ts) writes `final/<relPath>` + `finals/<sha1>.json` after every Shofer write.
- **Retention (when they are _not_ deleted):** The per-task copies are **not** freed on task completion, abort, or `dispose()` (which only disposes the file watchers — `FileContextTracker.dispose()`), nor on extension restart. They **persist for as long as the task exists in history**, so the panel / click-to-diff / revert / redo keep working when the task is later revisited or resumed. They are removed only by the deletion paths below. There is **no** pruning, LRU, TTL, or size cap (see [No snapshot size limit](#no-snapshot-size-limit)), and a checkpoint restore does **not** clear them (see [Checkpoint restore interaction](#checkpoint-restore-interaction-stalls-basefinal-cleanup)).
- **Deletion (whole directory):** When the user deletes a task, [`ShoferProvider.deleteTaskWithId()`](../src/core/webview/ShoferProvider.ts) removes the entire `<globalStorage>/tasks/<taskId>/` directory with `fs.rm({ recursive: true, force: true })` (ShoferProvider.ts ~3197) and deletes the shadow git branch `shofer-<taskId>`. This is the **only** place the whole working directory is removed, and it **cascades** — every subtask id in the delete set has its own task directory (and shadow repo) removed too. This is the normal way the copies are freed.
- **Partial deletion (per file):** `removeFinalSnapshot()` deletes an individual file's `final/` + `finals/` entry when the user **accepts** a change, and `overwriteOriginalBase()` promotes that file's content into `base/` as the new baseline. Separately, when a tool **deletes** a tracked file, `captureFinal()` removes the now-stale `final/` copy and records the final snapshot as `absent`.

## Scope & filtering rules

The panel and the `get_changed_files` tool show **only files Shofer edited at
least once during the current Task**. Files modified solely by the user
(`user_edited` events) that Shofer never touched are excluded.

Consequences:

- The candidate paths come from `FileContextTracker.getFilesEditedByRoo()`
  (authoritative for "who touched what" — only `shofer_edited` files of **this**
  task).
- Net state for each candidate is computed by diffing the task-owned
  `base/<relPath>` copy against the task-owned `final/<relPath>` copy — it answers
  "what did **this task** produce in this file?". It does **not** read the live
  workspace file for the diff, so a concurrent task editing the same file cannot
  alter this task's counts (see [Concurrency isolation](#concurrency-isolation)).
- A candidate whose `base` equals its `final` (the task's own net change is empty
  — e.g. a tool added a line then removed it) is **dropped**: +0/−0 has no
  effective diff.
- The live workspace file is consulted for exactly **one** thing: detecting a
  user-initiated revert (the file currently matches `base`), which drops the entry.

### Concurrency isolation

The changelist is **self-contained to the hosting task**. `base/<relPath>` (the
file as it was when this task first touched it) and `final/<relPath>` (what this
task last wrote) are both per-task copies, and `captureFinal` runs **only** on
this task's own `shofer_edited` writes — a parallel task's edit to the same file
is seen by this task's watcher as `user_edited` and never updates this task's
`final/`. Therefore parallel tasks/sessions running in the **same worktree/branch**
do not leak their changes into each other's panels, even though they share the
underlying files on disk. The click-to-diff view likewise compares `base` ↔ `final`
(not the live file) for the same reason.

## Unified source of truth

All consumers go through one async API exported from
[`ChangedFilesService.ts`](../src/core/file-changes/ChangedFilesService.ts).

```ts
type ChangedFileEntry = {
	path: string // workspace-relative POSIX path
	insertions: number // 0 if binary, unknown, or reverted
	deletions: number // 0 if binary, unknown, or reverted
	binary: boolean
	state: "modified" | "added" | "deleted" | "reverted"
	source: "working"
	hasOriginalContent: boolean // diff/revert against original is possible
	hasFinalContent: boolean // a "Shofer-produced" final snapshot exists → Redo possible
}

type ChangedFilesPayload = {
	taskId: string
	entries: ChangedFileEntry[]
	backend: "working" | "none"
}

export async function getChangedFiles(task: Task): Promise<ChangedFilesPayload>
export async function getOriginalContent(task: Task, relPath: string): Promise<string | null>
export async function getFinalContent(task: Task, relPath: string): Promise<string | null>
export async function restoreFile(task: Task, relPath: string): Promise<void>
export async function restoreAll(task: Task): Promise<void>
export async function acceptFile(task: Task, relPath: string): Promise<void>
export async function acceptAll(task: Task): Promise<void>
```

### Operation primitives

| Operation            | Mechanism                                                                                                                    |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `getChangedFiles`    | Unified diff of `base/` ↔ `final/` (task-owned) for insertions/deletions; live disk read only to detect a user revert       |
| `getOriginalContent` | Read `base/<relPath>` (returns "" for absent, null for missing)                                                              |
| `getFinalContent`    | Read `final/<relPath>`                                                                                                       |
| `restoreFile`        | Copy `base/<relPath>` → workspace (or delete if absent)                                                                      |
| `restoreAll`         | Iterate `restoreFile` over all candidates                                                                                    |
| `acceptFile`         | Read current disk content → `base/<relPath>`, update originals hash, then `removeFinalSnapshot` — file disappears from panel |
| `acceptAll`          | Iterate `acceptFile` over all candidates                                                                                     |

### How net state is computed

`getChangedFiles` iterates the candidate set from
`FileContextTracker.getFilesEditedByRoo(taskId)` and for each candidate:

- Reads the `base` snapshot/content and the `final` snapshot/content (both
  task-owned). If no `final` snapshot exists yet (captureFinal is best-effort and
  async), it falls back to the live disk content for that one file.
- Drops candidates whose `base` equals `final` (the task's own net change is zero).
- Drops candidates whose **live file currently matches `base`** (user reverted it
  via the panel) — the only place the live workspace file is read.
- Computes insertions/deletions via unified diff of `base` against `final`.
- Derives `added` / `deleted` / `modified` from the `base`/`final` existence (not
  the live file).

The backend is always `"working"` — there is no git dependency.

### Original- and final-content capture

`FileContextTracker` keeps two per-task snapshots per path:

- `original` — the first observed pre-Shofer content for the path. Captured
  on the first `roo_edited` event in the task and never overwritten.
- `final` — the latest "Shofer-produced" content for the path. Captured after
  every Shofer write, including writes via the native `file` tool's `rm`/`mv`
  subcommands. **Revert does _not_ recapture `final`**, so Redo always
  re-applies the last Shofer state, not the just-reverted base.

`getOriginalContent` returns:

1. The text snapshot (or `""` for `kind: "absent"`, so the diff editor
   shows additions cleanly), if present.
2. Falls back to reading `base/<relPath>` directly via
   `FileContextTracker.getBaseContent()` when the metadata snapshot is
   missing but the base copy exists (e.g. `captureOriginal` wrote the
   file copy before the snapshot write failed).
3. `null` only when neither source has any base content.

This makes click-to-diff and revert work without any git dependency, and
crucially also works for files Shofer edited via tool paths that bypass
`DiffViewProvider`'s snapshot hook (e.g. plain `write_to_file` for new
files, or the `file` tool's `rm`/`mv`).

## Capture points

Both `captureOriginal` (before first edit, idempotent) and `captureFinal`
(after every write, powers Redo/Accept) are needed for full panel support —
diff, revert, redo, accept. A tool that only calls `trackFileContext("shofer_edited")`
without `captureOriginal` will appear in the panel but diff won't work.

### Fully tracked (both `captureOriginal` + `trackFileContext("shofer_edited")`)

| Tool                                                                                                                      | Mechanism                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`apply_diff`](../src/core/tools/ApplyDiffTool.ts), `write_to_file`, `edit`, `edit_file`, `apply_patch`, `search_replace` | Via [`DiffViewProvider`](../src/integrations/editor/DiffViewProvider.ts) — `open()` captures original before mutation, `saveDirectly()` when `preventFocusDisruption` is enabled |
| [`file`](../src/core/tools/FileTool.ts) (`rm`/`mv`)                                                                       | Manual — captures originals for source (and destination for `mv`), then `trackFileContext("shofer_edited")` for each path                                                        |
| [`insert_edit`](../src/core/tools/InsertEditTool.ts)                                                                      | Manual — reads file content for `captureOriginal`, then `trackFileContext("shofer_edited")` after `WorkspaceEdit`                                                                |
| [`sed`](../src/core/tools/SedTool.ts)                                                                                     | Manual — reads file before regex replacement for `captureOriginal`, then `trackFileContext("shofer_edited")` after write                                                         |
| [`rename_symbol`](../src/core/tools/RenameSymbolTool.ts)                                                                  | Manual — reads each LSP-affected file for `captureOriginal` before rename, then `trackFileContext("shofer_edited")` after                                                        |

### Partial (tracks final but not original — diff won't work)

| Tool                                                       | Gap                                                                                                                                      |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| [`generate_image`](../src/core/tools/GenerateImageTool.ts) | Calls `trackFileContext("shofer_edited")` but no `captureOriginal` — appears in panel, click-to-diff is disabled (`!hasOriginalContent`) |

> **Why not just add `captureOriginal`?** The snapshot infrastructure is
> **text/utf8-oriented**: `buildSnapshotFromContent` only ever produces the
> `"text"` or `"absent"` `SnapshotKind` (never `"binary"`, which is declared in
> the type but currently unproduced), and both `captureOriginal` and
> `captureFinal` round-trip content as utf8 strings (`fs.readFile(abs, "utf8")` /
> `fs.writeFile(dest, content, "utf8")`). Passing a PNG's bytes through that path
> corrupts them, so a naive `captureOriginal` call for `generate_image` would
> store a broken "original" and break revert/redo rather than fix click-to-diff.
> Tracking generated images correctly requires real binary support (Buffer-based
> base/final copies + binary hashing). AGENTS.md lists `generate_image` among
> tools that must track manually; that becomes actionable once the snapshot
> system gains binary support (see TODO below). Until then this is a known,
> deliberate limitation — binary image diffs are not meaningful in a text diff
> editor anyway.

### Not tracked

| Tool                                       | Reason                                                  |
| ------------------------------------------ | ------------------------------------------------------- |
| `create_directory`, `create_new_workspace` | Only create directories (not files); no content to diff |
| `execute_command`                          | Arbitrary CLI commands — inherently untrackable         |

## Behaviour by feature

### Net-change accounting

A file Shofer created and later deleted (or whose lines were added then
removed) is **always dropped** from the list — zero net change means no
effective diff to show. A file Shofer edited that the user later restored by
hand also drops out automatically.

### Click-to-diff

Clicking a row opens a VS Code diff editor in the main area, comparing the
**original** content (left, virtual `shofer-original:` URI, read-only) against
this task's **`final`** content (right, also a virtual `shofer-original:` URI).
Both sides are task-owned copies, so the diff shows _this task's effect on this
file_ and is immune to edits other tasks/sessions made to the live file (see
[Concurrency isolation](#concurrency-isolation)). If no `final` snapshot exists
yet, the right side falls back to the live workspace file.

Implementation: `shofer-original:` is a `TextDocumentContentProvider`
registered in `extension.ts`; the body is base64-encoded into the URI
query. The host handler (`changedFiles/showDiff`) resolves the left via
`getOriginalContent` and the right via `getFinalContent`.

The row's click is disabled only when `!entry.hasOriginalContent`, which
in practice means a missing original snapshot.

### Per-file Revert / Accept / Redo

**Revert.** On click, the host:

1. Reads current disk content; if it differs from the last captured
   `final` content the user has edited the file after Shofer, so a modal
   warning is shown and the action proceeds only on confirmation.
2. Calls `ChangedFilesService.restoreFile(task, path)`:
    - Writes the original snapshot content back to disk, or `unlink`s when
      the snapshot says "absent".
3. Does **not** recapture `final` — the last Shofer-produced state is
   preserved so Redo can re-apply it.
4. Triggers a debounced `changedFiles/update` push; the entry reappears
   with `state: "reverted"`.

**Redo.** Visible only when `state === "reverted"`. Re-applies the last
captured `final` content (deterministic, no patch replay) and triggers a
push; the entry returns to `state: "modified"` (or `added`/`deleted`).

**Accept.** Reads the current on-disk content and copies it to `base/<relPath>`,
updates the originals hash, then calls `removeFinalSnapshot` — the file
disappears from the panel. This is a persistent operation that promotes the
current workspace state as the new accepted baseline.

> **Why disk, not `final/`?** The `final/` snapshot captures Shofer's last
> produced state, but the file may have been subsequently modified by user
> edits, language-server formatting, or auto-save. Using the `final/` content
> when disk has diverged causes a hash mismatch in `getChangedFiles`, keeping
> the file in the panel and requiring a second Accept click (which then falls
> back to disk because the final snapshot was cleared by the first attempt).

**Active-task guard.** Revert/redo are blocked with a toast when
`task.isStreaming` is true: the user must pause or cancel the task first.

### Accept-all & Revert-all

Two header buttons next to the file count.

- **Accept all** reads current disk content for every candidate, copies it
  to the base, and removes all final snapshots (persistent).
- **Revert all** shows a modal confirmation. On confirm, iterates
  `restoreFile` over all candidates.

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

### Robustness: Accept/Update Serialization and Logging (2026)

**Race condition fix:** Previously, rapid Accept clicks could cause some files to remain in the panel due to race conditions between concurrent `pushChangedFilesUpdate` calls. Each Accept would trigger a state mutation and a push, but the pushes could overlap and the last one to finish (even if stale) would win, causing accepted files to reappear.

**Current behavior:** `pushChangedFilesUpdate` is now serialized. If a push is in progress, further requests are queued and only the final state is sent to the webview after all mutations complete. This guarantees the panel always reflects the true post-accept state, even under rapid or concurrent Accept/AcceptAll actions.

**Disk-content fix (2026-05):** `acceptFile` now always reads the current on-disk content as the new baseline, instead of preferring the `final/` snapshot. The `final/` snapshot captures Shofer's last produced state, but the file may have been subsequently modified by user edits, language-server formatting, or auto-save. Using the stale `final/` content caused a hash mismatch in `getChangedFiles`, keeping the file in the panel and requiring a second Accept click to resolve. Reading disk content directly guarantees the baseline hash matches reality and the entry disappears on the first click.

**Diagnostics:** Logging was added to `acceptFile`, `acceptAll`, and `pushChangedFilesUpdate` to trace candidate counts, mutation order, and backend state for troubleshooting. If you still see files not disappearing, check the logs for the sequence of accept and update events.

The host pushes `changedFiles/update` debounced ~500 ms after each
`roo_edited` event and after every revert/accept. The panel also pulls on
mount and on task switch via `changedFiles/get`.

## Operating without a git repo / without checkpoints

The `ChangedFilesService` has **no** git dependency — it uses only the
per-task working directories (`base/` and `final/`). The shadow checkpoint
service (used only for user-initiated "restore to checkpoint" from the chat
UI) is a separate concern and does **not** affect file change tracking.

This means file change tracking works identically in every workspace type:
no git repo, nested git repo, protected paths — all function the same way.

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

| File                                                                                   | Role                                                                                                                                                            |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`ChangedFilesService.ts`](../src/core/file-changes/ChangedFilesService.ts)            | Public API: `getChangedFiles`, `getOriginalContent`, `getFinalContent`, `restoreFile`, `restoreAll`, `acceptFile`, `acceptAll`                                  |
| [`FileContextTracker.ts`](../src/core/context-tracking/FileContextTracker.ts)          | Snapshot capture: `captureOriginal`, `captureFinal`, `getBaseContent`, `getFinalContent`, `overwriteOriginalBase`, `removeFinalSnapshot`, `getFilesEditedByRoo` |
| [`FileChangesPanel.tsx`](../webview-ui/src/components/chat/FileChangesPanel.tsx)       | Webview UI: scrollable file list with diff/revert/accept buttons                                                                                                |
| [`DiffViewProvider.ts`](../src/integrations/editor/DiffViewProvider.ts)                | Edit infrastructure: `open()` and `saveDirectly()` both call `captureOriginal` before mutation                                                                  |
| [`webviewMessageHandler.ts`](../src/core/webview/webviewMessageHandler.ts)             | `changedFiles/*` IPC handlers                                                                                                                                   |
| [`ShoferProvider.ts`](../src/core/webview/ShoferProvider.ts)                           | `scheduleChangedFilesUpdate(taskId)` debouncer, `pushChangedFilesUpdate()`, and task deletion with directory cleanup                                            |
| [`extension.ts`](../src/extension.ts)                                                  | Registers the `shofer-original:` content provider scheme (anonymous class implementing `TextDocumentContentProvider`)                                           |
| [`storage.ts`](../src/utils/storage.ts)                                                | `getTaskDirectoryPath()` — resolves and creates `<globalStorage>/tasks/<taskId>/`                                                                               |
| [`ShadowCheckpointService.ts`](../src/services/checkpoints/ShadowCheckpointService.ts) | Shadow git repo management, `deleteTask()` for branch cleanup on task deletion                                                                                  |
| [`vscode-extension-host.ts`](../packages/types/src/vscode-extension-host.ts)           | Types: `ChangedFileEntry`, `ChangedFilesPayload`                                                                                                                |

## i18n keys

Webview (`webview-ui/src/i18n/locales/<lang>/chat.json`):

- `chat:fileChangesInConversation.header`
- `chat:fileChanges.acceptAll`, `chat:fileChanges.revertAll`
- `chat:fileChanges.accept`, `chat:fileChanges.revert`, `chat:fileChanges.redo`
- `chat:fileChanges.diffUnavailable`
- `chat:fileChanges.revertConfirmUserEdits`, `chat:fileChanges.revertConfirmYes`
- `chat:fileChanges.revertAllConfirm`
- `chat:fileChanges.blockedTaskRunning`

Host (`src/i18n/locales/<lang>/common.json`):

- `common:fileChanges.blockedTaskRunning`
- `common:fileChanges.revertConfirmUserEdits`, `common:fileChanges.revertConfirmYes`
- `common:fileChanges.revertAllConfirm`

The split is deliberate: keys consumed by the webview live in `chat.json`;
keys consumed by host code (modal dialogs, toasts shown by
`webviewMessageHandler.ts`) live in `common.json` because the host
i18next instance loads the `common` namespace, not `chat`.

## Gaps & Areas for Improvement

### Legacy naming

- `FileContextTracker.getFilesEditedByRoo()` retains the old "Roo" name. Renaming to `getFilesEditedByShofer()` would align with the rebranding.
- The internal `recentlyEditedByRoo` set in [`FileContextTracker.ts`](../src/core/context-tracking/FileContextTracker.ts) still carries the legacy name.

### No test coverage for ChangedFilesService

There is no `__tests__/` directory under `src/core/file-changes/`. The service handles snapshot hashing, unified diff computation, absent/add/delete state derivation, and the accept/revert flow — all of which would benefit from unit tests against known fixtures.

### `shofer-original:` content provider is an anonymous class

The virtual document scheme is registered via an anonymous `class implements vscode.TextDocumentContentProvider` inline in [`extension.ts`](../src/extension.ts:277). Extracting it into a named module (e.g., `src/integrations/editor/ShoferOriginalContentProvider.ts`) would make it independently testable and visible in stack traces.

### No snapshot size limit

`captureOriginal` writes verbatim file copies under `base/<relPath>`. For a task that edits many large files, the per-task working directory can grow unbounded. There is no pruning, no LRU eviction, and no configurable maximum size per task directory.

### `acceptFile` disk-read is not atomic with `overwriteOriginalBase`

Between `readDiskText(task.cwd, posix)` and `overwriteOriginalBase(posix, content)` the file could change on disk (user edit, auto-save, formatter run). The hash stored in the originals snapshot could reflect an intermediate state that doesn't match what was promoted. A racy re-read of the file after promotion to verify the hash would close this gap.

### Checkpoint restore interaction stalls base/final cleanup

After a checkpoint restore, `base/` and `final/` directories are stale until cleared manually or by the next new task. See the [Checkpoint restore interaction](#checkpoint-restore-interaction) section for details.

## TODO / Future work

- Clear `<taskDir>/base/`, `<taskDir>/final/`, `<taskDir>/originals/`, and `<taskDir>/finals/` after a successful checkpoint restore so the next edits start with fresh baselines (see [Checkpoint restore interaction](#checkpoint-restore-interaction)).
- **Binary snapshot support.** Make `buildSnapshotFromContent` actually produce the `"binary"` `SnapshotKind` and have `captureOriginal`/`captureFinal` store base/final copies as raw `Buffer`s (binary hashing) rather than utf8 strings. This unblocks full tracking for `generate_image` (and any future binary-producing tool) per the AGENTS.md File Change Tracking Pattern.
