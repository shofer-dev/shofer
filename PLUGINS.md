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

| Field                    | Type                | Notes                                                                                         |
| ------------------------ | ------------------- | --------------------------------------------------------------------------------------------- |
| `name`                   | string **required** | Unique id. Must match `^[a-zA-Z0-9][a-zA-Z0-9._-]*$`. Used for ordering, dedupe, namespacing. |
| `version`                | string **required** | Free-form version string.                                                                     |
| `shoferPluginApiVersion` | string              | The plugin-API semver you target (current host API: `1.0.0`). Incompatible ⇒ refused at load. |
| `description`            | string              | Shown in the Plugins UI and `plugin list`.                                                    |
| `author`                 | string              |                                                                                               |
| `homepage`               | string              |                                                                                               |
| `license`                | string              |                                                                                               |
| `shoferVersion`          | string              | Minimum Shofer version (semver range). Not yet enforced.                                      |
| `main`                   | string \| null      | Code entry, relative to the plugin dir. Absent/`null` ⇒ purely declarative.                   |
| `permissions`            | object              | The security contract. See below.                                                             |
| `contributes`            | object              | Declarative modes/skills/commands/mcpServers/rules. See [§4](#4-extension-points).            |
| `dependencies`           | string[]            | Other plugins that must be installed. (Discovery records unmet deps; not fully enforced yet.) |
| `config`                 | object              | JSON-Schema-ish description of user settings. See below.                                      |

### `permissions`

Every capability defaults to **denied**. A contribution is only surfaced, and a code capability only
reachable, when its permission is present. All keys are optional:

| Key            | Type     | Gates                                                                                                             |
| -------------- | -------- | ----------------------------------------------------------------------------------------------------------------- |
| `tools`        | boolean  | `registerTools` contributions.                                                                                    |
| `systemPrompt` | boolean  | `transformSystemPrompt`.                                                                                          |
| `modes`        | boolean  | `contributes.modes`.                                                                                              |
| `skills`       | boolean  | `contributes.skills`.                                                                                             |
| `commands`     | boolean  | `contributes.commands`.                                                                                           |
| `rules`        | boolean  | `contributes.rules`.                                                                                              |
| `mcpServers`   | boolean  | `contributes.mcpServers`.                                                                                         |
| `ui`           | region[] | UI regions the plugin may render into. See [§6](#6-ui-contributions).                                             |
| `lifecycle`    | boolean  | The `lifecycle` hooks. Without it, none of them ever fire.                                                        |
| `events`       | boolean  | `onEvent` observation.                                                                                            |
| `network`      | string[] | Allowed network origins/prefixes for `ctx.host.fetch`.                                                            |
| `filesystem`   | string[] | Allowed paths for `ctx.host.fs` and `ctx.host.watch` (relative entries resolve to plugin root **and** workspace). |
| `ai`           | boolean  | Host LLM/embeddings via `ctx.ai`. **Necessary but not sufficient** — also needs the AI-billing consent (§7).      |

### `config`

A JSON-Schema-ish object (`{ type, properties: { <key>: { default, ... } } }`). Shofer does a
shallow **default-merge**: any `properties.<key>.default` seeds `ctx.config[key]` unless the user has
stored a value (stored values always win). Full type/enum validation of stored values is not yet
enforced — treat `ctx.config` as best-effort typed.

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

| Hook                | Return                              | Effect                                                                                                                                                                          |
| ------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `beforeToolCall`    | `{ allow, modifiedArgs?, reason? }` | **Allow / modify / block.** `modifiedArgs` threads into later hooks and the tool; the first `allow:false` short-circuits the tool (surfaced like a denied tool, with `reason`). |
| `afterToolCall`     | `string \| void`                    | **Observe / transform** the result string. A returned string replaces it for later hooks and the model.                                                                         |
| `beforeAsk`         | `{ decision?, text? } \| void`      | **Modify / auto-answer** an ask. `text` edits the surfaced ask; `decision` of `"approve"`/`"deny"` auto-answers (short-circuit); `"ask"`/absent lets it proceed to the user.    |
| `beforeTaskStart`   | ignored                             | **Observer.** Fire-and-forget (off the latency-critical path). `ctx.prompt` carries the initial prompt.                                                                         |
| `afterTaskComplete` | ignored                             | **Observer.** `ctx.reason` is `"completed"` or `"aborted"`.                                                                                                                     |

---

## 5. The `ctx` (PluginContext) API

Every hook receives a `PluginContext`. Which fields are populated depends on the host and the
plugin's grants:

| Field                  | Availability                                                                   |
| ---------------------- | ------------------------------------------------------------------------------ |
| `workspacePath`        | Active workspace path, if any.                                                 |
| `mode`                 | Current mode slug.                                                             |
| `taskId`               | Id of the task the hook runs for, if applicable.                               |
| `cwd`                  | Current working directory.                                                     |
| `config`               | This plugin's validated, default-merged settings.                              |
| `host`                 | The restricted host surface (below). Present when the host wired its bridge.   |
| `ai`                   | Host LLM/embeddings. Present **only** with `permissions.ai` + a wired AI seam. |
| `storage`              | Per-plugin persistent dir. Present when the host wired a storage base dir.     |
| `registerService(svc)` | Register a background service. Present when the host wired the supervisor.     |

### `ctx.host` — the restricted host surface

Permission-scoped; the shape is always the same, but an out-of-scope call is **denied at runtime**
(throw + shown/logged warning), not hidden from the type. So you always get a clear error, never a
missing API.

- **`host.fs`** — `readFile`/`writeFile`/`exists`/`mkdir`/`delete`/`findFiles`, scoped to
  `permissions.filesystem`. Relative allowlist entries resolve against both the plugin root and the
  workspace.
- **`host.fetch(input, init?)`** — HTTP, scoped to `permissions.network` origins/prefixes.
- **`host.notifier`** — `info`/`warn`/`error`. **Always available** (surfacing messages is safe).
- **`host.env`** — read-only host/environment metadata. Always available.
- **`host.watch(pattern, onChange)`** — watch a glob for create/change/delete, **scoped to
  `permissions.filesystem`** (watches `pattern` under each granted root). Ungranted ⇒ deny + no-op
  disposable. Dispose to stop (the manager also disposes it on plugin disable). Present only when the
  host wired a watcher.

### Phase-6 host capabilities

**`ctx.ai`** (`PluginAi`) — requires `permissions.ai` **and** the user's "uses AI (billed)" consent.

- `buildHandler(profileRef?)` → `Promise<Handler>` — build the **same** `ApiHandler` the main agent
  uses (the host's default profile when `profileRef` is omitted). The plugin never sees raw API keys.
- `embed(texts, profileRef?)` → `Promise<number[][]>` — one embedding vector per input text.

Granted but **not** consented ⇒ `ctx.ai` is present but a _denying stub_ (every call throws + warns,
so the user is never silently billed). Ungranted ⇒ `ctx.ai` is **absent** entirely.

**`ctx.storage`** (`PluginStorage`) — the plugin's own persistent dir at
`<globalStorage>/plugins/<name>/`, independent of `permissions.filesystem`. `readFile`/`writeFile`/
`exists`/`delete`/`list`, all resolved under `dir` and **traversal-blocked** (a `..` escape is
denied). Created lazily, survives restart, removed on uninstall.

**`ctx.registerService(service)`** — register a supervised background service
`{ name, start, stop? }`. `start()` runs when the plugin is enabled+active; `stop()` on
disable/uninstall/deactivate. Each `start`/`stop` is bounded by a **5 s** timeout and error-isolated,
so a hanging or throwing service can never crash the host. Returns a disposable that stops + removes
the service.

---

## 6. UI contributions

A plugin can render React components into named webview **regions**. Declare the regions in
`permissions.ui` — this is both the grant _and_ the declaration (each granted region yields exactly
one contribution). Regions:

- `chat-input-toolbar`
- `task-header`
- `settings-tab`
- `chat-message-addon`
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

> **Current limitation.** First-party / co-bundled UI components (resolved from the webview's
> built-in component registry) work today. Loading a **third-party** plugin's own compiled UI bundle
> is not yet wired — the `source` bundle URL and the CSP/`localResourceRoots` plumbing are a
> follow-up. Until then, UI contributions are practical for first-party/co-bundled components.

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
# Install from a .shofer-plugin archive OR an unpacked plugin directory
shofer plugin install <source> [--enable] [--overwrite]

# List installed plugins and their state (enabled / disabled / inactive)
shofer plugin list [--json]

# Remove a plugin (deletes its dir, drops it from the enabled list)
shofer plugin remove <name>
```

The CLI installs into the **global** dir (`~/.shofer/plugins/<name>`) and shares the enabled
allow-list with the running app, so a plugin installed/enabled here is picked up by the extension and
the Plugins settings tab unchanged. Without `--enable`, a freshly installed plugin stays disabled
(the per-plugin consent gate). `--overwrite` replaces an already-installed plugin of the same name
(the upgrade path).

### Marketplace Plugins tab

The Marketplace's **Plugins** tab lists discovered plugins with enable/disable toggles, an uninstall
action, the "uses AI (billed)" badge + consent affordance, and an **Install from file** button that
opens a native picker for a local `.shofer-plugin` archive.

> **Remote registry install is not available yet** — install is local-only (archive or directory).

---

## 9. A worked example

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

---

## Reference

- Manifest schema, `ShoferPlugin`, `PluginContext`, `PluginHost`, `PluginAi`, `PluginStorage`,
  `PluginService`, `PluginUIApi`: `packages/types/src/plugin.ts`
- Runtime (manager/loader/registry/sandbox/ai/storage/services/pack): `packages/core/src/plugins/`
- CLI: `apps/cli/src/commands/plugin/`
- UI: `webview-ui/src/components/settings/PluginsSettings.tsx`,
  `webview-ui/src/components/marketplace/PluginsTab.tsx`
