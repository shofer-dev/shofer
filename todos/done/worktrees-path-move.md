# Proposal: move embedded worktrees out of `.shofer/`

> **Status: implemented.** Both decisions were taken as proposed: the new
> top-level `<workspace>/.worktrees/` (not the "exempt from `PROTECTED_PATTERNS`"
> alternative), and the old-path shim stays for one release. What remains is
> removing that shim — tracked in
> [`plugins/worktrees/TODO.md`](../../plugins/worktrees/TODO.md).

## The change

Embedded worktrees move from

```
<workspace>/.shofer/worktrees/<name>/     →   <workspace>/.worktrees/<name>/
```

one level up, still inside the opened workspace folder. The embedded model
([`plugins/worktrees/DESIGN.md`](../../plugins/worktrees/DESIGN.md) §3) is unchanged:
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
[`plugins/worktrees/DESIGN.md`](../../plugins/worktrees/DESIGN.md) §5 keeps in core so
that "a safety property a user can remove by disabling a plugin is not a safety
property".

## Shape of the change

1. **One constant, shared.** The path was a copy-pasted string literal in at
   least five places; that is the real defect and the rename was the occasion to
   fix it. `EMBEDDED_WORKTREES_DIR` (`.worktrees`) lives in `@shofer/types`,
   consumed by `worktreePathGuard.ts` and `FindFilesTool.ts` and by the bundled
   plugins, which no longer spell it themselves.
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
6. **Docs** — the path appears in `README.md`, `USER_MANUAL.md`,
   `plugins/worktrees/{README,DESIGN,TODO}.md`, `plugins/live-memory/DESIGN.md`,
   `docs/native_tools.md`, `docs/shofer_special_files.md`,
   `docs/terminology.md`, `docs/worktree-shell-sandboxing.md`,
   `docs/v3_architecture.md`, `docs/integration-tests/{worktrees,special-files.scenarios}.md`,
   `src/media/walkthrough/worktrees.md` and `todos/worktree-sync.md`; all moved
   in the same change.

## Testing

- `worktreePathGuard` tests: a task at the new path **is** embedded; a task at
  the old path is still embedded while the shim stands; a task at neither is not.
- Escape attempts (`..`, absolute paths, symlinks) blocked at the new path.
- `find_files` does not return worktree contents.
- An existing `.shofer/worktrees/<name>` is still listed and deletable.

## The two decisions, as taken

1. **A new top-level `.worktrees/` is acceptable** — the proposal's preferred
   option. The alternative (keep the path, exempt `.shofer/worktrees/` from
   `PROTECTED_PATTERNS`) was rejected: it fixes reason 2 only and leaves the
   lifecycle mismatch of reason 1 in place.
2. **The old-path shim stays for one release.** `isEmbeddedWorktreeTask()`, the
   `find_files` exclusion, the checkpoints exclusion and the plugin's
   listing/deletion all still recognise `.shofer/worktrees/`; nothing creates
   there any more.

## What shipped, against the shape above

- `EMBEDDED_WORKTREES_DIR` / `LEGACY_EMBEDDED_WORKTREES_DIR` live in
  [`packages/types/src/worktrees.ts`](../../packages/types/src/worktrees.ts), not
  `@shofer/core`: the bundled plugins resolve `@shofer/types` at runtime and
  `@shofer/core` never. The checkpoints plugin, whose entry is a pre-built bundle,
  imports the module by source path so its 200 KB bundle does not swallow the
  `@shofer/types` barrel.
- The consumer table was right about core and the `worktrees` / `checkpoints`
  plugins. Two corrections: **live-memory** filtered worktrees only incidentally
  (via its `.shofer` prefix skip), so it needed a new `.worktrees` entry in
  `SKIP_PARTS` and in `notifyFileModified`; and **`plugins/checkpoints/DESIGN.md`**
  never named the path, so there was nothing to update there.

## Why it is being raised now

The arkware deployment builds a plugin (`arkware-worktrees`) that replaces this
one's creation mechanics with copy-on-write mirrors, and it wants the same path
(its rationale: `shofer-plugins/arkware-worktrees/DESIGN.md` §4.1, in the
integrator's repo). It cannot move on its own — the guard above is core's — so
either both move or neither does.
