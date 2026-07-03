import type { AgentApi, ServerEvent } from "./agent-api.js"

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
export interface PooledExecutor {
	readonly id: string
	readonly api: AgentApi
	/** When true, excluded from new-task assignment (admin-disabled). */
	disabled?: boolean
}

export class ExecutorPool implements AgentApi {
	private readonly executors: PooledExecutor[] = []
	private readonly unsubs = new Map<string, () => void>()
	private readonly taskOwner = new Map<string, string>()
	private readonly listeners = new Set<(event: ServerEvent) => void>()
	private roundRobin = 0

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
	 * Advance the round-robin over the currently-assignable executors and return
	 * the chosen executor id, WITHOUT dispatching anything. Split out from
	 * {@link createTask} so a controller can decide the owner up front (e.g. to
	 * route a Local pick through an in-process path that bypasses the pool) while
	 * still advancing the load-balancer cursor. Returns `undefined` when no
	 * executor is assignable.
	 */
	pickNext(): string | undefined {
		const pool = this.assignable()
		if (pool.length === 0) return undefined
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
	 * Administratively enable/disable a registered executor. A disabled executor is
	 * excluded from new-task assignment (round-robin) but stays registered and keeps
	 * forwarding events for any task it already owns. No-op for an unknown id.
	 */
	setDisabled(id: string, disabled: boolean): void {
		const executor = this.executors.find((e) => e.id === id)
		if (executor) executor.disabled = disabled
	}
}
