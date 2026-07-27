import { z } from "zod"

import type { CustomToolDefinition } from "./custom-tool.js"
import type { HostDiagnostic, HostDisposable, HostEnv, HostFileSystem, HostSymbol, Notifier } from "./host.js"
import { modeConfigObjectSchema } from "./mode.js"

/**
 * Typed plugin API (v3 architecture §10).
 *
 * shofer's existing extensibility centers on the marketplace (data items) and the
 * custom-tool registry (tools only). A plugin generalizes that: a typed object
 * with optional **hooks** that can register tools, transform the system prompt,
 * and observe events — so third parties can extend *behavior*, not just add data.
 *
 * Hooks are all optional and host-agnostic (no `vscode` types), so plugins run in
 * any host (extension, CLI, future server). Distribution stays the marketplace's
 * job; this is the substrate it curates over.
 *
 * This is the contract; `PluginRegistry` (in `@shofer/core`) collects plugins and
 * runs the hooks at the right points. Wiring the registry into the live
 * system-prompt / tool-assembly / event paths is the strangler follow-on.
 */
export interface ShoferPlugin {
	/** Unique plugin name (used for ordering, logging, dedupe). */
	readonly name: string

	/** Called once when the plugin is registered. */
	initialize?(context: PluginContext): void | Promise<void>

	/**
	 * Contribute native/custom tools. Returned definitions are added to the tool
	 * set the model sees (subject to the usual permission/mode gating).
	 */
	registerTools?(context: PluginContext): CustomToolDefinition[] | Promise<CustomToolDefinition[]>

	/**
	 * Transform the system prompt before it is sent. Plugins run in registration
	 * order, each receiving the previous plugin's output.
	 */
	transformSystemPrompt?(prompt: string, context: PluginContext): string | Promise<string>

	/** Observe telemetry/lifecycle events (read-only; must not throw). */
	onEvent?(event: PluginEvent, context: PluginContext): void

	/**
	 * Task/tool **lifecycle hooks** (design §6.9). Only honored for a plugin whose
	 * manifest grants `permissions.lifecycle`; the registry filters on that grant so
	 * an ungranted plugin's hooks never fire. Every hook is run behind the shared
	 * per-hook 500ms timeout and per-plugin error isolation (owner decision #8): a
	 * slow or throwing hook is skipped with a shown+logged warning and can never
	 * crash or stall the agent loop.
	 */
	lifecycle?: LifecycleHooks

	/**
	 * Receive a message from this plugin's UI component(s) over the scoped plugin-UI
	 * channel (design §6.8, Phase 4). The extension routes only messages addressed to
	 * this plugin (namespaced by plugin name), so a plugin can neither observe nor
	 * spoof another's channel. Observer-style: the return value is ignored and it must
	 * not throw (the registry isolates and warns on a throw). A plugin pushes back *to*
	 * its UI via the host-side sender (`ShoferProvider.postPluginUiMessage`).
	 */
	onUiMessage?(message: unknown, context: PluginContext): void | Promise<void>

	/**
	 * Answer a **request/response** call addressed to this plugin (design §5.12). Unlike
	 * {@link onUiMessage} (fire-and-forget, UI-scoped), this is a typed RPC entry the host
	 * awaits and whose result it hands back to the caller — the seam a plugin owning a
	 * *feature* (rather than just a tool) needs so a host surface can query/drive it:
	 *
	 * - a plugin UI component asking its extension side for data to render;
	 * - the controller reaching a plugin running on a **remote executor** over the
	 *   `AgentApi` (`pluginRequest`), which is how per-task plugin state that lives on
	 *   the owning executor stays reachable.
	 *
	 * `method` is plugin-defined; unknown methods should throw. Throwing is safe — the
	 * error is isolated and surfaced to the caller (never silently swallowed), because a
	 * request has a waiting caller that must learn it failed.
	 */
	handleRequest?(method: string, params: unknown, context: PluginContext): Promise<unknown>
}

/**
 * Lifecycle hooks a plugin can implement (design §6.9). All optional. The reducer
 * semantics (how multiple plugins compose, and what each may change) live in the
 * `@shofer/core` `PluginRegistry`:
 *
 * - `beforeToolCall` — **allow / modify params / block**. Plugins run in
 *   registration order; a returned `modifiedArgs` threads into later hooks and the
 *   tool; the first plugin returning `allow: false` short-circuits the tool with an
 *   optional `reason` (surfaced like a denied tool).
 * - `afterToolCall` — **observe / transform the result**. Each plugin sees the prior
 *   plugin's (possibly transformed) result string; returning a string replaces it.
 * - `beforeAsk` — **observe / modify / auto-answer** an ask. A returned `text`
 *   modifies the surfaced ask; a `decision` of `"approve"`/`"deny"` auto-answers it
 *   (short-circuiting the user prompt), `"ask"`/absent lets it proceed.
 * - `beforeTaskStart` / `afterTaskComplete` — **observers** (owner decision for
 *   Phase 3: kept off the latency-critical path, fired non-blocking). Their return
 *   value is ignored in Phase 3.
 */
export interface LifecycleHooks {
	/**
	 * Observe a task starting (design §6.9). Phase 3 treats this as a fire-and-forget
	 * observer (non-blocking, timeout-guarded); any returned value is ignored.
	 */
	beforeTaskStart?(context: TaskLifecycleContext): void | Promise<void>

	/**
	 * Observe a task completing or aborting (design §6.9). Fire-and-forget observer;
	 * {@link TaskLifecycleContext.reason} distinguishes a normal completion from an abort.
	 */
	afterTaskComplete?(context: TaskLifecycleContext): void | Promise<void>

	/**
	 * Called before a tool executes. May allow it (return `{ allow: true }`), modify
	 * its arguments (`{ allow: true, modifiedArgs }`), or block it
	 * (`{ allow: false, reason }`). Blocking short-circuits the tool.
	 */
	beforeToolCall?(
		toolName: string,
		args: Record<string, unknown>,
		context: PluginContext,
	): BeforeToolCallResult | Promise<BeforeToolCallResult>

	/**
	 * Called after a tool executes with its stringified result. Returning a string
	 * replaces the result the model sees; returning nothing observes without change.
	 */
	afterToolCall?(
		toolName: string,
		args: Record<string, unknown>,
		result: string,
		context: PluginContext,
	): string | void | Promise<string | void>

	/**
	 * Called before an ask is surfaced to the user. May modify the ask (`text`) and/or
	 * auto-answer it (`decision`). Returning nothing (or `{ decision: "ask" }`) lets the
	 * ask proceed to the user unchanged.
	 */
	beforeAsk?(
		askType: string,
		payload: unknown,
		context: PluginContext,
	): BeforeAskResult | void | Promise<BeforeAskResult | void>

	/**
	 * Called **before** the host rewinds a task's chat timeline to `info.ts` — the user
	 * deleting/editing a message, or restoring to an earlier point. A plugin holding
	 * out-of-band state anchored to the timeline (a workspace snapshot, an external
	 * job, a cache) uses this to roll *its* state back in step, before the messages it
	 * was anchored to disappear.
	 *
	 * Awaited (the rewind waits for it), so it runs under the plugin's hook budget —
	 * a plugin doing real work here (e.g. a `git reset`) must declare a manifest
	 * `hookTimeoutMs` large enough, or it will be skipped with a warning.
	 */
	onTimelineRewind?(info: TimelineRewindInfo, context: PluginContext): void | Promise<void>

	/**
	 * Called when a task is deleted from history (its messages and task directory are
	 * being removed). The hook for a plugin that keeps **per-task** state outside the
	 * task directory — e.g. a shadow repository under global storage — so deleting a
	 * task doesn't leak it. Fire-and-forget observer; errors are isolated.
	 */
	onTaskDeleted?(info: TaskDeletedInfo, context: PluginContext): void | Promise<void>

	/**
	 * Called when the user sends a message into a running task (a reply, a follow-up,
	 * an interruption) — the moments the *user* thinks of as steps, which the tool-call
	 * hooks cannot see.
	 *
	 * Fire-and-forget observer: it must never make the user wait to be heard.
	 */
	onUserMessage?(info: UserMessageInfo, context: PluginContext): void | Promise<void>

	/**
	 * Called just **before** a tool mutates a workspace file, with the file's content
	 * as it is right now (`before === undefined` ⇒ it does not exist yet).
	 *
	 * This is the seam for a plugin that needs the pre-edit state, and it exists
	 * because only the tool knows what it is about to touch: a path may be embedded in
	 * a patch body, resolved by the language server (a symbol rename hitting N files),
	 * or be the destination of a move. Deriving that from `beforeToolCall`'s arguments
	 * would mean re-implementing every tool's semantics in the plugin — and silently
	 * missing files when one changes.
	 *
	 * Called once per path per mutation, in the tool, on the path that already tracks
	 * file context. Awaited under the plugin's hook budget (the tool waits), because a
	 * "before" snapshot taken after the write is worthless. Errors never reach the tool.
	 */
	beforeFileEdit?(edit: PluginFileEdit, context: PluginContext): void | Promise<void>

	/**
	 * Called **after** a tool mutated a workspace file. The current content is on
	 * disk — deliberately not passed, so a plugin reads only what it actually needs.
	 * Fire-and-forget observer; the tool does not wait.
	 */
	afterFileEdit?(edit: PluginFileEditResult, context: PluginContext): void | Promise<void>
}

/** What a {@link LifecycleHooks.onUserMessage} hook is being told (design §5.9). */
export interface UserMessageInfo {
	readonly taskId: string
	/** The message text, when there was any (a message may be images only). */
	readonly text?: string
	/** How many images the message carried. */
	readonly imageCount?: number
}

/** What a {@link LifecycleHooks.onTimelineRewind} hook is being told (design §5.9). */
export interface TimelineRewindInfo {
	/** Timestamp of the message the timeline is being rewound to. */
	readonly ts: number
	/** Task whose timeline is rewinding. */
	readonly taskId: string
	/**
	 * Why the rewind is happening: the user deleted a message, edited one (the target
	 * message is itself replaced), or explicitly restored to this point.
	 */
	readonly operation: "delete" | "edit" | "restore"
	/**
	 * Whether the user asked for out-of-band state (e.g. the workspace) to be rolled
	 * back too. `false` ⇒ chat-only rewind: a snapshot plugin must NOT touch the
	 * workspace.
	 */
	readonly restoreState: boolean
}

/** A workspace file a tool is about to mutate ({@link LifecycleHooks.beforeFileEdit}). */
export interface PluginFileEdit {
	/** Workspace-relative path, resolved against the **task's** cwd (a worktree task's subdirectory). */
	readonly path: string
	/** The file's content before the mutation; `undefined` when it does not exist. */
	readonly before?: string
}

/** A workspace file a tool has mutated ({@link LifecycleHooks.afterFileEdit}). */
export interface PluginFileEditResult {
	/** Workspace-relative path, resolved against the **task's** cwd. */
	readonly path: string
}

/** What a {@link LifecycleHooks.onTaskDeleted} hook is being told (design §5.9). */
export interface TaskDeletedInfo {
	readonly taskId: string
	/** Workspace the task ran in, when known — needed to locate per-workspace state. */
	readonly workspacePath?: string
}

/**
 * Context handed to the task-level lifecycle observers ({@link LifecycleHooks.beforeTaskStart},
 * {@link LifecycleHooks.afterTaskComplete}). Extends {@link PluginContext} with the
 * task's initial prompt and, for completion, the terminal reason.
 */
export interface TaskLifecycleContext extends PluginContext {
	/** The task's initial prompt (present for `beforeTaskStart`). */
	readonly prompt?: string
	/** Why the task ended, for `afterTaskComplete` (`"completed"` vs `"aborted"`). */
	readonly reason?: "completed" | "aborted"
}

/** Result of a {@link LifecycleHooks.beforeToolCall} hook (design §6.9). */
export interface BeforeToolCallResult {
	/** Whether the tool may run. `false` blocks it (short-circuit with {@link reason}). */
	allow: boolean
	/** Replacement args threaded into the tool and later hooks (honored only when allowed). */
	modifiedArgs?: Record<string, unknown>
	/** Human-readable reason surfaced to the model/user when the call is blocked. */
	reason?: string
}

/** Result of a {@link LifecycleHooks.beforeAsk} hook (design §6.9). */
export interface BeforeAskResult {
	/**
	 * Short-circuit the user prompt: `"approve"`/`"deny"` auto-answers the ask;
	 * `"ask"` (or absent) lets it proceed to the user.
	 */
	decision?: "approve" | "deny" | "ask"
	/** Modified ask text surfaced to the user, or the answer text when auto-answering. */
	text?: string
}

/**
 * The **restricted** host surface handed to a plugin via {@link PluginContext.host}
 * (design §6.2, §8). This is *not* the full `getHost()` `HostBridge`: it exposes
 * only the capabilities the plugin's manifest `permissions` grant, and every call
 * is checked against those permissions at runtime by the plugin sandbox (step 2.4).
 *
 * - {@link fs} — filesystem access, scoped to `permissions.filesystem` paths.
 * - {@link fetch} — network access, scoped to `permissions.network` origins.
 * - {@link notifier} — always available (surfacing messages is inherently safe).
 * - {@link log} — always available; writes to the plugin's own Log category.
 * - {@link env} — read-only host/environment metadata (safe, no side effects).
 *
 * The type shape is the same regardless of which permissions were granted; an
 * out-of-scope call is denied at runtime (deny + shown/logged warning), not hidden
 * from the type — so a plugin author gets a clear runtime error, not a missing API.
 */
/**
 * A minimal structured logger handed to a plugin (see {@link PluginHost.log}). Mirrors
 * the host's `ILogger` shape without depending on it, so `@shofer/types` stays free of
 * `@shofer/core`. Extra args are stringified and appended to the line.
 */
export interface PluginLogger {
	debug(message: string, ...extra: unknown[]): void
	info(message: string, ...extra: unknown[]): void
	warn(message: string, ...extra: unknown[]): void
	error(message: string | Error, ...extra: unknown[]): void
}

export interface PluginHost {
	/** Filesystem access, scoped to the plugin's `permissions.filesystem` allowlist. */
	readonly fs: HostFileSystem
	/**
	 * Surface an info/warning/error message, or ask the user to pick one of a set of
	 * actions (always permitted — asking is as safe as telling, and a plugin that must
	 * confirm a destructive action needs an answer, not a toast).
	 */
	readonly notifier: Pick<Notifier, "info" | "warn" | "error" | "showChoice">
	/**
	 * Scoped logger — always available (logging is inherently safe). Writes to the
	 * plugin's own `Plugin:<name>` Log category (Settings → Logging), so its output can
	 * be filtered independently of the core subsystems and of other plugins. Unlike
	 * {@link notifier} (user-facing toasts), this goes only to the log/output channel.
	 */
	readonly log: PluginLogger
	/** Read-only host/environment metadata. */
	readonly env: HostEnv
	/** HTTP access, scoped to the plugin's `permissions.network` origin allowlist. */
	fetch(input: string | URL, init?: RequestInit): Promise<Response>
	/**
	 * Watch files matching `pattern` (a glob) for create/change/delete, invoking
	 * `onChange` with the **changed path + change kind** on any event (design §6.11 G3;
	 * Phase 6, path-carrying since Phase 7 — see {@link PluginWatchEvent}). **Scoped to
	 * the plugin's `permissions.filesystem` grant**: it watches `pattern` under each
	 * granted root only, so a fired path is always inside a granted root. A plugin without
	 * a filesystem grant gets a deny + warn (no watcher; the returned {@link HostDisposable}
	 * is a no-op). Dispose to stop watching (the manager also disposes it on plugin disable).
	 * Present only when the host wired a watcher.
	 */
	watch?(pattern: string, onChange: (event: PluginWatchEvent) => void): HostDisposable
	/**
	 * Read-only **index / symbol / diagnostics search** over the host's code index, git
	 * history, language service, and diagnostics (design §6.11; the `ctx.host.search`
	 * seam — see {@link PluginSearch}). Gated on `permissions.search`: present only when
	 * the host wired a search provider **and** the plugin was granted `permissions.search`
	 * (live surface); granted-not / provider wired ⇒ a denying stub whose calls throw +
	 * warn; no provider (headless/pure-core) ⇒ absent entirely. This is the seam the
	 * built-in Live Memory's `rag_search` / `git_search` / `list_code_usages` / `get_errors`
	 * reach VS Code providers through — exposed to plugins without leaking `vscode` types
	 * (all results are plain DTOs).
	 */
	readonly search?: PluginSearch
	/**
	 * Editor-surface actions (currently the multi-file diff viewer — see
	 * {@link PluginEditor}). Gated on `permissions.editor`: granted ⇒ live; granted-not
	 * with the seam wired ⇒ a denying stub (calls throw + warn); no seam (headless) ⇒
	 * absent entirely. Kept separate from {@link notifier} because opening editors is a
	 * heavier, focus-stealing action than surfacing a message.
	 */
	readonly editor?: PluginEditor
}

/**
 * Editor actions handed to a plugin granted `permissions.editor`. A plugin that
 * computes a set of before/after file contents (a snapshot diff, a proposed refactor)
 * renders it in the host's own multi-file diff viewer instead of inventing a UI for it.
 * All inputs are plain DTOs, so `@shofer/types` stays browser-safe.
 */
export interface PluginEditor {
	/**
	 * Open the host's native multi-file diff view. `changes` is the same shape the
	 * host editor consumes (`{ paths: { relative, absolute }, content: { before, after } }`).
	 */
	showMultiFileDiff(title: string, changes: PluginFileDiff[]): Promise<void>
	/**
	 * Open a file in the editor. For the case where a plugin just wrote a file the user
	 * is expected to edit next (a generated config) — telling them where it is and
	 * making them find it is worse than showing it.
	 */
	openFile(absolutePath: string): Promise<void>
}

/** One file's before/after content in a {@link PluginEditor.showMultiFileDiff} call. */
export interface PluginFileDiff {
	readonly paths: { readonly relative: string; readonly absolute: string }
	readonly content: { readonly before: string; readonly after: string }
}

/** Options for {@link PluginSearch.ragSearch} (semantic code-index search). */
export interface PluginRagSearchOptions {
	/** Restrict results to files under this workspace-relative directory prefix. */
	directoryPrefix?: string
	/** Maximum number of results to return. */
	maxResults?: number
}

/** One semantic code-index hit (maps to a `VectorStoreSearchResult`). Positions are 1-based. */
export interface PluginRagSearchResult {
	/** Workspace-relative (or absolute, host-dependent) path of the matched file. */
	filePath: string
	/** First line of the matched chunk. */
	startLine: number
	/** Last line of the matched chunk. */
	endLine: number
	/** Similarity score (higher = closer). */
	score: number
	/** The matched code chunk (may be truncated by the host). */
	snippet: string
}

/** Options for {@link PluginSearch.gitSearch} (semantic git-history search). */
export interface PluginGitSearchOptions {
	/** Maximum number of commits to return. */
	maxResults?: number
}

/** One git-history hit (maps to a `GitSearchResult`). */
export interface PluginGitSearchResult {
	/** Full commit hash. */
	commitHash: string
	/** Abbreviated commit hash. */
	shortHash: string
	/** Commit author. */
	author: string
	/** Author date (as recorded by the index). */
	authorDate: string
	/** Commit subject line. */
	subject: string
	/** Commit body (may be empty). */
	body: string
	/** Similarity score (higher = closer). */
	score: number
}

/** Options for {@link PluginSearch.codeUsages} (workspace-symbol lookup). */
export interface PluginCodeUsagesOptions {
	/** Restrict results to a single file (workspace-relative or absolute). */
	filePath?: string
	/** Maximum number of symbols to return. */
	maxResults?: number
}

/**
 * Read-only **index / symbol / diagnostics** queries handed to a plugin granted
 * `permissions.search` (design §6.11; the `ctx.host.search` seam). Every result is a
 * plain DTO ({@link PluginRagSearchResult} / {@link PluginGitSearchResult} /
 * {@link HostSymbol} / {@link HostDiagnostic}) so `@shofer/types` stays browser-safe —
 * no `vscode` types cross the boundary. The concrete queries live host-side behind
 * core's `PluginSearchProvider` seam (mirroring {@link PluginAi} / {@link PluginAgent}),
 * so headless/pure-core hosts that wire no provider simply omit `ctx.host.search`.
 *
 * Each method is **fail-soft**: when the backing service is absent/unconfigured (e.g. the
 * code index is off) the host returns an empty result rather than throwing, so a plugin
 * can probe capabilities without special-casing. (A *denying stub* — granted-not — is the
 * one case that throws, mirroring the other capability seams.)
 */
export interface PluginSearch {
	/** Semantic code-index search (maps to the host `CodeIndexManager.searchIndex`). */
	ragSearch(query: string, opts?: PluginRagSearchOptions): Promise<PluginRagSearchResult[]>
	/** Semantic git-history search (maps to the host `GitIndexManager.searchIndex`). */
	gitSearch(query: string, opts?: PluginGitSearchOptions): Promise<PluginGitSearchResult[]>
	/** Workspace symbols matching `symbol` (maps to `vscode.executeWorkspaceSymbolProvider`). */
	codeUsages(symbol: string, opts?: PluginCodeUsagesOptions): Promise<HostSymbol[]>
	/**
	 * Current workspace diagnostics (maps to `vscode.languages.getDiagnostics`), optionally
	 * filtered to files under `path` (workspace-relative prefix). Empty on a headless host.
	 */
	diagnostics(path?: string): Promise<HostDiagnostic[]>
}

/**
 * A single file-watch event delivered to {@link PluginHost.watch}'s callback (P7). Carries
 * the **absolute path** of the changed file and the change {@link type}, so a plugin can
 * act on *which* file changed (e.g. re-index just that file) rather than a coarse
 * "something under the glob changed" signal.
 */
export interface PluginWatchEvent {
	/** Absolute path of the file that changed (always inside a granted filesystem root). */
	readonly path: string
	/** Which kind of change fired the event. */
	readonly type: "create" | "change" | "delete"
}

/**
 * Host LLM/embeddings access handed to a plugin granted `permissions.ai` **and** the
 * billed-calls consent (design §6.11 G1, §8; Phase 6). The plugin never sees raw API
 * keys — only an opaque {@link Handler} (the host's `ApiHandler`, constructed in
 * `@shofer/core` via `buildApiHandler`). `@shofer/types` stays browser-safe by leaving
 * the handler type abstract (defaulting to `unknown`); core wires the concrete
 * `ApiHandler` in (a `PluginAi<ApiHandler>` is assignable to `PluginAi`).
 *
 * Both calls are async because host provider-profile resolution
 * (`ProviderSettingsManager.getProfile`) is async — `→ ApiHandler` in the design is
 * shorthand for "the same handler abstraction `buildApiHandler` returns".
 */
export interface PluginAi<Handler = unknown> {
	/**
	 * Build an {@link Handler} for `profileRef` (a host provider-profile name/id), or the
	 * host's default profile when omitted. Reuses the host's `buildApiHandler` seam, so
	 * the plugin gets the identical `ApiHandler` the main agent uses — never keys.
	 */
	buildHandler(profileRef?: string): Promise<Handler>
	/** Embed `texts` via a host embedder, returning one vector per input text. */
	embed(texts: string[], profileRef?: string): Promise<number[][]>
	/**
	 * Whether the user has consented to this plugin's **billed** AI calls (§8) — i.e.
	 * whether {@link buildHandler}/{@link embed} will actually run rather than throw. A
	 * plugin sees `ctx.ai` as *present* in both the live and the denying-stub case (they
	 * differ only when called), so this read-only flag lets it word its prompt/UI copy
	 * for the consent state **without** making a billed call to find out. Read-only: the
	 * plugin still cannot grant itself consent. `true` on the live surface, `false` on the
	 * denying stub.
	 */
	hasConsent(): boolean
}

/**
 * Proactive **agent-steering** handed to a plugin granted `permissions.agent` (design
 * §6.11 G8; Phase 7). Lets a plugin — from a background service ({@link
 * PluginContext.registerService}), a file watcher ({@link PluginHost.watch}), or a
 * lifecycle hook — PROACTIVELY inject a message into the running agent ("the deploy just
 * failed, here's the log"), rather than only reacting when the agent calls it. This is
 * powerful (a plugin steering the agent carries billed/behavioral impact), so it is gated
 * on a dedicated `permissions.agent` grant.
 *
 * As with {@link PluginAi}, the plugin-facing surface stays in `@shofer/types`
 * (browser-safe) while the concrete task-injection lives host-side behind a seam (core's
 * `PluginAgentProvider`). Ungranted (but the host wired the seam) ⇒ a denying stub whose
 * {@link notify} throws + warns; no seam wired (pure-core embedding, or the discovery-only `shofer plugin` CLI manager) ⇒ `ctx.agent` is absent — note `shofer serve` DOES wire the seam (same extension bundle, same ShoferProvider).
 */
export interface PluginAgent {
	/**
	 * Inject `message` into the agent. Resolves once the message has been delivered
	 * (queued / the spawned task created). Rejects (+ warns) when the plugin lacks
	 * `permissions.agent` or the host has no task to steer.
	 */
	notify(message: string, opts?: PluginAgentNotifyOptions): Promise<void>

	/**
	 * Start a task and get an awaitable, cancellable {@link PluginTaskHandle} (design §14).
	 * Unlike {@link notify} (fire-and-forget), this is the **job-oriented** path a
	 * workflow/runner plugin uses: `await handle.result()` for the structured outcome,
	 * `handle.cancel()` to abort. Scoped, gated (`permissions.agent`); the plugin never
	 * touches the task stack or `ShoferAPI`.
	 */
	spawn(prompt: string, opts?: PluginAgentSpawnOptions): Promise<PluginTaskHandle>

	/** Cancel a task by id (structured cancellation). No-op if the task is not found. */
	cancel(taskId: string): Promise<void>
}

/** Options for {@link PluginAgent.spawn} (design §14). */
export interface PluginAgentSpawnOptions {
	/** Optional images to seed the task with. */
	images?: string[]
	/** Agent mode slug to start the task in (defaults to the host's current mode). */
	mode?: string
	/** Opaque metadata echoed back on {@link PluginTaskResult.metadata}; the host never interprets it. */
	metadata?: Record<string, unknown>
	/**
	 * A JSON Schema the task's final result must conform to.
	 *
	 * Unlike {@link metadata}, this is NOT opaque: the host threads it into the
	 * task's `attempt_completion` schema, so a provider with constrained decoding
	 * enforces the contract AT DECODE TIME rather than the caller checking a
	 * free-form answer afterwards — a post-hoc check costs a whole extra turn
	 * every time the model drifts, and drift is what makes it worth constraining.
	 *
	 * It reshapes the completion TOOL rather than being sent as a provider
	 * `response_format`, which is what lets an agentic task keep its other tools:
	 * a `response_format` constrains the whole turn, so it cannot coexist with an
	 * agent that still needs to read files before it can answer.
	 */
	completionSchema?: Record<string, unknown>
	/**
	 * Continue an existing agent session instead of starting a cold one.
	 *
	 * This is what makes a contract RE-prompt a continuation: when a result fails
	 * its schema or its semantic predicate, the caller re-asks the same session
	 * with the specific error, and the model still has everything it derived the
	 * first time. Starting fresh would re-do that work and quite likely reproduce
	 * the same mistake.
	 */
	sessionId?: string
}

/**
 * A handle to a task started via {@link PluginAgent.spawn} (design §14). Awaitable result,
 * task-scoped event subscription, and cancellation — the primitives a runner needs to drive
 * an agent run as a durable job (e.g. a Temporal activity).
 */
export interface PluginTaskHandle {
	readonly taskId: string
	/** Resolves when the task completes or aborts. */
	result(): Promise<PluginTaskResult>
	/** Subscribe to events scoped to **this** task; returns an unsubscribe fn. */
	onEvent(cb: (event: PluginEvent) => void): () => void
	/** Cancel this task (structured cancellation). */
	cancel(): Promise<void>
}

/** The outcome of a spawned task (design §14). */
export interface PluginTaskResult {
	readonly taskId: string
	readonly status: "completed" | "aborted" | "error"
	/** Best-effort final output (e.g. the `attempt_completion` summary), if available. */
	readonly output?: string
	/** The `metadata` passed to {@link PluginAgent.spawn}, echoed back. */
	readonly metadata?: Record<string, unknown>
}

/** Options for {@link PluginAgent.notify} (design §6.11 G8; Phase 7). */
export interface PluginAgentNotifyOptions {
	/**
	 * How the message reaches the agent. Four distinct delivery modes:
	 *
	 * - **`"notify"`** (default): one-way notification. Appended to the target task's
	 *   **notification queue** and drained ASAP into the **system prompt** (role: system)
	 *   on the task's next real agent request — no explicit tool call needed. Delivered
	 *   **only while the task loop is running**; if the loop has ended the message is not
	 *   delivered (by design). This is the channel for fire-and-forget event routing
	 *   (all shofer-mesh bus messages use it).
	 * - **`"queue"`**: enqueue into the task's message queue exactly like a user prompt
	 *   typed while the task is busy — drained on the next turn, no preemption.
	 * - **`"interrupt"`**: enqueue **and** cancel-and-process (Send-Now semantics) —
	 *   aborts the current turn (same task instance) and resumes with this message.
	 * - **`"spawn"`**: start a **new** task seeded with the message.
	 */
	mode?: "notify" | "queue" | "interrupt" | "spawn"
	/** Target a specific task by id; defaults to the host's active/current task. */
	taskId?: string
	/**
	 * For `mode: "notify"` — a short human-readable source label (e.g. a mesh subject)
	 * shown with the injected notification. Ignored by the other modes.
	 */
	source?: string
}

/**
 * **Timeline control** handed to a plugin granted `permissions.task`. Where
 * {@link PluginAgent} steers what the agent *does*, this governs the task's visible
 * **chat timeline**: appending the plugin's own rows to it and rewinding it.
 *
 * It exists so a plugin can own a feature whose UX lives inline in the conversation
 * (a snapshot marker, an external-job status row) rather than being exiled to a side
 * panel. A {@link PluginMarker} appended here is persisted with the task's messages,
 * survives restart, and is rendered by the plugin's own `chat-message-addon` component
 * — the host never interprets `kind`/`data`.
 *
 * Ungranted with the seam wired ⇒ a denying stub (calls throw + warn); no seam
 * (pure-core embedding) ⇒ `ctx.task` is absent.
 */
export interface PluginTaskControl {
	/**
	 * Append a marker row to a task's timeline. Resolves once persisted. Targets
	 * `input.taskId`, defaulting to the host's current task.
	 */
	marker(input: PluginMarkerInput): Promise<void>

	/**
	 * This plugin's markers on `taskId` (default: the current task), oldest first —
	 * how a plugin recovers its per-task anchor list after a restart without keeping a
	 * second, drift-prone copy in {@link PluginStorage}.
	 */
	listMarkers(taskId?: string): Promise<PluginMarker[]>

	/**
	 * Rewind the task's chat timeline to the message at `ts`: messages after it are
	 * removed (their token/cost accounting is reported as a deleted API request) and
	 * the task restarts against the truncated history.
	 *
	 * This is the *chat* half of a restore. A plugin that also rolls back out-of-band
	 * state (a workspace snapshot) does that itself first, then calls this.
	 */
	rewind(ts: number, opts?: PluginRewindOptions): Promise<void>

	/**
	 * Re-point a task at another working directory: the task, and every agent it starts
	 * afterwards, run there.
	 *
	 * The seam a plugin that *manages* directories (worktrees) needs, since only the host
	 * can move a running task. The host refuses when the move would be incoherent — a
	 * workflow that has already started agents has work on disk in the old directory —
	 * and reports that rather than silently doing nothing.
	 *
	 * Defaults to the host's current task.
	 */
	setCwd(cwd: string, taskId?: string): Promise<void>

	/**
	 * Open a **new task** and focus it, optionally somewhere other than the workspace.
	 *
	 * The counterpart of {@link setCwd} for a task that does not exist yet: a plugin that
	 * has just prepared a place to work (a fresh worktree) can put the user in it, rather
	 * than describing where they should go. With no `text` the task is created idle and
	 * waits for the user's first message — the plugin has produced a *place*, not a
	 * prompt.
	 *
	 * Distinct from {@link PluginAgent.spawn}, deliberately: that one starts an agent RUN
	 * (it takes a prompt, returns an awaitable handle, and is gated on `permissions.agent`
	 * because it bills). This one only opens a task the user then drives, which is why it
	 * sits on task control with the other "change what a task is" operations.
	 *
	 * Resolves with the new task's id. Rejects (+ warns) when the plugin lacks
	 * `permissions.task`, and on any host that has no task stack to open into.
	 */
	openTask(opts?: PluginOpenTaskOptions): Promise<string>
}

/** Options for {@link PluginTaskControl.openTask}. */
export interface PluginOpenTaskOptions {
	/** Title for the new task; the host generates one from `text` when omitted. */
	readonly name?: string
	/** First user message. Omit to leave the task idle, awaiting the user. */
	readonly text?: string
	/** Images to seed alongside `text`. */
	readonly images?: string[]
	/**
	 * Where the task runs. Omitted means the workspace — the same default a task gets
	 * when no plugin answers `"resolve-task-cwd"`.
	 */
	readonly cwd?: string
	/** Mode slug to start in; defaults to the host's current mode. */
	readonly mode?: string
}

/** What a plugin passes to {@link PluginTaskControl.marker}. */
export interface PluginMarkerInput {
	/** Plugin-defined marker kind (e.g. `"checkpoint"`); opaque to the host. */
	readonly kind: string
	/** The row's primary text — also what a plugin keys its own lookups on. */
	readonly text: string
	/** Task to append to; defaults to the host's current task. */
	readonly taskId?: string
	/** Plugin-defined payload rendered by the plugin's own UI component. Opaque. */
	readonly data?: Record<string, unknown>
	/**
	 * Whether this marker names a point the task can be restored to. The host uses it
	 * only to decide whether to *offer* state restoration when the user deletes/edits an
	 * earlier message (the restoring itself is the plugin's, via
	 * {@link LifecycleHooks.onTimelineRewind}).
	 */
	readonly restorable?: boolean
	/**
	 * Persist the marker but keep it out of the rendered timeline. For anchors that
	 * matter to the plugin but would be noise in the chat.
	 */
	readonly suppress?: boolean
}

/** A marker read back from a task's timeline ({@link PluginTaskControl.listMarkers}). */
export interface PluginMarker extends PluginMarkerInput {
	/** Timestamp of the marker message — the handle {@link PluginTaskControl.rewind} takes. */
	readonly ts: number
	/** The plugin that appended it. */
	readonly pluginName: string
}

/** Options for {@link PluginTaskControl.rewind}. */
export interface PluginRewindOptions {
	/**
	 * Whether the message at `ts` is itself removed. `false` (default) keeps it as the
	 * new last message (delete semantics); `true` drops it too (edit semantics, where
	 * the caller replaces it).
	 */
	includeTargetMessage?: boolean
}

/**
 * A plugin's **private** persistent storage (design §6.11 G2; Phase 6). Rooted at
 * {@link dir} (`<globalStorage>/plugins/<name>/`); every path is resolved relative to
 * it and **traversal-blocked** (a `..` escape is denied). Created lazily, survives
 * restart, removed on uninstall. Works regardless of `permissions.filesystem` — it is
 * the plugin's own sandbox, not host paths.
 */
export interface PluginStorage {
	/** Absolute path of this plugin's storage directory. */
	readonly dir: string
	/** Read a UTF-8 file under {@link dir}. Rejects on traversal or a missing file. */
	readFile(relativePath: string): Promise<string>
	/** Write a UTF-8 file under {@link dir} (parent dirs created). Rejects on traversal. */
	writeFile(relativePath: string, content: string): Promise<void>
	/** Whether a path under {@link dir} exists. Rejects on traversal. */
	exists(relativePath: string): Promise<boolean>
	/** Delete a file under {@link dir}. Rejects on traversal. */
	delete(relativePath: string): Promise<void>
	/** List entries (absolute paths) under {@link dir} or a subdirectory of it. */
	list(relativeDir?: string): Promise<string[]>
}

/**
 * A supervised, long-lived background service a plugin registers via
 * {@link PluginContext.registerService} (design §6.11 G7; Phase 6). {@link start} runs
 * when the plugin is enabled+active; {@link stop} on disable/uninstall/deactivate. The
 * {@link PluginManager} isolates a throwing/hanging `start`/`stop` (timeout + warning)
 * so a bad service can never crash the host.
 */
export interface PluginService {
	/** Service name — used in supervision warnings for attribution. */
	readonly name: string
	/** Start the service. Awaited (with a timeout) when the plugin activates. */
	start(): void | Promise<void>
	/** Stop/dispose the service. Awaited (with a timeout) when the plugin deactivates. */
	stop?(): void | Promise<void>
}

/**
 * Host-side sender a plugin uses to **push** a message to its own mounted UI
 * component(s) over the scoped plugin-UI channel (design §6.8) — the extension→UI
 * direction that complements the UI→extension {@link ShoferPlugin.onUiMessage} hook.
 * Namespaced by construction: the host tags the message with the plugin's name so it
 * reaches only that plugin's components (`PluginUIApi.onMessage`), never another's.
 * Surfaced on {@link PluginContext.ui} only when the plugin granted `permissions.ui`
 * **and** the host wired its UI sender (headless/pure-core ⇒ absent). Fire-and-forget.
 */
export interface PluginUiSender {
	/** Push a message to this plugin's mounted UI component(s) (scoped to the plugin). */
	postMessage(message: unknown): void
	/**
	 * Open — or focus, if already open — this plugin's UI bundle in a standalone editor
	 * panel (a `WebviewPanel` tab beside the editor), rather than an in-sidebar mount
	 * (design §6.8). The panel hosts the plugin's built UI bundle for {@link PluginPanelOptions.region}
	 * (default `"sidebar-panel"`) and is wired to the SAME scoped, name-tagged channel as
	 * the sidebar mount — {@link postMessage} pushes and {@link ShoferPlugin.onUiMessage}
	 * receives reach it too. Fire-and-forget; a no-op on a host with no panel surface.
	 */
	showPanel(opts?: PluginPanelOptions): void
	/**
	 * Open Settings on the Plugins tab, where this plugin's own controls live — its
	 * enable toggle, its `config` form, and (for a `permissions.ai` plugin) the
	 * billed-AI consent.
	 *
	 * A plugin whose UI has to tell the user "I need your approval before I can do
	 * anything" would otherwise be reduced to *describing* where that approval lives.
	 * Fire-and-forget; a no-op on a host with no settings surface.
	 */
	openSettings(): void
}

/** Options for {@link PluginUiSender.showPanel} (design §6.8). */
export interface PluginPanelOptions {
	/** Editor-tab title. Defaults to the plugin's name. */
	title?: string
	/** Which contributed UI region's bundle to host. Defaults to `"sidebar-panel"`. */
	region?: string
}

/**
 * Context handed to plugin hooks. Host-agnostic (no `vscode` types). The first two
 * fields are always populated by the hook call sites; {@link taskId}, {@link cwd},
 * {@link config}, and {@link host} are threaded in by the {@link PluginManager} when
 * a code plugin is registered (Phase 2) — they are absent for the seed/no-host case,
 * keeping behavior identical when no plugins are active. {@link ai}, {@link storage},
 * and {@link registerService} are the Phase-6 host capabilities (design §6.11), each
 * present only when the host wired its seam (and, for {@link ai}, only when
 * `permissions.ai` was granted).
 */
export interface PluginContext {
	/** Absolute path of the active workspace, if any. */
	readonly workspacePath?: string
	/**
	 * Every open workspace folder, when the host has more than one.
	 *
	 * {@link workspacePath} is the one a task runs in; a plugin whose feature is
	 * repository-shaped (worktrees) needs to know that the window has several roots,
	 * because "the repository" is then ambiguous and the honest answer is to refuse.
	 */
	readonly workspaceFolders?: readonly string[]
	/** Current mode slug. */
	readonly mode?: string
	/** Id of the task the hook is running for, if applicable (design §6.2). */
	readonly taskId?: string
	/** Current working directory (design §6.2). */
	readonly cwd?: string
	/**
	 * Whether the task is **currently producing output** (mid-turn). Set on request
	 * contexts, so a plugin whose UI offers a workspace-mutating action can refuse it
	 * while the agent is still writing the very files it would touch — the answer has
	 * to come from the host, since a plugin cannot see the agent loop.
	 */
	readonly taskStreaming?: boolean
	/** This plugin's validated, user-configured settings (design §6.2, step 2.3). */
	readonly config?: Record<string, unknown>
	/** Restricted, permission-checked host surface (design §6.2, §8; step 2.4). */
	readonly host?: PluginHost
	/**
	 * Host LLM/embeddings access (design §6.11 G1; Phase 6). Present **only** when the
	 * plugin was granted `permissions.ai` and the host wired its AI seam. When granted
	 * but the user has not consented to billed calls (§8), this is a denying stub whose
	 * calls throw + warn; when ungranted it is absent entirely.
	 */
	readonly ai?: PluginAi
	/**
	 * Proactive agent-steering (design §6.11 G8; Phase 7). Present only when the host
	 * wired its agent seam. Granted `permissions.agent` ⇒ a live surface that injects
	 * messages into the running agent; granted-not / seam wired ⇒ a denying stub whose
	 * `notify` throws + warns; no seam (headless) ⇒ absent entirely. See {@link PluginAgent}.
	 */
	readonly agent?: PluginAgent
	/**
	 * Chat-timeline control — append the plugin's own marker rows, rewind the task.
	 * Present only when the host wired its task seam. Granted `permissions.task` ⇒ a
	 * live surface; granted-not / seam wired ⇒ a denying stub; no seam ⇒ absent.
	 * See {@link PluginTaskControl}.
	 */
	readonly task?: PluginTaskControl
	/**
	 * The task's current turn index — incremented once per assistant turn (each new API
	 * request). Lets a hook that fires per *tool call* (`beforeToolCall` can run several
	 * times in one turn) act only once per turn, without the plugin having to guess turn
	 * boundaries. Present on contexts built for a running task.
	 */
	readonly turn?: number
	/** This plugin's private persistent storage (design §6.11 G2; Phase 6). */
	readonly storage?: PluginStorage
	/**
	 * Push messages to this plugin's mounted UI component(s) — the extension→UI half of
	 * the scoped plugin-UI channel (design §6.8). Present only when the plugin granted
	 * `permissions.ui` and the host wired its UI sender; absent otherwise (headless/
	 * pure-core, or an ungranted plugin). See {@link PluginUiSender}.
	 */
	readonly ui?: PluginUiSender
	/**
	 * Register a supervised background service tied to this plugin's lifecycle (design
	 * §6.11 G7; Phase 6). Returns a {@link HostDisposable} that stops + removes the
	 * service. Present only when the host wired the service supervisor.
	 */
	registerService?(service: PluginService): HostDisposable
}

/** A lightweight event surfaced to `onEvent` (decoupled from the telemetry catalog). */
export interface PluginEvent {
	readonly name: string
	readonly properties?: Record<string, unknown>
	/** Task that emitted the event, if any (design §6.10). */
	readonly taskId?: string
	/** When the event occurred (epoch ms), if known (design §6.10). */
	readonly timestamp?: number
}

// ---------------------------------------------------------------------------
// Plugin manifest (`plugin.json`) — the declarative contract (design §5).
//
// The manifest is the single source of truth for what a plugin *declares*: its
// metadata, the `permissions` it requests (the security contract), and the
// `contributes` block (declarative modes/skills/commands/MCP servers/rules).
// The Zod schema below is validated fail-closed (`.strict()` at every level —
// unknown keys are rejected), mirroring how tool schemas are done. Phase 1 wires
// the *declarative* contributions; code hooks (`main`) land in Phase 2.
// ---------------------------------------------------------------------------

/**
 * Ceiling for a manifest's `hookTimeoutMs`. A lifecycle hook runs INSIDE the agent
 * loop, so its budget is time the user waits with nothing happening; 60 s is already
 * generous for the one case that needs it (snapshotting a big workspace) and keeps a
 * misconfigured manifest from hanging the loop indefinitely.
 */
export const MAX_PLUGIN_HOOK_TIMEOUT_MS = 60_000

/**
 * UI regions a plugin may request to contribute components to (design §6.8).
 * Declared here so manifest validation is stable; the actual mounting is Phase 4.
 */
export const pluginUiRegionSchema = z.enum([
	"chat-input-toolbar",
	"task-header",
	"settings-tab",
	"chat-message-addon",
	"chat-footer",
	"sidebar-panel",
])

export type PluginUiRegion = z.infer<typeof pluginUiRegionSchema>

/**
 * Permissions a plugin requests. Every capability defaults to *denied* — an
 * absent/false flag means Shofer will not surface that contribution. This block
 * is the security contract (design §5, §8): a contribution is only honored when
 * the matching permission is granted.
 */
export const pluginPermissionsSchema = z
	.object({
		tools: z.boolean().optional(),
		systemPrompt: z.boolean().optional(),
		modes: z.boolean().optional(),
		skills: z.boolean().optional(),
		commands: z.boolean().optional(),
		rules: z.boolean().optional(),
		mcpServers: z.boolean().optional(),
		/**
		 * Contribute `.slang` **workflows** — the multi-phase, multi-agent programs the
		 * workflow runner executes (`contributes.workflows`). Shipped as files under the
		 * plugin's `workflows/` dir and discovered alongside the user's
		 * (`~/.shofer/workflows/`) and the project's (`.shofer/workflows/`).
		 */
		workflows: z.boolean().optional(),
		/** UI regions the plugin wants to render into (Phase 4). */
		ui: z.array(pluginUiRegionSchema).optional(),
		lifecycle: z.boolean().optional(),
		events: z.boolean().optional(),
		/** Allowed network endpoints (host or origin prefixes). Enforced in Phase 2. */
		network: z.array(z.string()).optional(),
		/** Allowed filesystem paths (relative to the plugin/workspace). Enforced in Phase 2. */
		filesystem: z.array(z.string()).optional(),
		/**
		 * Host LLM/embeddings access (`ctx.ai`, Phase 6 / P6.G1). Unlike the other
		 * flags this costs the **user money** (billed model calls), so the grant is
		 * necessary but not sufficient: `ctx.ai` is live only after a **separate**
		 * billed-calls consent (design §8). Granted-but-unconsented ⇒ a denying stub;
		 * ungranted ⇒ `ctx.ai` is absent entirely. The plugin never receives raw keys.
		 */
		ai: z.boolean().optional(),
		/**
		 * Proactive **agent-steering** (`ctx.agent`, Phase 7 / P6.G8). Lets the plugin
		 * inject messages into the running agent (queue / spawn / interrupt). This has
		 * **billed/behavioral impact** (a plugin steering the agent is powerful), so it is
		 * gated on this dedicated grant: ungranted ⇒ `ctx.agent` is a denying stub (calls
		 * throw + warn), absent entirely on a host with no agent seam.
		 */
		agent: z.boolean().optional(),
		/**
		 * Read-only **index / symbol / diagnostics search** (`ctx.host.search`, design
		 * §6.11). Grants the plugin the host's code-index (`rag_search`), git-history
		 * (`git_search`), workspace-symbol (`list_code_usages`), and diagnostics
		 * (`get_errors`) queries as plain DTOs — the seam the built-in Live Memory's read
		 * tools use, exposed without leaking `vscode` types. Read-only and side-effect-free,
		 * so it is a plain grant (no billed-calls consent): ungranted ⇒ `ctx.host.search` is
		 * a denying stub (calls throw + warn), absent entirely on a host with no search
		 * provider.
		 */
		search: z.boolean().optional(),
		/**
		 * **Task control** (`ctx.task`): append the plugin's own marker rows to a task's
		 * timeline, rewind it, and re-point it at another working directory (design
		 * §6.11). Each of those changes what the task IS — rewinding destroys conversation
		 * history and restarts it, `setCwd` moves where its tools write — so this is its
		 * own grant rather than riding on `permissions.agent` (which only *adds*
		 * messages): ungranted ⇒ `ctx.task` is a denying stub (calls throw + warn), absent
		 * on a host with no task seam.
		 */
		task: z.boolean().optional(),
		/**
		 * **Editor actions** (`ctx.host.editor`) — currently the multi-file diff viewer.
		 * Opening editors steals focus, so it is granted explicitly rather than being
		 * always-on like `notifier`: ungranted ⇒ a denying stub (calls throw + warn),
		 * absent on a host with no editor seam.
		 */
		editor: z.boolean().optional(),
	})
	.strict()

export type PluginPermissions = z.infer<typeof pluginPermissionsSchema>

/**
 * A mode a plugin contributes. Same shape as a `ModeConfig` object minus the
 * `source`/`pluginName` fields — those are assigned by the `PluginManager` at
 * discovery time (`source: "plugin"`, `pluginName: <name>`), not by the author.
 */
export const pluginModeContributionSchema = modeConfigObjectSchema
	.omit({ source: true, pluginName: true })
	.strict()
	.refine((data) => data.tools !== undefined || data.tools_allowed !== undefined, {
		message: "Either 'tools' or 'tools_allowed' must be provided",
	})

export type PluginModeContribution = z.infer<typeof pluginModeContributionSchema>

/** Separates a plugin's name from an authored contribution name in a qualified slug. */
export const PLUGIN_NAMESPACE_SEPARATOR = ":"

/**
 * Whether a mode slug is a plugin-namespaced one (`<plugin>:<authoredSlug>`).
 *
 * The complement — an unqualified slug on a plugin mode — means a bundled first-party
 * plugin with the {@link pluginManifestSchema} `unqualifiedContributions` exemption: Shofer's
 * own defaults, which keep their canonical names. Mode slugs authored by a user or a
 * project can never contain the separator, so this is an exact test.
 */
export function isNamespacedModeSlug(slug: string): boolean {
	return slug.includes(PLUGIN_NAMESPACE_SEPARATOR)
}

/**
 * A skill a plugin declares. The physical `SKILL.md` lives under the plugin's
 * `skills/` directory; this entry is the manifest-level declaration (design §6.4).
 */
export const pluginSkillContributionSchema = z
	.object({
		name: z.string().min(1),
		description: z.string().min(1),
		/**
		 * A **private** (internal) skill: registered and invocable by its qualified
		 * name (`<pluginName>:<name>`) but excluded from every user-facing enumeration
		 * (the skills UI list, the slash-command menu). Absent/false ⇒ user-visible.
		 */
		private: z.boolean().optional(),
	})
	.strict()

export type PluginSkillContribution = z.infer<typeof pluginSkillContributionSchema>

/**
 * A slash command a plugin declares. The physical `.md` lives under the plugin's
 * `commands/` directory; this entry is the manifest-level declaration (design §6.5).
 */
export const pluginCommandContributionSchema = z
	.object({
		name: z.string().min(1),
		description: z.string().optional(),
		argumentHint: z.string().optional(),
		/**
		 * A **private** (internal) command: registered and invocable by its qualified
		 * name (`<pluginName>:<command>`) but excluded from every user-facing
		 * enumeration (the command palette / slash-command list). Absent/false ⇒
		 * user-visible.
		 */
		private: z.boolean().optional(),
	})
	.strict()

export type PluginCommandContribution = z.infer<typeof pluginCommandContributionSchema>

/**
 * A rules markdown file a plugin ships, optionally scoped to specific modes
 * (design §6.7). `path` is relative to the plugin root.
 */
export const pluginRuleContributionSchema = z
	.object({
		path: z.string().min(1),
		modes: z.array(z.string()).optional(),
	})
	.strict()

export type PluginRuleContribution = z.infer<typeof pluginRuleContributionSchema>

/**
 * MCP server configs a plugin bundles (design §6.6 Mode A). Kept intentionally
 * loose here (`unknown` per-server config) — `@shofer/types` stays browser-safe
 * and `McpHub` re-validates each entry with its own `ServerConfigSchema` before
 * connecting. Keys are server names.
 */
export const pluginMcpServersSchema = z.record(z.string(), z.record(z.string(), z.unknown()))

export type PluginMcpServers = z.infer<typeof pluginMcpServersSchema>

/**
 * A UI bundle a plugin ships for a webview region (design §6.8, P4 external-UI).
 * `region` must also be granted in `permissions.ui` (the grant); this entry points
 * at the plugin's **built** UI module (an ESM file relative to the plugin root, e.g.
 * `ui/toolbar.js`) that the extension serves as a local `vscode-webview://` resource
 * and the webview dynamic-imports. A granted region *without* a matching entry falls
 * back to the webview's co-bundled/first-party component registry (non-breaking).
 *
 * The built module must default-export a React component that takes a single
 * `{ api: PluginUIApi }` prop and **externalize** `react`, `react-dom`, and
 * `react/jsx-runtime` so its `import React` resolves to the host's shared instance
 * (see PLUGINS.md §6 — the host injects an import map for those specifiers).
 */
export const pluginUiEntrySchema = z
	.object({
		region: pluginUiRegionSchema,
		/** Built UI ESM module, relative to the plugin root (e.g. `ui/toolbar.js`). */
		entry: z.string().min(1),
	})
	.strict()

export type PluginUiEntry = z.infer<typeof pluginUiEntrySchema>

/**
 * A `.slang` workflow a plugin ships. The physical `<name>.slang` lives under the
 * plugin's `workflows/` directory; this entry is the manifest-level declaration.
 *
 * Unlike modes/skills/commands these are **not** namespaced: a workflow is addressed
 * by the flow name inside its `.slang` source, and the discovery chain is a plain
 * priority merge (plugin < global < project) so a user or project can override a
 * shipped workflow by dropping in a file of the same name — which is exactly how the
 * built-in workflows behaved before they became a plugin.
 */
export const pluginWorkflowContributionSchema = z
	.object({
		/** File base name under `workflows/`, without the `.slang` extension. */
		name: z.string().min(1),
		description: z.string().optional(),
	})
	.strict()

export type PluginWorkflowContribution = z.infer<typeof pluginWorkflowContributionSchema>

/** The declarative `contributes` block (design §5, §6). All entries optional. */
export const pluginContributesSchema = z
	.object({
		modes: z.array(pluginModeContributionSchema).optional(),
		skills: z.array(pluginSkillContributionSchema).optional(),
		commands: z.array(pluginCommandContributionSchema).optional(),
		workflows: z.array(pluginWorkflowContributionSchema).optional(),
		mcpServers: pluginMcpServersSchema.optional(),
		rules: z.array(pluginRuleContributionSchema).optional(),
		/**
		 * External UI bundles per region (design §6.8, P4). Each entry's `region` must
		 * also be granted in `permissions.ui`; the `entry` names the built ESM module the
		 * extension serves + the webview dynamic-imports. Omit to use a co-bundled component.
		 */
		ui: z.array(pluginUiEntrySchema).optional(),
	})
	.strict()

export type PluginContributes = z.infer<typeof pluginContributesSchema>

/**
 * The `plugin.json` manifest schema (design §5). Validated fail-closed: unknown
 * top-level and nested keys are rejected. `main` is `null`/absent for purely
 * declarative plugins (Phase 1's target).
 */
export const pluginManifestSchema = z
	.object({
		/** Unique plugin id — used for ordering, dedupe, namespacing, and state keys. */
		name: z
			.string()
			.min(1)
			.regex(
				/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/,
				"Plugin name must start with a letter/number and contain only letters, numbers, '.', '_', or '-'",
			),
		version: z.string().min(1),
		/**
		 * Semver of the Shofer plugin API surface this plugin targets (design §14.2).
		 * Lets Shofer refuse/migrate plugins built against an incompatible API. Not
		 * enforced in Phase 1 (declarative-only), but part of the contract from day one.
		 */
		shoferPluginApiVersion: z.string().optional(),
		description: z.string().optional(),
		author: z.string().optional(),
		homepage: z.string().optional(),
		license: z.string().optional(),
		/** Minimum Shofer version required (semver range). Not enforced in Phase 1. */
		shoferVersion: z.string().optional(),
		/**
		 * Entry point relative to the plugin dir. `null`/absent ⇒ purely declarative
		 * (no code hooks). Code loading is Phase 2.
		 */
		main: z.string().nullable().optional(),
		permissions: pluginPermissionsSchema.optional(),
		contributes: pluginContributesSchema.optional(),
		/** Other plugins that must be installed. Not enforced in Phase 1. */
		dependencies: z.array(z.string()).optional(),
		/** JSON-schema-ish description of user-configurable settings (Phase 2). */
		config: z.record(z.string(), z.unknown()).optional(),
		/**
		 * Enable this plugin on first discovery, without waiting for the user to toggle
		 * it (design §7). Honored **only for `bundled` (first-party) scope** — a global
		 * or project plugin can never enable itself, since enabling is the user's consent
		 * to run third-party code. It exists so a first-party plugin that *is* a shipped
		 * Shofer feature (rather than an opt-in add-on) is on out of the box; the user
		 * can still disable it, and their choice always wins once recorded.
		 */
		defaultEnabled: z.boolean().optional(),
		/**
		 * Register this plugin's **modes and slash commands** under their authored names
		 * instead of the namespaced `<plugin>:<name>` form.
		 *
		 * Honored **only for `bundled` (first-party) scope**, and it exists for exactly one
		 * situation: a plugin that ships the *platform's own* defaults, whose names are a
		 * public contract. Shofer's built-in modes are `code`, `architect`, `debug`, … in
		 * every user setting, every mode link and every `switch_mode` call; its worktree
		 * commands are `/merge-worktree`, `/rebase-worktree`, … in every doc and every
		 * `run_slash_command` the agent makes. Moving them into a plugin must not rename
		 * them to `builtin-modes:code` or `worktrees:merge-worktree`.
		 *
		 * It trades away the "collisions are impossible by construction" guarantee for
		 * those names, so a third-party plugin can never have it: an unqualified name from
		 * a global/project plugin could silently shadow a built-in. An unqualified command
		 * sits at the **built-in** precedence tier, so a user's or project's own command of
		 * the same name still wins.
		 */
		unqualifiedContributions: z.boolean().optional(),
		/**
		 * Per-hook time budget in ms for this plugin's lifecycle hooks, overriding the
		 * shared default (`PLUGIN_HOOK_TIMEOUT_MS`, 500 ms). Raise it only when a hook
		 * legitimately does slow work the agent must WAIT for — e.g. snapshotting a large
		 * workspace before a file-mutating tool runs, where finishing late is useless
		 * because the mutation already happened. The agent loop is blocked for up to this
		 * long, so it is capped at {@link MAX_PLUGIN_HOOK_TIMEOUT_MS}.
		 */
		hookTimeoutMs: z.number().int().positive().max(MAX_PLUGIN_HOOK_TIMEOUT_MS).optional(),
	})
	.strict()

export type PluginManifest = z.infer<typeof pluginManifestSchema>

// ---------------------------------------------------------------------------
// Plugin API versioning (design §14.2 — owner decision: enforce at load).
//
// The `ShoferPlugin` hook surface is semver'd. A plugin declares the API it was
// built against via the manifest `shoferPluginApiVersion`; Shofer refuses to load
// a plugin whose declared version is incompatible with the host's current API
// (major mismatch, or a host older than the minor/patch the plugin requires) with
// a shown+logged warning. Kept in `@shofer/types` (browser-safe) so the manifest
// schema and the (core-side) loader share one policy.
// ---------------------------------------------------------------------------

/** The plugin API surface version this Shofer build implements (design §14.2). */
export const PLUGIN_API_VERSION = "1.0.0"

/** Parse a bare `major.minor.patch` string; returns `null` when malformed. */
function parsePluginSemver(version: string): { major: number; minor: number; patch: number } | null {
	const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim())
	if (!match) return null
	return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) }
}

/**
 * Whether a plugin declaring `declared` as its target plugin-API version can run
 * against a host implementing `host` (defaults to {@link PLUGIN_API_VERSION}).
 * Compatible iff the majors match **and** the host is at least as new as the
 * declared version within that major (a plugin that needs newer features than the
 * host provides, or a different major, is refused). Malformed versions are
 * incompatible (fail-closed).
 */
export function isPluginApiCompatible(declared: string, host: string = PLUGIN_API_VERSION): boolean {
	const d = parsePluginSemver(declared)
	const h = parsePluginSemver(host)
	if (!d || !h) return false
	if (d.major !== h.major) return false
	if (h.minor < d.minor) return false
	if (h.minor === d.minor && h.patch < d.patch) return false
	return true
}

// ---------------------------------------------------------------------------
// UI-facing plugin types (Settings → Plugins tab, design §12)
// ---------------------------------------------------------------------------

/** Per-kind counts of a plugin's declarative contributions (for the UI summary). */
export interface PluginContributionSummary {
	modes: number
	skills: number
	commands: number
	mcpServers: number
	rules: number
}

/** A discovered plugin as shown in the Plugins settings tab (no secrets). */
export interface PluginView {
	name: string
	version: string
	description?: string
	/**
	 * Provenance: `"bundled"` = first-party, shipped inside the extension; `"global"`
	 * = `~/.shofer/plugins`; `"project"` = `<cwd>/.shofer/plugins`.
	 */
	scope: "bundled" | "global" | "project"
	/**
	 * Whether this is a first-party (bundled) plugin. First-party plugins are
	 * non-uninstallable (they ship with the extension), so the Plugins panel hides
	 * their uninstall affordance. They still follow the normal enable toggle.
	 */
	firstParty: boolean
	/** The user's persisted toggle intent (design §7). */
	enabled: boolean
	/**
	 * Why an enabled plugin is nonetheless inactive — an unmet/missing/cyclic
	 * dependency (design §14.3 — fail-closed). Present only when {@link enabled} is
	 * `true` but the plugin's contributions are suppressed, so the panel can show
	 * the user *why* the toggle is on yet nothing registered. Unset when the plugin
	 * is active or disabled by the user.
	 */
	disabledReason?: string
	/** Whether the plugin ships a code entry point (`main`). Not loaded in Phase 1. */
	hasCode: boolean
	contributionCounts: PluginContributionSummary
	/**
	 * Whether the plugin declares `permissions.ai` — i.e. it wants host LLM/embeddings
	 * access, which makes **billed** calls (design §6.11 G1, §8; Phase 6). Drives the
	 * "uses AI (billed)" badge + consent affordance in the Plugins panel.
	 */
	usesAi?: boolean
	/**
	 * Whether the user has consented to this plugin's billed AI calls (§8). Only
	 * meaningful when {@link usesAi} is true; `ctx.ai` is live only when both hold.
	 */
	aiConsented?: boolean
	/**
	 * The plugin's declared config JSON-schema (manifest `config`), if any — an object
	 * with `properties`, each carrying `type`/`default`/`description`. Drives the
	 * editable config form in the Plugins panel. Absent ⇒ the plugin has no config.
	 */
	configSchema?: PluginConfigSchema
	/**
	 * The user's stored config overrides for this plugin (a subset of the schema's
	 * properties). A field absent here falls back to its schema `default`. The effective
	 * value the plugin sees is `default` merged under these overrides.
	 */
	config?: Record<string, unknown>
}

/** A plugin's config JSON-schema (manifest `config`) as surfaced to the Plugins panel. */
export interface PluginConfigSchema {
	type?: string
	properties?: Record<string, { type?: string; default?: unknown; description?: string; enum?: unknown[] }>
}

/** Snapshot of discovered plugins pushed to the webview (`ExtensionMessage.plugins`). */
export interface PluginsState {
	plugins: PluginView[]
}

/** Webview → extension request (carried in `WebviewMessage.plugin`). */
export type PluginRequest =
	| { action: "list" }
	| { action: "setEnabled"; name: string; enabled: boolean }
	/**
	 * Grant or revoke consent for a plugin's **billed** AI calls (`permissions.ai`,
	 * design §6.11 G1, §8; Phase 6). Separate from the enable toggle: `ctx.ai` is live
	 * only when the plugin is enabled, declares `permissions.ai`, **and** is consented.
	 */
	| { action: "setAiConsent"; name: string; consented: boolean }
	/**
	 * Persist the user's config overrides for a plugin and reload it so the new values
	 * take effect immediately (design §5 `config` / §6.2 `PluginContext.config`). `config`
	 * is the full override object for the plugin (fields omitted fall back to schema defaults).
	 */
	| { action: "setConfig"; name: string; config: Record<string, unknown> }
	/** Uninstall a plugin: delete its directory and drop it from the enabled allow-list. */
	| { action: "uninstall"; name: string }
	/**
	 * Install a plugin from a local `.shofer-plugin` archive. The extension opens a file
	 * picker (the webview cannot read local files), unpacks it into the global plugins
	 * dir, and re-discovers. Remote/registry install stays deferred (design §9, §14 Q5).
	 */
	| { action: "installFromFile" }
	/**
	 * Install a plugin from a direct http(s) `url` pointing at a `.shofer-plugin` archive.
	 * The extension downloads it via the core helper (https-only + size-capped + zip-slip
	 * / manifest validated), unpacks it into the global plugins dir, and re-discovers.
	 * Optional {@link enable} enables the freshly installed plugin on success (default:
	 * installed disabled, matching install-from-file). This is a **direct-URL** install,
	 * not a registry lookup (design §9, §14 Q5).
	 */
	| { action: "installFromUrl"; url: string; enable?: boolean }

// ---------------------------------------------------------------------------
// Plugin UI contributions (design §6.8, §12; Phase 4)
//
// A plugin may contribute React components into named webview regions
// ({@link PluginUiRegion}). Per the owner decision (§14 Q1) the component is loaded
// into the webview via dynamic import with a restricted API — NOT a sandboxed
// iframe — so it shares the host's React/theme. It receives only a {@link PluginUIApi}:
// a *scoped* message channel to its extension-side plugin plus a read-only context
// blob. No direct `vscode` API and no DOM escape are exposed.
//
// These types are the shared contract between the webview (`PluginSlot`) and the
// extension (`ui-registry` + provider routing). They are React-free so
// `@shofer/types` stays browser-safe — the concrete `React.ComponentType` lives in
// the webview, keyed by {@link PluginUiContribution.componentId}.
// ---------------------------------------------------------------------------

/** Read-only snapshot of the current task handed to a plugin UI component (design §6.8). */
export interface PluginUiTaskSummary {
	/** Id of the active task, if any. */
	readonly taskId?: string
	/** Current mode slug, if any. */
	readonly mode?: string
	/**
	 * How many rows the task's timeline currently has — a cheap "the conversation
	 * moved" signal a component can re-read state on.
	 *
	 * It is the only such signal a UI bundle has for a task running on a **remote
	 * executor**: that host's plugin pushes reach its own webview, not this one, so a
	 * component that must stay current there watches this instead.
	 */
	readonly messageCount?: number
	/**
	 * The directory the task runs in.
	 *
	 * "A task runs somewhere" is core's execution model, not any one plugin's feature —
	 * but a plugin that *chooses* that directory (worktrees) has to be able to show which
	 * one won, and reading it back from the task is the only honest source: the choice
	 * may have been made in another window, or restored from history.
	 */
	readonly cwd?: string
	/**
	 * Whether the host would still accept {@link PluginTaskControl.setCwd} for this task.
	 *
	 * False once the task's work is on disk in the current directory — an ordinary task
	 * that has started, or a workflow whose agents are running. A UI that offers to move
	 * the task asks this rather than re-deriving the rule, which lives host-side with the
	 * task it protects.
	 */
	readonly cwdMutable?: boolean
}

/**
 * The read-only context blob a plugin UI component receives (design §6.8). Carries
 * the region it is mounted in, the contributing plugin's name, the current task
 * summary, the plugin's user config, and theme variables — everything the component
 * may *read*. The only way to affect host state is {@link PluginUIApi.postMessage}.
 */
export interface PluginUIContext {
	/** The region this component is mounted in. */
	readonly region: PluginUiRegion
	/** The contributing plugin's name (also the channel namespace). */
	readonly pluginName: string
	/** Read-only summary of the active task. */
	readonly task?: PluginUiTaskSummary
	/** This plugin's validated, user-configured settings (design §6.2). */
	readonly config?: Record<string, unknown>
	/** VS Code theme CSS variables (name → value), for theme-aware rendering. */
	readonly theme?: Record<string, string>
	/**
	 * The timeline row this component is rendering — present only in the
	 * `chat-message-addon` region, where the mount exists *because* of a specific
	 * message. Carries the marker payload the plugin itself wrote, so the component
	 * renders from its own data rather than having to request it over the channel.
	 */
	readonly message?: PluginUiMessageSummary
}

/** The timeline row a `chat-message-addon` component is mounted for. */
export interface PluginUiMessageSummary {
	/** Timestamp of the message — the handle for restore/diff actions on it. */
	readonly ts: number
	/** The marker's primary text (for a snapshot plugin, typically its id/hash). */
	readonly text?: string
	/** The marker kind this plugin recorded. */
	readonly kind: string
	/** The plugin-defined payload from `ctx.task.marker(...)`. */
	readonly data?: Record<string, unknown>
	/** Whether the plugin declared this point restorable. */
	readonly restorable?: boolean
}

/**
 * The **restricted** surface handed to a plugin UI component (design §6.8, §14 Q1).
 * Scoped to a single plugin: {@link postMessage} tags every outgoing message with the
 * plugin's name so the extension routes it only to that plugin's extension-side code,
 * and {@link onMessage} only ever receives messages addressed to this plugin
 * (namespacing — one plugin can neither spoof nor observe another). {@link context}
 * is the read-only blob. No `vscode` API and no parent-DOM access are exposed.
 */
export interface PluginUIApi {
	/** Send a message to this plugin's extension-side code (scoped to the plugin). */
	postMessage(message: unknown): void
	/** Subscribe to messages addressed to this plugin. Returns an unsubscribe fn. */
	onMessage(listener: (message: unknown) => void): () => void
	/**
	 * Call this plugin's `handleRequest` and await the result — the request/response
	 * counterpart to {@link postMessage}, for the common case where the component
	 * needs an answer to render.
	 *
	 * Routed to the plugin instance on the **task's own host**, so it works unchanged
	 * when the focused task runs on a remote executor. Rejects when the plugin
	 * throws, is not enabled there, or implements no `handleRequest`.
	 */
	request(method: string, params?: unknown, opts?: { mutates?: boolean }): Promise<unknown>
	/** Read-only context (region, task, config, theme). */
	readonly context: PluginUIContext
}

/**
 * A single plugin UI contribution: plugin {@link pluginName} renders {@link componentId}
 * into {@link region}. Produced by the permission-gated UI registry from enabled
 * manifests and pushed to the webview, which resolves {@link componentId} to a React
 * component. {@link componentId} is namespaced (`<pluginName>:<region>`) so it is
 * globally unique across plugins and regions.
 */
export interface PluginUiContribution {
	readonly pluginName: string
	readonly region: PluginUiRegion
	readonly componentId: string
	/**
	 * Optional URL to the plugin's UI bundle, resolved to a local `vscode-webview://`
	 * resource (design §14 Q1 — CSP `strict-dynamic` permits importing scripts from
	 * `cspSource`, not arbitrary hosts). Absent for co-bundled/fixture components, which
	 * the webview resolves from its built-in component registry.
	 */
	readonly source?: string
}

/**
 * One plugin's translations, as shipped in its `locales/<lang>.json` files.
 *
 * Carried to the webview with the UI contributions and registered as the i18next
 * namespace `plugin:<pluginName>`, which `@shofer/plugin-ui`'s `usePluginTranslation`
 * reads. Every shipped language travels at once — the files are small, and it means
 * switching the display language needs no round-trip to the extension.
 */
export interface PluginLocaleBundle {
	readonly pluginName: string
	/** language tag (`en`, `de`, …) → that language's key/value tree. */
	readonly resources: Record<string, Record<string, unknown>>
}

/** Snapshot of plugin UI contributions pushed to the webview (`ExtensionMessage.pluginUiContributions`). */
export interface PluginUiContributionsState {
	contributions: PluginUiContribution[]
	/** Translations for the contributing plugins (see {@link PluginLocaleBundle}). */
	locales?: PluginLocaleBundle[]
}

/**
 * A message on the scoped plugin-UI ↔ plugin-extension channel (design §6.8). The
 * {@link pluginName} namespaces the message so routing (both directions) is confined
 * to one plugin. Carried by `WebviewMessage.pluginUiMessage` (UI → extension) and
 * `ExtensionMessage.pluginUiMessage` (extension → UI).
 */
export interface PluginUiMessageEnvelope {
	pluginName: string
	message: unknown
}

/**
 * Request/response over the (otherwise fire-and-forget) plugin-UI channel — the
 * transport behind {@link PluginUIApi.request}.
 *
 * A plugin UI component usually needs an *answer* ("give me this diff", "list my
 * markers"), and correlating that by hand in every plugin is exactly the kind of
 * boilerplate the API should absorb. It rides the existing scoped envelope rather
 * than a new message type, so it inherits the same namespacing guarantees.
 *
 * The host resolves it against the plugin running on the task's own host — including
 * a REMOTE executor when the focused task is a shadow — so a plugin-owned feature
 * behaves identically for local and remote tasks.
 */
export interface PluginUiRequestEnvelope {
	__pluginRequest: {
		/** Correlation id, unique per UI mount. */
		id: string
		/**
		 * Plugin-defined method name, dispatched to `ShoferPlugin.handleRequest`.
		 *
		 * A method prefixed {@link PLUGIN_LOCAL_REQUEST_PREFIX} is always answered on
		 * **this** host, even when the focused task runs on a remote executor — for the
		 * things only this host can do, like opening an editor. Everything else goes to
		 * the host that owns the task, because that is where its per-task state lives.
		 */
		method: string
		params?: unknown
		/**
		 * Whether this request changes state (rather than reading it). The host refuses
		 * to route a mutating request to a remote executor while a local task is running,
		 * since both would be acting on the same shared workspace.
		 */
		mutates?: boolean
	}
}

/** Methods with this prefix are always answered on the host the UI is running on. */
export const PLUGIN_LOCAL_REQUEST_PREFIX = "local:"

/**
 * Result convention: a plugin that **rewound its task's conversation** while handling
 * a request says so, letting the host resync a remote task's shadow (whose message
 * list is now stale). Plugins that never rewind can ignore it.
 */
export interface PluginRewoundResult {
	rewound?: boolean
}

/** The reply to a {@link PluginUiRequestEnvelope}, on the same scoped channel. */
export interface PluginUiResponseEnvelope {
	__pluginResponse: {
		id: string
		result?: unknown
		/** Present when the plugin (or the routing) failed; `result` is then absent. */
		error?: string
	}
}

/** Type guard for a {@link PluginUiRequestEnvelope} arriving from a plugin's UI. */
export function isPluginUiRequest(message: unknown): message is PluginUiRequestEnvelope {
	const req = (message as PluginUiRequestEnvelope | undefined)?.__pluginRequest
	return !!req && typeof req.id === "string" && typeof req.method === "string"
}

/** Type guard for a {@link PluginUiResponseEnvelope} arriving from the host. */
export function isPluginUiResponse(message: unknown): message is PluginUiResponseEnvelope {
	const res = (message as PluginUiResponseEnvelope | undefined)?.__pluginResponse
	return !!res && typeof res.id === "string"
}
