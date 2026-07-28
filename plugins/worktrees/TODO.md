# Worktrees — known gaps

What this plugin knowingly does not do, and what the move out of core cost.

## Reduced from the built-in version

- **The Settings panel lives under Settings → Plugins**, not its own top-level tab. The
  `settings-tab` region is where plugin settings mount; a plugin cannot add a tab to the
  Settings rail.
- **No polling.** The old view re-listed every 3 seconds. The panel now refreshes when it
  mounts and after each of its own operations. A worktree created outside Shofer shows up
  the next time the panel is opened.
- **The launcher no longer forwards a pick.** Launching a workflow used to send the chosen
  worktree with the `createWorkflow` message. It now goes through the same placement
  broadcast as any other task, which reads the same pending pick — the observable
  behaviour is unchanged, but a workflow started from a window that never opened the chip
  now gets the auto-create default rather than the workspace.

## Not implemented

- **`.shofer/worktreeinclude` is intersection-only.** A path is copied only if it matches
  BOTH `worktreeinclude` and `.gitignore`. Copying a tracked file would duplicate it into
  a second checkout and surface as a merge conflict later, so the restriction is
  deliberate — but it means a file that is neither tracked nor ignored (rare, but
  possible) cannot be copied at all.
- **Submodule init is `--depth 1`, always.** No setting; a repository whose submodules
  need full history has to run `git submodule update` itself in the new worktree.
- **No sync of `worktreeinclude` into existing worktrees.** The copy happens at creation.
  A `node_modules` that appears afterwards in the main checkout does not propagate.
- **No public API.** Everything is reachable from the UI, the slash commands, and core's
  placement question. Nothing is exposed to other extensions.

## Headless

- **The UI is webview-only, by nature.** On `shofer serve` there is no branch chip and no
  Settings panel, and the `worktrees:step` / `worktrees:copy-progress` pushes have nowhere
  to land. Everything that decides behaviour — placement, creation, seeding, the slash
  commands — runs there; what is missing is chrome, not function.
- **A headless task cannot be re-pointed interactively.** `set-task-cwd` is driven from
  the chip. The seam itself works headless; nothing calls it there.

## Depends on core

- **Path confinement and the `execute_command` sandbox live in core** and key off
  `task.cwd`. That is intentional (see [`DESIGN.md`](./DESIGN.md) §2), but it means a
  worktree's _isolation_ is not this plugin's to guarantee: disabling the plugin does not
  weaken confinement, and a bug in core's guard is not fixable here.
- **`ctx.task.setCwd` is the only way to move an existing task**, and the host refuses
  once a workflow has started. There is no way to move a task that has already written
  files, and there should not be.

## Transition shims

- **The legacy `.shofer/worktrees/` prefix is still recognised** — by core's
  `isEmbeddedWorktreeTask()` and by this plugin's `list`/`delete` — so worktrees created
  before the move to `<workspace>/.worktrees/` keep their confinement and stay
  manageable. Nothing creates them there. Remove the legacy branch (here, in
  `packages/types/src/worktrees.ts`, in `worktreePathGuard.ts`, in `FindFilesTool` and in
  the checkpoints exclusion) in a later release.
