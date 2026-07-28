# Worktrees — design

Two views of one feature. **The plugin side** — the git operations, the UI, the slash
commands and the decision of _where a task runs_ — lives here, in
[`plugins/worktrees/`](./). **The core side** — the execution model (a task has a
working directory) and the safety properties built on it — stays in core no matter
which plugins are installed. Sections 1–4 and 7–12 are the plugin's; §5 and §6 are
core's, and are marked as such because the distinction is load-bearing: a safety
property a user can remove by disabling a plugin is not a safety property.

For how the feature behaves, see [`README.md`](./README.md); for what it deliberately
does not do, [`TODO.md`](./TODO.md).

## 1. Why a plugin

Worktrees are a _workflow_ choice, not part of what an agent is. Someone who wants every
task on the current branch, or who works in a non-git directory, should be able to switch
the whole idea off — and get an editor that behaves as if it had never existed, with
nothing left behind in core.

That is the test this design is written against: **disable the plugin and core still
runs tasks correctly**, because everything core knows is that a task has a working
directory.

```mermaid
flowchart TD
    subgraph core["core — feature-agnostic"]
        RC["resolveTaskCwd<br/>broadcasts 'resolve-task-cwd'"]
        CWD["task.cwd · HistoryItem.cwd"]
        GUARD["path-containment guard<br/>+ Linux execute_command sandbox"]
        SETCWD["ctx.task.setCwd · openTask seams"]
    end
    subgraph plug["plugins/worktrees"]
        MAIN["main.ts — request surface"]
        SVC["worktree-service · worktree-include · worktree-status"]
        UI["ui/indicator · ui/settings"]
        CMD["commands/*.md"]
    end

    RC -->|"first concrete answer"| MAIN
    MAIN --> SVC
    UI -->|"api.request"| MAIN
    MAIN --> SETCWD --> CWD
    CWD --> GUARD
```

## 2. The split, line by line

| Piece                                | Owner     | Why                                                                                          |
| ------------------------------------ | --------- | -------------------------------------------------------------------------------------------- |
| `git worktree` operations            | plugin    | The feature itself                                                                           |
| `.shofer/worktreeinclude` copy       | plugin    | Ditto                                                                                        |
| Which directory a new task runs in   | plugin    | Core asks, does not decide                                                                   |
| The chat chip and the Settings panel | plugin    | Rendered through the host's own kit, so they look built-in without being built-in            |
| Six merge/rebase slash commands      | plugin    | `contributes.commands`, unqualified (see §9)                                                 |
| `task.cwd` / `HistoryItem.cwd`       | core      | "A task runs in a directory" is the execution model; the plugin only _chooses_ the directory |
| Path containment in mutating tools   | core      | **Safety.** A confinement a user can remove by disabling a plugin is not a confinement       |
| The Linux `execute_command` sandbox  | core      | Same reason                                                                                  |
| Re-pointing an existing task         | core seam | Only the host knows whether the task has already written files somewhere                     |
| Opening a task in a new worktree     | core seam | Creating and focusing tasks is the host's; the plugin supplies the directory                 |

The safety line is the important one. `validateWorktreePath()` and the `shofer-sandbox`
wrapper stay in core and key off `task.cwd` alone: any task whose cwd is not the
workspace is confined to it, whoever put it there. Move them into the plugin and
"disable the plugin" would silently mean "let the agent write anywhere", which is not a
trade a user should be able to make by accident.

## 3. The embedded model

A worktree lives at `<workspace>/.shofer/worktrees/<name>/`, inside the window the user
already has open, and tasks scoped to different worktrees run concurrently in it. That is
what makes parallel agents, in-window task switching and merge-back possible without a
second VS Code window.

A worktree created by hand outside the workspace (`git worktree add ../foo`) still works
as an ordinary Shofer workspace when opened on its own; it is simply not one of these.

The location is a **core** constant, not a plugin convention: `isEmbeddedWorktreeTask()`
tests for this prefix literally, and §6's confinement and shell sandbox are gated on it.
The plugin therefore cannot relocate worktrees on its own — it only enforces the prefix:
a create request whose path is not under `<workspace>/.shofer/worktrees/` is rewritten so
that it is, and when a branch is being created the directory basename is forced to match
the branch. One name across branch, directory and label is what makes a worktree
followable.

Moving the prefix is a coordinated core + plugins change — proposed, with the full
consumer list, in [`todos/worktrees-path-move.md`](../../todos/worktrees-path-move.md).

## 4. Placement: the one question core asks

At task creation core broadcasts `"resolve-task-cwd"` to every plugin and takes the
first concrete answer.

```mermaid
flowchart TD
    NEW["newTask / createWorkflow /<br/>createParallelTask"]
    RC["resolveTaskCwd(provider)"]
    BC["pluginRegistry.requestAll('resolve-task-cwd')"]
    P1["plugins/worktrees"]
    PN["any other plugin"]
    ANS{"first concrete answer?"}
    CWD["task.cwd = that directory<br/>persisted as HistoryItem.cwd"]
    WS["task.cwd = the workspace"]
    ABORT["{ error } — abort task creation,<br/>reset the UI and show the reason"]

    NEW --> RC --> BC
    BC --> P1
    BC --> PN
    P1 --> ANS
    PN --> ANS
    ANS -->|"{ cwd }"| CWD
    ANS -->|"nobody answered"| WS
    ANS -->|"{ error }"| ABORT
```

[`resolveTaskCwd`](../../src/core/webview/resolveTaskCwd.ts) is the whole of core's
knowledge on the subject. This plugin answers it with the rule the user sees in the chip:

```mermaid
flowchart TD
    Q["core: where should this task run?"]
    SEL{"pendingCwd"}
    PICK["a path — the user picked a worktree"]
    OUT["null — the user picked 'current branch'"]
    NONE["undefined — the user picked nothing"]
    REPO{"a single-root git repo?"}
    NEW["create shofer-<random>:<br/>new branch off HEAD, seed it"]
    ANS1["{ cwd }"]
    ANS0["no answer — the task runs in the workspace"]
    ERR["{ error } — core aborts the task and shows why"]

    Q --> SEL
    SEL --> PICK --> ANS1
    SEL --> OUT --> ANS0
    SEL --> NONE --> REPO
    REPO -->|no| ANS0
    REPO -->|yes| NEW
    NEW -->|ok| ANS1
    NEW -->|failed| ERR
```

Two decisions inside that are easy to get wrong:

- **A failure is `{ error }`, never a throw.** `requestAll` treats a throw as "this
  plugin does not answer that question" — correct for a plugin that does not recognise
  it, and catastrophic here: the task would silently start on the user's current branch,
  the exact outcome per-task worktrees exist to prevent.
- **The pick is consumed.** `pendingCwd` resets on every answer, so one deliberate choice
  scopes one task; the next falls back to the auto-create default rather than quietly
  reusing someone else's checkout.

The selection lives in the **plugin**, not the webview. Core no longer has a
worktree-shaped field on `newTask` to thread it through, and the answer must be
available at the moment core asks — including when the question comes from a window that
did not make the choice.

## 5. What core keeps: confinement

A task whose `cwd` is not the workspace is **confined to it**, and that confinement is
core's, not a plugin's.

```mermaid
flowchart TD
    T["Task whose cwd is<br/>workspace/.shofer/worktrees/name/"]
    TOOL["mutating native tool — write_to_file · apply_diff ·<br/>create_directory · file rm/mv · insert_edit · sed ·<br/>rename_symbol · create_new_workspace"]
    V{"validateWorktreePath&#40;&#41; resolves the target<br/>against task.cwd — does it stay inside?"}
    BLOCK["blocked — catches .. traversal,<br/>absolute paths pointing outside,<br/>and symlinks that resolve elsewhere"]
    OK["tool proceeds"]
    EC["execute_command"]
    LIN["Linux: shofer-sandbox wrapper —<br/>Landlock write-only sandbox (kernel 5.13+),<br/>else bubblewrap. Writes restricted to the task's<br/>directory, /tmp and /dev/null; reads unrestricted"]
    OTHER["macOS / Windows: no kernel sandbox —<br/>the approval prompt shows a warning instead"]

    T --> TOOL --> V
    V -->|no| BLOCK
    V -->|yes| OK
    T --> EC
    EC --> LIN
    EC --> OTHER
```

| Tool                   | What is validated                                                        |
| ---------------------- | ------------------------------------------------------------------------ |
| `write_to_file`        | `path`                                                                   |
| `apply_diff`           | `path`                                                                   |
| `create_directory`     | `path`                                                                   |
| `file` (rm)            | `path`                                                                   |
| `file` (mv)            | `path` + `destination`                                                   |
| `insert_edit`          | `filePath`                                                               |
| `sed`                  | `path`                                                                   |
| `rename_symbol`        | the source `filePath` **and** every file the LSP `WorkspaceEdit` touches |
| `create_new_workspace` | `projectRoot` (path + name)                                              |
| `execute_command`      | sandboxed on Linux (Landlock/bwrap), advisory warning on macOS/Windows   |

[`validateWorktreePath()`](../../packages/core/src/utils/worktreePathGuard.ts) resolves
the target against `task.cwd`; for a task running in the workspace it is a no-op. The
Linux sandbox wrapper is compiled from [`src/sandbox/main.go`](../../src/sandbox/main.go)
at build time.

## 6. The seams this plugin uses

| Seam                                                    | What worktrees uses it for                                                   |
| ------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `pluginRegistry.requestAll("resolve-task-cwd")`         | Answering where a new task runs — a fresh worktree unless told otherwise     |
| `ctx.task.setCwd`                                       | Re-pointing a workflow that has not started its agents                       |
| `ctx.task.openTask`                                     | Opening an idle task in a worktree just created from the chat input          |
| `ShoferPlugin.handleRequest` + `PluginUIApi.request`    | Everything the two UI bundles do (`local:`-prefixed — see §7)                |
| `ctx.ui.postMessage`                                    | Create progress: `worktrees:step`, `worktrees:copy-progress`                 |
| `contributes.ui` (`chat-input-toolbar`, `settings-tab`) | The branch chip and the management panel                                     |
| `contributes.commands` + `unqualifiedContributions`     | The six merge/rebase commands, keeping their bare names at the built-in tier |
| `ctx.host.editor.openFile`                              | Opening a freshly seeded `.shofer/worktreeinclude`                           |
| `ctx.workspaceFolders`                                  | Detecting a multi-root window, where "the repository" is ambiguous           |

## 7. Talking to the UI

Both bundles talk to `main.ts` over the plugin UI channel (`api.request`), which
replaces eleven webview IPC message types and the eight extension→webview replies they
were paired with.

Every request is prefixed **`local:`**. Without it, a request made while a remote
executor's task is focused would be answered by that executor — listing _its_ checkout
for a panel that manages the repository open here. Worktrees are directories on this
machine; the prefix pins them to the host with the workspace (see
[`plugin_system.md`](../../docs/plugin_system.md) on request routing).

Progress goes the other way as pushes (`worktrees:step`, `worktrees:copy-progress`),
because a create can take minutes and a silent dialog reads as a hang.

Two requests need core rather than git. `open-task` calls `ctx.task.openTask({ cwd })`,
which is how creating a worktree from the chat input still _puts you in it_ — an idle
task in the new checkout, waiting for your first message, exactly as the built-in control
did. It is on task control rather than `ctx.agent.spawn` deliberately: spawn starts an
agent RUN (a prompt, an awaitable result, billed), while this only opens a task the user
then drives.

`set-task-cwd` is the other, and the one that can be refused: re-pointing a task that
exists but has not begun work goes through `ctx.task.setCwd`, the mirror seam
`ShoferProvider` exposes. The host refuses a `WorkflowTask` once `flowState.started` —
by then its agents have work on disk in the old directory. The refusal surfaces in the
picker rather than being swallowed.

## 8. Headless

`shofer serve` loads this plugin like any other host, so placement must not be a webview
feature — and is not: the question is asked on **every** task-creation path.
`ShoferAPI.startNewTask` (which the AgentApi, the CLI and ACP all funnel through)
resolves it too. So a controller driving a headless executor gets the same isolation a
user typing in the sidebar does: each remote task in its own checkout of the executor's
workspace, rather than every agent on one branch.

What is genuinely webview-only is the _chrome_: the branch chip and the Settings panel
render where there is a webview, and `ctx.ui.postMessage` progress goes nowhere without
one. Neither is load-bearing — creation, placement, the slash commands and the
`worktreeinclude` seeding all run headless, and progress pushes are cosmetic. Nothing
here silently no-ops (`AGENTS.md` → "Plugins must work headless"): the one seam whose
absence would change behaviour, `ctx.task`, throws when it is not granted or not wired.

## 9. Names that are a contract

`plugin.json` sets `unqualifiedContributions: true`, honoured only for **bundled** scope.
The six commands therefore register as `/merge-worktree` rather than
`/worktrees:merge-worktree`, at the built-in precedence tier — so a project's own
`.shofer/commands/merge-worktree.md` still wins, exactly as when the commands were
compiled into core. A third-party plugin cannot claim the exemption, because an
unqualified name from an unknown author could shadow a built-in.

## 10. Conventions the plugin enforces

- **Location.** Every create is rewritten under `<workspace>/.shofer/worktrees/`, with
  the directory basename matched to the branch — see §3 for why the prefix is core's.
- **Ignoring.** Creating the first worktree appends `.shofer/worktrees/` to `.gitignore`
  (never `.shofer/` itself — the rest of it is meant to be committed). Embedded worktrees
  are inside the repository, so without this they are untracked noise that can be
  committed by accident.
- **Detection.** Whether a subfolder workspace _is_ one of our worktrees is a containment
  check anchored at the git root (`path.relative`), never a substring match — an
  unrelated directory whose name contains `.shofer/worktrees` cannot pass.
- **Seeding is all-or-nothing for submodules.** A failed `git submodule update --init`
  tears the worktree down: empty submodule directories look like success and fail much
  later. A failed `worktreeinclude` copy only warns — an inconvenient checkout beats no
  checkout.

## 11. Interaction with checkpoints

The bundled [`checkpoints`](../checkpoints/) plugin scopes its shadow git to `task.cwd`,
so a worktree task snapshots only its own checkout, and a workspace-root task excludes
`.shofer/worktrees/` from its snapshots — a second task's files never land in its
snapshots. Neither plugin knows about the other: both key off the task's directory,
which is core's.

## 12. Constraints

- **Single-root only.** With several folders open, "the repository" is ambiguous, and
  guessing would create a worktree somewhere the user did not ask for. The plugin says so
  instead.
- **Repository root (or an embedded worktree) only.** A subfolder checkout has a git root
  above the workspace; worktrees created from it would land outside the window.
- **`worktreeinclude` is intersection-only.** A path that is not also gitignored cannot be
  copied — see [`TODO.md`](./TODO.md).

## 13. Related

- [`plugins/checkpoints/DESIGN.md`](../checkpoints/DESIGN.md) — per-task undo, scoped the
  same way
- [`docs/submodule-support.md`](../../docs/submodule-support.md) — the `GIT_DIR` isolation
  nested repositories need
- [`docs/plugin_system.md`](../../docs/plugin_system.md) — the plugin architecture these
  seams belong to
