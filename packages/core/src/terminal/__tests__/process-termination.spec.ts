const psTree = vi.fn()
vi.mock("ps-tree", () => ({ default: (...a: unknown[]) => psTree(...a) }))

import { terminateProcessTree } from "../process-termination.js"

/**
 * SIGTERM → grace → SIGKILL over a whole process tree.
 *
 * The escalation is the point: Shofer's predecessor sent SIGKILL immediately,
 * which gives a build, a test runner or a dev server no chance to flush its
 * output or remove its lockfile — and the output it never flushed is exactly
 * what the agent reads back as the command's result. Every primitive
 * (`kill`, descendant enumeration, the delay) is injectable so the ORDER is
 * observable without real processes.
 *
 * Two orderings are load-bearing and both are asserted below: leaves are
 * signalled before the root (a parent that outlives its child can respawn it),
 * and the SIGKILL sweep probes liveness with signal 0 first, so a process that
 * honoured SIGTERM is never force-killed after the fact.
 */

/** A fake process table: `kill` records calls and throws for pids not in it. */
function processTable(alive: number[], opts: { failOn?: Set<number> } = {}) {
	const living = new Set(alive)
	const calls: Array<[number, NodeJS.Signals | 0]> = []

	const kill = (pid: number, signal: NodeJS.Signals | 0) => {
		if (signal !== 0) calls.push([pid, signal])
		if (opts.failOn?.has(pid)) throw new Error("operation not permitted")
		if (!living.has(pid)) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" })
		// A well-behaved process exits on SIGTERM.
		if (signal === "SIGTERM") living.delete(pid)
	}

	return { kill, calls, living, signalled: () => calls.map(([pid, sig]) => `${sig}:${pid}`) }
}

const noDelay = async () => {}

describe("terminateProcessTree", () => {
	it("signals descendants BEFORE the root, so a parent cannot respawn a child", async () => {
		const table = processTable([100, 200, 300])

		await terminateProcessTree(100, {
			kill: table.kill,
			getDescendants: async () => [200, 300],
			delay: noDelay,
		})

		expect(table.signalled()).toEqual(["SIGTERM:200", "SIGTERM:300", "SIGTERM:100"])
	})

	it("de-dupes a root that also appears in the descendant list", async () => {
		const table = processTable([100, 200])

		await terminateProcessTree(100, {
			kill: table.kill,
			getDescendants: async () => [200, 100],
			delay: noDelay,
		})

		expect(table.signalled()).toEqual(["SIGTERM:200", "SIGTERM:100"])
	})

	it("waits the grace window before escalating", async () => {
		const delays: number[] = []
		const table = processTable([100])

		await terminateProcessTree(100, {
			kill: table.kill,
			getDescendants: async () => [],
			delay: async (ms) => {
				delays.push(ms)
			},
		})

		expect(delays).toEqual([250])
	})

	it("honours a caller-supplied grace window", async () => {
		const delays: number[] = []

		await terminateProcessTree(100, {
			kill: () => {},
			getDescendants: async () => [],
			delay: async (ms) => {
				delays.push(ms)
			},
			graceMs: 1_000,
		})

		expect(delays).toEqual([1_000])
	})

	it("does NOT SIGKILL a process that honoured SIGTERM", async () => {
		const table = processTable([100, 200])

		await terminateProcessTree(100, {
			kill: table.kill,
			getDescendants: async () => [200],
			delay: noDelay,
		})

		expect(table.signalled()).not.toContain("SIGKILL:100")
		expect(table.signalled()).not.toContain("SIGKILL:200")
	})

	it("SIGKILLs whatever is still alive after the grace window", async () => {
		// A stubborn process: it stays in the table through SIGTERM.
		const living = new Set([100])
		const calls: Array<string> = []
		const kill = (pid: number, signal: NodeJS.Signals | 0) => {
			if (signal !== 0) calls.push(`${signal}:${pid}`)
			if (!living.has(pid)) throw new Error("ESRCH")
			if (signal === "SIGKILL") living.delete(pid)
		}

		await terminateProcessTree(100, { kill, getDescendants: async () => [], delay: noDelay })

		expect(calls).toEqual(["SIGTERM:100", "SIGKILL:100"])
	})

	it("never throws when a signal fails, and reports it instead", async () => {
		const errors: string[] = []
		const table = processTable([100], { failOn: new Set([100]) })

		await expect(
			terminateProcessTree(100, {
				kill: table.kill,
				getDescendants: async () => [],
				delay: noDelay,
				onError: (m) => errors.push(m),
			}),
		).resolves.toBeUndefined()

		expect(errors[0]).toContain("Failed to send SIGTERM to pid 100")
		expect(errors[0]).toContain("operation not permitted")
	})

	it("stays silent when no logger is supplied", async () => {
		const table = processTable([], { failOn: new Set([100]) })

		await expect(
			terminateProcessTree(100, { kill: table.kill, getDescendants: async () => [], delay: noDelay }),
		).resolves.toBeUndefined()
	})

	it("reports a non-Error rejection as a string rather than [object Object]", async () => {
		const errors: string[] = []

		await terminateProcessTree(100, {
			kill: () => {
				throw "plain string failure"
			},
			getDescendants: async () => [],
			delay: noDelay,
			onError: (m) => errors.push(m),
		})

		expect(errors[0]).toContain("plain string failure")
	})

	it("does nothing at all for a missing or negative pid", async () => {
		const table = processTable([1])
		const getDescendants = vi.fn()

		await terminateProcessTree(0, { kill: table.kill, getDescendants, delay: noDelay })
		await terminateProcessTree(-1, { kill: table.kill, getDescendants, delay: noDelay })

		expect(getDescendants).not.toHaveBeenCalled()
		expect(table.calls).toEqual([])
	})

	it("still terminates the root when enumeration finds nothing", async () => {
		const table = processTable([100])

		await terminateProcessTree(100, { kill: table.kill, getDescendants: async () => [], delay: noDelay })

		expect(table.signalled()).toEqual(["SIGTERM:100"])
	})
})

describe("the default enumeration and delay", () => {
	beforeEach(() => {
		psTree.mockReset()
	})

	it("walks the real process tree, discarding pids that are not numbers", async () => {
		psTree.mockImplementation((_pid: number, cb: (e: unknown, c: Array<{ PID: string }>) => void) =>
			cb(null, [{ PID: "200" }, { PID: "not-a-pid" }, { PID: "300" }]),
		)
		const table = processTable([100, 200, 300])

		await terminateProcessTree(100, { kill: table.kill, delay: noDelay })

		expect(psTree).toHaveBeenCalledWith(100, expect.any(Function))
		expect(table.signalled()).toEqual(["SIGTERM:200", "SIGTERM:300", "SIGTERM:100"])
	})

	it("treats an enumeration failure as 'no descendants' rather than giving up", async () => {
		// A tree we cannot read is not a reason to leave the root running.
		psTree.mockImplementation((_pid: number, cb: (e: unknown, c: unknown[]) => void) =>
			cb(new Error("no such process"), []),
		)
		const table = processTable([100])

		await terminateProcessTree(100, { kill: table.kill, delay: noDelay })

		expect(table.signalled()).toEqual(["SIGTERM:100"])
	})

	it("uses a real timer for the grace window when none is injected", async () => {
		psTree.mockImplementation((_pid: number, cb: (e: unknown, c: unknown[]) => void) => cb(null, []))
		const table = processTable([100])

		const before = Date.now()
		await terminateProcessTree(100, { kill: table.kill, graceMs: 5 })

		expect(Date.now() - before).toBeGreaterThanOrEqual(4)
		expect(table.signalled()).toEqual(["SIGTERM:100"])
	})
})
