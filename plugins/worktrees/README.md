# Worktrees

Parallel work on branches, without juggling windows.

A git worktree is a second checkout of the same repository on another branch. This
plugin puts them **inside** the workspace — `<workspace>/.shofer/worktrees/<name>/` —
and gives every task its own, so two agents working at once never edit the same files.

Bundled with Shofer and **enabled by default**: it is a shipped feature, not an add-on.
Disable it in Settings → Plugins and tasks simply run in the workspace, as they would
in an editor with no worktree support at all.

## What you get

| Surface                           | What it does                                                                                                |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| The branch chip in the chat input | Shows the branch the task is on, its status, and lets you pick or create the worktree the next task runs in |
| Settings → Plugins → Worktrees    | The full list: create, delete, and the `.shofer/worktreeinclude` status                                     |
| `/merge-worktree` & friends       | Six slash commands for merging, rebasing and cleaning up a finished worktree                                |
| Placement                         | A task you start without picking anything gets a fresh worktree on a new branch off HEAD                    |

## Everyday use

**Just send a message.** The task gets `shofer-<random>` — a branch, a directory and a
label sharing one name — branched from your current HEAD. Work happens there; your
checkout is untouched.

**Create one on purpose.** "Create new worktree…" in the branch chip opens a new, empty
task already running in the new checkout — type into it and the work happens there. (On a
workflow that has not started yet, the workflow is re-pointed instead of a second task
being opened.)

**Pick where it runs.** Click the branch chip before sending: choose an existing
worktree, or the workspace itself ("current branch") to opt out of isolation for that
task. Choosing nothing means a fresh worktree.

**Finish up.** In the task that did the work:

| Command                    | What it does                                                |
| -------------------------- | ----------------------------------------------------------- |
| `/merge-worktree`          | Merge the branch into base with a merge commit              |
| `/merge-worktree-cleanup`  | …then delete the branch and remove the worktree             |
| `/rebase-worktree`         | Rebase onto base and fast-forward merge                     |
| `/rebase-worktree-cleanup` | …then delete the branch and remove the worktree             |
| `/dryrun-rebase-worktree`  | Show the conflicts a rebase would produce, changing nothing |
| `/worktree-status`         | Ahead/behind, uncommitted changes, merge readiness          |

All of them auto-detect the base branch (`main`, else `master`), attempt conflict
auto-resolution but **bail out on anything ambiguous** rather than guess, and **never
push**.

Because this plugin is bundled and first-party, these keep their bare names — you type
`/merge-worktree`, not `/worktrees:merge-worktree` — and a `.shofer/commands/merge-worktree.md`
in your project still overrides them.

## `.shofer/worktreeinclude`

A fresh worktree contains only what the branch tracks — no `node_modules`, no `.env`,
so it may not build. List those paths in `.shofer/worktreeinclude` (one per line,
`.gitignore` syntax) and they are copied into every new worktree.

Only paths that are **also** matched by `.gitignore` are copied. That intersection is
deliberate: copying a tracked file would duplicate it into a second checkout and
produce a merge conflict later. The Settings panel offers to seed the file from your
`.gitignore` when it does not exist yet.

## Settings

The plugin has no settings of its own. Each create dialog offers:

- **Initialize submodules** (on by default) — runs `git submodule update --init --depth 1`
  in the new worktree. If it fails, the worktree is torn down rather than left
  half-built.
- **Copy files per worktreeinclude** (on by default) — the copy described above.

## Requirements

A single-root workspace opened at the git repository root (or at one of the plugin's own
embedded worktrees). A multi-root window, a non-git folder, or a subfolder of a
repository disables the feature and says which of those it is — each has a different fix,
and an empty list would tell you none of them.

## Files

| Path                      | What it is                                                            |
| ------------------------- | --------------------------------------------------------------------- |
| `src/main.ts`             | The plugin entry: request surface, placement, the create/seed flow    |
| `src/worktree-service.ts` | `git worktree` operations (list/create/delete/branches/checkout)      |
| `src/worktree-include.ts` | The `.shofer/worktreeinclude` intersection copy, with progress        |
| `src/worktree-status.ts`  | The ahead/behind + merge-readiness report                             |
| `ui/indicator.tsx`        | The chat-input chip (built to `ui/indicator.js`)                      |
| `ui/settings.tsx`         | The Settings panel (built to `ui/settings.js`)                        |
| `ui/shared.tsx`           | The create/delete dialogs and the host API both bundles use           |
| `commands/*.md`           | The six slash commands                                                |
| `locales/en.json`         | UI strings, resolved through the host's i18next as `plugin:worktrees` |

Build the UI bundles with `node build-ui.mjs` (the extension bundle runs this
automatically). Typecheck the plugin standalone with `npx tsgo -p plugins/worktrees`.
Run its unit tests from `packages/core` (they live in `__tests__/`), and the integration
test that loads this plugin off disk with
`npx vitest run src/plugins/__tests__/worktrees-plugin.spec.ts`.

## See also

- [`DESIGN.md`](./DESIGN.md) — why the split with core looks the way it does
- [`TODO.md`](./TODO.md) — what this does not do
- [`plugins/worktrees/DESIGN.md`](DESIGN.md) — the core-side view:
  the seams, and the safety properties core keeps regardless of this plugin
