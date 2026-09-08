/**
 * Graceful drain for the HTTP/SSE transport (`http-server.ts`).
 *
 * A served node's unit of work is a TURN, and a turn outlives the request that
 * starts it: `POST /task` (or `/task/:id/message`) returns in milliseconds while
 * the reply streams for seconds or minutes over the per-task SSE response the
 * caller opened just before. `http.Server.close()` therefore says nothing useful
 * about whether the node is finished — it stops the listener and reports the
 * still-open streams as "connections", with no way to tell a turn in progress
 * from an idle keep-alive socket.
 *
 * This module supplies the missing half: a registry of the streams that ARE
 * turns, a flag that makes the transport refuse to start new ones, and a bounded
 * wait for the outstanding ones to end on their own. It holds no reference to
 * `node:http` so it can be driven — and tested — without a socket.
 *
 * Three things are load-bearing:
 *
 *   - **A per-task stream is a turn; the node-wide `/event` firehose is not.**
 *     A controller opens `/task/:id/event` for one turn and closes it when the
 *     turn's terminal event arrives, so the set of open per-task streams IS the
 *     set of turns in flight. The node-wide stream has no such boundary — an
 *     observer may hold it for the process's whole life — so waiting on one
 *     would guarantee every drain runs to its ceiling. Observers are therefore
 *     ENDED when the drain begins rather than waited on; nothing of theirs is
 *     lost, because they were watching, not working.
 *   - **The wait is bounded, and the ceiling is not negotiable.** A turn parked
 *     on an interactive ask is waiting for a human, and a human may never
 *     answer. The grace is what stops human latency from becoming an
 *     unterminatable process; whatever is still open when it elapses is closed
 *     deliberately, so the caller sees a stream that ended rather than one that
 *     hangs.
 *   - **A short settle window follows the last turn.** The turn's terminal event
 *     reaches the controller from INSIDE the agent's run; the persistence
 *     teardown that follows it (a final transcript write, releasing a task
 *     lease) happens after, and this module cannot observe it. Waiting a moment
 *     after the last stream closes lets that teardown land before the caller
 *     exits the process. It is a margin, not a guarantee — a store that fences
 *     its writes must still have its own expiry backstop.
 */

/** How long to wait after the last turn ends for persistence teardown to land. */
export const STORE_SETTLE_MS = 2_000

/** Options for {@link TurnDrain.settle}. */
export interface DrainOptions {
	/** Ceiling on the whole wait. Turns still open when it elapses are closed. */
	graceMs: number
	/**
	 * Quiet period after the last turn ends, for persistence teardown this
	 * module cannot see. Skipped entirely when nothing was in flight.
	 */
	settleMs?: number
}

/** A cancellable timer promise, so a lost race never leaves a pending handle. */
function delay(ms: number): { promise: Promise<void>; cancel: () => void } {
	let timer: ReturnType<typeof setTimeout> | undefined
	const promise = new Promise<void>((resolve) => {
		timer = setTimeout(resolve, ms)
	})
	return { promise, cancel: () => clearTimeout(timer) }
}

/**
 * The drain registry and its state. One instance per served transport; it is
 * created by the caller so both the request handler and the shutdown path can
 * hold it.
 */
export class TurnDrain {
	private drainingNow = false
	private nextId = 1
	/** Open per-task event streams — the turns in flight. */
	private readonly turns = new Map<number, { taskId: string; close: () => void }>()
	/** Open node-wide event streams — observers, ended at drain time. */
	private readonly observers = new Map<number, () => void>()
	/** Resolvers waiting for the turn registry to empty. */
	private readonly idleWaiters: Array<() => void> = []

	/** Whether new turns are being refused. */
	get draining(): boolean {
		return this.drainingNow
	}

	/** How many turns are being served right now. */
	get inFlight(): number {
		return this.turns.size
	}

	/** The tasks whose turns are in flight, deduplicated — for the shutdown log. */
	inFlightTasks(): string[] {
		return [...new Set([...this.turns.values()].map((t) => t.taskId))]
	}

	/**
	 * Refuse new turns from here on, and release the observers.
	 *
	 * Separate from {@link settle} so a caller can take the node out of service
	 * at the instant the signal arrives and only then decide how long to wait —
	 * and so a readiness probe can answer "not serving" before the first turn has
	 * finished. Idempotent.
	 */
	begin(): void {
		if (this.drainingNow) return
		this.drainingNow = true
		for (const close of this.observers.values()) close()
		this.observers.clear()
	}

	/**
	 * Record a per-task event stream as a turn in flight. Returns the
	 * deregistration, which the caller runs when the stream closes; it is
	 * idempotent, because a response can close for more than one reason.
	 */
	registerTurn(taskId: string, close: () => void): () => void {
		const id = this.nextId++
		this.turns.set(id, { taskId, close })
		return () => {
			if (!this.turns.delete(id)) return
			if (this.turns.size === 0) {
				for (const resolve of this.idleWaiters.splice(0)) resolve()
			}
		}
	}

	/**
	 * Record a node-wide event stream. Observers are ended by {@link begin} and
	 * never waited on — see the module docstring.
	 */
	registerObserver(close: () => void): () => void {
		const id = this.nextId++
		this.observers.set(id, close)
		return () => {
			this.observers.delete(id)
		}
	}

	/**
	 * Begin draining (if not already) and wait for every turn in flight to end,
	 * bounded by `graceMs`. Returns how many turns were STRANDED — still open at
	 * the ceiling, and closed by this call. Zero is the healthy outcome.
	 */
	async settle({ graceMs, settleMs = STORE_SETTLE_MS }: DrainOptions): Promise<number> {
		const hadTurns = this.turns.size > 0
		this.begin()

		if (hadTurns) {
			const grace = delay(graceMs)
			try {
				await Promise.race([new Promise<void>((resolve) => this.idleWaiters.push(resolve)), grace.promise])
			} finally {
				grace.cancel()
			}
			// The margin runs whether the turns finished or the grace elapsed:
			// in both cases the agent-side teardown is still in progress and
			// nothing here can observe it.
			const settle = delay(settleMs)
			try {
				await settle.promise
			} finally {
				settle.cancel()
			}
		}

		const stranded = this.turns.size
		for (const turn of this.turns.values()) turn.close()
		this.turns.clear()
		return stranded
	}
}
