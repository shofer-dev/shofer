# Submodule & Nested Git Repository Support

## Symptom

```
Checkpoints are disabled because a nested git repository was detected at: shofer.dev.
To use checkpoints, please remove or relocate this nested git repository.
```

## How Checkpoints Work

Shofer implements checkpoints via a **shadow git repository**
([`ShadowCheckpointService`](../src/services/checkpoints/ShadowCheckpointService.ts)):

1. A separate `.git` directory is created **outside** the workspace (in a checkpoints directory)
2. The shadow git's `core.worktree` is set to the user's actual workspace directory
3. When checkpointing, `git add .` stages all workspace files into the shadow repo, then commits

```
┌─────────────────────────────────┐     ┌──────────────────────────────────┐
│  User Workspace                 │     │  Shadow Git Repo                 │
│  /home/user/project/            │     │  ~/.shofer-code/checkpoints/        │
│  ├── src/                       │     │  task-123/.git/                  │
│  ├── .git/           ◄──────────│──── │  core.worktree = workspace dir   │
│  └── extensions/                │     │                                  │
│      └── submodule/             │     │  git add .  → stages workspace   │
│          ├── .git  (submodule)  │     │  git commit → checkpoint saved   │
│          └── code.ts            │     └──────────────────────────────────┘
└─────────────────────────────────┘
```

## Why Nested Git Repositories Break Checkpoints

Git's fundamental rule: a nested `.git` directory **or** a `.git` file pointing to another repo
is treated as a **submodule**. When the shadow git runs `git add .`:

- Files **inside** the nested repo are **not** tracked by their content
- Only a **gitlink** (a mode `160000` entry / SHA reference) is recorded
- Restoring the checkpoint would **not** recover the actual file contents of the nested repo

This produces **silently incomplete** checkpoints — they look valid but don't capture the
nested repo's state. The original code chose to **fail explicitly** rather than produce
misleading checkpoints.

### Detection Gaps

The detection (`**/.git/HEAD` via ripgrep) only finds **nested `.git` directories**.
It does **not** detect:

- **Submodule `.git` files** — git submodules use a file containing `gitdir: <path>` instead
  of a `.git` directory. There is no `HEAD` inside, so ripgrep won't find it.
- **Worktree `.git` files** — `git worktree add` creates `.git` files, not directories.

| Variant                    | On-disk           | Contains `HEAD`? | Detected? |
| -------------------------- | ----------------- | ---------------- | --------- |
| Regular clone              | `.git/` directory | yes              | ✅        |
| Submodule (absorbed)       | `.git/` directory | yes              | ✅        |
| Submodule (gitdir pointer) | `.git` file       | no               | ❌        |
| Git worktree               | `.git` file       | no               | ❌        |

### Our Specific Trigger

The file [`extensions/shofer/.git`](../../extensions/shofer/.git) contains:

```
gitdir: ../../.git/modules/shofer
```

This makes `extensions/shofer` a **git submodule** of the parent repository.
The actual git data lives at `.git/modules/Shofer/`.

Since the submodule's `.git` is a **file** (not a directory), the `**/.git/HEAD` search
wouldn't normally find it. However, the actual git data at `.git/modules/Shofer/HEAD`
may be matched depending on path structure.

## Investigation (2026-05-08)

### Constraint

The workspace filesystem is shared across multiple VS Code sessions running independently.
Any solution that modifies the workspace filesystem (e.g. temporarily renaming nested `.git`
directories) is rejected — it would interfere with other sessions.

### Approaches Attempted

#### 1. Exclude patterns alone ❌

Add `.git` (bare) to `.git/info/exclude` alongside `.git/` to prevent git from tracking
nested repo metadata.

**Does not work.** Git's `.git/info/exclude` and `.gitignore` rules control _tracking_ —
they tell git which files to ignore when staging. However, git detects submodules
independently during filesystem walks. When git sees a nested `.git/` directory, it treats
the parent directory as a submodule and records a gitlink (mode `160000`) — regardless of
ignore/exclude rules.

Test confirmation: with `.git/` and `.git` in the exclude file, `git add .` still created
gitlinks for nested repos. `getDiffStat()` did not report files inside the nested repo as
individual entries.

#### 2. `GIT_DIR` environment variable ⚠️

Set `GIT_DIR` to the shadow repo's `.git` directory. This tells git "this is the ONLY repo"
and prevents submodule discovery.

**Logically correct, but breaks `git add .`.** The shadow git runs commands from the shadow
directory (via simple-git's `baseDir`), but `core.worktree` points to the workspace. With
`GIT_DIR` set, `git add .` resolves `.` relative to the CWD (shadow dir), which is outside
the working tree (workspace). Git refuses to add from outside the working tree. All 34 tests
failed — `saveCheckpoint()` returned `undefined` because no files were staged.

If `GIT_WORK_TREE` is also set to the workspace, the issue is resolved. However, adding
`GIT_WORK_TREE` created risk for `deleteBranch`, which temporarily unsets `core.worktree`
and runs `git clean -f -d`. With `GIT_WORK_TREE` still set to workspace, this would clean
the workspace instead of the shadow dir.

#### 3. Separate staging git with `GIT_DIR` + workspace baseDir ⚠️

Create a temporary SimpleGit instance for staging only, with `baseDir = workspaceDir` and
`GIT_DIR = shadow .git`.

**Still fails.** The new SimpleGit instance runs from the workspace directory successfully,
but it does NOT inherit the shadow git's `core.worktree` config (stored in the shadow repo's
git config file). Git discovers the workspace's own `.git` directory instead of the shadow's,
causing `git add` to target the wrong repository.

#### 4. Pathspec exclusions (`:!.git`) ❌

Use `git add . :!.git :!**/.git` to exclude `.git` paths at the pathspec level.

**Same limitation as exclude patterns.** Pathspecs only filter what gets staged, they don't
prevent submodule detection during the filesystem walk.

## Implemented Fix: `GIT_DIR` without `GIT_WORK_TREE`

The working solution sets `GIT_DIR` to the shadow repo's `.git` directory in
[`createSanitizedGit`](../src/services/checkpoints/ShadowCheckpointService.ts), but does
**not** set `GIT_WORK_TREE`.

`core.worktree` (set during `initShadowGit`) overrides `GIT_WORK_TREE` during normal
operation, so the working tree is correctly the workspace. Crucially, the existing code
already works with `core.worktree` + `git add .` from the shadow CWD — git resolves paths
relative to the working tree when `core.worktree` is set. Setting only `GIT_DIR` adds
submodule isolation without changing path resolution.

When `deleteBranch` temporarily unsets `core.worktree`, git falls back to CWD (the shadow
directory) rather than the workspace — keeping `git clean -f -d` safe.

### Changes

| File                                                                                                       | Change                                                                                                                  |
| ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| [`ShadowCheckpointService.ts`](../src/services/checkpoints/ShadowCheckpointService.ts)                     | Set `GIT_DIR` in `createSanitizedGit`; replace throw with log in `initShadowGit`; remove unused `vscode`/`i18n` imports |
| [`ShadowCheckpointService.spec.ts`](../src/services/checkpoints/__tests__/ShadowCheckpointService.spec.ts) | Test "throws error" → "succeeds" (nested git no longer blocks init)                                                     |

## Impact on File Changes Panel

The File Changes Panel ([`ChangedFilesService`](../src/core/file-changes/ChangedFilesService.ts))
uses a single per-task working-directory backend with **no git dependency**. It stores
verbatim file copies under `<taskDir>/base/<relPath>` (original state at first edit)
and `<taskDir>/final/<relPath>` (last Shofer-produced state, for Redo).

The backend is independent of the shadow-git checkpoint service — it works identically
in every workspace type, whether or not a git repo exists and whether or not nested
`.git` directories are present. The file list is driven by [`FileContextTracker`](../src/core/context-tracking/FileContextTracker.ts),
which records every file Shofer edits via `getFilesEditedByRoo()`.

Checkpoints (shadow git) and file-changes (per-task working directory) serve different
purposes and do not share a backend. The nested-git fix described above enables the
shadow-git checkpoint service to operate in submodule-heavy workspaces, but that has no
bearing on the file-changes panel — it always used the working-directory backend.

| Aspect            | Description                                                     |
| ----------------- | --------------------------------------------------------------- |
| Backend           | per-task working-directory (`base/` + `final/` copies)          |
| Git dependency    | none                                                            |
| Diff computation  | unified-diff of base copy vs. current disk content              |
| Revert (per-file) | restore `base/<relPath>` to workspace (or delete if was absent) |
| Redo (per-file)   | restore `final/<relPath>` to workspace                          |
| Revert-all        | iterate `restoreFile` over candidate set                        |
| Accept            | promote current disk content as new baseline, clear final copy  |

## References

- [`ShadowCheckpointService.ts`](../src/services/checkpoints/ShadowCheckpointService.ts) — checkpoint implementation
- [`ChangedFilesService.ts`](../src/core/file-changes/ChangedFilesService.ts) — file changes panel backend selection
- [`FileContextTracker.ts`](../src/core/context-tracking/FileContextTracker.ts) — per-task file snapshots
- [`extensions/shofer/.git`](../../extensions/shofer/.git) — our submodule trigger (`gitdir: ../../.git/modules/shofer`)
