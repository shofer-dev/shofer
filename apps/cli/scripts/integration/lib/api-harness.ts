/**
 * Shared harness for ExtensionHost-based integration tests.
 *
 * Provides:
 *
 * - `createApiHarness()` — boots an ExtensionHost against a real (or mock)
 *   provider and wires the per-task message collector.
 *
 * - `TaskTrace` — accumulated live messages and child task IDs for a single
 *   workflow or task run. Includes helpers to fetch the post-completion
 *   markdown/JSON exports for the task and each of its direct children.
 *
 * Design notes
 * ────────────
 * The ExtensionHost monkey-patches `console.*` during `activate()` and only
 * restores it at `dispose()`. All harness output therefore goes through
 * `process.stdout.write` (which the host does not intercept) rather than
 * `console.log`.
 *
 * Child tasks spawned by a workflow are tracked live via the
 * `ShoferEventName.TaskSpawned` event, whose payload is `(parentId, childId)`.
 * `HistoryItem.childIds` also carries the full list after completion, but
 * may lag (async persist); the live set is more reliable for test assertions.
 *
 * Human asks (`followup` type) surface via `client.on("waitingForInput")`.
 * Each `TaskTrace` carries a `followupQueue` that is consumed FIFO; the
 * harness drains it automatically when a `followup` ask fires for that task's
 * subtree. Register replies before starting the workflow.
 */

import path from "path"
import { fileURLToPath } from "url"

import { ShoferEventName } from "@shofer/types"
import type { ShoferMessage, HistoryItem } from "@shofer/types"

import { ExtensionHost } from "../../../src/agent/extension-host.js"
import type { ExtensionHostOptions } from "../../../src/agent/extension-host.js"
import { getDefaultExtensionPath } from "../../../src/lib/utils/extension.js"
import type { WaitingForInputEvent } from "../../../src/agent/events.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

/** Per-task accumulated data collected during a single workflow/task run. */
export interface TaskTrace {
	/** Task ID of the root workflow task. */
	readonly taskId: string

	/**
	 * Live per-task messages for the root and all direct children, keyed by
	 * taskId. Messages are non-partial `say`/`ask` entries only.
	 */
	readonly messages: Map<string, ShoferMessage[]>

	/**
	 * Direct child task IDs spawned by this workflow task (via TaskSpawned).
	 * Populated live; mirrors `HistoryItem.childIds` after settle.
	 */
	readonly childIds: Set<string>

	/**
	 * Pre-registered canned replies for `followup` asks. Consumed FIFO.
	 * Push replies here before calling `createWorkflow` or `runTask`.
	 */
	readonly followupQueue: string[]

	/**
	 * Returns all non-partial text messages for the root workflow task.
	 * Convenience over iterating `messages.get(taskId)`.
	 */
	rootMessages(): ShoferMessage[]

	/**
	 * Returns all non-partial text messages for a specific child task ID.
	 * Returns an empty array if that child produced no messages.
	 */
	childMessages(childId: string): ShoferMessage[]

	/**
	 * Fetches the markdown transcript for the root task (post-completion).
	 * Delegates to `ShoferAPI.getTaskMarkdownExport`.
	 */
	getMarkdown(): Promise<string>

	/**
	 * Fetches the markdown transcript for a direct child task (post-completion).
	 * Delegates to `ShoferAPI.getTaskMarkdownExport`.
	 */
	getChildMarkdown(childId: string): Promise<string>

	/**
	 * Fetches the JSON summary for the root task (post-completion).
	 * Delegates to `ShoferAPI.getTaskJsonExport`.
	 */
	getJsonExport(): Promise<Record<string, unknown>>

	/**
	 * Fetches the JSON summary for a direct child task (post-completion).
	 * Delegates to `ShoferAPI.getTaskJsonExport`.
	 */
	getChildJsonExport(childId: string): Promise<Record<string, unknown>>

	/**
	 * Returns the `HistoryItem` for the root task.
	 * The `flowState` field carries the workflow terminal status for WorkflowTasks.
	 */
	historyItem(): HistoryItem | undefined

	/**
	 * Awaits the root task reaching a terminal `TaskCompleted` event.
	 * Rejects on timeout.
	 */
	waitForCompletion(timeoutMs?: number): Promise<void>
}

/** Options for creating an API harness session. */
export interface ApiHarnessOptions {
	/** Real or mock provider name (e.g. `"shofer"` or `"mock"`). */
	provider: string
	apiKey?: string
	baseUrl?: string
	model?: string
	workspacePath?: string
	/** When true, omit stdout output entirely (useful when running many flows). */
	silent?: boolean
}

/** The harness session returned by `createApiHarness`. */
export interface ApiHarness {
	readonly host: ExtensionHost

	/**
	 * Create a TaskTrace for a new workflow run.
	 * Must be called before `host.api.createWorkflow()` so the event listeners
	 * are registered before the first event fires.
	 *
	 * @param followupReplies FIFO canned replies for `followup` asks.
	 * @returns A pre-wired `TaskTrace`; assign `trace.taskId` after
	 *          `createWorkflow` resolves.
	 */
	traceFor(taskIdRef: { taskId: string | undefined }, followupReplies?: string[]): TaskTrace

	/** Dispose the host. Must be called after all traces are done. */
	dispose(): Promise<void>
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal implementation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Boots an ExtensionHost and returns a harness session.
 *
 * The host is shared across all traces in one harness session, so multiple
 * workflows can be run sequentially without re-loading the extension bundle.
 */
export async function createApiHarness(options: ApiHarnessOptions): Promise<ApiHarness> {
	const extPath = path.resolve(getDefaultExtensionPath(__dirname))
	const workspacePath = options.workspacePath ?? process.cwd()

	const hostOptions: ExtensionHostOptions = {
		mode: "code",
		provider: options.provider as never,
		apiKey: options.apiKey ?? "x",
		baseUrl: options.baseUrl,
		model: options.model ?? "mock-model",
		workspacePath,
		extensionPath: extPath,
		user: null,
		ephemeral: false,
		debug: false,
		exitOnComplete: false,
		nonInteractive: true,
		disableOutput: options.silent ?? false,
	}

	const host = new ExtensionHost(hostOptions)
	await host.activate()

	const api = host.api
	const client = host.client

	// Global per-taskId message store (all traces in this session share it).
	const allMessages = new Map<string, ShoferMessage[]>()

	const appendMessage = (taskId: string, msg: ShoferMessage) => {
		if (!allMessages.has(taskId)) allMessages.set(taskId, [])
		allMessages.get(taskId)!.push(msg)
	}

	// Collect all non-partial messages across every task in the session.
	api.on(ShoferEventName.Message, (payload: { taskId: string; action: string; message: ShoferMessage }) => {
		if (!payload.message.partial && payload.action === "created") {
			appendMessage(payload.taskId, payload.message)
		}
	})

	// Active traces indexed by root taskId, used to route followup asks and
	// child-spawn events to the right trace.
	const activeTraces = new Map<string, TaskTraceImpl>()

	// TaskSpawned: (parentId, childId). Wire the child into the parent trace's
	// childIds set so the test can query child outputs.
	api.on(ShoferEventName.TaskSpawned, (parentId: string, childId: string) => {
		const trace = activeTraces.get(parentId)
		if (trace) {
			trace._childIds.add(childId)
			// Also register the child → parent mapping so followup asks on the
			// child bubble up to the right trace.
			activeTraces.set(childId, trace)
		}
	})

	// Followup intercept: fires for any task in the session. Route to the trace
	// that owns that task (either as root or child).
	client.on("waitingForInput", (event: WaitingForInputEvent) => {
		if (event.message.ask !== "followup") return

		// Find the trace that corresponds to this taskId. The WaitingForInput
		// event does not carry a taskId directly, but the active task in the
		// ExtensionHost client is the one that raised the ask. Walk through all
		// active traces and check the first one with a queued reply.
		for (const trace of new Set(activeTraces.values())) {
			if (trace.followupQueue.length > 0) {
				const reply = trace.followupQueue.shift()!
				// Give the dispatcher a beat to finish emitting the event before
				// we inject the response, so our reply arrives after the
				// ask is recorded in the task's message list. `respond()` posts
				// a proper `askResponse: messageResponse` WebviewMessage that
				// resolves the task's pending `ask("followup", …)`.
				setImmediate(() => client.respond(reply))
				break
			}
		}
	})

	return {
		host,
		traceFor(taskIdRef, followupReplies = []) {
			const trace = new TaskTraceImpl(taskIdRef, allMessages, api, followupReplies)
			// Register eagerly — taskIdRef.taskId is set after createWorkflow returns.
			// TaskSpawned events arrive after that, so the trace is always registered in time.
			// We use a proxy key that we backfill once the taskId is known.
			//
			// Use a sentinel key until the taskId is known; replace it once known.
			const registerOnce = () => {
				if (taskIdRef.taskId && !activeTraces.has(taskIdRef.taskId)) {
					activeTraces.set(taskIdRef.taskId, trace)
				}
			}
			// Call immediately (covers the case where createWorkflow is awaited
			// before traceFor is called, which is incorrect usage but guard anyway).
			registerOnce()
			// Also wire a one-shot TaskCreated listener to catch the common
			// pattern: `traceFor(ref)` → `ref.taskId = await createWorkflow(…)`
			const onCreated = (id: string) => {
				if (!taskIdRef.taskId || taskIdRef.taskId === id) {
					taskIdRef.taskId = id
					activeTraces.set(id, trace)
					api.off(ShoferEventName.TaskCreated, onCreated)
				}
			}
			api.on(ShoferEventName.TaskCreated, onCreated)
			return trace
		},
		async dispose() {
			activeTraces.clear()
			await host.dispose()
			process.exit(0)
		},
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// TaskTraceImpl
// ─────────────────────────────────────────────────────────────────────────────

class TaskTraceImpl implements TaskTrace {
	readonly followupQueue: string[]

	/** Mutable backing set; exposed as readonly `childIds` in the interface. */
	readonly _childIds = new Set<string>()

	private readonly taskIdRef: { taskId: string | undefined }
	private readonly allMessages: Map<string, ShoferMessage[]>
	private readonly api: {
		getTaskHistoryItems(): HistoryItem[]
		getTaskMarkdownExport(id: string): Promise<string>
		getTaskJsonExport(id: string): Promise<Record<string, unknown>>
	}

	constructor(
		taskIdRef: { taskId: string | undefined },
		allMessages: Map<string, ShoferMessage[]>,
		api: {
			getTaskHistoryItems(): HistoryItem[]
			getTaskMarkdownExport(id: string): Promise<string>
			getTaskJsonExport(id: string): Promise<Record<string, unknown>>
		},
		followupReplies: string[],
	) {
		this.taskIdRef = taskIdRef
		this.allMessages = allMessages
		this.api = api
		this.followupQueue = [...followupReplies]
	}

	get taskId(): string {
		if (!this.taskIdRef.taskId) throw new Error("taskId not yet assigned")
		return this.taskIdRef.taskId
	}

	get messages(): Map<string, ShoferMessage[]> {
		return this.allMessages
	}

	get childIds(): Set<string> {
		return this._childIds
	}

	rootMessages(): ShoferMessage[] {
		return this.allMessages.get(this.taskId) ?? []
	}

	childMessages(childId: string): ShoferMessage[] {
		return this.allMessages.get(childId) ?? []
	}

	async getMarkdown(): Promise<string> {
		return this.api.getTaskMarkdownExport(this.taskId)
	}

	async getChildMarkdown(childId: string): Promise<string> {
		return this.api.getTaskMarkdownExport(childId)
	}

	async getJsonExport(): Promise<Record<string, unknown>> {
		return this.api.getTaskJsonExport(this.taskId)
	}

	async getChildJsonExport(childId: string): Promise<Record<string, unknown>> {
		return this.api.getTaskJsonExport(childId)
	}

	historyItem(): HistoryItem | undefined {
		return this.api.getTaskHistoryItems().find((h) => h.id === this.taskId)
	}

	waitForCompletion(timeoutMs = 180_000): Promise<void> {
		return new Promise((resolve, reject) => {
			// Resolve via the authoritative TaskCompleted event (not persisted
			// history, which may lag by one async flush cycle).
			const onCompleted = (id: string, _t: unknown, _u: unknown, info: { isSubtask?: boolean }) => {
				if (id === this.taskId && !info?.isSubtask) {
					cleanup()
					resolve()
				}
			}
			const timer = setTimeout(() => {
				cleanup()
				reject(new Error(`waitForCompletion timed out after ${timeoutMs}ms for task ${this.taskIdRef.taskId}`))
			}, timeoutMs)

			const cleanup = () => {
				clearTimeout(timer)
				// Dynamic import isn't needed — ShoferEventName is available at
				// module scope, but the api reference is captured in the closure.
				;(this.api as unknown as { off(event: string, fn: unknown): void }).off(
					ShoferEventName.TaskCompleted,
					onCompleted,
				)
			}
			;(this.api as unknown as { on(event: string, fn: unknown): void }).on(
				ShoferEventName.TaskCompleted,
				onCompleted,
			)
		})
	}
}
