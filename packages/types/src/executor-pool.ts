import type { AgentApi, AskResponse, ServerEvent } from "./agent-api.js"
import type { CheckpointDiffEntry, CheckpointDiffOptions, CheckpointRestoreOptions } from "./checkpoints.js"
import type { ChangedFilesPayload } from "./vscode-extension-host.js"

/**
 * Executor pool — the controller side of distributed execution (v3 architecture §13).
 *
 * The controller registers one or more **executors** (each an `AgentApi` — the Local
 * in-process agent, or a remote one via `connectSession`). The pool **is itself an
 * `AgentApi`**, so a front-end drives 1 or N executors identically:
 *  - `createTask` (a new root) is assigned to an executor (round-robin over enabled
 *    executors); the whole task tree then lives on that one executor, so in-process
 *    coordination tools (`new_task`, `wait_for_task`, …) keep working unchanged.
 *  - `sendMessage`/`cancelTask` are routed to the executor that owns the task.
 *  - `subscribe` merges every executor's event stream into one feed, tagging each
 *    event with its `executorId` (the unified multi-executor task view).
 *
 * With a single executor this is behaviourally identical to driving it directly.
 */
/**
 * A point-in-time load reading for one executor. Mirrors the shape of
 * `os.loadavg()` + `os.cpus().length` on the executor host, but is produced by an
 * **injected accessor** ({@link PooledExecutor.load}) so this module stays
 * browser-safe (the webview imports `@shofer/types`; it must NOT pull in
 * `node:os`). The Node-side caller (`NodeRegistry`) supplies the accessor.
 */
export interface LoadSample {
	/** `os.loadavg()` output — 1-, 5- and 15-minute run-queue averages. */
	loadavg: [number, number, number]
	/** Logical core count on the host, used to normalize `loadavg` across nodes. */
	cpus: number
}

/**
 * New-task assignment strategy for {@link ExecutorPool.pickNext}.
 *  - `round-robin` — rotate over the assignable executors (the historical default).
 *  - `least-load-<W>` — pick the executor with the lowest **normalized** load
 *    (`loadavg[W] / max(cpus, 1)`) for the 1-, 5- or 15-minute window.
 */
export type LoadBalancerPolicy = "round-robin" | "least-load-1m" | "least-load-5m" | "least-load-15m"

/** `loadavg` array index for each least-load window. */
const LOAD_WINDOW_INDEX: Record<Exclude<LoadBalancerPolicy, "round-robin">, 0 | 1 | 2> = {
	"least-load-1m": 0,
	"least-load-5m": 1,
	"least-load-15m": 2,
}

export interface PooledExecutor {
	readonly id: string
	readonly api: AgentApi
	/** When true, excluded from new-task assignment (admin-disabled). */
	disabled?: boolean
	/**
	 * Optional load accessor returning this executor's latest {@link LoadSample}
	 * (or `undefined` if none is available yet). Injected by the Node-side caller;
	 * consumed by {@link ExecutorPool.pickNext} under a `least-load-*` policy.
	 */
	load?: () => LoadSample | undefined
}

export class ExecutorPool implements AgentApi {
	private readonly executors: PooledExecutor[] = []
	private readonly unsubs = new Map<string, () => void>()
	private readonly taskOwner = new Map<string, string>()
	private readonly listeners = new Set<(event: ServerEvent) => void>()
	private roundRobin = 0
	private policy: LoadBalancerPolicy = "round-robin"

	/** Select the new-task assignment strategy used by {@link pickNext}. */
	setPolicy(policy: LoadBalancerPolicy): void {
		this.policy = policy
	}

	/** The current new-task assignment strategy. */
	getPolicy(): LoadBalancerPolicy {
		return this.policy
	}

	/** Register an executor; returns a fn that removes it (and stops forwarding its events). */
	add(executor: PooledExecutor): () => void {
		this.executors.push(executor)
		const unsub = executor.api.subscribe((event) => {
			for (const listener of this.listeners) listener({ ...event, executorId: executor.id })
		})
		this.unsubs.set(executor.id, unsub)
		return () => this.remove(executor.id)
	}

	remove(id: string): void {
		const idx = this.executors.findIndex((e) => e.id === id)
		if (idx === -1) return
		this.executors.splice(idx, 1)
		this.unsubs.get(id)?.()
		this.unsubs.delete(id)
	}

	/** Executors currently eligible for new-task assignment. */
	private assignable(): PooledExecutor[] {
		return this.executors.filter((e) => !e.disabled)
	}

	/**
	 * Advance the load balancer over the currently-assignable executors and return
	 * the chosen executor id, WITHOUT dispatching anything. Split out from
	 * {@link createTask} so a controller can decide the owner up front (e.g. to
	 * route a Local pick through an in-process path that bypasses the pool) while
	 * still advancing the load-balancer cursor. Returns `undefined` when no
	 * executor is assignable.
	 *
	 * Under `round-robin` (the default) this rotates over the assignable pool. Under
	 * a `least-load-*` policy it picks the assignable executor with the lowest
	 * **normalized** load (`loadavg[window] / max(cpus, 1)`) among those that expose
	 * a {@link LoadSample}. Fallbacks: executors with no sample are excluded from the
	 * comparison; if NONE expose a sample it degrades to round-robin over the
	 * assignable pool; ties (equal minimum — including the all-zeros
	 * `os.loadavg()===[0,0,0]` case) are broken by advancing the round-robin cursor
	 * across the tied set so load stays spread.
	 */
	pickNext(): string | undefined {
		const pool = this.assignable()
		if (pool.length === 0) return undefined
		if (this.policy === "round-robin") return this.roundRobinPick(pool)

		const idx = LOAD_WINDOW_INDEX[this.policy]
		const scored: { executor: PooledExecutor; load: number }[] = []
		for (const executor of pool) {
			const sample = executor.load?.()
			if (!sample) continue // no sample → excluded from the least-load comparison
			scored.push({ executor, load: sample.loadavg[idx] / Math.max(sample.cpus, 1) })
		}
		// No executor exposes a sample → degrade to round-robin over the pool.
		if (scored.length === 0) return this.roundRobinPick(pool)

		const min = Math.min(...scored.map((s) => s.load))
		const tied = scored.filter((s) => s.load === min)
		if (tied.length === 1) return tied[0]!.executor.id
		// Tie (incl. all-zeros): spread by advancing the cursor across the tied set.
		return tied[this.roundRobin++ % tied.length]!.executor.id
	}

	/** Rotate the round-robin cursor over `pool` and return the chosen id. */
	private roundRobinPick(pool: PooledExecutor[]): string {
		return pool[this.roundRobin++ % pool.length]!.id
	}

	/** Ids of the executors currently eligible for new-task assignment (enabled). */
	assignableIds(): string[] {
		return this.assignable().map((e) => e.id)
	}

	/**
	 * Dispatch a new root task to a SPECIFIC executor and record ownership.
	 * Throws if `id` is not a registered executor. Pairs with {@link pickNext}
	 * (`createTaskOn(pickNext(), …)`), which is exactly what {@link createTask}
	 * now does.
	 */
	async createTaskOn(id: string, input: { prompt: string; taskId?: string }): Promise<{ taskId: string }> {
		const executor = this.executors.find((e) => e.id === id)
		if (!executor) throw new Error(`ExecutorPool: unknown executor ${id}`)
		const result = await executor.api.createTask(input)
		this.taskOwner.set(result.taskId, executor.id)
		return result
	}

	/**
	 * Record ownership for a task created OUT OF BAND (not via `createTaskOn`) —
	 * e.g. the Local bypass, where the controller runs the task in-process and
	 * only wants `ownerOf` to report the owner. No dispatch happens here.
	 */
	assignOwner(taskId: string, executorId: string): void {
		this.taskOwner.set(taskId, executorId)
	}

	async createTask(input: { prompt: string; taskId?: string }): Promise<{ taskId: string }> {
		const id = this.pickNext()
		if (id === undefined) throw new Error("ExecutorPool: no executor available")
		return this.createTaskOn(id, input)
	}

	async sendMessage(taskId: string, message: string): Promise<void> {
		await this.owner(taskId).api.sendMessage(taskId, message)
	}

	async cancelTask(taskId: string): Promise<void> {
		await this.owner(taskId).api.cancelTask(taskId)
	}

	async respondToAsk(taskId: string, response: AskResponse): Promise<void> {
		await this.owner(taskId).api.respondToAsk(taskId, response)
	}

	// ── Reverse data channel (Shofer Nodes L3) — route to the owning executor ────

	getCheckpointDiff(taskId: string, opts: CheckpointDiffOptions): Promise<CheckpointDiffEntry[]> {
		return this.owner(taskId).api.getCheckpointDiff(taskId, opts)
	}

	getTaskChangedFiles(taskId: string): Promise<ChangedFilesPayload> {
		return this.owner(taskId).api.getTaskChangedFiles(taskId)
	}

	getChangedFileDiff(taskId: string, relPath: string): Promise<{ original: string | null; final: string | null }> {
		return this.owner(taskId).api.getChangedFileDiff(taskId, relPath)
	}

	async restoreCheckpoint(taskId: string, opts: CheckpointRestoreOptions): Promise<void> {
		await this.owner(taskId).api.restoreCheckpoint(taskId, opts)
	}

	async revertChangedFile(taskId: string, relPath: string): Promise<void> {
		await this.owner(taskId).api.revertChangedFile(taskId, relPath)
	}

	async revertAllChangedFiles(taskId: string): Promise<void> {
		await this.owner(taskId).api.revertAllChangedFiles(taskId)
	}

	async acceptChangedFile(taskId: string, relPath: string): Promise<void> {
		await this.owner(taskId).api.acceptChangedFile(taskId, relPath)
	}

	async acceptAllChangedFiles(taskId: string): Promise<void> {
		await this.owner(taskId).api.acceptAllChangedFiles(taskId)
	}

	subscribe(listener: (event: ServerEvent) => void): () => void {
		this.listeners.add(listener)
		return () => this.listeners.delete(listener)
	}

	private owner(taskId: string): PooledExecutor {
		const id = this.taskOwner.get(taskId)
		const executor = id ? this.executors.find((e) => e.id === id) : undefined
		if (!executor) throw new Error(`ExecutorPool: no owner for task ${taskId}`)
		return executor
	}

	// ── read / admin accessors (Shofer Nodes L1) ───────────────────────────────

	/** The executor id that owns `taskId`, or `undefined` if the pool never assigned it. */
	ownerOf(taskId: string): string | undefined {
		return this.taskOwner.get(taskId)
	}

	/** Ids of every registered executor (enabled and disabled), in registration order. */
	ids(): string[] {
		return this.executors.map((e) => e.id)
	}

	/** Whether an executor with `id` is currently registered. */
	has(id: string): boolean {
		return this.executors.some((e) => e.id === id)
	}

	/**
	 * The latest {@link LoadSample} for a registered executor (via its injected
	 * `load` accessor), or `undefined` if the executor is unknown or exposes none.
	 */
	loadOf(id: string): LoadSample | undefined {
		return this.executors.find((e) => e.id === id)?.load?.()
	}

	/**
	 * Administratively enable/disable a registered executor. A disabled executor is
	 * excluded from new-task assignment (round-robin) but stays registered and keeps
	 * forwarding events for any task it already owns. No-op for an unknown id.
	 */
	setDisabled(id: string, disabled: boolean): void {
		const executor = this.executors.find((e) => e.id === id)
		if (executor) executor.disabled = disabled
	}
}
