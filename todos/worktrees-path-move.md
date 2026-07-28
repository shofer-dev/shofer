# Proposal: move embedded worktrees out of `.shofer/`

> **Status: proposed, nothing implemented.** Written for review. It changes a
> **user-visible path** and touches a **safety property**, so it should not be
> started before the two decisions at the end are made.

## The change

Embedded worktrees move from

```
<workspace>/.shofer/worktrees/<name>/     →   <workspace>/.worktrees/<name>/
```

one level up, still inside the opened workspace folder. The embedded model
([`plugins/worktrees/DESIGN.md`](../plugins/worktrees/DESIGN.md) §3) is unchanged:
worktrees stay in the window the user already has open, which is what makes
parallel agents, in-window task switching and merge-back work without a second
window.

## Why

1. **`.shofer/` is committed configuration.** It holds modes, rules, commands,
   skills and `mcp.json` — files a team checks in. Worktrees are bulky,
   machine-local, throwaway checkouts. The only thing keeping them out of git is
   an entry the plugin appends to `.gitignore`; the two kinds of content have
   opposite lifecycles and do not belong in one directory.
2. **Everything under `.shofer/` is write-protected.** `PROTECTED_PATTERNS` in
   `ShoferProtectedController` covers the whole directory. The controller is
   rooted at the _task's_ cwd, so a task inside a worktree is unaffected — but a
   task running at the workspace root sees every other worktree's files as
   protected, and every write to them raises the shield marker and an approval.
   Moving one level up removes that entirely.
3. **It removes a coincidence.** `.shofer/worktrees/` reads as "Shofer config
   about worktrees" when it is in fact "N complete checkouts of this repository".

## Why this is not a plugin-local change

The path is a **core constant**, not a plugin convention, and one of its
consumers is a safety property:

| Consumer                   | File                                           | What breaks if the plugin moves alone                                                                                    |
| -------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `isEmbeddedWorktreeTask()` | `packages/core/src/utils/worktreePathGuard.ts` | Hardcodes `path.join(workspace, ".shofer", "worktrees") + sep`. Anything outside it is "not a worktree".                 |
| `validateWorktreePath()`   | same file                                      | Returns `null` — **no restriction** — for a non-embedded task. Mutating tools would stop being confined to the worktree. |
| `execute_command` sandbox  | same file (Landlock/bubblewrap)                | Gated on the same check; the shell sandbox silently disappears.                                                          |
| `find_files` exclusion     | `packages/core/src/tools/FindFilesTool.ts`     | Excludes `.shofer/worktrees/**`; worktrees would reappear as search noise.                                               |
| checkpoints exclusion      | `plugins/checkpoints`                          | A workspace-root task's shadow git would start capturing other tasks' worktrees.                                         |
| live-memory filters        | `plugins/live-memory`                          | Worktree files would enter the knowledge log as if they were workspace edits.                                            |

The first three matter most: they fail **silently and open**. A task in a
worktree at the new path would simply not be recognised, so confinement and the
sandbox would be absent with no error — the exact outcome
[`plugins/worktrees/DESIGN.md`](../plugins/worktrees/DESIGN.md) §5 keeps in core so
that "a safety property a user can remove by disabling a plugin is not a safety
property".

## Shape of the change

1. **One constant, exported from core.** The path is a copy-pasted string
   literal in at least five places today; that is the real defect and the rename
   is the occasion to fix it. Introduce `EMBEDDED_WORKTREES_DIR` (`.worktrees`)
   in core, consume it from `worktreePathGuard.ts` and `FindFilesTool.ts`, and
   export it so the bundled plugins stop spelling it themselves.
2. **The guard recognises both paths for one release.** Normally
   `AGENTS.md` → "No Backward Compatibility Unless Asked" would say change it and
   move on. It does not apply cleanly here: what breaks for an existing user is
   not a parse failure but the _silent_ loss of confinement and the shell sandbox
   on worktrees they already have. `isEmbeddedWorktreeTask()` should therefore
   match the old prefix as well, with a comment naming the release that drops it.
3. **The plugin creates only at the new path**, and keeps _listing_ and _deleting_
   worktrees found at either, so existing ones remain manageable rather than
   orphaned.
4. **Move the exclusions and filters** (`FindFilesTool`, checkpoints,
   live-memory) with the constant.
5. **`.gitignore` seeding** writes the new entry; the stale `.shofer/worktrees/`
   line in an existing repo is harmless and is not rewritten.
6. **Docs** — this path appears in `README.md`, `USER_MANUAL.md`,
   `plugins/worktrees/DESIGN.md`, `plugins/live-memory/DESIGN.md`,
   `plugins/checkpoints/DESIGN.md`, `docs/native_tools.md`,
   `docs/shofer_special_files.md`, `docs/worktree-shell-sandboxing.md`,
   `docs/v3_architecture.md` and `todos/worktree-sync.md`. All must move in the
   same change.

## Testing

- `worktreePathGuard` tests: a task at the new path **is** embedded; a task at
  the old path is still embedded while the shim stands; a task at neither is not.
- Escape attempts (`..`, absolute paths, symlinks) blocked at the new path.
- `find_files` does not return worktree contents.
- An existing `.shofer/worktrees/<name>` is still listed and deletable.

## Two decisions this needs

1. **Is a new top-level `.worktrees/` in every user's repository acceptable?**
   This is a product call. The counter-argument for the status quo is real:
   `.shofer/` is one directory for everything Shofer, and a second dot-directory
   in the repo root is a visible change for every existing user. If the answer is
   no, the alternative is to keep the path and instead exempt
   `.shofer/worktrees/` from `PROTECTED_PATTERNS`, which fixes reason 2 alone.
2. **How long does the old-path shim live?** Suggested: recognised by the guard
   for one minor release, named in the comment, removed in the next.

## Why it is being raised now

The arkware deployment builds a plugin (`arkware-worktrees`) that replaces this
one's creation mechanics with copy-on-write mirrors, and it wants the same path
(its rationale: `shofer-plugins/arkware-worktrees/DESIGN.md` §4.1, in the
integrator's repo). It cannot move on its own — the guard above is core's — so
either both move or neither does.
