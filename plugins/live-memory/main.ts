/**
 * Live Memory — a first-party Shofer plugin (the P1–P6 dogfood).
 *
 * Reimplements the *core* of the built-in Live Memory using ONLY the public plugin
 * surface — no reach into `@shofer/core` internals:
 *
 * | Built-in piece                         | Plugin extension point used                       |
 * | -------------------------------------- | ------------------------------------------------- |
 * | `ConversationStore` (persist Q&A/ctx)  | `ctx.storage` (P6.G2) — see {@link MemoryStore}   |
 * | `LiveMemoryLlmClient` (buildApiHandler)| `ctx.ai.buildHandler` (P6.G1) — see memory-llm    |
 * | `AskLiveMemoryTool`                    | `registerTools` (`ask_live_memory`)               |
 * | `getLiveMemorySection`                 | `transformSystemPrompt`                           |
 * | `FileContextTracker._notifyLiveMemory` | `lifecycle.afterToolCall` (Shofer's own edits)    |
 * | file-watcher (external edits)          | `ctx.host.watch` (P6.G3)                           |
 * | task lifecycle                         | `lifecycle.beforeTaskStart/afterTaskComplete` + `onEvent` |
 * | background compaction                  | `ctx.registerService` (P6.G7)                     |
 *
 * See DOGFOOD.md for the full mapping, the reduced-fidelity notes, and the one
 * genuine gap (external-edit path granularity).
 */

import { defineCustomTool, parametersSchema as z } from "@shofer/types"
import type { HostDisposable, PluginContext, PluginEvent, ShoferPlugin } from "@shofer/types"

import { DEFAULT_MAX_CONTEXT_TOKENS, DEFAULT_CONTEXT_FILL_THRESHOLD } from "./types.js"

import { MemoryStore, type Observation, type ObservationKind } from "./memory-store.js"
import { renderMemoryContext, summarizeMemory, MemoryLlmClient } from "./memory-llm.js"
import { LiveMemoryToolExecutor } from "./tool-executor.js"
import { LiveMemoryDirectoryTree } from "./directory-tree.js"
import { LiveMemoryAgent } from "./agent.js"
import { buildLiveMemorySection } from "./system-section.js"

const PLUGIN_NAME = "live-memory"

/** Tools whose invocation means Shofer *edited* a file (the built-in's `shofer_edited`). */
const EDIT_TOOLS = new Set(["write_to_file", "apply_diff", "insert_content", "search_and_replace", "edit_file"])
/** Tools whose invocation means Shofer *read/searched* a file. */
const READ_TOOLS = new Set(["read_file"])

/**
 * Process-lived shared state. The {@link PluginManager} loads the plugin once and
 * builds one stable `ctx` (storage/ai/host) reused across every hook call, so a
 * single lazily-created {@link MemoryStore} keeps all hooks on one coherent view.
 */
interface PluginState {
	/** One store per workspace (mirrors the built-in's per-workspace manager instances). */
	stores: Map<string, MemoryStore>
	/** One agent orchestrator per workspace (the Stage-C loop; created lazily on first question). */
	agents: Map<string, LiveMemoryAgent>
	watchDisposable?: HostDisposable
	serviceDisposable?: HostDisposable
}
const state: PluginState = { stores: new Map(), agents: new Map() }

/** The workspace key used for both the store + agent maps. */
function workspaceKey(ctx: PluginContext): string {
	return ctx.workspacePath ?? ctx.cwd ?? "default-workspace"
}

/**
 * Whether this plugin may actually do its job.
 *
 * The plugin is **enabled by default** (bundled scope), but everything it does costs
 * the user money: answering a question, compacting the memory log. Until they grant
 * the separate billed-AI consent, `ctx.ai` is a denying stub — so every hook below
 * returns early and the plugin is inert: no tool in the model's catalog that would
 * only fail, no prompt section, no watcher, no background service, no stored
 * observations. Granting consent reloads the plugin, and it comes alive with the same
 * code path a manual enable takes.
 */
function isReady(ctx: PluginContext): boolean {
	return ctx.ai?.hasConsent() ?? false
}

/** Config accessors with defaults matching the manifest. */
function cfg(ctx: PluginContext) {
	const c = ctx.config ?? {}
	return {
		profileRef: typeof c.profileRef === "string" ? c.profileRef : "",
		maxObservations: typeof c.maxObservations === "number" ? c.maxObservations : 400,
		maxQuestions: typeof c.maxQuestions === "number" ? c.maxQuestions : 50,
		watchGlob: typeof c.watchGlob === "string" ? c.watchGlob : "**/*",
		compactIntervalMs: typeof c.compactIntervalMs === "number" ? c.compactIntervalMs : 300000,
		maxContextTokens:
			typeof c.maxContextTokens === "number" && c.maxContextTokens > 0
				? c.maxContextTokens
				: DEFAULT_MAX_CONTEXT_TOKENS,
		contextFillThreshold:
			typeof c.contextFillThreshold === "number" && c.contextFillThreshold > 0 && c.contextFillThreshold <= 1
				? c.contextFillThreshold
				: DEFAULT_CONTEXT_FILL_THRESHOLD,
	}
}

/** Lazily create (once per workspace) the workspace-scoped store from `ctx.storage`. */
function getStore(ctx: PluginContext): MemoryStore | undefined {
	if (!ctx.storage) return undefined
	const c = cfg(ctx)
	const workspace = workspaceKey(ctx)
	const existing = state.stores.get(workspace)
	if (existing) return existing
	const store = new MemoryStore(ctx.storage, workspace, {
		maxObservations: c.maxObservations,
		maxQuestions: c.maxQuestions,
		// Enables on-load file-context validation (a no-op until file contexts are
		// persisted). Scoped by the plugin's `permissions.filesystem: ["."]` grant.
		hostFs: ctx.host?.fs,
	})
	state.stores.set(workspace, store)
	return store
}

/** An already-created agent for this workspace, if any (non-creating — for cheap hooks). */
function peekAgent(ctx: PluginContext): LiveMemoryAgent | undefined {
	return state.agents.get(workspaceKey(ctx))
}

/**
 * Push the current panel state over the scoped plugin-UI channel (`ctx.ui`, §6.8) —
 * the Stage-E chat panel's data source. Mirrors the built-in
 * `LiveMemoryChatProvider._postState`: a single `state` message carrying the agent
 * state header, context-window usage, the typed conversation, and the accumulated
 * observation/Q&A counters. No-op when the plugin has no UI sender (headless / no
 * `permissions.ui`). `agent` is passed directly during streaming (it may not yet be in
 * the workspace map); otherwise the already-created agent (if any) is used. Best-effort:
 * fire-and-forget and never throws into a hook.
 */
async function pushPanelState(ctx: PluginContext, agent?: LiveMemoryAgent): Promise<void> {
	if (!ctx.ui) return
	const a = agent ?? peekAgent(ctx)
	let observations = 0
	let questions = 0
	const store = getStore(ctx)
	if (store) {
		try {
			const data = await store.snapshot()
			observations = data.stats.totalObservations
			questions = data.stats.totalQuestions
		} catch {
			// Best-effort stats; never block a state push.
		}
	}
	const contextUsage = a?.getContextUsage() ?? {
		currentTokens: 0,
		maxTokens: 0,
		fillFraction: 0,
		isNearlyFull: false,
	}
	// Best-effort model label (for the badge popover's "Model" row). Never block/throw.
	let modelId: string | undefined
	try {
		modelId = a ? await a.getModelLabel() : undefined
	} catch {
		// model label is best-effort — omit on failure.
	}
	try {
		ctx.ui.postMessage({
			type: "state",
			state: a?.state ?? "Standby",
			stateMessage: a?.stateMessage ?? "Live Memory is idle — ask a question to start a session.",
			contextUsage,
			messages: a ? a.getMessages() : [],
			stats: { observations, questions, pendingQuestions: a?.pendingQuestionCount ?? 0 },
			// Extra fields for the chat-input badge popover (mirrors the built-in
			// LiveMemoryPopover's info rows).
			modelId,
			contextFiles: a?.contextFiles ?? [],
			conversationTurnCount: a?.conversationTurnCount ?? 0,
			costSnapshot: a?.getCostSnapshot(),
		})
	} catch {
		// A detached webview must never break the caller (ctx.ui already isolates errors).
	}
}

/**
 * Lazily create (once per workspace) + initialize the Stage-C {@link LiveMemoryAgent}.
 * Requires `ctx.ai` (host LLM access) + `ctx.host.fs` (the tool executor's filesystem);
 * returns `undefined` when either is absent. The agent restores its persisted
 * conversation window from the store, wires the workspace directory tree + the live
 * accumulated-memory context into its system prompt, and persists back through the store.
 */
async function getAgent(ctx: PluginContext): Promise<LiveMemoryAgent | undefined> {
	if (!ctx.ai || !ctx.host?.fs) return undefined
	const store = getStore(ctx)
	if (!store) return undefined

	const workspace = workspaceKey(ctx)
	const existing = state.agents.get(workspace)
	if (existing) return existing

	const c = cfg(ctx)
	const fs = ctx.host.fs
	const maxContextTokens = c.maxContextTokens
	const buildTree = async (): Promise<string> => {
		try {
			return await new LiveMemoryDirectoryTree(workspace, maxContextTokens, fs).generate()
		} catch {
			return "[Workspace directory tree unavailable]"
		}
	}

	const agent = new LiveMemoryAgent({
		llm: new MemoryLlmClient(ctx.ai, c.profileRef),
		executor: LiveMemoryToolExecutor.fromContext(ctx),
		workspacePath: workspace,
		maxContextTokens,
		contextFillThreshold: c.contextFillThreshold,
		directoryTree: await buildTree(),
		rebuildDirectoryTree: buildTree,
		// Fold the live observation/Q&A log into the system prompt each question (the
		// plugin's "memory" is the passive activity log; the built-in's is its window).
		memoryContextProvider: async () => renderMemoryContext(await store.snapshot()),
		// Sandboxed reads for contextFiles, scoped by `permissions.filesystem`.
		readFile: (abs) => fs.readFile(abs),
		persist: (snapshot) => store.saveConversation(snapshot),
		// Stage-E: stream every state transition + conversation mutation to the chat
		// panel over `ctx.ui` (the plugin-native replacement for the built-in manager's
		// onStateChange/onConversationUpdate emitters the LiveMemoryChatProvider subscribes
		// to). `agent` is passed directly so streaming works before it lands in the map.
		onStateChange: () => void pushPanelState(ctx, agent),
		onConversationUpdate: () => void pushPanelState(ctx, agent),
	})

	// Restore any persisted conversation window + cost ledger, then promote to Ready.
	const data = await store.snapshot()
	agent.initialize({ messages: data.messages, fileContexts: data.fileContexts, costTracking: data.costTracking })

	state.agents.set(workspace, agent)
	return agent
}

/** Best-effort extraction of a file path from a tool call's arguments. */
function extractPath(args: Record<string, unknown>): string | undefined {
	for (const key of ["path", "file_path", "filePath", "file"]) {
		const v = args[key]
		if (typeof v === "string" && v.trim() !== "") return v
	}
	return undefined
}

/** Classify a tool call as an edit/read observation, or `undefined` to ignore it. */
function classify(toolName: string): ObservationKind | undefined {
	if (EDIT_TOOLS.has(toolName)) return "edit"
	if (READ_TOOLS.has(toolName)) return "read"
	return undefined
}

function truncate(text: string, max: number): string {
	const oneLine = text.replace(/\s+/g, " ").trim()
	return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`
}

const plugin: ShoferPlugin = {
	name: PLUGIN_NAME,

	async initialize(ctx: PluginContext): Promise<void> {
		if (!isReady(ctx)) {
			ctx.host?.log.info("enabled but not AI-consented — staying inert until the user consents")
			return
		}
		const store = getStore(ctx)
		if (!store) return
		// Prime the cache so the first prompt build / question sees persisted memory.
		await store.load()

		const c = cfg(ctx)
		ctx.host?.log.info(`initialized (watchGlob="${c.watchGlob}", maxObservations=${c.maxObservations})`)

		// ── External edits via ctx.host.watch (P6.G3) ──────────────────────────
		// The watch callback now carries the changed path + change kind (P7 —
		// path-carrying watch), so we record the concrete file and whether it was
		// created/changed/deleted. Debounced per path so a burst of saves to one file
		// is a single observation.
		if (ctx.host?.watch) {
			const pending = new Map<string, ReturnType<typeof setTimeout>>()
			state.watchDisposable = ctx.host.watch(c.watchGlob, (event) => {
				const prior = pending.get(event.path)
				if (prior) clearTimeout(prior)
				pending.set(
					event.path,
					setTimeout(() => {
						pending.delete(event.path)
						ctx.host?.log.debug(`observed external ${event.type}: ${event.path}`)
						void store.recordObservation({
							at: Date.now(),
							kind: "external",
							subject: event.path,
							via: "ctx.host.watch",
							note: `external ${event.type}`,
						})
					}, 250),
				)
			})
		}

		// ── Background maintenance service via ctx.registerService (P6.G7) ──────
		// Periodically compact the observation log into a running summary using ctx.ai.
		if (ctx.registerService && c.compactIntervalMs > 0) {
			let timer: ReturnType<typeof setInterval> | undefined
			state.serviceDisposable = ctx.registerService({
				name: "live-memory-compactor",
				start: () => {
					timer = setInterval(() => {
						void (async () => {
							if (!ctx.ai) return
							try {
								const data = await store.snapshot()
								const summary = await summarizeMemory(ctx.ai, c.profileRef, data)
								if (summary) await store.setSummary(summary)
							} catch {
								// Best-effort maintenance; never surface to the host.
							}
						})()
					}, c.compactIntervalMs)
					if (typeof timer.unref === "function") timer.unref()
				},
				stop: () => {
					if (timer) clearInterval(timer)
				},
			})
		}
	},

	registerTools(ctx: PluginContext) {
		// An unconsented plugin contributes nothing: a registered `ask_live_memory` would
		// cost every task's catalog its schema and burn a turn when the model tried it.
		if (!isReady(ctx)) return []
		// Capture this call's `ctx` (with ai/storage) in the tool closure — the tool's
		// own `execute` receives a CustomToolContext, not the PluginContext.
		const store = getStore(ctx)
		return [
			defineCustomTool({
				name: "ask_live_memory",
				description:
					"Ask the persistent Live Memory a question about this codebase. It answers from the knowledge it has accumulated by observing the files Shofer edits and reads (and external changes) over time, running a read-only tool-using agent loop over the workspace. Read-only; best for bigger, cross-file investigative questions.",
				parameters: z.object({
					question: z.string().describe("The investigative question to answer from accumulated memory."),
					contextFiles: z
						.array(z.string())
						.describe("Optional workspace-relative file paths to load into the memory's context window.")
						.optional(),
					timeoutMs: z
						.number()
						.describe(
							"HARD limit (ms) for the whole call, covering queue-wait + processing. Default 300000.",
						)
						.optional(),
					softTimeoutSec: z
						.number()
						.describe(
							"Soft (advisory) wall-time recommendation in seconds, embedded in the prompt. Default 60.",
						)
						.optional(),
					softResultLength: z
						.number()
						.describe(
							"Soft (advisory) answer-length recommendation in characters, embedded in the prompt. Default 2000.",
						)
						.optional(),
				}),
				async execute({
					question,
					contextFiles,
					timeoutMs,
					softTimeoutSec,
					softResultLength,
				}): Promise<string> {
					if (!store) return "Live Memory error: no persistent storage is available (ctx.storage unwired)."
					if (!ctx.ai) {
						return "Live Memory error: this plugin is not granted host AI access (ctx.ai absent). Grant permissions.ai."
					}
					if (!question || question.trim() === "")
						return "Live Memory error: a non-empty `question` is required."
					try {
						const agent = await getAgent(ctx)
						if (!agent) {
							return "Live Memory error: the agent could not start (ctx.host.fs is unavailable — grant permissions.filesystem)."
						}
						const result = await agent.askQuestion(question, contextFiles ?? undefined, {
							timeoutMs: timeoutMs ?? undefined,
							softTimeoutSec: softTimeoutSec ?? undefined,
							softResultLength: softResultLength ?? undefined,
						})
						// Persist the Q&A so the observation/Q&A stats (surfaced in the prompt
						// section) reflect the exchange; the conversation window is persisted
						// separately by the agent itself.
						await store.recordQa(question, result.answer)

						// Output block matching the built-in AskLiveMemoryTool.
						return `Live Memory Answer:
${result.answer}

---
Context: ${result.contextUsage.currentTokens} / ${result.contextUsage.maxTokens} tokens (${(result.contextUsage.fillFraction * 100).toFixed(1)}% full)
Duration: ${(result.durationMs / 1000).toFixed(1)}s
Tokens: ${result.tokensUsed.prompt} prompt + ${result.tokensUsed.completion} completion = ${result.tokensUsed.total} total
Cost: $${result.costSnapshot.sessionEstimatedCostUSD.toFixed(6)} (session total)
Files in context: ${result.contextFiles.length}`
					} catch (error) {
						// A granted-but-not-consented plugin gets a denying ctx.ai stub whose
						// buildHandler throws inside the loop — surfaced as a clear, non-billing error.
						return `Live Memory error: ${error instanceof Error ? error.message : String(error)}`
					}
				},
			}),
		]
	},

	async transformSystemPrompt(prompt: string, ctx: PluginContext): Promise<string> {
		// Without consent there is no tool to describe, so the section would be prompt
		// tokens spent telling the model about something it cannot use.
		if (!isReady(ctx)) return prompt
		const store = getStore(ctx)
		if (!store) return prompt
		const data = await store.snapshot()
		// `ctx.ai.hasConsent()` (P7) tells us whether calls will actually run — `ctx.ai`
		// is *present* in both the live and denying-stub cases, so a bare `!!ctx.ai` would
		// mislabel a granted-but-unconsented plugin as ready. Read-only: no billed call.
		const aiReady = ctx.ai?.hasConsent() ?? false

		// Read live model label + context-window fill from an ALREADY-running agent (do not
		// force-create one here — building the directory tree/handler on every prompt would
		// be wasteful). Before the first question the section shows stats only; once the
		// agent exists it gains the model label + fill %/⚠️, matching getLiveMemorySection.
		const agent = peekAgent(ctx)
		let modelLabel: string | undefined
		if (agent && aiReady) {
			// getModel() on the (already-built) handler — best-effort, no billed call.
			modelLabel = await agent.getModelLabel().catch(() => undefined)
		}

		const section = buildLiveMemorySection(data, {
			aiReady,
			modelLabel,
			contextUsage: agent?.getContextUsage(),
		})
		return `${prompt}\n\n${section}`
	},

	/**
	 * Stage-E: the extension-side receiver for the chat panel's scoped UI channel (§6.8).
	 * The panel drives the plugin with a tiny command vocabulary; the plugin answers by
	 * pushing fresh state back over `ctx.ui` (via {@link pushPanelState}). Observer-style —
	 * never throws (the registry isolates + warns on a throw).
	 *
	 *  - `ready` / `getState` → push the current state (panel mount / manual refresh).
	 *  - `clear`  → clear the memory agent's context window (keeps the observation/Q&A log),
	 *               mirroring the built-in `liveMemory.clearContext`.
	 *  - `empty`  → wipe the persisted store (`ctx.storage.delete`) and drop the live agent
	 *               so the next question re-initializes from a blank slate.
	 */
	async onUiMessage(message: unknown, ctx: PluginContext): Promise<void> {
		const type =
			message && typeof message === "object" && "type" in message
				? String((message as { type: unknown }).type)
				: ""
		switch (type) {
			case "ready":
			case "getState":
				await pushPanelState(ctx)
				return
			case "showChat":
				// The badge popover's "View Chat" — open the live chat bundle (the
				// `sidebar-panel` region) in a standalone editor panel, matching the built-in
				// "Live Memory Chat" panel. Then push fresh state so it renders immediately.
				ctx.ui?.showPanel({ title: "Live Memory Chat" })
				await pushPanelState(ctx)
				return
			case "clear": {
				const agent = peekAgent(ctx)
				if (agent) await agent.clearContext()
				await pushPanelState(ctx)
				return
			}
			case "empty": {
				const store = getStore(ctx)
				if (store) await store.empty()
				// Drop the live agent so the next `ask_live_memory` rebuilds it from the now-empty
				// store (its persisted conversation window was in the deleted file).
				state.agents.delete(workspaceKey(ctx))
				await pushPanelState(ctx)
				return
			}
			default:
				// Unknown command — ignore (forward-compatible; never throws).
				return
		}
	},

	onEvent(event: PluginEvent, ctx: PluginContext): void {
		if (!isReady(ctx)) return
		// Lightweight, read-only observation of the telemetry catalog. Task starts/
		// completions are captured with richer detail by the lifecycle hooks below;
		// this catches anything else worth a memory marker without ever throwing.
		const store = getStore(ctx)
		if (!store) return
		void store
			.recordObservation({ at: Date.now(), kind: "task", subject: `event:${event.name}`, via: "onEvent" })
			.catch(() => {})
	},

	lifecycle: {
		beforeTaskStart(ctx): void {
			if (!isReady(ctx)) return
			const store = getStore(ctx)
			if (!store) return
			const prompt = ctx.prompt ? truncate(ctx.prompt, 200) : "(no prompt)"
			void store
				.recordObservation({
					at: Date.now(),
					kind: "task",
					subject: "task started",
					via: "lifecycle",
					note: prompt,
				})
				.catch(() => {})
		},

		afterTaskComplete(ctx): void {
			if (!isReady(ctx)) return
			const store = getStore(ctx)
			if (!store) return
			void store
				.recordObservation({
					at: Date.now(),
					kind: "task",
					subject: `task ${ctx.reason ?? "ended"}`,
					via: "lifecycle",
				})
				.catch(() => {})
		},

		/**
		 * The plugin-native replacement for `FileContextTracker._notifyLiveMemory`:
		 * observe Shofer's own file activity. `afterToolCall` gives us the tool name,
		 * its args (carrying the file path), AND the result — strictly *more* signal
		 * than the built-in's edit-only path notification. Read-only: we return
		 * nothing, leaving the tool result untouched for the model.
		 */
		async afterToolCall(toolName, args, result, ctx): Promise<void> {
			if (!isReady(ctx)) return
			const kind = classify(toolName)
			if (!kind) return
			const store = getStore(ctx)
			if (!store) return
			const subject = extractPath(args) ?? "(unknown file)"
			const observation: Observation = {
				at: Date.now(),
				kind,
				subject,
				via: toolName,
				note: kind === "edit" ? truncate(String(result ?? ""), 160) : undefined,
			}
			await store.recordObservation(observation)

			// Feed edit observations into the running agent's recentlyModifiedFiles hint —
			// the plugin-native replacement for FileContextTracker → notifyFileModified. Only
			// an already-created agent is notified (no eager LLM-handler build for a hook).
			if (kind === "edit" && subject !== "(unknown file)") {
				peekAgent(ctx)?.notifyFileModified(subject)
			}
		},
	},
}

export default plugin
