# Outside-Workspace Path Allowlist (Design)

**Status:** Implemented (branch `feat/config-sync`). Rides the implemented config-sync channel.
**Owner:** —
**Related:** [`auto_approval.md`](auto_approval.md), [`settings_overlay.md`](settings_overlay.md), [`command-execution.md`](command-execution.md), [`configuration.md`](configuration.md), [`tool-categories.md`](tool-categories.md)

---

## 1. Problem

When the agent touches a file **outside** every workspace root, auto-approval is gated
by a single blanket boolean per group:

| Group   | Blanket toggle                        |
| ------- | ------------------------------------- |
| `read`  | `alwaysAllowReadOnlyOutsideWorkspace` |
| `write` | `alwaysAllowWriteOutsideWorkspace`    |

The modifier is applied in
[`group-gates.ts:100`](../packages/core/src/auto-approval/group-gates.ts):

```ts
if (ctx.isOutsideWorkspace && gate.outsideToggle && state[gate.outsideToggle] !== true) return false
```

So today there are exactly two outcomes:

- **Toggle ON** → _every_ outside-workspace path is auto-approved (blanket trust — too broad).
- **Toggle OFF** → _every_ outside-workspace access prompts, **once per file** (too noisy).

There is no middle ground. A user working against, say, `/etc/myapp/` or a sibling repo at
`/home/me/other-project/` must click Approve for every single file, or disable the safety
rail entirely.

## 2. Goals

1. **Scoped trust** — trust specific directory subtrees outside the workspace without
   trusting everything.
2. **Read / write separation with superset semantics** — a path can be marked
   read-without-approval **or** readwrite-without-approval. **Write trust implies read
   trust** (if you may write under a dir, reading there needs no separate grant).
3. **Interactive grant** — an "approve the whole path" option on the Approve/Deny prompt
   so the user can widen trust in one click, mid-task.
4. **Config-driven / persisted setup** — the user _or an external service_ can pre-seed
   trusted paths in Shofer's configuration (no interactive step), and interactively-granted
   paths persist across restarts.
5. **Purely additive** — the existing blanket toggles keep working unchanged; this feature
   only ever _widens_ auto-approval, never narrows what the blanket toggles already allow.

Non-goals (this iteration): a `deniedPaths` denylist (see [§11](#11-open-questions)); glob
patterns (prefix/subtree matching only); per-workspace path scoping in the UI (config can
still target workspace scope — see [§8](#8-persistence--configuration)).

## 3. Data model

Two ordered string lists of **absolute directory prefixes**:

```ts
allowedReadPaths:  string[]   // subtrees trusted for READ without approval
allowedWritePaths: string[]   // subtrees trusted for READ+WRITE without approval
```

- Entries are absolute, normalized filesystem paths (a directory, e.g. `/etc/myapp`).
  A file path may also be stored (it matches only itself).
- Stored in **both** setting backends, exactly like `allowedCommands` (see [§8](#8-persistence--configuration)).
- Empty/unset ⇒ feature contributes nothing; behavior is identical to today.

This mirrors the `allowedCommands` / `deniedCommands` model
([`global-settings.ts:114`](../packages/types/src/global-settings.ts)) so it inherits the
same persistence, merge, and UI plumbing.

## 4. Matching semantics (the read/write superset)

A candidate absolute path `P` matches an entry `E` when `P` is `E` itself or lives under it:

```
match(P, E)  ≡  norm(P) === norm(E)  ||  norm(P).startsWith(norm(E) + path.sep)
```

`norm` resolves and normalizes (`path.resolve`), so `E = /etc/myapp` matches
`/etc/myapp/conf.d/a.yaml` but **not** `/etc/myapp-secrets/x` (the `+ sep` guard prevents the
`/foo` → `/foobar` false match — same care as `isPathOutsideWorkspace`,
[`pathUtils.ts:22`](../packages/core/src/utils/pathUtils.ts)).

The superset rule, expressed as the effective trust set per operation:

| Operation being approved  | Auto-approve iff `P` matches an entry in …   |
| ------------------------- | -------------------------------------------- |
| **read** (`read` group)   | `allowedWritePaths` **∪** `allowedReadPaths` |
| **write** (`write` group) | `allowedWritePaths` only                     |

So marking a directory readwrite covers reads there for free; a read grant never enables
writes. Proposed helper (new `auto-approval/paths.ts`, mirroring
[`commands.ts`](../packages/core/src/auto-approval/commands.ts)):

```ts
export function isPathAutoApproved(
	absPath: string,
	group: "read" | "write",
	allowedReadPaths: string[],
	allowedWritePaths: string[],
): boolean {
	if (!absPath) return false
	const trusted = group === "write" ? allowedWritePaths : [...allowedWritePaths, ...allowedReadPaths]
	return trusted.some((entry) => isUnder(absPath, entry))
}
```

> **Longest-match / conflict resolution:** with allow-only lists there is no conflict to
> resolve, so we do **not** need the command engine's "longest prefix wins" arbitration.
> If a `deniedPaths` list is added later ([§11](#11-open-questions)), adopt the same
> longest-match rule `commands.ts` uses.

## 5. Decision-flow integration

Single insertion point, in the native-tool branch of `checkAutoApproval`
([`index.ts:256-270`](../packages/core/src/auto-approval/index.ts)). Precedence:

```
1. base group toggle off        → ask            (unchanged)
2. inside workspace             → approve         (unchanged)
3. outside + blanket toggle on  → approve         (unchanged)
4. outside + path allowlist hit → approve         ← NEW
5. otherwise                    → ask             (unchanged)
```

Concretely, step 4 slots in where the outside-workspace modifier currently returns "not
approved". Cleanest is to fold it into `isGroupAutoApproved`
([`group-gates.ts:88`](../packages/core/src/auto-approval/group-gates.ts)) so both the check
and its inputs stay in one place:

```ts
if (applyModifiers) {
	if (ctx.isOutsideWorkspace && gate.outsideToggle && state[gate.outsideToggle] !== true) {
		// Blanket toggle off — fall back to the per-path allowlist before denying.
		if (group !== "read" && group !== "write") return false
		if (!ctx.absolutePath) return false
		if (!isPathAutoApproved(ctx.absolutePath, group, state.allowedReadPaths ?? [], state.allowedWritePaths ?? []))
			return false
	}
	if (ctx.isProtected && gate.protectedToggle && state[gate.protectedToggle] !== true) return false
}
```

This keeps the MCP path (`applyModifiers: false`) unaffected, consistent with today's
behavior where MCP-served tools skip the outside-workspace modifier entirely.

> **Protected files still win.** The `isProtected` check runs after and is unchanged: a
> path allowlist hit does **not** bypass `alwaysAllowWriteProtected`. A protected file under
> a trusted dir still prompts unless the protected toggle is also on. (Decision point — see
> [§11](#11-open-questions).)

## 6. The absolute-path plumbing gap

The gate needs the **absolute** path to match against stored prefixes, but
`ShoferSayTool` currently carries only the workspace-_relative_ readable `path`
([`vscode-extension-host.ts:1261`](../packages/types/src/vscode-extension-host.ts)). The
absolute path already exists locally in every file-touching tool at the exact point
`isOutsideWorkspace` is computed (e.g. [`EditTool.ts:178`](../packages/core/src/tools/EditTool.ts)
passes `absolutePath` straight into `isPathOutsideWorkspace`) — it simply isn't serialized.

**Change:** add `absolutePath?: string` to `ShoferSayTool` and set it alongside
`isOutsideWorkspace` in the tool sites. To keep the blast radius small, only the sites that
already compute `isOutsideWorkspace = true` need it; a tool that is always in-workspace
(e.g. `LspSearchTool`, `RagSearchTool`) can omit it. The full site list is the same one that
sets `isOutsideWorkspace`:

`WriteToFileTool`, `EditTool`/`EditFileTool`, `InsertEditTool`, `SedTool`,
`SearchReplaceTool`, `ApplyPatchTool`, `RenameSymbolTool`, `ReadFileTool`,
`GrepSearchTool`, `ListFilesTool`, `CreateDirectoryTool`, `ViewImageTool`,
`GenerateImageTool`.

> **Pre-existing gap:** `FileTool` (rm/mv) hardcodes `isOutsideWorkspace: false`
> ([`FileTool.ts:115`](../packages/core/src/tools/FileTool.ts)) even though it is a write-group
> op, so today it is never subject to the outside-workspace modifier at all. If we want
> `rm`/`mv` of outside-workspace files to honor this allowlist, that site must compute the real
> value and set `absolutePath` too. Called out as a decision, not silently assumed.

`checkAutoApproval` then reads `tool.absolutePath` and threads it into the
`GroupGateContext` (`ctx.absolutePath`), next to the existing `isOutsideWorkspace` /
`isProtected` fields ([`group-gates.ts:75`](../packages/core/src/auto-approval/group-gates.ts)).

> **Batch reads.** `read_file` can carry multiple `batchFiles`, each with its own
> `isOutsideWorkspace` ([`vscode-extension-host.ts:1288`](../packages/types/src/vscode-extension-host.ts)).
> Each batch entry needs its own `absolutePath`, and the tool auto-approves only if **every**
> outside-workspace entry matches the allowlist (any unmatched entry → ask). Mirror this for
> `batchDiffs`.

## 7. Interactive grant — inline "Trust path" (task-scoped) and "Trust path (always)"

**As shipped, the inline grant is a pair of approval buttons, not a separate panel.** An earlier
design put a persistent split-button/dropdown next to Approve; user testing showed that two
orthogonal surfaces (Approve/Deny **plus** a trust panel) is confusing. So the trust actions
are inline buttons in the same question, and the choice of scope is explicit per-button.

**One question, up to four buttons: `Save` · `Trust path (…)` · `Trust path (…, always)` · `Deny`.**
For a tool ask flagged `isOutsideWorkspace` with an `absolutePath`, ChatView renders the two
Trust buttons between Approve and Deny. Both trust the file's **parent directory** and approve
the ask in one click; they differ only in scope. **The access level is auto-determined by the
operation, not chosen by the user**: a write-group tool (`isWriteTool`, from `WRITE_GROUP_TOOLS`)
trusts **read+write**, a read tool trusts **read** (the `write ⊇ read` superset still applies via
[`isPathAutoApproved`](#4-matching-semantics-the-readwrite-superset)). The resolved access is
rendered **in the button label** — `Trust path (read)` / `Trust path (read+write)` (and the
`, always` variants) — so the grant's scope is visible without hovering the tooltip.

**"Trust path" is task-scoped, not persistent.** It trusts the dir for the **current task and
its subtasks only** — in-memory, gone when the task ends. Mechanism:

- `Task` holds `trustedReadPaths` / `trustedWritePaths`, **snapshot-inherited** by subtasks at
  creation (so a subtask sees what the parent trusted).
- A private `Task.withTaskTrust(state)` merges them into the settings object at **all three**
  `checkAutoApproval` call sites, so task trust rides the same gate as the persistent lists.
- The button posts a `trustOutsideWorkspacePath` webview message
  (`{ outsideWorkspacePath: parentDir, outsideWorkspaceAccess, outsideWorkspacePersist: false }`);
  its handler calls `task.trustOutsideWorkspacePath(dir, access)` then approves
  (`handleWebviewAskResponse("yesButtonClicked", …)`) — trust-and-approve in one action.

**"Trust path (always)" is persistent.** It writes the dir straight into the same permanent
`allowedReadPaths`/`allowedWritePaths` settings the Settings panel edits — surviving restarts
and replicated to nodes by config-sync — then approves the ask. Mechanism: the same
`trustOutsideWorkspacePath` message is posted with `outsideWorkspacePersist: true`; the handler
appends the dir (deduped) to `allowedWritePaths` (write grant) or `allowedReadPaths` (read grant)
via `contextProxy.setValue`, calls `postInitState()` (so the Settings lists refresh), then
approves. Because `contextProxy` is the `NodeRegistry` `configSource`, the `setValue`'s
`onDidChange` drives the config-sync broadcast to remote nodes automatically ([§8](#8-persistence--configuration)).

**Permanent trust is also editable in Settings**: `AutoApproveSettings.tsx` has two editable
lists (read paths / read+write paths) next to the command lists, writing the same
`allowedReadPaths`/`allowedWritePaths` via `updateSettings` → globalState. So the three surfaces
are: **`Trust path` = this task; `Trust path (always)` = forever, inline; Settings = forever, curated.**

> **Implementation gotcha (fixed).** `checkAutoApproval` reads the allowlist from the object
> `provider.getState()` returns, which is **curated** — it copies specific keys, not the whole
> settings blob. The path keys must be added to **both** `getState()` (feeds the gate) and
> `getStateToPostToWebview()` (feeds the UI lists) next to `allowedCommands`/`deniedCommands`.
> Omitting them makes every grant silently ignored (the keys are written to globalState but
> never read back) — the first shipped build had exactly this bug.

## 8. Persistence & configuration

This is a first-class requirement: paths must be settable **without any interactive step**,
by the user or an external service, and interactive grants must survive restarts.

**Where the decision runs (this constrains everything below).** `checkAutoApproval` lives in
**`@shofer/core`** and runs wherever the agent core runs — the **executor**, which per the
[v3 architecture](v3_architecture.md#distributed-execution-horizontal-scaling) may be the
in-process VS Code host, a headless CLI process, or a **remote `shofer serve` node**. It
does **not** read config through Category I `HostConfig`; it reads the settings object
returned by `provider.getState()` in-core. VS Code is _just one front-end_ — "the config
must reach the remote nodes too." So the trusted paths must live in the **portable settings
state that `getState()` serves on every executor**, and reach each executor as described in
[§8d](#8d-reaching-every-executor-cli--remote-nodes) — for remote nodes, replicated from the
controller (locally present for the VS Code host and the self-driven CLI).

**Do NOT use VS Code `settings.json` (`contributes.configuration`).** It fails the constraint
above and the settings architecture rejects it on two further counts:

- **It is front-end-specific.** `settings.json` is a VS Code artifact. A headless CLI or a
  remote `shofer serve` node has no user `settings.json`; a path trusted only there would
  **never reach the executor that actually evaluates the approval**. The portable
  `globalSettingsSchema` is what crosses front-ends (via export/import / `importConfiguration`).
- **It is not the runtime source of truth, and is legacy debt being removed.**
  `checkAutoApproval` reads globalState via `provider.getState()`. `allowedCommands` /
  `deniedCommands` are single-sourced in globalState (their former VS Code-config
  dual-write was removed — [`settings_overlay.md` §14l](settings_overlay.md)), and
  [§15](settings_overlay.md) leaves only `customStoragePath` / `autoImportSettingsPath` in
  VS Code config (read before `ContextProxy` initializes). Adding two new keys there would
  copy the anti-pattern.

So the design uses **globalState/`globalSettingsSchema` as the store** and the **portable
import channel** (auto-import file / `ShoferAPI.importConfiguration`) as the
external-service / cross-executor seeding path — the same pair the settings architecture
recommends for automated deployments ([`settings_overlay.md` §10d, §11](settings_overlay.md)).

### 8a. Store: ContextProxy GlobalState (`globalSettingsSchema`) — source of truth

Add to [`global-settings.ts:114`](../packages/types/src/global-settings.ts):

```ts
allowedReadPaths:  z.array(z.string()).optional(),
allowedWritePaths: z.array(z.string()).optional(),
```

This is the copy ContextProxy serves to runtime, and the store the interactive "approve
this path" button and the Settings panel write to (via `updateSettings` →
`ContextProxy.setValues` → globalState — **not** `ConfigurationTarget.Global`). Thread the
two keys through the state-key unions
([`vscode-extension-host.ts:477`](../packages/types/src/vscode-extension-host.ts), `:845`)
and `AutoApprovalStateOptions`
([`group-gates.ts:32`](../packages/core/src/auto-approval/group-gates.ts)).

### 8b. External / automated setup: auto-import (the recommended channel)

Because the keys live in `globalSettingsSchema`, they flow **for free** through the
existing full-settings export/import and, crucially, **auto-import on startup**
([`importExport.ts`](../src/core/config/importExport.ts),
[`autoImportSettings`](../src/utils/autoImportSettings.ts)). An external service or a
provisioned code-server image sets one VS Code bootstrap key,
`shofer.autoImportSettingsPath` (e.g. `/etc/shofer/settings.json`), and drops a
`shofer-code-settings.json` whose `globalSettings` block carries the trusted paths:

```jsonc
{
	"globalSettings": {
		"autoApprovalEnabled": true,
		"alwaysAllowReadOnly": true,
		"alwaysAllowWrite": true,
		"allowedReadPaths": ["/data/reference"],
		"allowedWritePaths": ["/workspace/generated"],
	},
}
```

On activation, `autoImportSettings()` → `importSettingsFromPath()` →
`ContextProxy.setValues(globalSettings)` writes them to globalState — no interactive step,
survives restarts, and unifies with any interactively-granted paths already there. This is
exactly the mechanism [`settings_overlay.md` §11](settings_overlay.md) prescribes for
code-server / automated deployments. Confirm the two keys are **not** excluded by
`globalSettingsExportSchema` ([`ContextProxy.ts:34`](../src/core/config/ContextProxy.ts))
so they round-trip through export/import as well.

> **Caveat (matches all globalState settings):** auto-import is **startup-only** — there is
> no external-change watcher on globalState ([`settings_overlay.md` §8 table](settings_overlay.md)).
> An external service that rewrites the import file mid-session needs an extension reload to
> take effect. If live, per-project reload is required, see [§8c](#8c-optional-project-scoped-file-live-reload).

### 8c. Optional: project-scoped file (live reload, git-shareable)

If we want an external service **or a repo itself** to declare trusted paths **per
workspace with live reload** — conceptually apt for outside-workspace trust ("working in
_this_ repo legitimately needs these sibling dirs") — the pattern to follow is the
`.shofer/`-watched files (`.shofer/mcp.json`, `.shofer/shofermodes`), which get a
`FileSystemWatcher` with debounce and are git-shareable
([`settings_overlay.md` §7](settings_overlay.md)). A new
`<workspace>/.shofer/allowed-paths.json` watched like `.shofer/mcp.json` would give:
live reload (no restart), per-project scoping, and a committable declaration an external
provisioner can write. Its entries would union with globalState at gate-evaluation time.

This is a **larger surface** (new file schema + watcher + merge) and is proposed as a
follow-up, not part of v1. v1 = globalState + auto-import ([§8a](#8a-store-contextproxy-globalstate-globalsettingsschema--source-of-truth)–[§8b](#8b-external--automated-setup-auto-import-the-recommended-channel)).

### 8d. Reaching every executor (CLI & remote nodes)

The setting must be usable wherever the core runs, because that is where the decision is
made. The design's guiding rule: **the path allowlist is just additional fields on the
existing auto-approval state** (`autoApprovalEnabled`, `alwaysAllow*`, `allowedCommands`),
so it inherits, for free, whatever already carries that state to each executor. We add **no
new distribution mechanism** — we only insist the fields live in the portable state, not a
front-end-only backend.

| Executor                         | How the auto-approval state (incl. these fields) is present                                                                                                                                                                                                                                                                                     |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **VS Code (local)**              | Controller == executor; `provider.getState()` reads globalState directly. ([§8a](#8a-store-contextproxy-globalstate-globalsettingsschema--source-of-truth))                                                                                                                                                                                     |
| **CLI / headless**               | The core runs against the `vscode-shim` (globalState → `~/.vscode-mock/` JSON; config overlay in `WorkspaceConfiguration`). Pre-seed via `ShoferAPI.importConfiguration(json)` / auto-import — the same `globalSettings` block ([`headless.md`](headless.md) "Configuration Import/Export", which explicitly covers **auto-approval toggles**). |
| **Remote node (`shofer serve`)** | **Controller-authoritative.** The controller owns the config and **replicates it to each node** — on node registration and again on every controller-side change — and the node applies it to the local state its `provider.getState()` serves. Nothing is hand-edited on the node. (See design below.)                                         |

**Design: controller-authoritative config, pushed to nodes (registration + on change).**
The intended model is that a node is a **replica**, never a separately-administered box: the
user (or an external service) configures trust **once, on the controller**, and it
propagates. Concretely:

- **On registration** — when `NodeRegistry` completes a node's connect/auth/version
  handshake ([`node-connection.ts`](../packages/core/src/transport/node-connection.ts)), the
  controller ships the current auto-approval config (incl. `allowedReadPaths` /
  `allowedWritePaths`) to the node, which applies it to its local state.
- **On change** — any controller-side mutation (Settings panel, the interactive
  "approve this path" grant, an auto-import) **broadcasts** the updated config to all
  registered nodes, so a path trusted mid-session takes effect on every node without a node
  restart or manual edit.

**This rides an existing channel, specified separately.** The controller→node config-sync
channel is **implemented** ([`config_sync.md`](config_sync.md)) — it replicates the
node-scoped `globalSettings` slice to every remote node on connect and on change. The path
allowlist is one **consumer**: `allowedReadPaths`/`allowedWritePaths` are classified `"node"`
in `SETTING_SYNC_SCOPE` (the exhaustiveness guard forces the classification when the keys are
added), so they are part of the synced slice and reach every remote node **for free** — a
path trusted on the controller (via Settings, an interactive grant, or auto-import)
propagates to nodes with no node-side edit.

Because this feature only _adds fields_ to the portable auto-approval state, it imposes just
one hard requirement of its own: the fields must live in the serializable
`globalSettingsSchema` state (so config-sync can ship them), and **not** in VS Code
`settings.json`, which is front-end-only and would strand every non-VS-Code executor.

### 8e. Precedence

All sources that contribute paths are **unioned** (every source only ever _widens_ trust).
The master `autoApprovalEnabled` gate and the per-group base toggle (`alwaysAllowReadOnly`
/ `alwaysAllowWrite`) still apply first — a trusted path never overrides a group whose base
toggle is off, and never overrides the master switch.

## 9. Security considerations

- **Absolute paths only, resolved before matching.** Match on `path.resolve`'d absolute
  paths so `..` traversal in a tool argument can't smuggle a path past a prefix
  (`/trusted/../etc/shadow` resolves to `/etc/shadow`, which won't match `/trusted`).
- **Segment-boundary matching** (`+ path.sep`) prevents `/foo` trusting `/foobar`.
- **No implicit widening.** An empty list trusts nothing; the feature is inert until a path
  is explicitly added. Defaults ship empty.
- **Symlinks.** Matching is lexical on the resolved path, not the realpath — a symlink under
  a trusted dir pointing outside it would still be trusted by lexical prefix. If that matters,
  `fs.realpath` the candidate before matching (decision point — [§11](#11-open-questions)).
- **Protected files** remain independently gated (see [§5](#5-decision-flow-integration)).
- **Blast radius of config.** An external service can grant readwrite trust
  non-interactively via the auto-import file ([§8b](#8b-external--automated-setup-auto-import-the-recommended-channel)),
  and — if the optional project file ships ([§8c](#8c-optional-project-scoped-file-live-reload)) —
  a committed `.shofer/allowed-paths.json` grants trust to anyone who opens the repo. Treat
  both with the same care as `allowedCommands: ["*"]`; document the committed-file exposure
  prominently.

## 10. Testing

- **Unit** (`auto-approval/__tests__/paths.spec.ts`): `isPathAutoApproved` truth table —
  read-in-read, read-in-write (superset), write-in-write, write-in-read (must **fail**),
  subtree match, sibling-prefix non-match (`/foo` vs `/foobar`), `..` traversal, empty lists.
- **Engine** (`auto-approval/__tests__/index.spec.ts`): extend the outside-workspace cases —
  blanket toggle off + matching path → approve; off + non-matching → ask; batch read where
  one entry is unmatched → ask.
- **Integration** ([`docs/integration-tests/auto-approval.test-scenarios.yaml`](integration-tests/auto-approval.test-scenarios.yaml)):
  a scenario that reads two files under a pre-seeded `allowedReadPaths` dir and asserts the
  second is auto-approved (no second prompt).
- **Persistence**: config-seeded path is honored on a cold start with empty globalState;
  interactive grant survives a provider reload; config + interactive grants union.

## 11. Decisions & open questions

### Decided (v1 implementation)

- **Inline grant is two scope-explicit buttons** ([§7](#7-interactive-grant--inline-trust-path-task-scoped-and-trust-path-always)) —
  `Save · Trust path · Trust path (always) · Deny`, both trusting the file's **parent
  directory**. **Trust path** is task-scoped (current task + subtasks, in-memory, not
  persisted); **Trust path (always)** writes the dir to the permanent
  `allowedReadPaths`/`allowedWritePaths` settings (via `outsideWorkspacePersist: true`) and
  syncs to nodes. Settings remains the curated permanent editor.
  (Superseded the earlier permanent-inline-panel design after user testing.)
- **Protected files stay independent** — a `write` grant under a trusted dir does **not**
  satisfy `alwaysAllowWriteProtected`; a protected file still prompts unless that toggle is on.
- **Lexical matching for v1** — match on the `path.resolve`'d absolute path (defeats `..`
  traversal), not `realpath`; the symlink caveat is documented ([§9](#9-security-considerations)).
- **No `deniedPaths` in v1** — allow-only lists; revisit with the longest-prefix rule if a
  carve-out need appears.
- **Config-sync rides for free** — `allowedReadPaths`/`allowedWritePaths` are `"node"` in the
  (implemented) config-sync `SETTING_SYNC_SCOPE`, so trusted paths propagate to remote nodes
  with no extra work ([§8d](#8d-reaching-every-executor-cli--remote-nodes)).

### Open / deferred

1. **Project-scoped `.shofer/allowed-paths.json`** ([§8c](#8c-optional-project-scoped-file-live-reload)) —
   the only channel giving live reload + per-workspace scoping + a git-committable
   declaration, but a larger surface (schema + watcher + merge). Deferred; v1 is globalState +
   auto-import + config-sync.
