# Worktree Shell Sandboxing (Landlock / Bubblewrap)

> **Status (verified 2026-06-10):** ✅ **Implemented in v1.6.0** — Phases 1, 2 and 4 complete;
> Phase 3 (rename_symbol) implemented but its **3 unit tests are still missing** (see checklist).
> Landed across four commits:
> `3994e7420` (wrapper binary), `86e9d56fd` (enforce sandboxing + rename isolation),
> `3e1dcd33c` (quote prefix tokens), `097bff4cb` (scope Landlock to `/dev/null` node).
>
> Implemented entry points (line numbers re-verified against current source):
> [`getWorktreeSandboxPrefix()`](extensions/shofer/src/utils/worktreePathGuard.ts:108),
> [`getWorktreeCommandWarning()`](extensions/shofer/src/utils/worktreePathGuard.ts:152) (now macOS/Windows-only),
> [`validateWorktreePath()`](extensions/shofer/src/utils/worktreePathGuard.ts:63),
> [`isEmbeddedWorktreeTask()`](extensions/shofer/src/utils/worktreePathGuard.ts:38),
> [`shellQuote()`](extensions/shofer/src/core/tools/ExecuteCommandTool.ts:29) +
> sandbox prefix application at [`ExecuteCommandTool.ts:136`](extensions/shofer/src/core/tools/ExecuteCommandTool.ts:136),
> the rename-boundary guard at [`RenameSymbolTool.ts:141`](extensions/shofer/src/core/tools/RenameSymbolTool.ts:141), and
> the wrapper binary [`sandbox/main.go`](extensions/shofer/sandbox/main.go) + [`sandbox/main_test.go`](extensions/shofer/sandbox/main_test.go).
>
> **Known gap:** the committed binary [`sandbox/shofer-sandbox`](extensions/shofer/sandbox/shofer-sandbox)
> is x86-64 / not-stripped, with no Bazel target and no `go.work` entry — arm64 deploys fail with a
> loud `ENOEXEC` (not silent degradation). Deferred to a build-system follow-up (Med 5 below).

## Goal

When an agent runs inside an embedded worktree (`task.cwd` → `<workspace>/.shofer/worktrees/<name>/`),
shell commands executed via `execute_command` must be unable to **write** outside the task's assigned
worktree directory. The current [`getWorktreeCommandWarning()`](extensions/shofer/src/utils/worktreePathGuard.ts:97)
advisory warning is a best-effort placeholder that does not prevent escape.

Additionally, `rename_symbol` (LSP rename) could escape worktree boundaries because the LSP rename
provider operates on the entire workspace. **This is now fixed** (Phase 3 ✅): in addition to the
source-file guard at [`RenameSymbolTool.execute()`](extensions/shofer/src/core/tools/RenameSymbolTool.ts:70),
the handler enumerates every affected file via `workspaceEdit.entries()` and runs each through
[`validateWorktreePath()`](extensions/shofer/src/utils/worktreePathGuard.ts:62) **before** applying the
edit; if any affected path is outside the worktree, the whole rename is blocked (strict Option A) — see
[`RenameSymbolTool.ts:139-150`](extensions/shofer/src/core/tools/RenameSymbolTool.ts:139). (Note: this is
worktree-boundary enforcement; mode-level `fileRegex` restrictions for `rename_symbol` remain
source-path-derived — see [`adding-new-tools.md`](adding-new-tools.md).)

## Design

### Write-Only Sandboxing

We only need to limit **writes**. Reads can remain unrestricted. This simplifies the sandbox
considerably — no need to maintain a system-essentials allowlist for interpreters, libraries,
config files, etc. The sandbox policy is:

```
ALLOW WRITE: <worktree-path>/**
ALLOW WRITE: <main>/.git/worktrees/<name>/**   (git metadata; auto-discovered)
ALLOW WRITE: <main>/.git/objects/**             (shared object store; auto-discovered)
ALLOW WRITE: <main>/.git/refs/**                (shared refs; auto-discovered)
ALLOW WRITE: /tmp/**              (shared; not a concern)
ALLOW WRITE: /dev/null            (for shell redirects to /dev/null)
DENY  WRITE: everything-else
READS:               unrestricted
```

> **Git metadata discovery is automatic.** In a git worktree, `.git` is a plain file containing
> `gitdir: /path/to/.git/worktrees/<name>`. The sandbox wrapper reads this file at startup,
> resolves the `gitdir` path, and also reads the `commondir` pointer inside the worktree's git
> metadata directory (typically `../..` → the main `.git` dir) to whitelist `objects/` and
> `refs/`. This means `git add`, `git commit`, `git checkout`, and other git operations work
> inside sandboxed worktree shells without any manual configuration. See
> [`resolveWorktreeGitPaths()`](extensions/shofer/src/sandbox/main.go:305).

### Mechanism: `landlock` (Linux 5.13+)

Linux Landlock is an unprivileged LSM that supports exactly this model — a process can create a
ruleset that denies writes outside a set of allowed paths. No root required. Available since
kernel 5.13 (Ubuntu 22.04+, Debian 12, Fedora 35+).

### Mechanism: `bwrap` (fallback on older kernels)

Bubblewrap creates a private mount namespace and bind-mounts the worktree as the only writable
location. Reads from the host filesystem still work because the bind-mounts are read-only.

### Integration Point: Execa Backend

The VS Code Terminal backend (`TerminalProcess.ts`) cannot be sandboxed because VS Code owns the
shell process lifecycle. We will **force the execa backend** for worktree-scoped `execute_command`
calls. This means:

- On **Linux**: use execa + landlock/bwrap wrapper → full sandboxing
- On **macOS/Windows**: keep VS Code terminal + current advisory warning (no kernel sandbox available)

The execa path is already the fallback when shell integration fails
([`ShellIntegrationError`](extensions/shofer/src/core/tools/ExecuteCommandTool.ts:25)).

**How the backend is actually selected.** In
[`executeCommandInTerminal()`](extensions/shofer/src/core/tools/ExecuteCommandTool.ts:207) the
backend is chosen by `terminalShellIntegrationDisabled ? "execa" : "vscode"`, and that flag comes
from provider state at [`ExecuteCommandTool.ts:85`](extensions/shofer/src/core/tools/ExecuteCommandTool.ts:85).
To force execa for a worktree task we pass `terminalShellIntegrationDisabled: true` into the
`ExecuteCommandOptions` for that call rather than reading it from provider state. The terminal is
then created via `TerminalRegistry.getOrCreateTerminal(workingDir, taskId, "execa")` at
[`ExecuteCommandTool.ts:374`](extensions/shofer/src/core/tools/ExecuteCommandTool.ts:374).

**Where the sandbox prefix is applied.** `ExecaTerminalProcess.run()` invokes the command with
`` execa({ shell, cwd, … })`${command}` `` at
[`ExecaTerminalProcess.ts:43`](extensions/shofer/src/integrations/terminal/ExecaTerminalProcess.ts:43).
The sandbox wrapper must be the **outermost** process so the shell itself (and any subprocess it
spawns) inherits the Landlock ruleset. The cleanest options are (a) set the execa `shell` option to
the wrapper binary so it `exec`s the real shell under restriction, or (b) rewrite `command` to
`<wrapper> /bin/sh -c '<original>'` and run without `shell: true`. Simply prepending the wrapper to
`command` while `shell: true` still holds is insufficient — the outer shell runs unrestricted and
only the wrapper's own child is sandboxed.

Note: forcing execa loses VS Code shell-integration exit-code detection;
[`ExecaTerminalProcess.run()`](extensions/shofer/src/integrations/terminal/ExecaTerminalProcess.ts:134)
emits `exitCode: 0` on success and only surfaces non-zero via `ExecaError`. A sandbox write denial
(EACCES) will therefore surface correctly as a non-zero `ExecaError`, but commands that succeed
despite a denied write will not.

### Implementation: Sandbox Wrapper Binary

A dedicated wrapper binary (Go, shipped with the extension) that:

1. Resolves the git metadata directories from the worktree's `.git` file (see `resolveWorktreeGitPaths`
   in [`main.go`](extensions/shofer/src/sandbox/main.go:305))
2. Detects whether the kernel supports landlock (≥ 5.13)
3. If landlock: creates a landlock ruleset with write-only restrictions (worktree + git metadata + `/tmp` + `/dev/null`), self-restricts, then `exec`s the target command
4. If no landlock but `bwrap` available: bind-mounts the worktree + git metadata paths + `/tmp` + `/dev/null` as writable, then `exec`s the target command
5. If neither: exits with an error (shouldn't happen on Linux)

The [`ExecuteCommandTool.ts`](extensions/shofer/src/core/tools/ExecuteCommandTool.ts) handler:

1. Checks `isEmbeddedWorktreeTask(task)`
2. If true: forces the execa backend, prepends the sandbox wrapper to the command
3. If false: uses the normal VS Code terminal backend (unchanged)

### Files Changed (as implemented)

| File                                            | Change                                                                                                                                            | Status |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `src/core/tools/ExecuteCommandTool.ts`          | Force execa + wrap command via `shellQuote()` into `<wrapper> <worktree> -- /bin/sh -c '<cmd>'`                                                   | ✅     |
| `src/utils/worktreePathGuard.ts`                | Added `getWorktreeSandboxPrefix()` (existence check + lazy output-channel diagnostic); repurposed `getWorktreeCommandWarning()` for macOS/Windows | ✅     |
| `src/core/tools/RenameSymbolTool.ts`            | Validate every `affectedRelPaths` entry against the worktree boundary before `applyEdit`                                                          | ✅     |
| `sandbox/main.go` + `sandbox/main_test.go`      | Landlock (ABI-negotiated) + bwrap wrapper + git worktree metadata discovery; 10 Go tests (5 unit + 5 git-resolution)                              | ✅     |
| `src/utils/__tests__/worktreePathGuard.test.ts` | 5 unit tests for `getWorktreeSandboxPrefix`                                                                                                       | ✅     |

> **Design deviation:** the original plan threaded a sandbox-prefix parameter through
> `ExecaTerminalProcess`. The implementation instead bakes the wrapper into the `effectiveCommand`
> string at [`ExecuteCommandTool.ts:136`](extensions/shofer/src/core/tools/ExecuteCommandTool.ts:136),
> so `ExecaTerminalProcess` was left unchanged. Functionally equivalent; the wrapper is the outermost
> process via `<wrapper> … -- /bin/sh -c '<cmd>'`.

### `rename_symbol` Isolation — ✅ implemented (Option A, strict)

> The design below describes the approach that was **implemented** in Phase 3. The
> per-affected-path worktree check is live at `RenameSymbolTool.ts:139-150`.

[`RenameSymbolTool`](extensions/shofer/src/core/tools/RenameSymbolTool.ts:32) calls
`vscode.executeDocumentRenameProvider`, which operates on the entire workspace. The source-file guard
[`validateWorktreePath(task, filePath)`](extensions/shofer/src/core/tools/RenameSymbolTool.ts:70)
only validates the **source** file's location, so the downstream-effects check below was added on top.

The handler already enumerates every affected file: the loop at
[`RenameSymbolTool.ts:127`](extensions/shofer/src/core/tools/RenameSymbolTool.ts:127) iterates
`workspaceEdit.entries()` and collects `affectedRelPaths`/`affectedDisplayPaths` **before** the edit
is applied at [`RenameSymbolTool.ts:155`](extensions/shofer/src/core/tools/RenameSymbolTool.ts:155)
(`vscode.workspace.applyEdit`). The validation slots in cleanly between those two points.

Approach: after building `affectedRelPaths` (before `captureOriginal` / `applyEdit`), run each path
through [`validateWorktreePath()`](extensions/shofer/src/utils/worktreePathGuard.ts:62). If any edit
targets a file outside the worktree boundary:

1. **Option A (strict):** Block the entire rename with an error (nothing has been applied yet).
2. **Option B (lenient):** Allow the rename but warn that references outside the worktree were modified.

Prefer **Option A** — the same principle as the other tools: worktree tasks cannot modify
files outside their assigned directory. The LLM should switch to a master-scoped task
if it needs cross-worktree refactoring. (Note: the API here is `WorkspaceEdit.entries()`, not the
`documentChanges` shape — validate against the `fsPath` of each entry's `Uri`.)

## Todo Checklist

### Phase 1: Sandbox Wrapper Binary ✅ complete

- [x] Implement landlock write-only sandbox in Go (static-linked binary) — ABI-negotiated (`landlockWriteMaskForABI`), file-scoped `/dev/null` rule
- [x] Add bwrap fallback for pre-5.13 kernels (`--ro-bind / /` first, then writable overlays)
- [x] Integration test: verify writes outside worktree fail with EACCES (`main_test.go` `TestBinaryIntegration`)
- [x] Integration test: verify reads outside worktree succeed
- [x] Integration test: verify writes inside worktree succeed
- [x] Integration test: verify writes to /tmp succeed (`TestBinaryWriteTmp`)

### Phase 2: Integration into ExecuteCommandTool ✅ complete

- [x] Add `getWorktreeSandboxPrefix(task)` to `worktreePathGuard.ts` (`:108`)
- [x] In `ExecuteCommandTool.execute()`: force execa path when `isEmbeddedWorktreeTask()`
- [x] ~~Thread sandbox wrapper prefix through `ExecaTerminalProcess`~~ — **superseded**: wrapper baked into `effectiveCommand` string instead (see Design deviation above); `ExecaTerminalProcess` unchanged
- [x] Unit test: non-worktree tasks use normal backend
- [x] Unit test: worktree tasks use execa + sandbox on Linux
- [x] Unit test: worktree tasks use advisory warning on macOS/Windows

### Phase 3: rename_symbol Isolation ✅ complete

- [x] After the LSP rename, iterate `workspaceEdit.entries()` to collect `affectedRelPaths` (`RenameSymbolTool.ts:127`)
- [x] Validate each path against the worktree boundary via `validateWorktreePath()`, **before** `applyEdit` (guard loop at `RenameSymbolTool.ts:141`; apply at `:168`)
- [x] Block renames that would modify files outside the worktree (nothing applied yet — clean abort)
- [x] Unit test: rename inside worktree succeeds (`RenameSymbolTool.test.ts:72`)
- [x] Unit test: rename affecting master checkout is blocked (`RenameSymbolTool.test.ts:44`)
- [x] Unit test: rename affecting sibling worktree is blocked (`RenameSymbolTool.test.ts:58`)

### Phase 4: Cleanup & Docs ✅ complete

- [x] Update [`worktrees.md`](extensions/shofer/docs/worktrees.md) — Known Limitation collapsed; sandboxing documented
- [x] Update [`command-execution.md`](extensions/shofer/docs/command-execution.md) — execa-forcing for worktrees documented
- [x] `getWorktreeCommandWarning()` repurposed for macOS/Windows-only (`worktreePathGuard.ts:152`)

## Open / Deferred

- **Med 5 — build integration (the one substantive open risk).** `sandbox/shofer-sandbox` is a
  committed x86-64 / not-stripped binary with no Bazel target and no `go.work` entry. Editing
  `main.go` does not rebuild the shipped artifact, and arm64 deploys exec it → loud `ENOEXEC` (the
  `fs.existsSync` guard in `getWorktreeSandboxPrefix` only catches a _missing_ binary, not a
  _wrong-arch_ one). Add a Bazel cross-compile target keyed to the deploy arch and stop committing
  the prebuilt binary.
- **Low — i18n.** The `🔒 WORKTREE SANDBOX` approval banner in `ExecuteCommandTool.ts` and
  `getWorktreeCommandWarning()` are hard-coded English; route through `t(...)` when the i18n rule is
  enforced. Deferred (matches the pre-existing un-localized warning).

## Future Work

### Restore a VS Code terminal tab (with its X/kill button) for sandboxed commands

**Context.** Forcing the execa backend (Phase 2) means sandboxed worktree commands run as a headless
[`execa()`](extensions/shofer/src/integrations/terminal/ExecaTerminalProcess.ts:43) child rather than
in a `vscode.Terminal`. Command text and streamed output are **still fully visible** — both backends
funnel through the same `onLine` → `task.say("command_output", …)` path, so output renders live in the
Shofer chat panel. What's lost is specifically the **VS Code integrated-terminal tab** in the bottom
panel: the kind with its own trash/X icon. (The chat **Stop** button remains the kill affordance for
execa, routing to [`ExecaTerminalProcess.abort()`](extensions/shofer/src/integrations/terminal/ExecaTerminalProcess.ts:163)
— SIGKILL + `psTree` child reaping.) The `vscode` backend creates a real terminal via
[`Terminal.ts`](extensions/shofer/src/integrations/terminal/Terminal.ts:21); the execa backend creates
nothing.

**Is it possible?** Yes. The constraint that "VS Code owns the shell process, so it can't be
sandboxed" applies only to the _shell-spawning_ terminal API (`createTerminal({ cwd, name })`). It does
**not** apply to VS Code's **extension-owned pseudoterminal** API
(`vscode.window.createTerminal({ name, pty })` with a `vscode.Pseudoterminal`). With a pseudoterminal,
_we_ still own and spawn the process (execa + the Landlock/bwrap wrapper, exactly as today); the
pseudoterminal is only a rendering surface and tab affordance. This decouples "who owns the process"
(us — so sandboxing is preserved) from "is there a terminal tab" (yes). The `pty` API exists in
code-server too, so this works in the deployed environment.

**Sketch.**

1. Add a `Pseudoterminal`-backed `ShoferTerminal` variant (a third `ShoferTerminalProvider` alongside
   `vscode`/`execa`, or an `execa+pty` mode) in
   [`TerminalRegistry.createTerminal()`](extensions/shofer/src/integrations/terminal/TerminalRegistry.ts:131).
2. On `Pseudoterminal.open()`, spawn the sandboxed execa process (the current `ExecaTerminalProcess`
   logic, unchanged) and pipe its stdout/stderr into the pty's `onDidWrite` emitter so output appears
   in the tab. Keep the existing `onLine` chat streaming as-is — the LLM still needs the captured
   output as the tool result, so the pty is **additive**, not a replacement.
3. Wire the two kill directions: the tab's X invokes `Pseudoterminal.close()` → call
   `ExecaTerminalProcess.abort()`; conversely a chat-Stop `abort()` should `dispose()` the terminal so
   the tab closes. Both must converge on the same abort path to avoid orphans.

**Trade-offs / caveats to weigh before doing this.**

- **No shell integration.** A pseudoterminal has no VS Code shell-integration decorations (command
  boundaries, exit-code badges) unless we emit the OSC 633 escape sequences ourselves. This is the same
  exit-code-visibility limitation already noted for execa above — the pty doesn't fix it, it just adds a
  visual surface.
- **Output duplication.** Output would appear in both the chat panel and the pty tab. That's arguably
  desirable (chat for the agent transcript, tab for the human), but the line-ending normalization the
  chat path applies must not corrupt the raw pty stream — keep the two sinks independent.
- **CRLF / TTY semantics.** A pty implies the program may detect a TTY and change behavior (colors,
  pagers, line buffering). execa today runs without a controlling TTY; mirroring into a pseudoterminal
  is display-only and does **not** give the child a real TTY, so programs that probe `isatty(stdout)`
  still see a pipe. If true TTY semantics are wanted, that's a larger change (and reintroduces the
  pager-hang risks the headless path avoids).
- **Scope.** This is a UX nicety, not a correctness or security gap — kill and visibility both already
  work via the chat panel. Prioritize accordingly, and only after the Med 5 build-integration item,
  which is the one substantive risk.
