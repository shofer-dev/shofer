/**
 * Embedded-worktree location — the one place the directory name is spelled.
 *
 * Shofer's worktree model is *embedded*: a per-task git worktree lives inside the
 * opened workspace folder, so several tasks work on different branches in one
 * window. The directory that holds them is a cross-cutting constant rather than a
 * plugin convention, because core depends on it for a **safety** property: a task
 * whose `cwd` is under it is path-confined (`validateWorktreePath`) and, on Linux,
 * shell-sandboxed. A consumer that spells the name itself and drifts loses that
 * confinement silently, which is why every consumer — core's guard and file tools,
 * and the bundled `worktrees`, `checkpoints` and `live-memory` plugins — imports
 * these constants instead.
 *
 * It lives in `@shofer/types` (the lowest layer) rather than `@shofer/core` so the
 * bundled plugins, which resolve `@shofer/types` at runtime but never `@shofer/core`,
 * can import it too.
 */

/**
 * Directory holding embedded worktrees, relative to the workspace root:
 * `<workspace>/.worktrees/<name>/`.
 *
 * Deliberately NOT under `.shofer/`: that directory is committed configuration
 * (modes, rules, commands, `mcp.json`) and is write-protected wholesale by
 * `PROTECTED_PATTERNS`, whereas worktrees are bulky, machine-local, throwaway
 * checkouts with the opposite lifecycle.
 */
export const EMBEDDED_WORKTREES_DIR = ".worktrees"

/**
 * The previous location, `<workspace>/.shofer/worktrees/<name>/`.
 *
 * **Transition shim — remove in a later release.** It is recognised (never created)
 * so worktrees a user already has keep their path confinement and shell sandbox.
 * Dropping it early would not raise an error: `isEmbeddedWorktreeTask()` would
 * simply answer "not a worktree", and both safety properties would disappear
 * silently — which is why this outlives the usual "no backward compatibility" rule.
 *
 * Written with a forward slash; `path.join` normalises it on every platform.
 */
export const LEGACY_EMBEDDED_WORKTREES_DIR = ".shofer/worktrees"
