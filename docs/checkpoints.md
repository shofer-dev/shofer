# Checkpoints — Design & Implementation

## Purpose

Checkpoints give the user a **per-task undo history** that works independently of the workspace's own git repository. Each checkpoint is a shadow git commit that captures the full state of every workspace file Shofer has touched during the task. The user can:

- **Preview** the diff between any two checkpoints (or from a checkpoint to the current workspace).
- **Restore** the workspace to any previous checkpoint, rewinding chat history to match.
- **Delete** a message and optionally roll the workspace back to the checkpoint taken just before it.

Checkpoints are orthogonal to the **File Changes Panel** (a separate per-task working-directory backend — see below).

---

## Architecture

```
Task
 ├── task.enableCheckpoints        — boolean gate; set false on any fatal error
 ├── task.checkpointService        — RepoPerTaskCheckpointService instance
 ├── task.checkpointServiceInitializing — prevents re-entrant init
 │
 └── core/checkpoints/index.ts     — public API used by Task and webview handler
      ├── getCheckpointService()   — lazy init with pWaitFor concurrency guard
      ├── checkpointSave()         — saves a checkpoint in the background
      ├── checkpointRestore()      — restores workspace + rewinds chat history
      └── checkpointDiff()         — opens VS Code diff editor for a range

 services/checkpoints/
  ├── ShadowCheckpointService.ts   — abstract base: shadow git operations
  ├── RepoPerTaskCheckpointService.ts — concrete per-task subclass
  ├── excludes.ts                  — .git/info/exclude pattern builder
  └── types.ts                     — CheckpointDiff, CheckpointDiffStat, CheckpointServiceOptions, CheckpointEventMap
```

---

## Shadow Git Approach

Shofer never commits into the user's own git repository. Instead it maintains a **shadow git repo** stored in VS Code's global storage directory, completely outside the workspace:

```
~/.config/Code/User/globalStorage/shofer.dev/
  tasks/<taskId>/checkpoints/
    .git/
      config        ← core.worktree = <workspaceDir>
      info/exclude  ← build artifacts, media, LFS patterns, sibling worktrees
```

`core.worktree` is set to the real workspace directory so `git add .` inside the shadow repo stages workspace files. The shadow git's `baseDir` (where simple-git runs commands) is the checkpoints directory itself, not the workspace.

### Why a separate repo?

- **No history pollution** — the user's own commits are untouched.
- **Tracks untracked files** — shadow git stages everything not excluded, including files the workspace repo ignores.
- **Survives no-git workspaces** — works even if the workspace has no `.git` at all.

---

## Key Source Files

| File                                                                                                                      | Role                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| [`src/core/checkpoints/index.ts`](../src/core/checkpoints/index.ts)                                                       | Public API: `getCheckpointService`, `checkpointSave`, `checkpointRestore`, `checkpointDiff`           |
| [`src/services/checkpoints/ShadowCheckpointService.ts`](../src/services/checkpoints/ShadowCheckpointService.ts)           | Abstract base class: `initShadowGit`, `saveCheckpoint`, `restoreCheckpoint`, `getDiff`, `getDiffStat` |
| [`src/services/checkpoints/RepoPerTaskCheckpointService.ts`](../src/services/checkpoints/RepoPerTaskCheckpointService.ts) | Concrete subclass; `static create()` factory wires the per-task path                                  |
| [`src/services/checkpoints/excludes.ts`](../src/services/checkpoints/excludes.ts)                                         | `getExcludePatterns(workspaceDir)` — builds `.git/info/exclude` content                               |
| [`src/services/checkpoints/types.ts`](../src/services/checkpoints/types.ts)                                               | `CheckpointDiff`, `CheckpointDiffStat`, `CheckpointServiceOptions`, `CheckpointEventMap`              |

---

## Initialization Flow

`getCheckpointService(task)` is called at the start of every task loop iteration (from `initiateTaskLoop` in `Task.ts`). It is lazy and idempotent:

```
getCheckpointService(task)
  → task.enableCheckpoints? No → return undefined
  → task.checkpointService already set? → return it
  → workspaceDir available? No → disable, return undefined
  → globalStorageDir available? No → disable, return undefined
  → task.checkpointServiceInitializing?
      → pWaitFor(task.checkpointService?.isInitialized, timeout=checkpointTimeout)
      → timeout → sendCheckpointInitWarn(INIT_TIMEOUT), disable, return undefined
      → resolved → return task.checkpointService
  → create RepoPerTaskCheckpointService
  → task.checkpointServiceInitializing = true
  → checkGitInstallation(task, service)
      → git not installed → showWarningMessage, disable, return
      → service.on("initialize") → clears checkpointServiceInitializing
      → service.on("checkpoint") → posts currentCheckpointUpdated to webview, task.say("checkpoint_saved")
      → service.initShadowGit()
  → task.checkpointService = service
  → return service
```

The `pWaitFor` guard handles the race where a tool calls `getCheckpointService` a second time before the first `initShadowGit` has emitted `"initialize"`.

### Concurrency and Timeouts

- **`checkpointTimeout`** (from task settings, default configurable) — maximum time to wait for init before giving up.
- **`WARNING_THRESHOLD_MS = 5000`** — after 5 s of waiting, a `checkpointInitWarning` message (`WAIT_TIMEOUT`) is posted to the webview so the user sees a spinner caption.
- On timeout a second warning (`INIT_TIMEOUT`) is posted, `enableCheckpoints` is set to `false`, and `undefined` is returned — the task continues without checkpoints.

---

## `initShadowGit()` in Detail

`ShadowCheckpointService.initShadowGit()` is the core setup step:

1. **Diagnostic nested-git scan** — calls `getNestedGitRepository()` (ripgrep search for `**/.git/HEAD`). If ripgrep is absent or the search fails, the error is caught and `null` is returned. The result is **log-only** — it does not gate initialization.

2. **Create shadow directory** — `fs.mkdir(checkpointsDir, { recursive: true })`.

3. **Create sanitized git instance** — `createSanitizedGit(checkpointsDir)` strips inherited git environment variables (`GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_OBJECT_DIRECTORY`, `GIT_ALTERNATE_OBJECT_DIRECTORIES`, `GIT_CEILING_DIRECTORIES`, `GIT_TEMPLATE_DIR`) and then sets `GIT_DIR` to the shadow repo's `.git` directory. Setting `GIT_DIR` alone (without `GIT_WORK_TREE`) is the key design choice: it prevents git from discovering nested `.git` directories in the workspace as submodules, while leaving `core.worktree` in control of the working tree so `git add .` still stages workspace files correctly.

4. **First run** (no `.git` yet):

    - `git init --template=""`
    - `git config core.worktree <worktreeTarget>` (workspace root, or scoped worktree dir for embedded worktree tasks)
    - `git config commit.gpgSign false`
    - Write `.git/info/exclude` (see Exclude Patterns below)
    - `git add . --ignore-errors`
    - `git commit --allow-empty -m "initial commit"` → records `baseHash`

5. **Subsequent runs** (shadow repo already exists):

    - Verify `core.worktree` still matches the expected target (guards against workspace relocation)
    - Re-write `.git/info/exclude` (LFS patterns may have changed)
    - Read `HEAD` as `baseHash`

6. **Emit `"initialize"`** — clears `task.checkpointServiceInitializing` via the listener registered in `getCheckpointService`.

---

## Saving Checkpoints

`checkpointSave(task, force?, suppressMessage?)` is called:

- Before every file-mutating tool execution (`checkpointSaveAndMark` in `presentAssistantMessage.ts`).
- On `force=true` to create an empty baseline commit even if no files changed.

Internally: `git add . --ignore-errors` → `git commit -m "Task: <taskId>, Time: <epoch>"`. If git reports nothing to commit, `saveCheckpoint` returns `undefined` (not an error). On success the service emits `"checkpoint"` with `{ fromHash, toHash, suppressMessage }`.

The `suppressMessage` flag lets callers suppress the `checkpoint_saved` chat bubble (used for automatic pre-tool checkpoints that would otherwise flood the chat).

---

## Restoring Checkpoints

`checkpointRestore(task, { ts, commitHash, mode, operation })`:

1. Calls `service.restoreCheckpoint(commitHash)` — `git clean -f -d -f` then `git reset --hard <hash>`.
2. Posts `currentCheckpointUpdated` to the webview.
3. If `mode === "restore"`: collects token/cost metrics from messages that will be deleted, calls `task.messageManager.rewindToTimestamp(ts)` to truncate chat history, then posts an `api_req_deleted` message.
4. Calls `provider.cancelTask()` to restart the task loop against the rewound history.

The `operation` field (`"delete"` or `"edit"`) controls whether the target message itself is included in the rewind via `rewindToTimestamp`'s `includeTargetMessage` option.

---

## Diffing

`checkpointDiff(task, { ts, previousCommitHash, commitHash, mode })` supports four comparison modes:

| Mode           | `from`           | `to`                       |
| -------------- | ---------------- | -------------------------- |
| `"from-init"`  | first checkpoint | `commitHash`               |
| `"checkpoint"` | `commitHash`     | next checkpoint in history |
| `"to-current"` | `commitHash`     | working tree               |
| `"full"`       | first checkpoint | working tree               |

The diff is rendered via `vscode.commands.executeCommand("vscode.changes", title, [...])`, which opens VS Code's native multi-file diff viewer.

`getDiff()` stages the workspace (`git add . --ignore-errors`) before diffing so untracked files appear. `getDiffStat()` does the same and returns per-file `{ insertions, deletions, binary }` without loading file contents.

---

## Exclude Patterns

`getExcludePatterns(workspaceDir)` in `excludes.ts` builds the content of `.git/info/exclude` (local to the shadow repo, never shared with the user's own `.gitignore`). It merges:

- **Build artifacts** — `.gradle/`, `node_modules/`, `dist/`, `build/`, `target/`, etc.
- **Media files** — `*.jpg`, `*.png`, `*.mp4`, `*.gif`, etc.
- **Cache/temp files** — `*.log`, `*.tmp`, `*.swp`, `*.lock`, etc.
- **Config files** — `*.env*`, `*.local`, `*.production`, etc.
- **Large data files** — `*.zip`, `*.tar`, `*.gz`, `*.exe`, `*.dll`, etc.
- **Database files** — `*.sqlite`, `*.db`, `*.sql`, `*.parquet`, etc.
- **LFS patterns** — read dynamically from `.gitattributes` (`filter=lfs` lines); ensures LFS pointer files (not content) are excluded.

For non-scoped shadow gits (main-branch tasks), `/.shofer/worktrees/` is also appended so sibling embedded worktree directories are not checkpointed by the main task.

---

## Nested Git Repositories

The workspace may contain nested `.git` directories or `.git` files (submodules, child clones, git worktrees). Without `GIT_DIR` isolation, `git add .` in the shadow repo would record these as gitlinks (mode `160000`) — silently incomplete checkpoints that don't capture the nested repo's file contents.

`createSanitizedGit` sets `GIT_DIR` to the shadow repo's `.git`, telling git it is the only repository. Git never scans for nested repos during staging; source files inside submodules are tracked directly as regular files. All four nested-repo variants (regular clone, absorbed submodule, gitdir-pointer submodule, git worktree) are protected by this mechanism.

`getNestedGitRepository()` (ripgrep scan for `**/.git/HEAD`) is diagnostic-only — result is logged, does not gate initialization, and ripgrep failure is silently ignored.

See [`submodule-support.md`](submodule-support.md) for the full investigation, approaches tried, and implementation rationale.

### Submodule HEAD Pointer

Checkpoint restore returns file contents on disk to a prior state but does **not** restore which commit a submodule was pointing to. If the agent checked out a different submodule revision, that pointer is not rolled back by `git reset --hard`.

---

## Scoped Worktrees

For **embedded worktree tasks** (tasks whose `cwd` is a subdirectory under `.shofer/worktrees/<name>/`), `getCheckpointService` passes `scopedWorktreeDir = task.cwd` to `RepoPerTaskCheckpointService.create()`. The shadow git's `core.worktree` is then set to the worktree subdirectory, so:

- Checkpoints only capture files within the worktree — not sibling worktrees or the main working tree.
- The worktree directory path is validated on reconnect (subsequent `initShadowGit` calls).

Non-scoped shadow gits (main-branch tasks) exclude `/.shofer/worktrees/` via the exclude file to prevent cross-contamination.

See [`worktrees.md`](worktrees.md#4-checkpoint-isolation-srcservicescheckpoints) for the full scoping table.

---

## Storage Layout

```
~/.config/Code/User/globalStorage/shofer.dev/
  tasks/<taskId>/checkpoints/
    .git/
      config          ← core.worktree, commit.gpgSign, user.name/email
      info/
        exclude       ← merged exclude patterns (rebuilt on every init)
      objects/        ← shadow git object store
      refs/
```

The shadow repo is keyed by `taskId`, not by workspace path. Each task gets its own independent shadow repo, so two concurrent tasks in the same workspace do not share checkpoint history.

---

## Checkpoint Events

`ShadowCheckpointService` extends `EventEmitter` with a typed `CheckpointEventMap`:

| Event          | Payload                                           | When                                               |
| -------------- | ------------------------------------------------- | -------------------------------------------------- |
| `"initialize"` | `{ workspaceDir, baseHash, created, duration }`   | After `initShadowGit` completes                    |
| `"checkpoint"` | `{ fromHash, toHash, duration, suppressMessage }` | After a successful `saveCheckpoint`                |
| `"restore"`    | `{ commitHash, duration }`                        | After a successful `restoreCheckpoint`             |
| `"error"`      | `{ error }`                                       | On `saveCheckpoint` or `restoreCheckpoint` failure |

`getCheckpointService` registers listeners for `"initialize"` (clears `checkpointServiceInitializing`) and `"checkpoint"` (posts `currentCheckpointUpdated` to the webview and calls `task.say("checkpoint_saved", ...)`).

---

## Webview Integration

| Direction           | Message type                                      | Meaning                                                                         |
| ------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------- |
| Extension → Webview | `checkpointInitWarning`                           | Init taking longer than expected (`WAIT_TIMEOUT`) or timed out (`INIT_TIMEOUT`) |
| Extension → Webview | `currentCheckpointUpdated`                        | A new checkpoint hash is now current                                            |
| Webview → Extension | `checkpointDiff`                                  | User clicked "Show diff" on a checkpoint bubble                                 |
| Webview → Extension | `checkpointRestore` (via webview message handler) | User clicked "Restore"                                                          |

---

## Disabling Checkpoints

`task.enableCheckpoints` starts as the user-configured setting value. It is set to `false` (disabling checkpoints for the rest of the task) on:

- No workspace folder found
- No `globalStorageDir`
- Git not installed (shows `showWarningMessage` with link to git-scm.com)
- `initShadowGit()` throws
- `saveCheckpoint` throws (caught in `checkpointSave`)
- `restoreCheckpoint` or `getDiff` throws (caught in `checkpointRestore`/`checkpointDiff`)
- `pWaitFor` timeout waiting for init to complete

In all cases Shofer continues operating normally — checkpoints are a best-effort feature.

---

## Relationship to File Changes Panel

The **File Changes Panel** ([`ChangedFilesService`](../src/core/file-changes/ChangedFilesService.ts)) is a completely separate system:

| Aspect         | Checkpoints (shadow git)                   | File Changes Panel (working-directory)                              |
| -------------- | ------------------------------------------ | ------------------------------------------------------------------- |
| Purpose        | Full workspace rollback to any prior state | Per-file diff/revert/redo of Shofer's edits                         |
| Backend        | Shadow git repo (git commits)              | Verbatim file copies under `<taskDir>/base/` and `<taskDir>/final/` |
| Git dependency | Yes (git must be installed)                | None                                                                |
| Scope          | All workspace files (except excluded)      | Only files Shofer explicitly edited                                 |
| Revert         | `git reset --hard <hash>`                  | Restore `base/<relPath>` to disk                                    |

They do not share a backend and operate independently.

---

## Prerequisites

| Requirement                | Effect if absent                                                               |
| -------------------------- | ------------------------------------------------------------------------------ |
| Git installed              | `checkGitInstalled()` fails → checkpoints disabled, `showWarningMessage` shown |
| VS Code `globalStorageUri` | No shadow dir → checkpoints disabled                                           |
| Open workspace folder      | No `workspaceDir` → checkpoints disabled                                       |
| ripgrep                    | `getNestedGitRepository()` fails silently → log line only, init continues      |

---

## Key Design Decisions

**`GIT_DIR` without `GIT_WORK_TREE`** — setting only `GIT_DIR` achieves submodule isolation while letting `core.worktree` keep `git add .` working correctly from the shadow dir. Setting both `GIT_DIR` and `GIT_WORK_TREE` would break `deleteBranch`, which temporarily unsets `core.worktree` to scope `git clean -f -d` to the shadow directory. See [`submodule-support.md`](submodule-support.md) for the full investigation and approaches tried.

**`--ignore-errors` on `git add`** — `stageAll` uses `git add . --ignore-errors` so that permission errors or file-system races on individual files do not abort the entire staging operation.

**`--allow-empty` on the base commit** — `initShadowGit` creates the initial commit with `--allow-empty` so the shadow repo is always in a valid state even if the workspace is empty at task start.

**Per-task shadow repo** — keyed by `taskId` rather than workspace path. Concurrent tasks in the same workspace get independent histories. Cleanup is done by `ShadowCheckpointService.deleteTask()` (called when a task is deleted from history).

**Background `checkpointSave`** — `checkpointSave` launches `saveCheckpoint` as a floating Promise (`.catch` only, no `await`). This keeps tool execution latency from growing with checkpoint size. The `allowEmpty: force` option is used for forced baseline commits.

---

## Source File Map

```
src/
  core/checkpoints/
    index.ts                    ← public API (getCheckpointService, checkpointSave, checkpointRestore, checkpointDiff)
  services/checkpoints/
    ShadowCheckpointService.ts  ← abstract base (shadow git ops)
    RepoPerTaskCheckpointService.ts ← concrete per-task subclass
    excludes.ts                 ← .git/info/exclude pattern builder
    types.ts                    ← CheckpointDiff, CheckpointDiffStat, CheckpointServiceOptions, CheckpointEventMap
    index.ts                    ← barrel: exports RepoPerTaskCheckpointService + CheckpointServiceOptions
    __tests__/
      ShadowCheckpointService.spec.ts ← vitest suite (uses RepoPerTaskCheckpointService directly)
```

## Related Documentation

- [`submodule-support.md`](submodule-support.md) — detailed investigation of the nested-git / `GIT_DIR` fix
- [`worktrees.md`](worktrees.md) — embedded worktree checkpoint scoping
- [`file-change-tracking.md`](file-change-tracking.md) — File Changes Panel (separate from checkpoints)
