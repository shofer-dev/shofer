# Plugin System — Design Document

> **📐 Proposed.** Not yet built. This document describes a comprehensive plugin
> system for Shofer that is a strict superset of MCP — it can affect the UI,
> system prompt, tools, modes, hooks, and lifecycle, not just expose callable
> functions.

## Table of Contents

1. [Motivation](#1-motivation)
2. [Design Goals](#2-design-goals)
3. [What Exists Today](#3-what-exists-today)
4. [Architecture Overview](#4-architecture-overview)
5. [Plugin Manifest](#5-plugin-manifest)
6. [Extension Points](#6-extension-points)
7. [Plugin Lifecycle](#7-plugin-lifecycle)
8. [Security Model](#8-security-model)
9. [Distribution & Discovery](#9-distribution--discovery)
10. [Relationship to MCP](#10-relationship-to-mcp)
11. [Relationship to Existing Subsystems](#11-relationship-to-existing-subsystems)
12. [UI Integration](#12-ui-integration)
13. [Implementation Plan](#13-implementation-plan)
14. [Open Questions](#14-open-questions)

---

## 1. Motivation

Shofer currently has several disconnected extension mechanisms:

| Mechanism                                                  | What it extends                   | Limitation                                                                                                                                                                                                                  |
| ---------------------------------------------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **MCP servers**                                            | Tools + resources                 | Can only expose callable functions and readable resources. Cannot affect the system prompt, UI, modes, or lifecycle.                                                                                                        |
| **Custom tools** (`.shofer/tools/`)                        | Tools only                        | File-based TypeScript tools, no lifecycle hooks, no prompt access.                                                                                                                                                          |
| **Private tool providers** (`shofer.privateToolProviders`) | Tools only                        | VS Code extension-registered tools via command channel. No behavioral extension.                                                                                                                                            |
| **Marketplace**                                            | Modes + MCP configs               | Distribution/curation layer only — installs data items (YAML mode definitions, MCP JSON), no runtime behavior.                                                                                                              |
| **Skills** (`.shofer/skills/`)                             | System prompt (lazy)              | Markdown instructions loaded on-demand. No code execution, no hooks.                                                                                                                                                        |
| **`ShoferPlugin` interface** (§10 scaffold)                | Tools + prompt transform + events | Typed API exists ([`plugin.ts`](../packages/types/src/plugin.ts)) and is wired ([`plugin-registry.ts`](../packages/core/src/plugins/plugin-registry.ts)), but has only 3 hooks and no discovery, manifest, or distribution. |

None of these can do what Claude Code's plugin system does: **a single package
that bundles tools, prompt modifications, UI contributions, mode definitions,
hooks, and lifecycle handlers** — all declaratively described and safely
sandboxed.

### The Gap

A third party who wants to extend Shofer must today:

1. Write an MCP server (for tools) — separate process, separate language, no prompt/UI access.
2. Write a custom mode YAML (for mode-level restrictions) — no code.
3. Write skills (for prompt instructions) — no code, no hooks.
4. Write a VS Code extension (for UI/private tools) — heavy, platform-specific.

The plugin system unifies all of these into **one package format with one
manifest**, while remaining a strict superset of MCP (MCP servers are one kind
of plugin contribution).

---

## 2. Design Goals

1. **Superset of MCP.** A plugin can do everything an MCP server can (expose tools/resources) plus everything Shofer-internal (modify the system prompt, contribute UI components, register modes, hook into lifecycle events, affect auto-approval).

2. **Declarative manifest.** A `plugin.json` manifest declares what the plugin contributes. Shofer reads the manifest and wires up the extension points without the plugin needing to know Shofer internals.

3. **Host-agnostic.** Plugins use the same `HostBridge` (`getHost()`) seam as the core. A plugin runs identically in the VS Code extension, the CLI, and a future headless server. No `vscode` imports in plugin code.

4. **Sandboxed.** Plugins are loaded with restricted permissions. The manifest declares what resources the plugin needs (filesystem paths, network endpoints, settings keys). Shofer enforces these at runtime.

5. **Composable.** Multiple plugins coexist. Extension points have defined composition semantics (e.g., system-prompt transforms chain in priority order; tool contributions merge; UI contributions slot into named regions).

6. **Distributable.** Plugins are packaged as `.shofer-plugin` archives (tarball with `plugin.json` + code). The marketplace becomes a plugin directory. Installation is one click.

7. **Safe failure.** A crashing plugin is isolated. Its tools disappear, its prompt transforms are skipped, its UI components unmount — but the rest of Shofer keeps working.

---

## 3. What Exists Today

### Plugin substrate (§10 — scaffolded, wired, minimal)

The `ShoferPlugin` interface ([`packages/types/src/plugin.ts`](../packages/types/src/plugin.ts)) and `PluginRegistry` ([`packages/core/src/plugins/plugin-registry.ts`](../packages/core/src/plugins/plugin-registry.ts)) are built and wired:

```typescript
export interface ShoferPlugin {
	readonly name: string
	initialize?(context: PluginContext): void | Promise<void>
	registerTools?(context: PluginContext): CustomToolDefinition[] | Promise<CustomToolDefinition[]>
	transformSystemPrompt?(prompt: string, context: PluginContext): string | Promise<string>
	onEvent?(event: PluginEvent, context: PluginContext): void
}
```

Wiring points (live today):

| Call site                                      | File                                                             | What it does                                                                                           |
| ---------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `pluginRegistry.collectTools()`                | [`build-tools.ts:361`](../packages/core/src/task/build-tools.ts) | Plugin-contributed tools are registered into `customToolRegistry` and assembled into the LLM tool set. |
| `pluginRegistry.applySystemPromptTransforms()` | [`system.ts:207`](../packages/core/src/prompts/system.ts)        | System prompt is threaded through all plugin transforms in registration order.                         |
| `pluginRegistry.dispatchEvent()`               | [`extension.ts:215`](../src/extension.ts)                        | Every `TelemetryService.onEvent` is forwarded to plugin `onEvent` observers.                           |

This is the **seed** — 3 hooks, no manifest, no discovery, no distribution. The
design below grows this into a full plugin system.

> **⚠️ Wired to fire, but dormant.** The three hook paths above are live, but
> nothing ever calls `pluginRegistry.register()` — there is no discovery or
> registration path, so the registry is always empty and no hook can currently
> fire. Building that registration path (via `PluginManager`, step 1.2) is the
> real starting point of Phase 1, not an enhancement to an already-running system.

### Other extension surfaces (to be unified)

| Surface                       | Will become                  | Plugin contribution type                     |
| ----------------------------- | ---------------------------- | -------------------------------------------- |
| `.shofer/shofermodes`         | `modes` contribution         | Plugin ships mode YAML inline                |
| `.shofer/skills/`             | `skills` contribution        | Plugin ships SKILL.md files                  |
| `.shofer/mcp.json`            | `mcpServers` contribution    | Plugin declares MCP server configs           |
| `.shofer/commands/`           | `commands` contribution      | Plugin ships slash commands                  |
| `.shofer/rules/`              | `rules` contribution         | Plugin ships rules markdown                  |
| `shofer.privateToolProviders` | `toolProviders` contribution | Plugin registers via private command channel |

---

## 4. Architecture Overview

```
┌──────────────────────────────────────────────────────────────┐
│                    Shofer Extension Host                       │
│                                                               │
│  ┌─ PluginManager ─────────────────────────────────────────┐ │
│  │  • Discovers plugins (.shofer/plugins/ + global)        │ │
│  │  • Reads plugin.json manifests                          │ │
│  │  • Validates permissions & dependencies                 │ │
│  │  • Loads plugin code (esbuild transpile for .ts)        │ │
│  │  • Registers into PluginRegistry                        │ │
│  │  • Manages lifecycle (enable/disable/uninstall)         │ │
│  └──────────────────────────────────────────────────────────┘ │
│                          │                                     │
│          ┌───────────────┼───────────────┐                    │
│          ▼               ▼               ▼                    │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐          │
│  │ PluginRegistry│ │ UI Registry  │ │ Mode Registry│          │
│  │ (tools,      │ │ (webview     │ │ (mode defs   │          │
│  │  prompt,     │ │  components, │ │  from plugin)│          │
│  │  events)     │ │  commands)   │ │              │          │
│  └──────┬───────┘ └──────┬───────┘ └──────┬───────┘          │
│         │                │                │                   │
│         ▼                ▼                ▼                   │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │              Shofer Core (Task, Tools, Prompts)          │ │
│  │  Calls plugin hooks at:                                  │ │
│  │   • Tool assembly (build-tools.ts)                       │ │
│  │   • System prompt generation (system.ts)                 │ │
│  │   • Mode resolution (getFullModeDetails.ts)              │ │
│  │   • Lifecycle events (Task lifecycle, ask/approve)       │ │
│  │   • UI rendering (webview postMessage bridge)            │ │
│  └──────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

### Directory layout

```
<workspace>/.shofer/plugins/
  ├── my-plugin/
  │   ├── plugin.json          ← manifest
  │   ├── index.ts             ← entry point (or index.js)
  │   ├── tools/               ← tool definitions
  │   ├── modes/               ← mode YAML files
  │   ├── skills/              ← SKILL.md files
  │   ├── commands/            ← slash command .md files
  │   └── webview/             ← webview UI contributions (optional)
  └── another-plugin/
      └── ...

~/.shofer/plugins/             ← global plugins (all workspaces)
```

---

## 5. Plugin Manifest

### `plugin.json`

```jsonc
{
	"name": "my-org-ci",
	"version": "1.0.0",
	"description": "CI/CD integration — Jenkins/GitLab Actions tools, deployment modes, and pipeline visualization.",
	"author": "DevOps Team",
	"homepage": "https://github.com/my-org/shofer-ci-plugin",
	"license": "MIT",

	// Minimum Shofer version required
	"shoferVersion": ">=1.0.0",

	// Entry point (relative to plugin dir). If omitted, plugin is purely
	// declarative (modes, skills, commands, MCP configs — no code hooks).
	"main": "index.ts",

	// Permissions the plugin requests (all default to denied)
	"permissions": {
		"tools": true, // Can register tools
		"systemPrompt": true, // Can transform the system prompt
		"modes": true, // Can contribute mode definitions
		"skills": true, // Can contribute skills
		"commands": true, // Can contribute slash commands
		"rules": true, // Can contribute rules markdown
		"mcpServers": true, // Can declare MCP server configs
		"ui": ["chat-input-toolbar", "task-header"], // UI regions to contribute to
		"lifecycle": true, // Can hook into task lifecycle
		"events": true, // Can observe telemetry/lifecycle events
		"network": ["https://jenkins.my-org.com", "https://gitlab.com/api/v4"],
		"filesystem": ["./ci-config/", "./.pipeline/"],
	},

	// Declarative contributions (no code needed for these)
	"contributes": {
		"modes": [
			{
				"slug": "deploy",
				"name": "🚀 Deploy",
				"roleDefinition": "You are a deployment specialist...",
				"tools": ["read", "execute", "mcp"],
				"customInstructions": "Use the CI tools to deploy...",
			},
		],
		"skills": [{ "name": "deploy-to-staging", "description": "Deploy the current branch to staging" }],
		"commands": [
			{ "name": "deploy", "description": "Deploy the current project", "argumentHint": "<environment>" },
		],
		"mcpServers": {
			"jenkins": {
				"type": "streamable-http",
				"url": "https://jenkins.my-org.com/mcp",
				"headers": { "Authorization": "Bearer ${env:JENKINS_TOKEN}" },
			},
		},
		"rules": [{ "path": "rules/deploy-rules.md", "modes": ["deploy", "code"] }],
	},

	// Plugin-level dependencies (other plugins that must be installed)
	"dependencies": ["git-integration"],

	// Configuration schema (user-configurable settings for this plugin)
	"config": {
		"type": "object",
		"properties": {
			"jenkinsUrl": { "type": "string", "description": "Jenkins base URL" },
			"defaultEnvironment": { "type": "string", "enum": ["staging", "production"], "default": "staging" },
		},
	},
}
```

### Manifest validation

The manifest is validated against a Zod schema (`pluginManifestSchema`) in
`@shofer/types`. Unknown fields are rejected (fail-closed). The `permissions`
block is the security contract — Shofer checks every plugin API call against
the declared permissions.

---

## 6. Extension Points

### 6.1 Tools (`registerTools`)

Already wired via `PluginRegistry.collectTools()`. A plugin returns
`CustomToolDefinition[]` and they are merged into the tool set.

**New:** Plugin tools carry a `source: "plugin:<name>"` tag for attribution
in the UI and auto-approval.

### 6.2 System Prompt Transform (`transformSystemPrompt`)

Already wired via `PluginRegistry.applySystemPromptTransforms()`. Plugins
chain in priority order (manifest `priority` field, default = registration
order). A throwing plugin is skipped.

**New:** The `PluginContext` is enriched with:

```typescript
export interface PluginContext {
	workspacePath?: string
	mode?: string
	taskId?: string // NEW: current task ID
	cwd?: string // NEW: current working directory
	config?: Record<string, unknown> // NEW: plugin's user-configured settings
	host?: HostBridge // NEW: host-agnostic API access (getHost())
}
```

### 6.3 Modes (`contributes.modes`)

A plugin ships mode definitions in its manifest. These are merged into the
mode resolution chain alongside `.shofer/shofermodes` and built-in modes.

**Precedence:** Built-in < global `custom_modes.yaml` < project `.shofer/shofermodes` < **plugin modes** < user overrides.

Plugin modes are tagged `source: "plugin:<name>"` so the user can see which
plugin contributed which mode.

> **Schema change required.** `ModeConfig.source` in
> [`packages/types/src/mode.ts`](../packages/types/src/mode.ts) is currently a
> closed enum (`z.enum(["global", "project"])`), so a `"plugin:*"` source
> fails validation today. This applies wherever the design proposes a
> `source: "plugin:<name>"` tag (§6.1 tools, §6.3 modes, §11). The enum must be
> widened (e.g. add a `"plugin"` variant plus a separate `pluginName` field, or
> switch to a discriminated union) as a prerequisite for attribution.

### 6.4 Skills (`contributes.skills`)

A plugin ships `SKILL.md` files. These are discovered by `SkillsManager`
alongside `.shofer/skills/` and `~/.shofer/skills/`.

**Precedence:** `~/.agents/skills/` < `{project}/.agents/skills/` < `~/.shofer/skills/` < `{project}/.shofer/skills/` < **plugin skills**.

### 6.5 Slash Commands (`contributes.commands`)

A plugin ships `.md` command files. These are discovered by the command
service alongside `.shofer/commands/`.

**Precedence:** Built-in < global `~/.shofer/commands/` < project `.shofer/commands/` < **plugin commands**.

### 6.6 MCP Integration (three modes)

A plugin can interact with MCP in three distinct ways, from simplest to most
powerful:

#### Mode A: Plugin bundles an MCP server (declarative)

A plugin declares MCP server configs in its manifest. Shofer's `McpHub`
connects to them alongside `.shofer/mcp.json` entries.

```jsonc
{
	"contributes": {
		"mcpServers": {
			"my-database": {
				"type": "stdio",
				"command": "node",
				"args": ["${SHOFER_PLUGIN_ROOT}/server.js"],
				"env": { "DB_PATH": "${SHOFER_PLUGIN_DATA}/db.sqlite" },
			},
		},
	},
}
```

The MCP server runs as a **separate process** managed by `McpHub`. This is
the simplest integration — no Shofer-specific code, just standard MCP protocol.
The plugin package includes the server binary/script.

**Use case:** A plugin that wraps an existing MCP server (e.g., a database
query tool) and additionally contributes Shofer-specific content (a mode,
a skill, a UI badge showing connection status).

#### Mode B: Plugin IS an in-process MCP server (programmatic)

A plugin registers itself as an MCP server **in-process** — no separate
process, no stdio/SSE transport. The plugin's tools are exposed through the
MCP tool protocol but execute in the extension host with full `PluginContext`
access.

```typescript
// plugin entry point (index.ts)
export default {
	name: "code-analyzer",
	async initialize(ctx) {
		// Register as an in-process MCP server
		ctx.mcp.registerServer("code-analyzer", {
			// Tools exposed via MCP protocol — but executed in-process
			tools: [
				{
					name: "analyze_complexity",
					description: "Analyze code complexity for a file",
					inputSchema: { type: "object", properties: { path: { type: "string" } } },
					execute: async (args) => {
						// Full PluginContext access — workspace, mode, task, host
						const content = await ctx.host.fs.readFile(`${ctx.workspacePath}/${args.path}`)
						return { content: [{ type: "text", text: analyze(content) }] }
					},
				},
			],
			// Resources exposed via MCP protocol
			resources: [
				{
					uri: "complexity://summary",
					name: "Complexity Summary",
					read: async () => ({ contents: [{ type: "text", text: "..." }] }),
				},
			],
		})
	},
}
```

**Advantages over Mode A:**

- No process management — the MCP server lives in the extension host.
- Full `PluginContext` access — tools can read workspace state, task context,
  plugin config, and use `getHost()` for filesystem/LSP/terminal operations.
- Lower latency — no IPC overhead.
- The same tools can also participate in Shofer's tool system directly (via
  `registerTools`) with richer `CustomToolDefinition` types, while also being
  exposed over MCP for external consumers.

**Implementation:** `PluginRegistry` gains a `registerMcpServer(name, impl)`
method. The implementation is an `InProcessMcpServer` that satisfies the MCP
tool/resource protocol but executes callbacks in-process. `McpHub` treats
in-process servers identically to stdio/SSE servers — tools appear in the
LLM catalog, resources appear in `access_mcp_resource`, auto-approval uses
the same group-based gating.

**Use case:** A code analysis plugin that needs workspace-aware tools (read
files, query LSP) and also wants to be discoverable as an MCP server so
external tools (Claude Desktop, other editors) can use the same analysis
capabilities.

#### Mode C: Plugin exposes Shofer as an MCP server host (external)

A plugin (or Shofer itself) can expose **all** registered tools — native,
plugin-contributed, and MCP-aggregated — as a single MCP server endpoint
that external MCP clients can connect to.

```
External MCP Client (Claude Desktop, other editor)
        │
        │ MCP protocol (stdio/SSE/streamable-http)
        ▼
┌─────────────────────────────────────────────┐
│  Shofer as MCP Server Host                   │
│                                              │
│  Aggregates tools from:                      │
│    • Native Shofer tools (read_file, etc.)   │
│    • Plugin-contributed tools                │
│    • Other MCP servers (Mode A/B)            │
│                                              │
│  Exposes them as a single MCP tool catalog   │
│  to external clients                         │
└─────────────────────────────────────────────┘
```

This turns Shofer into a **tool aggregator** — it becomes the single MCP
endpoint that external tools connect to, rather than each tool needing its
own MCP server.

**Implementation:** Shofer's transport layer
([`packages/core/src/transport/`](../packages/core/src/transport/)) already
has the HTTP/SSE server infrastructure (§10 of the v3 architecture). A new
`McpHostServer` adapter exposes the aggregated tool catalog over the MCP
protocol. Plugin tools registered via `registerTools()` or
`registerMcpServer()` are automatically included.

**Use case:** A team wants all developers to use the same set of internal
tools (deploy, CI status, security scan) regardless of which AI coding
assistant they use. They install one Shofer plugin that registers all the
tools, and Shofer exposes them as an MCP server. Claude Code, Cursor, Zed,
and any other MCP client connect to Shofer's MCP endpoint.

#### Summary: MCP integration modes

| Mode  | What                         | Process model                | Plugin code?                     | External clients?         |
| ----- | ---------------------------- | ---------------------------- | -------------------------------- | ------------------------- |
| **A** | Plugin bundles an MCP server | Separate process (stdio/SSE) | Server code in plugin package    | Yes (standard MCP)        |
| **B** | Plugin IS an MCP server      | In-process (extension host)  | Yes (`ctx.mcp.registerServer()`) | Yes (via Mode C)          |
| **C** | Shofer as MCP server host    | Shofer process               | No (infrastructure)              | Yes (aggregated endpoint) |

**All three modes compose:** A plugin can bundle an MCP server (Mode A),
register additional in-process MCP tools (Mode B), and Shofer can expose
everything to external clients (Mode C).

### 6.7 Rules (`contributes.rules`)

A plugin ships rules markdown files, optionally scoped to specific modes.
These are injected into the system prompt's `addCustomInstructions()` path.

### 6.8 UI Components (`permissions.ui`)

**The key differentiator from MCP.** A plugin can contribute React components
that render in designated Shofer UI regions:

| Region ID            | Location                                                  | What plugins can render                        |
| -------------------- | --------------------------------------------------------- | ---------------------------------------------- |
| `chat-input-toolbar` | ChatTextArea toolbar (next to ModeSelector, SkillsButton) | Custom buttons, dropdowns, indicators          |
| `task-header`        | TaskHeader (expanded state)                               | Status badges, info rows, action buttons       |
| `settings-tab`       | SettingsView (new tab per plugin)                         | Full settings panel for plugin configuration   |
| `chat-message-addon` | Below specific ChatRow messages                           | Inline annotations, action buttons per message |
| `sidebar-panel`      | New panel in the Shofer sidebar                           | Custom dashboard/view                          |

**Implementation:** Plugins declare UI contributions as **webview-safe
JavaScript modules** that export React components. Shofer loads them in a
sandboxed iframe (like the Slang visualization) or via dynamic import with
a restricted API surface (`PluginUIApi`).

```typescript
// Plugin webview contribution (my-plugin/webview/deploy-button.tsx)
export function DeployButton({ context }: { context: PluginUIContext }) {
  return <button onClick={() => context.postMessage({ type: "deploy" })}>🚀 Deploy</button>
}
```

The `PluginUIApi` provides:

- `postMessage(msg)` — send a message to the plugin's background code
- `context` — current workspace, mode, task info (read-only)
- `theme` — VS Code theme variables (for CSS variable resolution)

### 6.9 Lifecycle Hooks (`permissions.lifecycle`)

**New extension point.** A plugin can hook into task lifecycle events and
execute code:

```typescript
export interface LifecycleHooks {
	/** Called before a task starts. Can modify the initial prompt. */
	beforeTaskStart?(context: TaskLifecycleContext): Promise<string | void>

	/** Called after a task completes. */
	afterTaskComplete?(context: TaskLifecycleContext): Promise<void>

	/** Called before a tool is executed. Can block or modify the call. */
	beforeToolCall?(
		toolName: string,
		args: Record<string, unknown>,
		context: PluginContext,
	): Promise<{ allow: boolean; modifiedArgs?: Record<string, unknown> }>

	/** Called after a tool executes. Can modify the result. */
	afterToolCall?(
		toolName: string,
		args: Record<string, unknown>,
		result: string,
		context: PluginContext,
	): Promise<string | void>

	/** Called before an ask is shown to the user. Can auto-approve/deny. */
	beforeAsk?(
		askType: string,
		payload: unknown,
		context: PluginContext,
	): Promise<{ decision: "approve" | "deny" | "ask" } | void>
}
```

This enables:

- **Policy plugins** — enforce org rules (block `rm -rf`, require code review before `attempt_completion`).
- **Integration plugins** — auto-approve known-safe commands, log all tool calls to an external SIEM.
- **Workflow plugins** — inject context before task start, post results to external systems.

### 6.10 Events (`onEvent`)

Already wired via `pluginRegistry.dispatchEvent()`. Every telemetry event is
forwarded. The `PluginEvent` type is enriched with typed event names:

```typescript
export interface PluginEvent {
	readonly name: PluginEventName // typed union, not just string
	readonly properties?: Record<string, unknown>
	readonly taskId?: string // NEW: task that emitted the event
	readonly timestamp?: number // NEW: when the event occurred
}
```

---

## 7. Plugin Lifecycle

```
Discovery → Manifest Validation → Permission Check → Load Code → Register → Initialize → Active
                                                                                │
                                                           Disable/Uninstall ←──┘
```

### Discovery

`PluginManager` scans:

1. `~/.shofer/plugins/` (global)
2. `{workspace}/.shofer/plugins/` (project)

Each subdirectory with a `plugin.json` is a candidate.

### Manifest validation

`pluginManifestSchema.safeParse(manifest)` — invalid manifests are skipped
with a warning logged to the output channel.

### Permission check

The user sees a consent dialog when a plugin is first discovered:

```
┌──────────────────────────────────────────────────────────┐
│  Plugin "my-org-ci" requests:                            │
│                                                          │
│  🔧 Register tools                                       │
│  📝 Modify system prompt                                 │
│  🎨 Contribute UI components (chat-input-toolbar)        │
│  🌐 Network access (jenkins.my-org.com, gitlab.com)     │
│  📁 Filesystem access (./ci-config/)                     │
│  ⚡ Hook into task lifecycle                             │
│                                                          │
│  [Enable]  [Enable for this workspace]  [Skip]          │
└──────────────────────────────────────────────────────────┘
```

### Code loading

If `main` is specified:

- `.ts` files are transpiled via the existing `esbuild-runner.ts` (same as custom tools).
- `.js` files are loaded directly via dynamic `import()`.
- The plugin's default export must be a `ShoferPlugin` object.

### Registration

`pluginRegistry.register(plugin, context)` — same as today, but `context`
includes the plugin's config values (from `config` schema + user settings).

### Enable/Disable/Uninstall

- **Disable:** Plugin is removed from the registry. Its tools, modes, skills, commands disappear. Its UI components unmount. Its MCP servers disconnect.
- **Enable:** Plugin is re-registered (code is re-loaded if needed).
- **Uninstall:** Plugin directory is deleted. All contributions are removed.

State is persisted in `globalState` under `shofer.plugins.enabledPlugins: string[]`.

---

## 8. Security Model

### Permission boundaries

| Permission     | What it allows                       | Risk                                                                                                  |
| -------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `tools`        | Register LLM-callable tools          | Tool code runs in the extension host with full `getHost()` access. Tools are gated by auto-approval.  |
| `systemPrompt` | Modify the system prompt             | Can inject instructions that change agent behavior. User sees the diff in Settings.                   |
| `modes`        | Contribute mode definitions          | Can restrict or expand tool access per mode. Subject to user mode-override.                           |
| `ui`           | Render React components in Shofer    | Components run in a sandboxed context with `PluginUIApi` (no direct `vscode` access).                 |
| `lifecycle`    | Hook into task lifecycle             | `beforeToolCall` can block/modify tool calls. `beforeAsk` can auto-approve/deny. High trust required. |
| `network`      | Make HTTP requests to listed domains | Plugin code can call `fetch()` to listed domains only. Other domains are blocked.                     |
| `filesystem`   | Read/write listed paths              | Plugin code can access `getHost().fs` for listed paths only.                                          |

### Sandboxing

- **Code plugins** (with `main`) run in the extension host process but with a **restricted `PluginContext`** that wraps `getHost()` with permission checks.
- **UI plugins** run in a sandboxed iframe or a restricted module scope — no direct `vscode` API, no DOM access to the parent webview.
- **Declarative-only plugins** (no `main`) are inherently safe — they only contribute static files (modes, skills, commands, MCP configs).

### Trust levels

| Level                | Behavior                                                                               |
| -------------------- | -------------------------------------------------------------------------------------- |
| **Trusted**          | All requested permissions granted. Code runs with full `PluginContext`.                |
| **Workspace**        | Permissions granted only in this workspace. Other workspaces must re-consent.          |
| **Declarative-only** | No code execution. Only static contributions (modes, skills, etc.). No consent needed. |

### Audit log

All plugin hook invocations are logged to the Shofer output channel:

```
[plugin:my-org-ci] transformSystemPrompt: +124 chars, -0 chars
[plugin:my-org-ci] beforeToolCall: execute_command → allowed (policy: ci-safe-commands)
[plugin:my-org-ci] registerTools: contributed 3 tools (jenkins-trigger, gitlab-pipeline, deploy-status)
```

---

## 9. Distribution & Discovery

### Package format

A plugin is distributed as a `.shofer-plugin` archive (gzip tarball):

```
my-org-ci-1.0.0.shofer-plugin
  ├── plugin.json
  ├── index.ts (or index.js)
  ├── tools/
  ├── modes/
  ├── skills/
  ├── commands/
  └── webview/
```

### Installation

```bash
# CLI
shofer plugin install /path/to/my-org-ci-1.0.0.shofer-plugin
shofer plugin install https://github.com/my-org/shofer-ci-plugin/releases/download/1.0.0/my-org-ci.shofer-plugin

# Or extract manually
tar xzf my-org-ci-1.0.0.shofer-plugin -C .shofer/plugins/
```

### Marketplace integration

The marketplace ([`marketplace.md`](../docs/marketplace.md)) becomes a **plugin
directory**. Each marketplace item can be:

- A **plugin package** (`.shofer-plugin` archive) — full behavioral extension.
- A **mode** (YAML) — declarative only (backward compatible).
- An **MCP config** (JSON) — declarative only (backward compatible).

The marketplace UI gains a "Plugins" tab alongside "Modes" and "MCP Servers".

### Plugin registry (remote)

A future hosted plugin registry (like npm or VS Code Marketplace) would allow:

```
shofer plugin search "jenkins"
shofer plugin install my-org-ci@latest
shofer plugin update --all
```

This is deferred — the initial implementation uses local directories and
direct archive installation.

---

## 10. Relationship to MCP

**MCP is a subset of plugins.** Every MCP server can be wrapped as a plugin:

```jsonc
// plugin.json for an MCP-wrapping plugin
{
	"name": "filesystem-mcp",
	"version": "1.0.0",
	"main": null, // no code — purely declarative
	"permissions": { "mcpServers": true },
	"contributes": {
		"mcpServers": {
			"filesystem": {
				"type": "stdio",
				"command": "npx",
				"args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
			},
		},
	},
}
```

But a plugin can do **more** than an MCP server:

| Capability                            | MCP                          | Plugin                                       |
| ------------------------------------- | ---------------------------- | -------------------------------------------- |
| Expose tools                          | ✅                           | ✅                                           |
| Expose resources                      | ✅                           | ✅ (via tools or `HostFileSystem` extension) |
| Modify system prompt                  | ❌                           | ✅                                           |
| Contribute modes                      | ❌                           | ✅                                           |
| Contribute skills                     | ❌                           | ✅                                           |
| Contribute slash commands             | ❌                           | ✅                                           |
| Contribute UI components              | ❌                           | ✅                                           |
| Hook into lifecycle                   | ❌                           | ✅                                           |
| Observe events                        | ❌                           | ✅                                           |
| Run in-process (no separate process)  | ❌                           | ✅                                           |
| Access Shofer state (task, mode, cwd) | ❌                           | ✅ (via `PluginContext`)                     |
| Cross-platform (CLI + extension)      | ❌ (MCP is separate process) | ✅ (host-agnostic)                           |

### MCP compatibility

Existing MCP servers continue to work unchanged — `.shofer/mcp.json` and
`mcp_settings.json` are not deprecated. A plugin's `contributes.mcpServers`
is just another source of MCP configs, merged into `McpHub` alongside the
existing sources.

### Migration path

An MCP server author who wants prompt/UI access wraps their server in a
plugin:

1. Create `plugin.json` with `contributes.mcpServers` pointing to the existing server.
2. Add a `main: "index.ts"` with `transformSystemPrompt` to inject context about the MCP tools.
3. Add a UI contribution to render a status badge for the MCP connection.

No MCP protocol changes needed — the plugin just adds Shofer-specific
extensions around it.

---

## 11. Relationship to Existing Subsystems

### `CustomToolRegistry` → absorbed

The existing `CustomToolRegistry` ([`packages/core/src/custom-tools/`](../packages/core/src/custom-tools/))
becomes the implementation behind `registerTools`. Plugin tools are
registered into it with `source: "plugin:<name>"`. The `.shofer/tools/`
directory loading continues to work (it's just another source).

### `SkillsManager` → extended

`SkillsManager.discoverSkills()` gains a new source: plugin-contributed
skills from `contributes.skills`. The discovery order is extended (plugin
skills have higher priority than `.shofer/skills/`).

### `CustomModesManager` → extended

`getAllModes()` includes plugin-contributed modes from `contributes.modes`.
Plugin modes are tagged with `source: "plugin:<name>"`.

### `McpHub` → extended

`McpHub` reads MCP server configs from a new source: plugin manifests
(`contributes.mcpServers`). These are merged with `.shofer/mcp.json` and
`mcp_settings.json`.

### Marketplace → unified

The marketplace installs plugins (`.shofer-plugin` archives) in addition
to the current mode/MCP YAML items. A plugin can contain modes and MCP
configs as declarative contributions — so a marketplace "Install" for a
plugin is a superset of the current mode/MCP install.

---

## 12. UI Integration

### Settings → Plugins tab

A new "Plugins" tab in SettingsView:

```
┌──────────────────────────────────────────────────────────┐
│  Plugins                                                  │
│                                                           │
│  Installed:                                               │
│  ┌──────────────────────────────────────────────────────┐ │
│  │ 🚀 my-org-ci                          v1.0.0  [⚙] [✓] │ │
│  │   CI/CD integration — 3 tools, 1 mode, 1 UI component│ │
│  ├──────────────────────────────────────────────────────┤ │
│  │ 📊 code-metrics                        v0.5.0  [⚙] [✓] │ │
│  │   Code quality metrics — 2 tools, prompt transform   │ │
│  ├──────────────────────────────────────────────────────┤ │
│  │ 🔒 security-policy                     v1.2.0  [⚙] [✓] │ │
│  │   Enforces security rules — lifecycle hooks           │ │
│  └──────────────────────────────────────────────────────┘ │
│                                                           │
│  [Install from file...]  [Browse marketplace]             │
└──────────────────────────────────────────────────────────┘
```

Each plugin row shows:

- Name, version, icon
- Summary of contributions (N tools, N modes, N UI components)
- Settings button (opens plugin config panel)
- Enable/disable toggle

### Chat input toolbar contributions

Plugin UI components in the `chat-input-toolbar` region render as buttons/chips
in `ChatTextArea`, after the existing `SkillsButton`:

```
[Mode ▼] [API ▼] [Auto ▼] [🌿] [⚡] [🎓] [🚀 Deploy] [📊 Metrics]
```

### Task header contributions

Plugin UI components in the `task-header` region render as badges/rows in the
expanded `TaskHeader`:

```
┌──────────────────────────────────────────────────────┐
│  Task: Implement auth module          💻 Code mode   │
│  Tokens: 12.3K / 128K    Cost: $0.04    Time: 2m15s │
│  ──────────────────────────────────────────────────  │
│  🚀 CI Status: passing (last build: 3m ago)         │ ← plugin contribution
│  📊 Coverage: 87% (+2.1% this task)                 │ ← plugin contribution
└──────────────────────────────────────────────────────┘
```

---

## 13. Implementation Plan

### Phase 1: Manifest + declarative contributions (no code)

**Goal:** Plugins that ship only declarative content (modes, skills, commands, MCP configs, rules).

| Step | What                                                 | Files                                                          |
| ---- | ---------------------------------------------------- | -------------------------------------------------------------- |
| 1.1  | `pluginManifestSchema` Zod schema                    | `packages/types/src/plugin.ts`                                 |
| 1.2  | `PluginManager` — discovery, validation, lifecycle   | `packages/core/src/plugins/plugin-manager.ts` (new)            |
| 1.3  | Extend `SkillsManager` to discover plugin skills     | `src/services/skills/SkillsManager.ts`                         |
| 1.4  | Extend `CustomModesManager` to discover plugin modes | `src/core/config/CustomModesManager.ts`                        |
| 1.5  | Extend `McpHub` to read plugin MCP configs           | `packages/core/src/services/mcp/McpHub.ts`                     |
| 1.6  | Extend command discovery to read plugin commands     | `packages/core/src/services/command/commands.ts`              |
| 1.7  | Settings → Plugins tab (list, enable/disable)        | `webview-ui/src/components/settings/PluginsSettings.tsx` (new) |

**Declarative plugins work end-to-end after Phase 1.** No code execution.

> **Reconcile with the v3 host-agnostic carve-out.** The target subsystems are
> at different migration stages. `McpHub` and the command service already live in
> `packages/core` (host-agnostic). `SkillsManager` (`src/services/skills/`) and
> `CustomModesManager` (`src/core/config/`) are **still host-coupled in `src/`** —
> extending them (steps 1.3, 1.4) either lands in host code or waits on their
> carve-out. Sequence Phase 1 against the carve-out so plugin discovery doesn't
> re-couple these subsystems to the VS Code host.

### Phase 2: Code plugins (existing hooks: tools, prompt, events)

**Goal:** Plugins with `main` entry points that use the existing `ShoferPlugin` hooks.

| Step | What                                                          | Files                                                                          |
| ---- | ------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| 2.1  | Plugin code loading (esbuild transpile + dynamic import)      | `packages/core/src/plugins/plugin-loader.ts` (new, reuses `esbuild-runner.ts`) |
| 2.2  | Enrich `PluginContext` with `taskId`, `cwd`, `config`, `host` | `packages/types/src/plugin.ts`                                                 |
| 2.3  | Plugin config schema validation + storage via `ContextProxy`  | `packages/types/src/global-settings.ts` (new key: `pluginConfigs`)             |
| 2.4  | Permission enforcement wrapper around `PluginContext`         | `packages/core/src/plugins/plugin-sandbox.ts` (new)                            |
| 2.5  | Wire `PluginManager` into extension activation                | `src/extension.ts`                                                             |

### Phase 3: Lifecycle hooks

**Goal:** Plugins can hook into `beforeToolCall`, `afterToolCall`, `beforeTaskStart`, `afterTaskComplete`, `beforeAsk`.

| Step | What                                                             | Files                                                            |
| ---- | ---------------------------------------------------------------- | ---------------------------------------------------------------- |
| 3.1  | `LifecycleHooks` interface                                       | `packages/types/src/plugin.ts`                                   |
| 3.2  | `PluginRegistry.applyLifecycleHook()` method                     | `packages/core/src/plugins/plugin-registry.ts`                   |
| 3.3  | Wire `beforeToolCall` into `presentAssistantMessage.ts`          | `packages/core/src/assistant-message/presentAssistantMessage.ts` |
| 3.4  | Wire `beforeAsk` into `Task.ask()`                               | `packages/core/src/task/Task.ts`                                 |
| 3.5  | Wire `beforeTaskStart` / `afterTaskComplete` into task lifecycle | `packages/core/src/task/Task.ts`                                 |

### Phase 4: UI contributions

**Goal:** Plugins can contribute React components to designated UI regions.

| Step | What                                                         | Files                                                               |
| ---- | ------------------------------------------------------------ | ------------------------------------------------------------------- |
| 4.1  | `PluginUIApi` + `PluginUIContext` types                      | `packages/types/src/plugin.ts`                                      |
| 4.2  | UI component registry (maps region → plugin components)      | `packages/core/src/plugins/ui-registry.ts` (new)                    |
| 4.3  | Webview IPC for plugin UI mounting                           | `packages/types/src/vscode-extension-host.ts` (new message types)   |
| 4.4  | `PluginSlot` React component (renders plugin UI in a region) | `webview-ui/src/components/plugins/PluginSlot.tsx` (new)            |
| 4.5  | Mount `PluginSlot` in `ChatTextArea`, `TaskHeader`           | `webview-ui/src/components/chat/ChatTextArea.tsx`, `TaskHeader.tsx` |

### Phase 5: Distribution

**Goal:** `.shofer-plugin` archive format, CLI install, marketplace integration.

| Step | What                                               | Files                                                        |
| ---- | -------------------------------------------------- | ------------------------------------------------------------ |
| 5.1  | Archive pack/unack utilities                       | `packages/core/src/plugins/plugin-pack.ts` (new)             |
| 5.2  | `shofer plugin install/list/remove` CLI commands   | `apps/cli/src/commands/plugin/` (new)                        |
| 5.3  | Marketplace "Plugins" tab                          | `webview-ui/src/components/marketplace/PluginsTab.tsx` (new) |
| 5.4  | Remote plugin registry (deferred — hosted service) | —                                                            |

---

## 14. Open Questions

1. **UI component sandboxing.** Should plugin UI components run in an iframe (like Slang visualization) or via dynamic import with a restricted API? Iframe is safer but limits integration (no shared React context, no theme inheritance without injection). Dynamic import is more flexible but requires careful API surface design.

2. **Plugin versioning.** How to handle breaking changes in the `ShoferPlugin` API? Semver the API surface (`shoferPluginApiVersion` in manifest). Major version bumps require migration.

3. **Plugin dependencies.** If plugin A depends on plugin B, what happens if B is disabled? Fail-closed (A is also disabled) or fail-soft (A runs without B's contributions)?

4. **Hot reload.** Should plugins be hot-reloadable during development? Probably yes — watch the plugin directory and re-register on change (same as `.shofer/shofermodes` watcher).

5. **Remote plugins.** Should Shofer support loading plugins from a remote URL (like a CDN)? This would require code signing and a trust chain. Deferred.

6. **Plugin permissions UI.** How granular should the consent dialog be? One dialog per plugin, or one dialog per permission? Probably per-plugin with expandable details.

7. **Conflict resolution.** If two plugins contribute a mode with the same slug, which wins? Proposal: last-installed wins, with a warning. Or: namespace plugin modes (`plugin:slug`) to avoid collisions entirely.

8. **Performance.** How to measure and limit plugin impact on task startup latency? Plugin hooks (`collectTools`, `transformSystemPrompt`) are on the hot path. Proposal: timeout per hook (default 500ms), async loading (don't block task start on plugin initialization).

---

## 15. Competitive Analysis: OpenCode and Claude Code

### OpenCode plugin system

OpenCode has a sophisticated two-generation plugin architecture. The **V1 API**
([`packages/plugin/src/index.ts`](../../../opencode/packages/plugin/src/index.ts))
returns a `Hooks` object from a setup function. The **V2 API**
([`packages/plugin/src/v2/`](../../../opencode/packages/plugin/src/v2/)) uses
imperative registration during setup — plugins call `ctx.domain.transform()`
and `ctx.domain.hook()` to register behavior.

**Key design patterns from OpenCode:**

| Pattern                         | How OpenCode does it                                                                                                                                                                                                                                                                                                                | Relevance to Shofer                                                                                                                                                                                                 |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **Domain transforms**           | `ctx.agent.transform()`, `ctx.catalog.transform()`, `ctx.command.transform()`, `ctx.skill.transform()` — replayable mutations on a stateful domain editor. Transforms run in order; rebuilds are serialized and coalesced.                                                                                                          | ✅ Adopt: Shofer's mode/skill/command contributions should use the same "transform the domain" model rather than ad-hoc merge logic.                                                                                |
| **Runtime hooks**               | `ctx.tool.hook("execute.before", fn)` — sequential, later hooks see earlier mutations. Not replayed during rebuilds.                                                                                                                                                                                                                | ✅ Already in our design (§6.9). OpenCode confirms the `before`/`after` hook pattern.                                                                                                                               |
| **Plugin ordering**             | Explicit priority: built-ins → base data → config → provider normalization → **user plugins** → core finalization. Same-ID replacement retains position.                                                                                                                                                                            | ✅ Adopt: Shofer needs the same explicit ordering chain.                                                                                                                                                            |
| **Scope-owned registration**    | Every registration is attached to a `Scope`. Closing the scope removes all registrations. `dispose()` removes early.                                                                                                                                                                                                                | ✅ Adopt: Shofer's enable/disable should use the same scoped-registration model.                                                                                                                                    |
| **Boot batching**               | Plugin boot runs in a batch: initialize sequentially → register → collect affected domains → rebuild each once.                                                                                                                                                                                                                     | ✅ Adopt: Shofer should batch plugin initialization to avoid N rebuilds.                                                                                                                                            |
| **Config integration**          | Plugins are declared in `opencode.jsonc` as `"plugin": ["name", {"opt": "val"}]`. Plugin options are available as `ctx.options`.                                                                                                                                                                                                    | ✅ Already in our design (`config` schema in manifest).                                                                                                                                                             |
| **Dual API: Effect + Promise**  | V2 offers both `@opencode-ai/plugin/v2/effect` (Effect-based) and `@opencode-ai/plugin/v2/promise` (async/await). Same capabilities, different async boundary.                                                                                                                                                                      | ✅ Adopt: Shofer should offer a Promise-based API (primary) with an optional Effect-style API for advanced use.                                                                                                     |
| **Rich hook catalog (V1)**      | `chat.message`, `chat.params`, `chat.headers`, `permission.ask`, `tool.execute.before`, `tool.execute.after`, `tool.definition`, `shell.env`, `experimental.chat.system.transform`, `experimental.chat.messages.transform`, `experimental.session.compacting`, `experimental.compaction.autocontinue`, `experimental.text.complete` | ✅ Adopt several: `chat.params` (modify LLM params), `tool.definition` (modify tool schemas before sending to LLM), `experimental.session.compacting` (customize compaction). These are missing from our v1 design. |
| **Auth hooks**                  | `AuthHook` with OAuth/API key flows, prompts, and validation.                                                                                                                                                                                                                                                                       | ⚠️ Consider: Shofer's provider settings are already rich; auth hooks may be overkill initially.                                                                                                                     |
| **Provider hooks**              | `ProviderHook` with `models()` callback to dynamically list models.                                                                                                                                                                                                                                                                 | ⚠️ Consider: Shofer's `llm-router` already handles dynamic model discovery.                                                                                                                                         |
| **Filesystem tools in plugins** | `.opencode/tools/*.ts` — drop a TypeScript file, it becomes a tool. Uses Zod schema, `execute` returns `string                                                                                                                                                                                                                      | { title, output, metadata, attachments }`.                                                                                                                                                                          | ✅ Shofer already has this via `CustomToolRegistry`. OpenCode's `ToolResult` with `attachments` is richer — consider adopting. |

### Claude Code plugin system

Claude Code's plugin system is **manifest-driven and declarative-first**. A
plugin is a directory with a `.claude-plugin/plugin.json` manifest. Components
are discovered by convention (skills in `skills/`, agents in `agents/`, hooks
in `hooks/hooks.json`, MCP in `.mcp.json`, LSP in `.lsp.json`).

**Key design patterns from Claude Code:**

| Pattern                        | How Claude Code does it                                                                                                                                                                                                                                                                                                                                        | Relevance to Shofer                                                                                                                                                                                                                  |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Declarative-first**          | A plugin with no code — just directories of skills, agents, hooks JSON, MCP configs, LSP configs — works out of the box. The manifest is optional (auto-discovery by convention).                                                                                                                                                                              | ✅ Strongly adopt: Shofer's Phase 1 already targets this. Claude Code proves a manifest can be optional for simple plugins.                                                                                                          |
| **Hooks as external commands** | Hooks are shell commands (`"type": "command"`) or HTTP endpoints (`"type": "http"`) or MCP tool calls (`"type": "mcp_tool"`) or LLM prompts (`"type": "prompt"`). No in-process code.                                                                                                                                                                          | ⚠️ Different philosophy. Shofer's in-process hooks (via `ShoferPlugin`) are more powerful but require code loading. **Adopt the command/http hook types** as alternatives to in-process hooks — they're safer and language-agnostic. |
| **Extensive hook catalog**     | 30+ lifecycle events: `SessionStart`, `PreToolUse`, `PostToolUse`, `PermissionRequest`, `PermissionDenied`, `UserPromptSubmit`, `PreCompact`, `PostCompact`, `SubagentStart`, `SubagentStop`, `TaskCreated`, `TaskCompleted`, `Stop`, `Notification`, `FileChanged`, `CwdChanged`, `WorktreeCreate`, `InstructionsLoaded`, `ConfigChange`, `Elicitation`, etc. | ✅ Adopt broadly. Shofer's lifecycle hooks (§6.9) should expand to cover most of these. The `FileChanged`, `CwdChanged`, `InstructionsLoaded` hooks are particularly useful.                                                         |
| **User configuration**         | `userConfig` in the manifest declares fields the user is prompted for at enable time. Values are substituted as `${user_config.KEY}` in commands/configs. Sensitive values go to keychain.                                                                                                                                                                     | ✅ Adopt: Shofer's `config` schema in the manifest is the equivalent. Claude Code's `${user_config.*}` substitution pattern is elegant — adopt it.                                                                                   |
| **Environment variables**      | `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}`, `${CLAUDE_PROJECT_DIR}` — substituted in all paths. `CLAUDE_PLUGIN_DATA` is a persistent directory that survives updates.                                                                                                                                                                                    | ✅ Adopt: `${SHOFER_PLUGIN_ROOT}`, `${SHOFER_PLUGIN_DATA}`, `${SHOFER_PROJECT_DIR}`. The persistent data directory is essential for plugins that install dependencies.                                                               |
| **Namespacing**                | Plugin skills are namespaced: `/plugin-name:skill-name`. Prevents conflicts.                                                                                                                                                                                                                                                                                   | ✅ Adopt: Shofer plugin skills/modes/commands should be namespaced (`plugin-name:skill-name`).                                                                                                                                       |
| **Marketplace**                | Git-hosted marketplace repos (`marketplace.json`). Community + official marketplaces. `claude plugin install name@marketplace`.                                                                                                                                                                                                                                | ✅ Adopt: Shofer's marketplace already has the infrastructure. Extend it to install plugin archives.                                                                                                                                 |
| **Plugin scopes**              | `user` (global), `project` (checked into VCS), `local` (gitignored), `managed` (admin-enforced).                                                                                                                                                                                                                                                               | ✅ Adopt: Shofer already has project/global scope for modes/MCP. Extend to plugins.                                                                                                                                                  |
| **Skills-directory plugins**   | A folder in `~/.claude/skills/` with a `.claude-plugin/plugin.json` auto-loads as `name@skills-dir`. No install step.                                                                                                                                                                                                                                          | ✅ Adopt: Shofer should support `.shofer/plugins/` auto-discovery (already in the design).                                                                                                                                           |
| **Background monitors**        | `monitors/monitors.json` — shell commands that run for the session lifetime, delivering stdout lines to Claude as notifications.                                                                                                                                                                                                                               | ✅ **Strongly adopt.** This is a unique and powerful feature. A plugin that watches a log file or deployment status and proactively notifies the agent.                                                                              |
| **LSP servers**                | `.lsp.json` — configure language servers for code intelligence. Diagnostics pushed into Claude's context after edits.                                                                                                                                                                                                                                          | ✅ **Adopt.** Shofer already has LSP tools (`get_errors`, `list_code_usages`, `rename_symbol`). Plugin-contributed LSP configs would let plugins add language support.                                                               |
| **Themes**                     | `themes/` — JSON color theme files.                                                                                                                                                                                                                                                                                                                            | ⚠️ Low priority. Shofer uses VS Code themes. Could adopt for webview-only themes.                                                                                                                                                    |
| **Output styles**              | `output-styles/` — markdown files that define how Claude formats responses.                                                                                                                                                                                                                                                                                    | ⚠️ Consider. Shofer's modes already control persona/instructions. Output styles are a lighter-weight version.                                                                                                                        |
| **Plugin validation**          | `claude plugin validate` — checks manifest, frontmatter, hooks JSON. `--strict` treats warnings as errors.                                                                                                                                                                                                                                                     | ✅ Adopt: `shofer plugin validate` CLI command.                                                                                                                                                                                      |
| **Token cost estimation**      | `claude plugin details <name>` — shows projected token cost per component (always-on vs on-invoke).                                                                                                                                                                                                                                                            | ✅ **Adopt.** This is excellent UX — users need to know the token cost of enabling a plugin.                                                                                                                                         |
| **Channels**                   | MCP-based message injection (Telegram, Slack, Discord). Plugin declares a `channels` array binding to an MCP server.                                                                                                                                                                                                                                           | ⚠️ Defer. Interesting but niche. Could be a Phase 6 addition.                                                                                                                                                                        |
| **Agent definitions**          | `agents/` — markdown files with frontmatter (`name`, `description`, `model`, `effort`, `maxTurns`, `tools`, `disallowedTools`). Claude invokes them as subagents.                                                                                                                                                                                              | ✅ Adopt: Shofer's modes are the equivalent, but Claude Code's lightweight agent markdown format is simpler. Consider a `contributes.agents` section.                                                                                |

### Design refinements based on research

Based on the competitive analysis, the following changes are made to the v1
design:

#### R1: Adopt command/HTTP hook types (from Claude Code)

In addition to in-process lifecycle hooks (§6.9), support **external hook
types** that don't require code loading:

```jsonc
// In plugin.json contributes.hooks
{
	"PostToolUse": [
		{
			"matcher": "Write|Edit",
			"type": "command",
			"command": "${SHOFER_PLUGIN_ROOT}/scripts/lint.sh",
		},
		{
			"type": "http",
			"url": "https://ci.my-org.com/api/shofer-hook",
		},
	],
}
```

This makes plugins accessible to non-TypeScript authors (shell scripts, Python,
any language) and is safer (no in-process code execution).

#### R2: Add background monitors (from Claude Code)

New contribution type: `contributes.monitors`.

```jsonc
{
	"contributes": {
		"monitors": [
			{
				"name": "error-log",
				"command": "tail -F ./logs/error.log",
				"description": "Application error log",
			},
		],
	},
}
```

Each monitor runs for the task lifetime; stdout lines are delivered to the agent
as system-prompt-injected notifications (same as peer messages, Form A).

#### R3: Add LSP server configs (from Claude Code)

New contribution type: `contributes.lspServers`.

```jsonc
{
	"contributes": {
		"lspServers": {
			"go": {
				"command": "gopls",
				"args": ["serve"],
				"extensionToLanguage": { ".go": "go" },
			},
		},
	},
}
```

These register with Shofer's existing `HostLsp` capability, making language
intelligence available to `get_errors`, `list_code_usages`, and `rename_symbol`.

#### R4: Expand lifecycle hook catalog (from both)

Expand §6.9 to cover the full lifecycle event surface:

| Hook                   | When                               | Source                           |
| ---------------------- | ---------------------------------- | -------------------------------- |
| `beforeTaskStart`      | Before a task starts               | Original design                  |
| `afterTaskComplete`    | After task completes               | Original design                  |
| `beforeToolCall`       | Before tool execution              | Original design                  |
| `afterToolCall`        | After tool execution               | Original design                  |
| `beforeAsk`            | Before showing an ask              | Original design                  |
| `onMessageSubmit`      | When user submits a message        | Claude Code `UserPromptSubmit`   |
| `beforeCompaction`     | Before context compaction          | Claude Code `PreCompact`         |
| `afterCompaction`      | After context compaction           | Claude Code `PostCompact`        |
| `onFileChanged`        | When a watched file changes        | Claude Code `FileChanged`        |
| `onInstructionsLoaded` | When rules/AGENTS.md loaded        | Claude Code `InstructionsLoaded` |
| `onSubtaskSpawn`       | When a subtask is spawned          | Claude Code `SubagentStart`      |
| `onSubtaskComplete`    | When a subtask finishes            | Claude Code `SubagentStop`       |
| `onPermissionRequest`  | When permission dialog appears     | Claude Code `PermissionRequest`  |
| `onToolDefinition`     | Modify tool schema before LLM send | OpenCode `tool.definition`       |
| `onChatParams`         | Modify LLM request parameters      | OpenCode `chat.params`           |

#### R5: Adopt domain transform model (from OpenCode)

Instead of ad-hoc merge logic for modes/skills/commands, use OpenCode's
**domain transform** pattern. Each contribution type is a domain with:

```typescript
ctx.modes.transform((modes) => { modes.add({ slug: "deploy", ... }) })
ctx.skills.transform((skills) => { skills.add({ name: "deploy", ... }) })
ctx.commands.transform((commands) => { commands.add({ name: "deploy", ... }) })
```

Transforms are replayable, ordered, and disposable. When a plugin is disabled,
its transforms are removed and the domain is rebuilt.

This replaces the current design's "merge into resolution chain" approach with
a more principled model.

#### R6: Add environment variable substitution (from Claude Code)

Support `${SHOFER_PLUGIN_ROOT}`, `${SHOFER_PLUGIN_DATA}`,
`${SHOFER_PROJECT_DIR}`, and `${user_config.*}` substitution in:

- MCP server configs
- LSP server configs
- Hook commands
- Monitor commands
- Skill/agent content (non-sensitive only)

#### R7: Add token cost estimation (from Claude Code)

`shofer plugin details <name>` shows:

- Always-on token cost (skill descriptions, agent descriptions, command names)
- Per-component on-invoke cost
- Total projected token budget impact

This helps users decide whether to enable a plugin.

#### R8: Adopt namespacing (from Claude Code)

Plugin-contributed skills, commands, and modes are namespaced:
`plugin-name:skill-name`. This prevents conflicts when multiple plugins
contribute items with the same base name.

Built-in skills/commands/modes (from `.shofer/`) are not namespaced.

---

## 16. Updated Extension Points (consolidated)

After the competitive analysis, the full extension point catalog is:

| #   | Extension point                                       | Type            | Phase | Source                |
| --- | ----------------------------------------------------- | --------------- | ----- | --------------------- |
| 1   | **Tools** (`registerTools`)                           | In-process code | 2     | Existing              |
| 2   | **System prompt transform** (`transformSystemPrompt`) | In-process code | 2     | Existing              |
| 3   | **Modes** (`contributes.modes`)                       | Declarative     | 1     | Original design       |
| 4   | **Skills** (`contributes.skills`)                     | Declarative     | 1     | Original design       |
| 5   | **Slash commands** (`contributes.commands`)           | Declarative     | 1     | Original design       |
| 6   | **MCP servers** (`contributes.mcpServers`)            | Declarative     | 1     | Original design       |
| 7   | **Rules** (`contributes.rules`)                       | Declarative     | 1     | Original design       |
| 8   | **UI components** (`permissions.ui`)                  | In-process code | 4     | Original design       |
| 9   | **Lifecycle hooks** (in-process)                      | In-process code | 3     | Original design + R4  |
| 10  | **Lifecycle hooks** (external)                        | Command/HTTP    | 1     | R1 (from Claude Code) |
| 11  | **Events** (`onEvent`)                                | In-process code | 2     | Existing              |
| 12  | **Background monitors** (`contributes.monitors`)      | Declarative     | 1     | R2 (from Claude Code) |
| 13  | **LSP servers** (`contributes.lspServers`)            | Declarative     | 1     | R3 (from Claude Code) |
| 14  | **Tool definition transform** (`onToolDefinition`)    | In-process code | 3     | R4 (from OpenCode)    |
| 15  | **Chat params transform** (`onChatParams`)            | In-process code | 3     | R4 (from OpenCode)    |
| 16  | **Agent definitions** (`contributes.agents`)          | Declarative     | 1     | From Claude Code      |

**Phase 1 delivers 10 of 16 extension points** with no code execution — purely
declarative contributions plus external command/HTTP hooks.

---

## Related Documents

| Document                                                                                          | Relationship                                                                                         |
| ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| [`docs/marketplace.md`](../docs/marketplace.md)                                                   | Marketplace becomes plugin distribution; §"Plugin substrate" describes the current scaffold          |
| [`docs/v3_architecture.md`](../docs/v3_architecture.md)                                           | §9 (Typed plugin API) and §10 (HTTP API/SDK) — the plugin system is initiative §9's full realization |
| [`docs/adding-new-tools.md`](../docs/adding-new-tools.md)                                         | Plugin tools follow the `CustomToolDefinition` contract                                              |
| [`docs/tool-categories.md`](../docs/tool-categories.md)                                           | Plugin tools are assigned to `ToolGroup`s for mode filtering                                         |
| [`docs/mcp.md`](../docs/mcp.md)                                                                   | MCP servers are one kind of plugin contribution (`contributes.mcpServers`)                           |
| [`docs/skills.md`](../docs/skills.md)                                                             | Plugin skills are discovered alongside `.shofer/skills/`                                             |
| [`docs/built-in-modes.md`](../docs/built-in-modes.md)                                             | Plugin modes merge into the mode resolution chain                                                    |
| [`docs/settings_overlay.md`](../docs/settings_overlay.md)                                         | Plugin config is stored via `ContextProxy` in `globalState`                                          |
| [`docs/host-boundary.md`](../docs/host-boundary.md)                                               | Plugins use `getHost()` — they are host-agnostic by construction                                     |
| [`packages/types/src/plugin.ts`](../packages/types/src/plugin.ts)                                 | The `ShoferPlugin` interface (seed, to be extended)                                                  |
| [`packages/core/src/plugins/plugin-registry.ts`](../packages/core/src/plugins/plugin-registry.ts) | The `PluginRegistry` (seed, to be extended)                                                          |
