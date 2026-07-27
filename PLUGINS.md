# Writing Shofer Plugins

A **plugin** extends Shofer's _behavior_, not just its data. Where the marketplace curates data
items and the custom-tool registry adds tools, a plugin is a self-contained bundle that can
contribute modes, skills, slash commands, MCP servers, and rules **declaratively**, and — if it
ships code — register tools, transform the system prompt, hook the task/tool lifecycle, run a
background service, call the host LLM, and render UI into the app.

Plugins are host-agnostic: the same plugin runs in the VS Code extension and the CLI (and any
future host). Everything a plugin can touch goes through a permission-checked, restricted surface —
a plugin only gets the capabilities its manifest declares **and** the user grants.

This is the practical guide to authoring one. For the internal design rationale see
`todos/plugin_system.md`.

---

## 1. What a plugin is

A plugin is a directory containing a `plugin.json` **manifest** and, optionally, a code entry point
and asset directories (`skills/`, `commands/`, rules markdown, etc.):

```
my-plugin/
  plugin.json        # the manifest — required, at the root
  index.ts           # optional code entry ("main")
  skills/            # optional SKILL.md files
  commands/          # optional slash-command .md files
  rules/             # optional rules markdown
```

### Discovery directories

Shofer scans two locations and loads a `<name>/plugin.json` from each subdirectory:

| Scope     | Directory                           | Meaning                                   |
| --------- | ----------------------------------- | ----------------------------------------- |
| `global`  | `~/.shofer/plugins/<name>/`         | available in every workspace              |
| `project` | `<project>/.shofer/plugins/<name>/` | scoped to one workspace (the current cwd) |

If a plugin of the same `name` exists in both, the **project** one (scanned later) wins. A plugin is
**disabled by default** after install — the user enables it per-plugin (that toggle is the consent
gate; see [§7](#7-permissions--consent)).

---

## 2. Quickstart

A minimal code plugin that contributes one tool. Create `~/.shofer/plugins/hello/`:

**`plugin.json`**

```json
{
	"name": "hello",
	"version": "1.0.0",
	"shoferPluginApiVersion": "1.0.0",
	"description": "Adds a greeting tool.",
	"main": "index.ts",
	"permissions": {
		"tools": true
	}
}
```

**`index.ts`**

```ts
import { defineCustomTool, parametersSchema as z } from "@shofer/types"
import type { PluginContext, ShoferPlugin } from "@shofer/types"

const plugin: ShoferPlugin = {
	name: "hello", // MUST equal manifest `name`

	registerTools(_ctx: PluginContext) {
		return [
			defineCustomTool({
				name: "greet",
				description: "Greet someone by name.",
				parameters: z.object({
					who: z.string().describe("Who to greet"),
				}),
				async execute({ who }) {
					return `Hello, ${who}!`
				},
			}),
		]
	},
}

export default plugin
```

Then, from the CLI:

```bash
shofer plugin install ~/.shofer/plugins/hello --enable
shofer plugin list
```

The plugin's default export must be a `ShoferPlugin` object whose `name` matches the manifest. The
entry may be `.ts`/`.tsx`/`.js`/`.mjs`; TypeScript is transpiled with the same esbuild path custom
tools use (Node built-ins external, deps bundled).

> A purely **declarative** plugin needs no `main` and no code — just a manifest with a `contributes`
> block. See [§4](#4-extension-points).

---

## 3. Manifest reference (`plugin.json`)

The manifest is validated **fail-closed**: every level is `.strict()`, so an unknown key is a hard
error and the plugin is skipped with a warning. Fields:

| Field                      | Type                | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`                     | string **required** | Unique id. Must match `^[a-zA-Z0-9][a-zA-Z0-9._-]*$`. Used for ordering, dedupe, namespacing.                                                                                                                                                                                                                                                                                                                                                                                                         |
| `version`                  | string **required** | Free-form version string.                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `shoferPluginApiVersion`   | string              | The plugin-API semver you target (current host API: `1.0.0`). Incompatible ⇒ refused at load.                                                                                                                                                                                                                                                                                                                                                                                                         |
| `description`              | string              | Shown in the Plugins UI and `plugin list`.                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `author`                   | string              |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `homepage`                 | string              |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `license`                  | string              |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `shoferVersion`            | string              | Minimum Shofer version (semver range). Not yet enforced.                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `main`                     | string \| null      | Code entry, relative to the plugin dir. Absent/`null` ⇒ purely declarative.                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `permissions`              | object              | The security contract. See below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `contributes`              | object              | Declarative modes/skills/commands/mcpServers/rules, plus `ui` bundles. See [§4](#4-extension-points), [§6](#6-ui-contributions).                                                                                                                                                                                                                                                                                                                                                                      |
| `dependencies`             | string[]            | Other plugins that must be installed. (Discovery records unmet deps; not fully enforced yet.)                                                                                                                                                                                                                                                                                                                                                                                                         |
| `config`                   | object              | JSON-Schema-ish description of user settings. See below.                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `defaultEnabled`           | boolean             | **Bundled (first-party) scope only.** Ship enabled instead of waiting to be opted into — for a plugin that IS a Shofer feature. Ignored for global/project plugins. If you also declare `permissions.ai`, gate every hook on `ctx.ai.hasConsent()`: enabling is not consent to bill, so an unconsented plugin must contribute nothing rather than a tool that only fails (see `plugins/live-memory/main.ts`).                                                                                         |
| `hookTimeoutMs`            | number              | Override the 500 ms per-hook budget for this plugin's lifecycle hooks (max 60000). Only for a hook the agent must genuinely wait for.                                                                                                                                                                                                                                                                                                                                                                 |
| `unqualifiedContributions` | boolean             | **Bundled (first-party) scope only.** Register `contributes.modes` and `contributes.commands` under their authored names instead of `<plugin>:<name>`, at the built-in precedence tier. Exists for a plugin shipping the platform's own defaults, whose names are a contract (`plugins/builtin-modes/` — the built-in modes must stay `code`, `architect`, …; `plugins/worktrees/` — `/merge-worktree`). Ignored for global/project plugins: an unqualified third-party name could shadow a built-in. |

### `permissions`

Every capability defaults to **denied**. A contribution is only surfaced, and a code capability only
reachable, when its permission is present. All keys are optional:

| Key            | Type     | Gates                                                                                                                                                          |
| -------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tools`        | boolean  | `registerTools` contributions.                                                                                                                                 |
| `systemPrompt` | boolean  | `transformSystemPrompt`.                                                                                                                                       |
| `modes`        | boolean  | `contributes.modes`.                                                                                                                                           |
| `skills`       | boolean  | `contributes.skills`.                                                                                                                                          |
| `commands`     | boolean  | `contributes.commands`.                                                                                                                                        |
| `rules`        | boolean  | `contributes.rules`.                                                                                                                                           |
| `mcpServers`   | boolean  | `contributes.mcpServers`.                                                                                                                                      |
| `workflows`    | boolean  | `contributes.workflows` — `.slang` workflows under your `workflows/` dir.                                                                                      |
| `ui`           | region[] | UI regions the plugin may render into. See [§6](#6-ui-contributions).                                                                                          |
| `lifecycle`    | boolean  | The `lifecycle` hooks. Without it, none of them ever fire.                                                                                                     |
| `events`       | boolean  | `onEvent` observation.                                                                                                                                         |
| `network`      | string[] | Allowed network origins/prefixes for `ctx.host.fetch`.                                                                                                         |
| `filesystem`   | string[] | Allowed paths for `ctx.host.fs` and `ctx.host.watch` (relative entries resolve to plugin root **and** workspace).                                              |
| `ai`           | boolean  | Host LLM/embeddings via `ctx.ai`. **Necessary but not sufficient** — also needs the AI-billing consent (§7).                                                   |
| `agent`        | boolean  | Proactive agent-steering via `ctx.agent.notify` (inject a message into the running agent). Billed/behavioral.                                                  |
| `task`         | boolean  | Task control via `ctx.task`: timeline markers, rewind, `setCwd`, `openTask`. Each changes what a task IS (rewind destroys history), so it is its own grant.    |
| `telemetry`    | boolean  | Report product events via `ctx.host.telemetry`. Telemetry LEAVES the machine, so it is a grant — the user's global telemetry opt-in still gates it underneath. |
| `editor`       | boolean  | The host's multi-file diff viewer via `ctx.host.editor`.                                                                                                       |

### `config`

A JSON-Schema-ish object (`{ type, properties: { <key>: { default, ... } } }`). Shofer does a
shallow **default-merge**: any `properties.<key>.default` seeds `ctx.config[key]` unless the user has
stored a value (stored values always win). Full type/enum validation of stored values is not yet
enforced — treat `ctx.config` as best-effort typed.

**Credentials: `"secret": true`.** A property marked secret is stored in the host's secret store
(the OS keychain), never in plain state, and its value is never sent to the settings webview — the
panel renders it as a password field showing only whether one is stored. Your plugin reads it from
`ctx.config[key]` like any other property; the split is the host's job:

```json
"config": {
	"type": "object",
	"properties": {
		"qdrantUrl": { "type": "string", "default": "http://localhost:6333" },
		"qdrantApiKey": { "type": "string", "secret": true, "description": "Vector-store token" }
	}
}
```

Saving an **empty** secret field deletes the stored value; leaving it untouched keeps it (the panel
cannot round-trip a value it is never shown). "Reset to defaults" clears the plain config and leaves
credentials alone — losing a key to a button labelled "reset defaults" would be a surprise.

### `syncConfig`

`"syncConfig": true` replicates this plugin's config **and** its secret properties from a controller
to the Shofer Nodes it drives. Default off: plugin settings are host-local, which is right for
anything describing the machine it runs on. Turn it on when your feature actually runs on the
executor — an indexer answering a search there is useless without its embedder settings and store
credentials, and those are not in the settings schema the node sync already carries.

Your plugin can shape what leaves the controller by answering the **`"node-config"`** request:

```ts
async handleRequest(method, params) {
	if (method === "node-config") {
		const { config, secrets } = params as { config: Record<string, unknown>; secrets: Record<string, string> }
		// A node queries the shared index; it must never scan or watch (the controller does).
		return { config: { ...config, searchOnly: true, indexKey: resolvedKey() }, secrets }
	}
}
```

Answer nothing and your stored values go as they are. The node **merges** the slice per plugin and
per key — it may hold local config for plugins the controller does not sync — and reloads your
plugin so `ctx.config` is live without a restart.

### A real example

```json
{
	"name": "acme-ci",
	"version": "2.1.0",
	"shoferPluginApiVersion": "1.0.0",
	"description": "ACME CI helpers: a status tool, a guardrail, and a CI mode.",
	"author": "ACME",
	"main": "index.ts",
	"permissions": {
		"tools": true,
		"lifecycle": true,
		"modes": true,
		"network": ["https://ci.acme.example"],
		"filesystem": ["./ci-config"]
	},
	"contributes": {
		"modes": [
			{
				"slug": "ci",
				"name": "CI",
				"roleDefinition": "You help diagnose and fix CI failures.",
				"groups": ["read", "command"]
			}
		]
	},
	"config": {
		"type": "object",
		"properties": {
			"baseUrl": { "type": "string", "default": "https://ci.acme.example" },
			"blockForcePush": { "type": "boolean", "default": true }
		}
	}
}
```

---

## 4. Extension points

### Declarative (no code)

Declared under `contributes` and gated by the matching permission. The physical assets live in the
plugin directory; the manifest entry is the declaration.

- **`modes`** — array of mode configs (same shape as a `ModeConfig`, minus `source`/`pluginName`,
  which Shofer assigns). Each must provide `tools` or `tools_allowed`.
- **`skills`** — `{ name, description }`. The `SKILL.md` lives under the plugin's `skills/` dir.
- **`commands`** — `{ name, description?, argumentHint? }`. The `.md` lives under `commands/`.
- **`mcpServers`** — a map of `name → server config` (validated by `McpHub`'s own schema before
  connecting; kept loose in the manifest).
- **`rules`** — `{ path, modes? }`, where `path` is a rules-markdown file relative to the plugin
  root, optionally scoped to specific modes.

### Namespacing

Plugin-contributed **modes**, **commands**, and **skills** are addressed under a
`<plugin-name>:<name>` identifier, so a plugin item can never shadow a built-in/user item or
another plugin's item — collisions are impossible **by construction** (there is no
"last-installed-wins" tie-break between plugins). How the qualification surfaces differs slightly:

| Contribution | Addressed as              | On-disk / authored name                                                                                                                                                                                                |
| ------------ | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **modes**    | `<plugin-name>:<slug>`    | The emitted mode `slug` **is** the qualified form; the authored slug in your manifest stays natural (no `:`). Attribution is carried on `source: "plugin"` + `pluginName`.                                             |
| **commands** | `<plugin-name>:<command>` | The command is registered and invoked under the namespaced name; the bare name is never resolvable on its own.                                                                                                         |
| **skills**   | `<plugin-name>:<name>`    | Namespaced purely at the **resolution/addressing** layer — the on-disk directory name and the `SKILL.md` frontmatter `name` stay spec-compliant (no `:`). The model lists and invokes the skill by its qualified name. |

The only residual collision is a single plugin declaring the same slug/name twice — a manifest bug,
surfaced with a defensive warning (later entry wins, deterministically).

### Private contributions

A mode, command, or skill can be marked **`private: true`**. A private contribution is fully
registered and **agent-invocable by its qualified name** (`<plugin-name>:<name>`), but is **hidden
from every user-facing surface** — the mode selector/picker, the slash-command menu, the skills
list, and the Plugins panel. Use it for an item the agent drives but the user never picks directly —
e.g. a plugin's `verifier` mode that a task switches into programmatically. Absent/`false` ⇒ a
normal, user-visible contribution. (`private` is a field on the mode, command, and skill
contribution schemas; a private mode still governs its subtask's tools once switched into.)

### Code (requires `main`)

Implement any subset of the `ShoferPlugin` hooks. All are optional.

- **`initialize(ctx)`** — run once when the plugin is registered.
- **`registerTools(ctx)`** — return `CustomToolDefinition[]` added to the tool set. Requires
  `permissions.tools`.
- **`transformSystemPrompt(prompt, ctx)`** — return a new prompt string. Plugins run in registration
  order, each receiving the previous output. Requires `permissions.systemPrompt`.
- **`onEvent(event, ctx)`** — observe lifecycle/telemetry events. Read-only; must not throw.
- **`onUiMessage(message, ctx)`** — receive a message from this plugin's UI (see
  [§6](#6-ui-contributions)).
- **`lifecycle`** — the task/tool lifecycle hooks below. **Only fires with `permissions.lifecycle`.**

#### Lifecycle hooks & reducer semantics

Plugins run in registration order. Each hook is bounded by a **500 ms** per-hook timeout with
per-plugin error isolation: a hook that throws or exceeds the budget is skipped with a shown+logged
warning — it can never stall or crash the agent loop, and its would-be mutation is not applied.

| Hook                | Return                              | Effect                                                                                                                                                                                      |
| ------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `beforeToolCall`    | `{ allow, modifiedArgs?, reason? }` | **Allow / modify / block.** `modifiedArgs` threads into later hooks and the tool; the first `allow:false` short-circuits the tool (surfaced like a denied tool, with `reason`).             |
| `afterToolCall`     | `string \| void`                    | **Observe / transform** the result string. A returned string replaces it for later hooks and the model.                                                                                     |
| `beforeAsk`         | `{ decision?, text? } \| void`      | **Modify / auto-answer** an ask. `text` edits the surfaced ask; `decision` of `"approve"`/`"deny"` auto-answers (short-circuit); `"ask"`/absent lets it proceed to the user.                |
| `beforeTaskStart`   | ignored                             | **Observer.** Fire-and-forget (off the latency-critical path). `ctx.prompt` carries the initial prompt.                                                                                     |
| `afterTaskComplete` | ignored                             | **Observer.** `ctx.reason` is `"completed"` or `"aborted"`.                                                                                                                                 |
| `onUserMessage`     | ignored                             | **Observer.** The user sent a message into a running task — the step boundary the tool hooks cannot see.                                                                                    |
| `onTimelineRewind`  | ignored (**awaited**)               | The chat is about to be rewound to `info.ts`. Runs BEFORE the messages go, so state anchored to them can be rolled back. `info.restoreState: false` ⇒ chat-only, don't touch the workspace. |
| `onTaskDeleted`     | ignored                             | **Observer.** A task was deleted — drop per-task state kept outside its task dir.                                                                                                           |

`ctx.turn` (a per-task turn counter) lets a hook that fires per _tool call_ act once per
turn. A hook that legitimately needs longer than 500 ms declares `hookTimeoutMs` in its
manifest — see [§3](#3-manifest-reference-pluginjson).

---

## 5. The `ctx` (PluginContext) API

Every hook receives a `PluginContext`. Which fields are populated depends on the host and the
plugin's grants:

| Field                  | Availability                                                                                                    |
| ---------------------- | --------------------------------------------------------------------------------------------------------------- |
| `workspacePath`        | Active workspace path, if any.                                                                                  |
| `mode`                 | Current mode slug.                                                                                              |
| `taskId`               | Id of the task the hook runs for, if applicable.                                                                |
| `cwd`                  | Current working directory.                                                                                      |
| `config`               | This plugin's validated, default-merged settings.                                                               |
| `host`                 | The restricted host surface (below). Present when the host wired its bridge.                                    |
| `ai`                   | Host LLM/embeddings. Present **only** with `permissions.ai` + a wired AI seam.                                  |
| `agent`                | Proactive agent-steering. Present when the host wired its agent seam; denying stub without `permissions.agent`. |
| `task`                 | Timeline markers + rewind. Present when the host wired its task seam; denying stub without `permissions.task`.  |
| `turn`                 | The task's current turn index (one per assistant turn), for once-per-turn hook behaviour.                       |
| `storage`              | Per-plugin persistent dir. Present when the host wired a storage base dir.                                      |
| `registerService(svc)` | Register a background service. Present when the host wired the supervisor.                                      |

### `ctx.host` — the restricted host surface

Permission-scoped; the shape is always the same, but an out-of-scope call is **denied at runtime**
(throw + shown/logged warning), not hidden from the type. So you always get a clear error, never a
missing API.

- **`host.fs`** — `readFile`/`writeFile`/`exists`/`mkdir`/`delete`/`findFiles`, scoped to
  `permissions.filesystem`. Relative allowlist entries resolve against both the plugin root and the
  workspace.
- **`host.fetch(input, init?)`** — HTTP, scoped to `permissions.network` origins/prefixes.
- **`host.notifier`** — `info`/`warn`/`error`. **Always available** (surfacing messages is safe).
  Pops a user-facing toast; use it sparingly for things the user must see.
- **`host.log`** — `debug`/`info`/`warn`/`error`. **Always available** (logging is safe). Writes to
  the plugin's **own Log category `Plugin:<name>`** (Settings → Logging), _not_ a user toast. Each
  loaded plugin automatically gets its category, so a user can view and filter one plugin's output
  independently. Prefer this over `console.*` for anything diagnostic.

    ```ts
    ctx.host?.log.info("reindexed", { files: 12 })
    // shows in Settings → Logging under the "Plugin:my-plugin" category
    ```

- **`host.metrics`** — `increment`/`gauge`/`observe`. **Always available** (a number in a local
  registry is as harmless as a log line), and a no-op on a host with no metrics pipeline. Metric
  names are yours: a plugin that owns a subsystem publishes the numbers an operator watches.
- **`host.telemetry.capture(event, properties?)`** — report a product event, gated on
  `permissions.telemetry`. Three things the host does for you, and none of them is optional:
  your event name is **namespaced** under the single `Plugin Event` catalog entry with
  `plugin`/`event` properties (a plugin cannot name a top-level event, or shadow a core one);
  properties are **scrubbed** to primitives with strings truncated (you see workspace content, and
  this leaves the machine — an `Error.stack` or a file's text must not become an analytics
  payload); and the user's telemetry opt-in still applies, so a granted plugin on a machine with
  telemetry off reports nothing. Ungranted ⇒ warns and drops. It never throws: reporting a failure
  must not fail differently because reporting was refused.

    ```ts
    ctx.host?.telemetry.capture("indexing_error", { subsystem: "OpenAiEmbedder", attempts: 3 })
    ```

- **`host.env`** — read-only host/environment metadata. Always available.
- **`host.watch(pattern, onChange)`** — watch a glob for create/change/delete, **scoped to
  `permissions.filesystem`** (watches `pattern` under each granted root). The callback receives the
  event **`{ path, type }`** — `path` is the absolute path of the changed file (always inside a
  granted root) and `type` is `"create" | "change" | "delete"` — so you can act on _which_ file
  changed, not just that something did. Ungranted ⇒ deny + no-op disposable. Dispose to stop (the
  manager also disposes it on plugin disable). Present only when the host wired a watcher.

    ```ts
    ctx.host.watch("**/*.json", (event) => {
    	// event.path e.g. "/abs/ws/ci-config/status.json", event.type "change"
    	reindex(event.path)
    })
    ```

### Phase-6 host capabilities

**`ctx.ai`** (`PluginAi`) — requires `permissions.ai` **and** the user's "uses AI (billed)" consent.

- `buildHandler(profileRef?)` → `Promise<Handler>` — build the **same** `ApiHandler` the main agent
  uses (the host's default profile when `profileRef` is omitted). The plugin never sees raw API keys.
- `embed(texts, profileRef?)` → `Promise<number[][]>` — one embedding vector per input text.
- `hasConsent()` → `boolean` — **read-only** consent check: `true` when calls will actually run,
  `false` on the denying stub. Because `ctx.ai` is _present_ in both the live and unconsented cases,
  use this to word prompt/UI copy for the consent state **without** making a billed call to find out.
  It cannot grant consent — only the user can.

Granted but **not** consented ⇒ `ctx.ai` is present but a _denying stub_ (`buildHandler`/`embed` throw +
warn, `hasConsent()` returns `false`), so the user is never silently billed. Ungranted ⇒ `ctx.ai` is
**absent** entirely.

**`ctx.agent`** (`PluginAgent`) — proactive **agent-steering**, requires `permissions.agent`. Lets a
plugin push a message **into** the running agent (rather than only reacting to it) — from a background
service, a `ctx.host.watch` callback, or a lifecycle hook:

- `notify(message, opts?)` → `Promise<void>`. `opts.mode` (default **`"queue"`**) enqueues the message
  into the active task's queue so the agent picks it up on its next turn (non-disruptive); **`"spawn"`**
  starts a new task seeded with the message; **`"interrupt"`** is _reduced_ to queued-ASAP (the message
  is enqueued and, if the loop already ended, drained immediately via the tested cancel-and-process
  path — there is no fragile mid-turn injection). `opts.taskId` targets a specific task; otherwise the
  current/active task is used (with no task to steer, a `queue`/`interrupt` notify falls back to spawning
  so the message is never dropped).

```ts
// e.g. inside a registered service watching a deploy log
await ctx.agent?.notify("The deploy just failed — see /var/log/deploy.log for the trace.")
```

Ungranted (host wired the seam) ⇒ `ctx.agent` is a _denying stub_ (`notify` throws + warns). No agent
seam (headless/pure-core) ⇒ `ctx.agent` is **absent** entirely.

**`ctx.task`** (`PluginTaskControl`) — **task control**, requires `permissions.task`.
For a plugin whose feature belongs _in the conversation_ rather than in a side panel, and
for one that decides _where_ a task runs:

- `marker({ kind, text, data?, restorable?, suppress?, taskId? })` — append a row the
  plugin's own `chat-message-addon` component renders (the host never interprets
  `kind`/`data`). `suppress` persists it without rendering it (an anchor the user
  doesn't need to see); `restorable` makes the delete/edit dialog offer to roll your
  state back.
- `listMarkers(taskId?)` — your markers, oldest first: how you recover anchors after a
  restart without a second, drift-prone copy in `ctx.storage`. Scoped to your plugin.
- `rewind(ts, { includeTargetMessage? })` — truncate the conversation to `ts` and restart
  the task. Roll back anything _outside_ the conversation yourself, first.
- `setCwd(cwd, taskId?)` — re-point a task at another working directory. The host refuses
  when the move would be incoherent (a workflow whose agents are already running) and says
  so rather than silently doing nothing.
- `openTask({ cwd?, name?, text?, images?, mode? })` — open and focus a NEW task, resolving
  with its id. With no `text` it lands idle, waiting for the user: this is for a plugin
  that has prepared a _place_ to work (`plugins/worktrees` opens a task in a worktree it
  just created), not a prompt. Use `ctx.agent.spawn` instead when you want an agent RUN —
  that one takes a prompt, returns an awaitable handle, and is gated on `permissions.agent`
  because it bills.

```ts
await ctx.task?.marker({ kind: "snapshot", text: commitHash, restorable: true })
```

Ungranted (seam wired) ⇒ a denying stub; no task seam ⇒ **absent**.

**`ctx.host.editor`** (`permissions.editor`) — `showMultiFileDiff(title, changes)` opens
the host's native multi-file diff view for a set of before/after file contents.

**`ctx.ui.openSettings()`** — reveal Settings → Plugins, where this plugin's toggle,
`config` form and (with `permissions.ai`) its billed-AI consent live. For the case where
your UI has to say "I need your approval before I can do anything": send the user to the
approval rather than describing where it is. Fire-and-forget; a warned no-op on a host
with no settings surface.

**`ctx.storage`** (`PluginStorage`) — the plugin's own persistent dir at
`<globalStorage>/plugins/<name>/`, independent of `permissions.filesystem`. `readFile`/`writeFile`/
`exists`/`delete`/`list`, all resolved under `dir` and **traversal-blocked** (a `..` escape is
denied). Created lazily, survives restart, removed on uninstall.

**`ctx.registerService(service)`** — register a supervised background service
`{ name, start, stop? }`. `start()` runs when the plugin is enabled+active; `stop()` on
disable/uninstall/deactivate. Each `start`/`stop` is bounded by a **5 s** timeout and error-isolated,
so a hanging or throwing service can never crash the host. Returns a disposable that stops + removes
the service.

### Answering requests (`handleRequest`)

`onUiMessage` is fire-and-forget; when your UI needs an **answer**, implement
`handleRequest(method, params, ctx)` and call it with **`api.request(method, params?, opts?)`**
from the component. Errors propagate to the caller (they are not swallowed like observer
hooks), so a failure surfaces instead of looking like an empty result.

The host answers the request on the machine that OWNS the focused task — a remote
executor for a task running there — so a plugin-owned feature works the same locally and
remotely. Three conventions:

- prefix a method **`local:`** to force it onto the host the UI runs on (opening an
  editor/viewer, which a headless executor cannot do);
- pass **`{ mutates: true }`** for a state-changing request: the host refuses to route it
  to an executor while a local task shares the workspace;
- return **`{ rewound: true }`** if you rewound the task's conversation, so the controller
  resyncs its view of a remote task.

```ts
// ui/row.tsx
const result = await api.request("diff", { id }) // answered where the task runs
await api.request("local:show-diff", result, { mutates: false }) // rendered here
```

---

## 6. UI contributions

A plugin can render React components into named webview **regions**. Declare the regions in
`permissions.ui` — this is the grant. A granted region renders either a first-party/co-bundled
component (default) or your **own compiled UI bundle** when you point `contributes.ui` at a built
module (see [Shipping your own UI bundle](#shipping-your-own-ui-bundle)). Regions:

- `chat-input-toolbar`
- `task-header`
- `settings-tab`
- `chat-message-addon`
- `chat-footer`
- `sidebar-panel`

The component is loaded into the webview by **dynamic import** (not a sandboxed iframe), so it shares
the host's React and theme. It receives only a **`PluginUIApi`**:

- `postMessage(message)` — send to this plugin's extension-side code. Every message is tagged with
  the plugin name, so it's routed only to that plugin.
- `onMessage(listener)` — subscribe to messages addressed **only** to this plugin (namespaced — a
  plugin can neither observe nor spoof another's channel). Returns an unsubscribe fn.
- `context` — read-only `{ region, pluginName, task?, config?, theme? }`.

The extension side receives your UI's messages via the `onUiMessage(message, ctx)` hook and pushes
back with the host-side sender. No `vscode` API and no parent-DOM access are exposed.

### Shipping your own UI bundle

A third-party plugin ships its **own compiled UI bundle**. Point a granted region at a built module
with `contributes.ui`:

```json
{
	"permissions": { "ui": ["chat-input-toolbar"] },
	"contributes": { "ui": [{ "region": "chat-input-toolbar", "entry": "ui/toolbar.js" }] }
}
```

- `permissions.ui` is still the **grant** — a region must be listed there or the contribution is
  refused (fail-closed). `contributes.ui[].region` must be one of those granted regions.
- `entry` is the built ESM module, **relative to your plugin root** (e.g. `ui/toolbar.js`). The
  extension serves it as a local `vscode-webview://` resource (its dir is added to the webview's
  `localResourceRoots`) and the webview **dynamic-imports** it. A granted region _without_ a
  `contributes.ui` entry falls back to a first-party/co-bundled component (unchanged behavior).

**The build contract — externalize React and the kit.** Your bundle must **not** bundle its own
React: the host injects an [import map](https://developer.mozilla.org/en-US/docs/Web/HTML/Element/script/type/importmap)
so that `react`, `react-dom`, `react/jsx-runtime` (and `react/jsx-dev-runtime`, `react-dom/client`)
resolve to the **host's running React instance**. Sharing one instance is what keeps hooks and
context working — a second copy silently breaks them. The same map resolves **`@shofer/plugin-ui`**
(next section) to the host's component kit. So build the entry as an **ES module** and mark those
packages **external**. With esbuild:

```sh
esbuild ui/toolbar.jsx --bundle --format=esm --jsx=automatic \
  --external:react --external:react-dom --external:react/jsx-runtime \
  --external:@shofer/plugin-ui \
  --outfile=ui/toolbar.js
```

(or, with Vite/Rollup, `build.lib` + `rollupOptions.external: ["react", "react-dom", "react/jsx-runtime", "@shofer/plugin-ui"]`).

The module must **default-export** a React component taking a single `{ api: PluginUIApi }` prop:

```jsx
import { useEffect, useState } from "react"
export default function Toolbar({ api }) {
	const [reply, setReply] = useState("")
	useEffect(() => api.onMessage((m) => setReply(String(m))), [api])
	return <button onClick={() => api.postMessage({ deploy: api.context.task?.taskId })}>Deploy {reply}</button>
}
```

The bundle loads under the webview CSP without weakening it: `script-src` uses `strict-dynamic` +
a nonce, so the nonced host script may dynamic-import your same-origin (`vscode-webview://`) module.
Arbitrary external hosts remain blocked — only files under the plugin dirs are served. If your
component throws while rendering, it is caught by an error boundary and unmounted; the host UI keeps
working.

### `@shofer/plugin-ui` — the host's components and your translations

Your UI shares more than React. Import the host's kit and render the **same** components the product
does, instead of look-alikes that drift from it and behave differently under keyboard and focus:

```jsx
import {
	Button,
	Popover,
	PopoverContent,
	PopoverTrigger,
	StandardTooltip,
	cn,
	usePluginTranslation,
} from "@shofer/plugin-ui"

export default function Toolbar({ api }) {
	const t = usePluginTranslation()
	return (
		<StandardTooltip content={t("toolbar.deployTooltip")}>
			<Button variant="ghost" size="icon" onClick={() => api.postMessage({ deploy: true })}>
				<span className="codicon codicon-rocket" />
			</Button>
		</StandardTooltip>
	)
}
```

Available: `Button`, `Badge`, `Checkbox`, `Input`, `Textarea`, `ToggleSwitch`, `Progress`,
`Separator`, `StandardTooltip`, `Popover*`, `Dialog*`, `Collapsible*`, `SearchableSelect`,
`useShoferPortal`, `cn`, `usePluginTranslation`. The full signature list is
[`plugins/plugin-ui.d.ts`](plugins/plugin-ui.d.ts) — map it in your plugin's tsconfig `paths` to
typecheck your UI:

```json
{ "compilerOptions": { "jsx": "react-jsx", "paths": { "@shofer/plugin-ui": ["../plugin-ui.d.ts"] } } }
```

Styling needs nothing: your component renders inside the host document, so its CSS and VS Code theme
variables already apply (`text-vscode-descriptionForeground`, `codicon codicon-*`, …). Icons are not
re-exported — bundle `lucide-react` yourself if you want them.

**Translations.** Ship `locales/<lang>.json` in your plugin root and `usePluginTranslation()` reads
them, with the host's interpolation, plural rules and language switching:

```
my-plugin/
├── plugin.json
├── locales/en.json      { "toolbar": { "deployTooltip": "Deploy this task" } }
├── locales/de.json
└── ui/toolbar.js
```

They are registered as the i18next namespace `plugin:<your-plugin-name>`, so your keys can never
collide with the host's or another plugin's. A key with no translation renders as the key itself —
visible, rather than silently blank. A plugin with no `locales/` directory simply gets no
translations.

---

## 7. Permissions & consent

Two independent gates decide what a plugin can do:

1. **Enable = per-plugin consent.** A plugin is disabled by default. Enabling it (Plugins tab, or
   `--enable` on install) is the user's consent to run it at all. Disabling unregisters it: its
   tools/transforms/observers stop firing, its watchers and services are torn down.

2. **Manifest permissions gate each capability.** A declarative contribution is only surfaced, and a
   code capability only reachable, when the matching `permissions` key is granted. `fs`/`network`/
   `filesystem` calls are checked at runtime against the allowlists; `lifecycle` hooks don't fire
   without `permissions.lifecycle`; UI regions must be in `permissions.ui`.

**AI billing is a third, separate consent.** `permissions.ai` alone is not enough: `ctx.ai` only
becomes live after the user grants the **"uses AI (billed)"** consent in the Plugins panel (a
distinct toggle from enable). Granted-but-unconsented gives a denying `ctx.ai` stub; consent can be
revoked at any time. Plugins never receive raw API keys.

The plugin-API version is also enforced: a plugin whose `shoferPluginApiVersion` is incompatible with
the host (major mismatch, or the host is older than the minor/patch it needs) is refused at load,
before any of its code runs.

---

## 8. Packaging & install

### The archive

A distributable plugin is a **`.shofer-plugin`** file — a gzip tarball of the plugin directory's
**contents** (the `plugin.json`, code, and asset dirs sit at the archive root; there is no wrapping
directory). The archive must contain a valid `plugin.json` at its root. Unpacking is hardened against
zip-slip (absolute paths, `..` segments, symlink/hardlink entries are all rejected).

### CLI

```bash
# Install from a .shofer-plugin archive, an unpacked plugin directory, OR a direct http(s) URL
shofer plugin install <source> [--enable] [--overwrite] [--allow-insecure-http]

# List installed plugins and their state (enabled / disabled / inactive)
shofer plugin list [--json]

# Remove a plugin (deletes its dir, drops it from the enabled list)
shofer plugin remove <name>
```

`<source>` may be a local `.shofer-plugin` archive, an unpacked plugin directory, **or a direct
`http(s)` URL to a `.shofer-plugin` archive**. A URL source is downloaded and unpacked through the
same manifest-validation / zip-slip-hardened path as a local archive; **`https` is required** unless
the host is loopback or you pass `--allow-insecure-http` (see the https/size policy below).

The CLI installs into the **global** dir (`~/.shofer/plugins/<name>`) and shares the enabled
allow-list with the running app, so a plugin installed/enabled here is picked up by the extension and
the Plugins settings tab unchanged. Without `--enable`, a freshly installed plugin stays disabled
(the per-plugin consent gate). `--overwrite` replaces an already-installed plugin of the same name
(the upgrade path).

### Marketplace Plugins tab

The Marketplace's **Plugins** tab lists discovered plugins with enable/disable toggles, an uninstall
action, and the "uses AI (billed)" badge + consent affordance, plus **two install affordances**:

- **Install from file** — opens a native picker for a local `.shofer-plugin` archive (the webview
  can't read local files, so the extension does the pick + unpack).
- **Install from URL** — paste a direct `http(s)` link to a `.shofer-plugin` archive; the extension
  downloads it via the core helper (https-only + size-capped + zip-slip / manifest validated),
  unpacks it into the global plugins dir, and re-discovers. Freshly installed plugins stay disabled
  (matching install-from-file), so you enable them afterward.

> The Settings → **Plugins** tab shows the same discovered-plugin list with enable/disable toggles
> (plus the `settings-tab` UI region), but the install affordances + AI-consent controls live in the
> Marketplace Plugins tab.

> **Direct-URL install is supported; a remote _registry_ is not.** There is no
> `shofer plugin search` / `install name@version` / hosted directory — install is a local archive,
> a local directory, or a **direct** archive URL. Registry lookup + a trust/signing chain stay
> deferred.

### The https / size policy (URL install)

Both the CLI (`shofer plugin install <URL>`) and the Marketplace "Install from URL" go through the
same host-agnostic core helper:

- **`https` only** by default. A plain `http://` URL is refused unless the host is loopback
  (`localhost`/`127.0.0.1`) or, on the CLI, `--allow-insecure-http` is passed.
- **Size-capped** — the download is bounded (default 64 MiB) to prevent an oversized-response DoS.
- **Validated + hardened** — the fetched bytes are unpacked through the same `.shofer-plugin`
  pipeline: a valid `plugin.json` at the archive root is required, and unpacking rejects absolute
  paths, `..` segments, and symlink/hardlink entries (zip-slip hardened).

---

## Plugin declarations (`.shofer/plugins.json`)

The discovery directories in [§1](#discovery-directories) and the CLI/Marketplace
installs in [§8](#8-packaging--install) cover a plugin whose **code is already
present** as an installed directory. A `.shofer/plugins.json` **declaration** covers
the complementary need — stating **which** plugins a scope wants, **from where**,
and at **which version** — without committing the plugin bytes. "Declare, don't
vendor": only the declaration lives in `.shofer/`, so the tree stays text-only,
reproducible, and zip/overlay-able. Plugin _config_ already flows through
`.shofer/settings.json` (`pluginConfigs`); the declaration adds the missing
source/version/enablement lockfile.

### The declaration file

`.shofer/plugins.json` is validated fail-closed (`pluginDeclarationSchema` in
[`plugin-declaration.ts`](packages/core/src/plugins/plugin-declaration.ts)):

```json
{
	"version": 1,
	"plugins": {
		"git-guard": { "source": "./plugins/git-guard", "version": "1.0.0", "enabled": true },
		"acme-ci": {
			"source": "/opt/plugins/acme-ci.shofer-plugin",
			"version": "2.1.0",
			"config": { "baseUrl": "https://ci.acme.example" }
		}
	}
}
```

Each entry is `{ source, version, config?, enabled? }`:

- **`source`** — a local **directory** path or a local **`.shofer-plugin`** archive
  path resolve today. A `marketplace:<id>@<ver>` ref or an `http(s)` URL is reserved
  for a later pass — the resolver raises a `PluginResolveError` ("marketplace/remote
  sources not yet supported") for those, isolated per-declaration so it never blocks
  discovery of the physically-present plugins.
- **`version`** — the version the resolver materializes under.
- **`config`** — the user's config overrides, merged with the manifest's `config`
  defaults (see [§3](#config)).
- **`enabled`** — defaults to `true`.

### Merge across scopes and governance

The three scopes' declarations are cross-merged per plugin **name** by
`mergePluginDeclarations`, under the **same** `locked.json` engine as the rest of
the layered config (see
[`configuration.md`](docs/configuration.md#layered-shofer-configuration)):

- **Unlocked** (or global does not declare it) → more-specific wins:
  `project ?? user ?? global`. A user/project may always **add** plugins the global
  scope did not declare.
- **Locked** (`plugins/<name>` in the global scope's `locked.json`) → the **global**
  scope's entry wins and is final; user/project entries for that name are dropped,
  and the plugin is force-enabled with its declared config authoritative per key.
  This is the governance payoff: a read-only org-global `.shofer/` can mandate
  "these plugins, these versions, this config — non-negotiable", while users still
  add their own unlocked plugins.

### Resolution and wiring

`resolvePluginDeclaration` materializes each declared `source@version` into a
content-addressed cache dir `<globalStorage>/plugins-cache/<name>@<version>/` — a
directory source is copied, a `.shofer-plugin` archive is unpacked, and an
already-materialized dir is reused idempotently. The materialized `plugin.json` is
validated against the manifest schema and its `name` checked against the declaration
key; a mismatch skips that one plugin with a warning.

The host loader ([`pluginDeclarationLoader.ts`](src/core/config/pluginDeclarationLoader.ts))
then folds the resolved plugins into `PluginManager` discovery: each cache dir is
appended to the scan list (alongside the bundled, global `~/.shofer/plugins/`, and
project `<ws>/.shofer/plugins/` dirs), its declared config seeds `pluginConfigs`
(the user's stored values win per key for an unlocked plugin; the declaration wins
per key for a locked one), and an `enabled !== false` (or locked) plugin is enabled.
The path is **purely additive** — with no `plugins.json` anywhere it resolves
nothing and discovery is unchanged. A declared plugin still passes through the same
enable/permission/AI-consent gates as any other ([§7](#7-permissions--consent)).

---

## 9. Worked examples

### A guardrail plugin

A guardrail plugin: a status tool, a `beforeToolCall` hook that blocks force-pushes, and a config
flag. It uses `permissions.tools` + `permissions.lifecycle` + `permissions.network`.

**`plugin.json`**

```json
{
	"name": "git-guard",
	"version": "1.0.0",
	"shoferPluginApiVersion": "1.0.0",
	"description": "Blocks risky git commands and reports CI status.",
	"main": "index.ts",
	"permissions": {
		"tools": true,
		"lifecycle": true,
		"network": ["https://ci.acme.example"]
	},
	"config": {
		"type": "object",
		"properties": {
			"blockForcePush": { "type": "boolean", "default": true }
		}
	}
}
```

**`index.ts`**

```ts
import { defineCustomTool, parametersSchema as z } from "@shofer/types"
import type { PluginContext, ShoferPlugin } from "@shofer/types"

const plugin: ShoferPlugin = {
	name: "git-guard",

	async initialize(ctx: PluginContext) {
		ctx.host?.notifier.info("git-guard active")
	},

	registerTools(ctx: PluginContext) {
		return [
			defineCustomTool({
				name: "ci_status",
				description: "Fetch the latest CI status for a branch.",
				parameters: z.object({ branch: z.string().describe("Branch name") }),
				async execute({ branch }) {
					// host.fetch is scoped to permissions.network
					const res = await ctx.host!.fetch(`https://ci.acme.example/status?branch=${branch}`)
					return await res.text()
				},
			}),
		]
	},

	lifecycle: {
		// Allow / modify / block — here we block `git push --force`.
		async beforeToolCall(toolName, args, ctx) {
			const blocking = ctx.config?.blockForcePush !== false
			const cmd = typeof args.command === "string" ? args.command : ""
			if (blocking && toolName === "execute_command" && /\bpush\b.*--force\b/.test(cmd)) {
				return { allow: false, reason: "git-guard: force-push is blocked by policy." }
			}
			return { allow: true }
		},
	},
}

export default plugin
```

Install and enable it:

```bash
shofer plugin install ./git-guard --enable
```

Now the model sees a `ci_status` tool (network-scoped), and any attempt to run `git push --force` via
`execute_command` is short-circuited with the guard's reason — unless the user sets
`blockForcePush: false` in the plugin's config.

### A feature as a plugin: Checkpoints (first-party, bundled)

**`plugins/checkpoints/`** is per-task undo history — shadow-git snapshots, the timeline
row with diff/restore, cleanup on task deletion — implemented entirely on the public
surface. It is the reference for a plugin that owns a _feature_ rather than adding a tool:

| What it does                                        | Extension point                                                                                |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Snapshot before a file-mutating tool                | `lifecycle.beforeToolCall`, **awaited**, once per `ctx.turn`, under a manifest `hookTimeoutMs` |
| An anchor per user message                          | `lifecycle.onUserMessage`                                                                      |
| The checkpoint row in the chat                      | **`ctx.task.marker`** + a `chat-message-addon` bundle                                          |
| Diff / restore from that row                        | **`handleRequest`** + `api.request` (incl. the `local:` and `mutates` conventions)             |
| Rewinding the conversation                          | **`ctx.task.rewind`**                                                                          |
| Rolling the workspace back on a message delete/edit | `lifecycle.onTimelineRewind`                                                                   |
| Dropping a deleted task's shadow repo               | `lifecycle.onTaskDeleted`                                                                      |
| Rendering a computed diff                           | **`ctx.host.editor.showMultiFileDiff`**                                                        |
| Being on out of the box                             | manifest `defaultEnabled` (bundled scope only)                                                 |

It also shows the packaging end: `build-ui.mjs` bundles both the UI and `main.mjs` (with
`simple-git` inlined), so the plugin ships with no `node_modules` and packs to a single
`.shofer-plugin` archive.

### A capability-rich plugin: Live Memory (first-party dogfood)

The repo ships **`plugins/live-memory/`** — a real, first-party plugin that re-implements the core of
Shofer's built-in Live Memory using **only** the public plugin surface (no reach into
`@shofer/core` internals). It is the reference for the Phase-6/7 capabilities, exercising most of
them in one plugin. Read its source; it is the canonical worked example.

Its `plugin.json` grants `tools`, `systemPrompt`, `lifecycle`, `events`, `ai`, and
`filesystem: ["."]`, and each capability maps to a public extension point:

| What it does                                     | Extension point                                                                                                    |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| The `ask_live_memory` tool                       | `registerTools`                                                                                                    |
| A memory section appended to the prompt          | `transformSystemPrompt` (gated on `ctx.ai?.hasConsent()`, not a bare `!!ctx.ai`)                                   |
| Answering / summarizing from memory              | **`ctx.ai.buildHandler`** (never sees keys) + the billed-calls consent                                             |
| Persisting observations + Q&A across restarts    | **`ctx.storage`** (its own traversal-blocked dir)                                                                  |
| Observing external edits                         | **`ctx.host.watch(glob, cb)`** — uses the path-carrying `cb(event: { path, type })` to record _which_ file changed |
| Observing Shofer's own file activity             | `lifecycle.afterToolCall` (+ `beforeTaskStart` / `afterTaskComplete`, `onEvent`)                                   |
| Periodic background compaction of the memory log | **`ctx.registerService`** (a supervised `{ name, start, stop }` service)                                           |

Key files: `plugins/live-memory/main.ts` (the `ShoferPlugin`), `memory-store.ts` (the `ctx.storage`
wrapper), `memory-llm.ts` (the `ctx.ai` calls), `system-section.ts` (the prompt section), and
`plugin.json` (the manifest + `config` schema). **`plugins/live-memory/DOGFOOD.md`** documents the
full built-in → plugin-API mapping, the reduced-fidelity notes, and the one genuine gap (the
external-edit watch granularity) that Phase 7's path-carrying watch closed.

---

## Reference

- Manifest schema, `ShoferPlugin`, `PluginContext`, `PluginHost`, `PluginAi`, `PluginStorage`,
  `PluginService`, `PluginUIApi`: `packages/types/src/plugin.ts`
- Runtime (manager/loader/registry/sandbox/ai/storage/services/pack): `packages/core/src/plugins/`
- CLI: `apps/cli/src/commands/plugin/`
- UI: `webview-ui/src/components/settings/PluginsSettings.tsx`,
  `webview-ui/src/components/marketplace/PluginsTab.tsx`,
  `webview-ui/src/components/plugins/` (`PluginSlot`, component resolver)
- Worked examples: `plugins/live-memory/` (+ `plugins/live-memory/DOGFOOD.md`) and
  `plugins/checkpoints/` (+ its `DESIGN.md`) — the latter is a whole _feature_
  (per-task undo history) living outside core on `beforeToolCall` + `ctx.task` +
  `onTimelineRewind` + `handleRequest`.
