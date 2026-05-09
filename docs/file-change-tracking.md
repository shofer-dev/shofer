# File Change Tracking — Design

> **Status:** Implemented (v3.65.0+)
> **Goal:** Zero-git, per-task working-directory approach for tracking Roo's file edits with diff, revert, redo, and accept.

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

## Key files

| File                                                                             | Role                                                                                                                                                            |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`ChangedFilesService.ts`](../src/core/file-changes/ChangedFilesService.ts)      | Public API: `getChangedFiles`, `getOriginalContent`, `getFinalContent`, `restoreFile`, `restoreAll`, `redoFile`, `acceptFile`, `acceptAll`                      |
| [`FileContextTracker.ts`](../src/core/context-tracking/FileContextTracker.ts)    | Snapshot capture: `captureOriginal`, `captureFinal`, `getBaseContent`, `getFinalContent`, `overwriteOriginalBase`, `removeFinalSnapshot`, `getFilesEditedByRoo` |
| [`FileChangesPanel.tsx`](../webview-ui/src/components/chat/FileChangesPanel.tsx) | Webview UI: scrollable file list with diff/revert/redo/accept buttons                                                                                           |
| [`DiffViewProvider.ts`](../src/integrations/editor/DiffViewProvider.ts)          | Edit infrastructure: `open()` and `saveDirectly()` both call `captureOriginal` before mutation                                                                  |
| [`vscode-extension-host.ts`](../packages/types/src/vscode-extension-host.ts)     | Types: `ChangedFileEntry`, `ChangedFilesPayload`                                                                                                                |

## Operation primitives

| Operation            | Mechanism                                                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `getChangedFiles`    | Hash disk content vs. `base/` copy; compute unified diff for insertions/deletions                                         |
| `getOriginalContent` | Read `base/<relPath>` (returns "" for absent, null for missing)                                                           |
| `getFinalContent`    | Read `final/<relPath>`                                                                                                    |
| `restoreFile`        | Copy `base/<relPath>` → workspace (or delete if absent)                                                                   |
| `restoreAll`         | Iterate `restoreFile` over all candidates                                                                                 |
| `redoFile`           | Copy `final/<relPath>` → workspace (or delete if absent)                                                                  |
| `acceptFile`         | Copy `final/<relPath>` → `base/<relPath>`, update originals hash, then `removeFinalSnapshot` — file disappears from panel |
| `acceptAll`          | Iterate `acceptFile` over all candidates                                                                                  |

## IPC

Single bidirectional channel between webview and extension host:

| Direction      | Message                  | Payload               |
| -------------- | ------------------------ | --------------------- |
| Webview → host | `changedFiles/get`       | –                     |
| Webview → host | `changedFiles/showDiff`  | `text: relPath`       |
| Webview → host | `changedFiles/revert`    | `text: relPath`       |
| Webview → host | `changedFiles/revertAll` | –                     |
| Webview → host | `changedFiles/redo`      | `text: relPath`       |
| Webview → host | `changedFiles/accept`    | `text: relPath`       |
| Webview → host | `changedFiles/acceptAll` | –                     |
| Host → webview | `changedFiles/update`    | `ChangedFilesPayload` |

The host pushes `changedFiles/update` debounced 500 ms after each `roo_edited` event and after every revert/redo/accept. The panel also pulls on mount and on task switch via `changedFiles/get`.

## Capture points

`captureOriginal` is called from every edit path:

- **`DiffViewProvider.open()`** — called by all tools that show a diff view ([`apply_diff`](../src/core/tools/ApplyDiffTool.ts), `search_replace`, `edit`, `edit_file`, `apply_patch`, `write_to_file`)
- **`DiffViewProvider.saveDirectly()`** — called by the same tools when `preventFocusDisruption` experiment is enabled (no diff view shown)
- **`InsertEditTool`** — manually reads the file and calls `captureOriginal` + `trackFileContext("roo_edited")` since it uses `vscode.WorkspaceEdit` directly
- **`FileTool`** (`rm`/`mv`) — captures originals for both source and destination paths

## Multi-task same-file editing

Each task has its own `base/` and `final/`, so parallel tasks don't interfere:

- Task B's `base/` captures whatever is on disk when it first edits the file — which may include Task A's modifications
- Task B revert → reverts to Task A's version
- Task A revert → reverts to the pre-both-tasks original

The `FileChangesPanel` only shows changes for the focused foreground task.

## What was removed

The old shadow-git checkpoint backend and its dual-backend architecture:

- All `getCheckpointService` / `CheckpointDiffStat` imports from `ChangedFilesService.ts`
- `checkoutSingleFileFromBase()` helper
- `"checkpoint"` source/backend values from types
- `degraded` flag from `ChangedFilesPayload`
- "limited mode" badge from `FileChangesPanel.tsx`
- `restoreCheckpoint()` call path in `restoreAll()`

The shadow-git checkpoint service itself is **preserved** — it still powers user-initiated "restore to checkpoint" from the chat UI. Only `ChangedFilesService`'s dependency on it was removed.
