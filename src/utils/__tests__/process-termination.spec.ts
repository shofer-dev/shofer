import { describe, it, expect, vi } from "vitest"

import { terminateProcessTree } from "@shofer/core"

/**
 * §6 structured termination. Uses injected kill/getDescendants/delay so the
 * SIGTERM→SIGKILL escalation is verified deterministically without real
 * processes.
 */
describe("terminateProcessTree", () => {
	const setup = (alivePidsAfterTerm: number[], descendants: number[]) => {
		const calls: Array<{ pid: number; signal: string | number }> = []
		const dead = new Set<number>()
		const kill = (pid: number, signal: NodeJS.Signals | 0) => {
			calls.push({ pid, signal })
			if (signal === 0) {
				// liveness probe: throw if not alive
				if (dead.has(pid) || !alivePidsAfterTerm.includes(pid)) throw new Error("ESRCH")
				return
			}
			if (signal === "SIGKILL") dead.add(pid)
		}
		const getDescendants = vi.fn(async () => descendants)
		const delay = vi.fn(async () => {})
		return { calls, kill, getDescendants, delay }
	}

	it("sends SIGTERM to the whole tree, then SIGKILL only to survivors", async () => {
		// root 100 + children 101,102. After SIGTERM, only 102 is still alive.
		const { calls, kill, getDescendants, delay } = setup([102], [101, 102])
		await terminateProcessTree(100, { kill, getDescendants, delay, graceMs: 10 })

		const term = calls
			.filter((c) => c.signal === "SIGTERM")
			.map((c) => c.pid)
			.sort()
		expect(term).toEqual([100, 101, 102])
		const killed = calls.filter((c) => c.signal === "SIGKILL").map((c) => c.pid)
		expect(killed).toEqual([102]) // only the survivor
	})

	it("waits the grace period between SIGTERM and SIGKILL", async () => {
		const order: string[] = []
		const kill = (_pid: number, signal: NodeJS.Signals | 0) => {
			if (signal === "SIGTERM") order.push("term")
			if (signal === 0) throw new Error("ESRCH") // nothing survives
		}
		const delay = vi.fn(async () => {
			order.push("delay")
		})
		await terminateProcessTree(100, { kill, getDescendants: async () => [], delay, graceMs: 500 })
		expect(delay).toHaveBeenCalledWith(500)
		// SIGTERM happens before the grace delay.
		expect(order[0]).toBe("term")
		expect(order).toContain("delay")
	})

	it("does not SIGKILL processes that exited on SIGTERM", async () => {
		const { calls, kill, getDescendants, delay } = setup([], [201]) // all dead after SIGTERM
		await terminateProcessTree(200, { kill, getDescendants, delay })
		expect(calls.some((c) => c.signal === "SIGKILL")).toBe(false)
	})

	it("is a no-op for an invalid pid", async () => {
		const kill = vi.fn()
		await terminateProcessTree(0, { kill })
		await terminateProcessTree(-1, { kill })
		expect(kill).not.toHaveBeenCalled()
	})

	it("never throws when a signal fails", async () => {
		const kill = (_pid: number, signal: NodeJS.Signals | 0) => {
			if (signal === 0) throw new Error("ESRCH")
			throw new Error("EPERM")
		}
		await expect(
			terminateProcessTree(300, { kill, getDescendants: async () => [301], delay: async () => {} }),
		).resolves.toBeUndefined()
	})
})
