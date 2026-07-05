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

import { MemoryStore, type Observation, type ObservationKind } from "./memory-store.js"
import { answerFromMemory, summarizeMemory } from "./memory-llm.js"
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
	watchDisposable?: HostDisposable
	serviceDisposable?: HostDisposable
}
const state: PluginState = { stores: new Map() }

/** Config accessors with defaults matching the manifest. */
function cfg(ctx: PluginContext) {
	const c = ctx.config ?? {}
	return {
		profileRef: typeof c.profileRef === "string" ? c.profileRef : "",
		maxObservations: typeof c.maxObservations === "number" ? c.maxObservations : 400,
		maxQuestions: typeof c.maxQuestions === "number" ? c.maxQuestions : 50,
		watchGlob: typeof c.watchGlob === "string" ? c.watchGlob : "**/*",
		compactIntervalMs: typeof c.compactIntervalMs === "number" ? c.compactIntervalMs : 300000,
	}
}

/** Lazily create (once per workspace) the workspace-scoped store from `ctx.storage`. */
function getStore(ctx: PluginContext): MemoryStore | undefined {
	if (!ctx.storage) return undefined
	const c = cfg(ctx)
	const workspace = ctx.workspacePath ?? ctx.cwd ?? "default-workspace"
	const existing = state.stores.get(workspace)
	if (existing) return existing
	const store = new MemoryStore(ctx.storage, workspace, {
		maxObservations: c.maxObservations,
		maxQuestions: c.maxQuestions,
	})
	state.stores.set(workspace, store)
	return store
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
		const store = getStore(ctx)
		if (!store) return
		// Prime the cache so the first prompt build / question sees persisted memory.
		await store.load()

		const c = cfg(ctx)

		// ── External edits via ctx.host.watch (P6.G3) ──────────────────────────
		// The watch callback carries no path (the HostFileWatcher seam drops the URI —
		// see DOGFOOD.md "reduced fidelity"), so we record a coarse "external change"
		// marker. Debounced so a burst of saves is one observation.
		if (ctx.host?.watch) {
			let pending: ReturnType<typeof setTimeout> | undefined
			state.watchDisposable = ctx.host.watch(c.watchGlob, () => {
				if (pending) clearTimeout(pending)
				pending = setTimeout(() => {
					void store.recordObservation({
						at: Date.now(),
						kind: "external",
						subject: `(external change under ${c.watchGlob})`,
						via: "ctx.host.watch",
					})
				}, 250)
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
		// Capture this call's `ctx` (with ai/storage) in the tool closure — the tool's
		// own `execute` receives a CustomToolContext, not the PluginContext.
		const store = getStore(ctx)
		const c = cfg(ctx)
		return [
			defineCustomTool({
				name: "ask_live_memory",
				description:
					"Ask the persistent Live Memory a question about this codebase. It answers from the knowledge it has accumulated by observing the files Shofer edits and reads (and external changes) over time. Read-only; best for bigger, cross-file investigative questions.",
				parameters: z.object({
					question: z.string().describe("The investigative question to answer from accumulated memory."),
				}),
				async execute({ question }): Promise<string> {
					if (!store) return "Live Memory error: no persistent storage is available (ctx.storage unwired)."
					if (!ctx.ai) {
						return "Live Memory error: this plugin is not granted host AI access (ctx.ai absent). Grant permissions.ai."
					}
					if (!question || question.trim() === "") return "Live Memory error: a non-empty `question` is required."
					try {
						const data = await store.snapshot()
						const result = await answerFromMemory(ctx.ai, c.profileRef, question, data, {
							maxAnswerChars: 4000,
						})
						// Persist the Q&A so memory behaves as a companion across tasks.
						await store.recordQa(question, result.answer)
						const model = result.modelId ? ` [model: ${result.modelId}]` : ""
						return `Live Memory Answer${model}:\n${result.answer}\n\n---\nGrounded in ${data.observations.length} observation(s) across this workspace; tokens: ${result.promptTokens} prompt + ${result.completionTokens} completion.`
					} catch (error) {
						// A granted-but-not-consented plugin gets a denying ctx.ai stub whose
						// buildHandler throws here — surfaced as a clear, non-billing error.
						return `Live Memory error: ${error instanceof Error ? error.message : String(error)}`
					}
				},
			}),
		]
	},

	async transformSystemPrompt(prompt: string, ctx: PluginContext): Promise<string> {
		const store = getStore(ctx)
		if (!store) return prompt
		const data = await store.snapshot()
		const section = buildLiveMemorySection(data, { aiReady: !!ctx.ai })
		return `${prompt}\n\n${section}`
	},

	onEvent(event: PluginEvent, ctx: PluginContext): void {
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
			const store = getStore(ctx)
			if (!store) return
			const prompt = ctx.prompt ? truncate(ctx.prompt, 200) : "(no prompt)"
			void store
				.recordObservation({ at: Date.now(), kind: "task", subject: "task started", via: "lifecycle", note: prompt })
				.catch(() => {})
		},

		afterTaskComplete(ctx): void {
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
		},
	},
}

export default plugin
