import psTree from "ps-tree"

/**
 * Structured process termination (todos/opencode_inspired_work.md §6).
 *
 * shofer historically aborted child processes by sending **SIGKILL immediately**
 * to the subprocess and each PID returned by a `ps-tree` snapshot. SIGKILL gives
 * the process no chance to flush/clean up, and enumerating then killing PIDs one
 * by one races against newly-spawned grandchildren.
 *
 * `terminateProcessTree` instead escalates **SIGTERM → (grace) → SIGKILL** over
 * the whole tree, matching opencode's scope-close behavior: well-behaved
 * processes exit cleanly on SIGTERM, and anything still alive after the grace
 * window is force-killed. The signal/enumeration/delay primitives are injectable
 * so the escalation is deterministically unit-testable without real processes.
 */
export interface TerminateOptions {
	/** Milliseconds to wait after SIGTERM before escalating to SIGKILL. Default 250. */
	graceMs?: number
	/** Send a signal to a pid. Default `process.kill`. */
	kill?: (pid: number, signal: NodeJS.Signals | 0) => void
	/** Resolve a root pid to its descendant pids. Default uses `ps-tree`. */
	getDescendants?: (pid: number) => Promise<number[]>
	/** Delay helper (injectable for tests). Default `setTimeout`. */
	delay?: (ms: number) => Promise<void>
	/** Optional logger for failures. */
	onError?: (message: string) => void
}

const defaultDelay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const defaultGetDescendants = (pid: number): Promise<number[]> =>
	new Promise((resolve) => {
		psTree(pid, (err, children) => {
			if (err) {
				resolve([])
				return
			}
			resolve(children.map((c) => parseInt(c.PID, 10)).filter((n) => Number.isFinite(n)))
		})
	})

/** Whether a process is still alive (signal 0 probes without killing). */
function isAlive(pid: number, kill: (pid: number, signal: NodeJS.Signals | 0) => void): boolean {
	try {
		kill(pid, 0)
		return true
	} catch {
		return false
	}
}

/**
 * Terminate a process and all its descendants with a SIGTERM→SIGKILL escalation.
 * Resolves once the grace window has elapsed and survivors have been SIGKILLed.
 * Never throws — individual signal failures (already-dead pids, permission) are
 * reported via `onError` and otherwise ignored.
 */
export async function terminateProcessTree(rootPid: number, options: TerminateOptions = {}): Promise<void> {
	const {
		graceMs = 250,
		kill = process.kill,
		getDescendants = defaultGetDescendants,
		delay = defaultDelay,
		onError,
	} = options

	if (!rootPid || rootPid < 0) return

	const descendants = await getDescendants(rootPid)
	// Kill leaves before the root so a parent can't immediately respawn a child,
	// and de-dupe in case the root appears in the descendant list.
	const pids = [...new Set([...descendants, rootPid])]

	const signal = (pid: number, sig: NodeJS.Signals) => {
		try {
			kill(pid, sig)
		} catch (e) {
			onError?.(`Failed to send ${sig} to pid ${pid}: ${e instanceof Error ? e.message : String(e)}`)
		}
	}

	// 1. Polite request to exit.
	for (const pid of pids) signal(pid, "SIGTERM")

	// 2. Grace period.
	await delay(graceMs)

	// 3. Force-kill anything still alive.
	for (const pid of pids) {
		if (isAlive(pid, kill)) signal(pid, "SIGKILL")
	}
}
