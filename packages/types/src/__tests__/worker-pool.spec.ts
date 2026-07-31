import { describe, it, expect, vi } from "vitest"

import type { AgentApi, ServerEvent } from "../agent-api.js"
import type { LoadSample } from "../worker-pool.js"
import { WorkerPool } from "../worker-pool.js"

/** A mock executor whose task ids are namespaced + whose event stream is drivable. */
function makeExecutor(id: string) {
	let emit: (e: ServerEvent) => void = () => {}
	let seq = 0
	const api: AgentApi = {
		createTask: vi.fn(async () => ({ taskId: `${id}-task-${++seq}` })),
		sendMessage: vi.fn(async () => {}),
		cancelTask: vi.fn(async () => {}),
		respondToAsk: vi.fn(async () => {}),
		applyConfig: vi.fn(async () => {}),
		pluginRequest: vi.fn(async () => ({ ok: true })),
		subscribe: (listener) => {
			emit = listener
			return () => {
				emit = () => {}
			}
		},
	}
	return { id, api, emit: (e: ServerEvent) => emit(e) }
}

describe("WorkerPool (§13 controller side)", () => {
	it("round-robins new root tasks across executors and remembers the owner", async () => {
		const a = makeExecutor("A")
		const b = makeExecutor("B")
		const pool = new WorkerPool()
		pool.add({ id: a.id, api: a.api })
		pool.add({ id: b.id, api: b.api })

		const t1 = await pool.createTask({ prompt: "1", mode: "code" }) // → A
		const t2 = await pool.createTask({ prompt: "2", mode: "code" }) // → B
		expect(t1.taskId).toBe("A-task-1")
		expect(t2.taskId).toBe("B-task-1")

		await pool.sendMessage(t1.taskId, "hi")
		expect(a.api.sendMessage).toHaveBeenCalledWith("A-task-1", "hi")
		expect(b.api.sendMessage).not.toHaveBeenCalled()

		await pool.cancelTask(t2.taskId)
		expect(b.api.cancelTask).toHaveBeenCalledWith("B-task-1")

		await pool.respondToAsk(t1.taskId, { askResponse: "yesButtonClicked", askId: "a1" })
		expect(a.api.respondToAsk).toHaveBeenCalledWith("A-task-1", {
			askResponse: "yesButtonClicked",
			askId: "a1",
		})
		expect(b.api.respondToAsk).not.toHaveBeenCalled()
	})

	it("routes a plugin request to the executor that owns the task", async () => {
		const a = makeExecutor("A")
		const b = makeExecutor("B")
		const pool = new WorkerPool()
		pool.add({ id: a.id, api: a.api })
		pool.add({ id: b.id, api: b.api })

		const t1 = await pool.createTask({ prompt: "1", mode: "code" }) // → A
		await pool.createTask({ prompt: "2", mode: "code" }) // → B (advances round-robin)

		// One generic method carries every plugin-owned per-task feature, and it must
		// land on the host holding that task's state — not on whichever executor is next.
		expect(await pool.pluginRequest(t1.taskId, "checkpoints", "diff", { hash: "abc" })).toEqual({ ok: true })
		expect(a.api.pluginRequest).toHaveBeenCalledWith("A-task-1", "checkpoints", "diff", { hash: "abc" })
		expect(b.api.pluginRequest).not.toHaveBeenCalled()
	})

	it("merges executor event streams, tagging each with executorId", async () => {
		const a = makeExecutor("A")
		const b = makeExecutor("B")
		const pool = new WorkerPool()
		pool.add({ id: a.id, api: a.api })
		pool.add({ id: b.id, api: b.api })
		const seen: ServerEvent[] = []
		pool.subscribe((e) => seen.push(e))

		a.emit({ type: "Message", text: "from A" })
		b.emit({ type: "TaskCompleted" })
		expect(seen).toEqual([
			{ type: "Message", text: "from A", executorId: "A" },
			{ type: "TaskCompleted", executorId: "B" },
		])
	})

	it("skips disabled executors and stops forwarding events after remove", async () => {
		const a = makeExecutor("A")
		const b = makeExecutor("B")
		const pool = new WorkerPool()
		pool.add({ id: a.id, api: a.api, disabled: true })
		pool.add({ id: b.id, api: b.api })

		const t = await pool.createTask({ prompt: "x", mode: "code" }) // A disabled → B
		expect(t.taskId).toBe("B-task-1")

		const seen: ServerEvent[] = []
		pool.subscribe((e) => seen.push(e))
		pool.remove("B")
		b.emit({ type: "Message" })
		expect(seen).toEqual([]) // B removed, no forwarding
	})

	it("throws when no executor is available", async () => {
		const pool = new WorkerPool()
		await expect(pool.createTask({ prompt: "x", mode: "code" })).rejects.toThrow(/no executor/)
	})

	it("exposes ids/has and ownerOf for assigned tasks", async () => {
		const a = makeExecutor("A")
		const b = makeExecutor("B")
		const pool = new WorkerPool()
		pool.add({ id: a.id, api: a.api })
		pool.add({ id: b.id, api: b.api })

		expect(pool.ids()).toEqual(["A", "B"])
		expect(pool.has("A")).toBe(true)
		expect(pool.has("Z")).toBe(false)
		expect(pool.ownerOf("nope")).toBeUndefined()

		const t1 = await pool.createTask({ prompt: "1", mode: "code" }) // → A
		const t2 = await pool.createTask({ prompt: "2", mode: "code" }) // → B
		expect(pool.ownerOf(t1.taskId)).toBe("A")
		expect(pool.ownerOf(t2.taskId)).toBe("B")
	})

	it("pickNext advances round-robin without dispatching; createTaskOn dispatches to a specific executor", async () => {
		const a = makeExecutor("A")
		const b = makeExecutor("B")
		const pool = new WorkerPool()
		pool.add({ id: a.id, api: a.api })
		pool.add({ id: b.id, api: b.api })

		// pickNext advances the cursor but dispatches nothing.
		expect(pool.pickNext()).toBe("A")
		expect(pool.pickNext()).toBe("B")
		expect(a.api.createTask).not.toHaveBeenCalled()
		expect(b.api.createTask).not.toHaveBeenCalled()
		expect(pool.assignableIds()).toEqual(["A", "B"])

		// createTaskOn dispatches to exactly the named executor and records ownership.
		const t = await pool.createTaskOn("B", { prompt: "hi", mode: "code" })
		expect(b.api.createTask).toHaveBeenCalledTimes(1)
		expect(a.api.createTask).not.toHaveBeenCalled()
		expect(pool.ownerOf(t.taskId)).toBe("B")

		// createTaskOn on an unknown id throws.
		await expect(pool.createTaskOn("Z", { prompt: "x", mode: "code" })).rejects.toThrow(/unknown executor/)
	})

	it("assignOwner records ownership for an out-of-band task (Local bypass) without dispatch", async () => {
		const a = makeExecutor("A")
		const pool = new WorkerPool()
		pool.add({ id: a.id, api: a.api })
		pool.assignOwner("local-task-1", "A")
		expect(pool.ownerOf("local-task-1")).toBe("A")
		expect(a.api.createTask).not.toHaveBeenCalled()
	})

	it("pickNext returns undefined when no executor is assignable", () => {
		const pool = new WorkerPool()
		expect(pool.pickNext()).toBeUndefined()
		expect(pool.assignableIds()).toEqual([])
	})

	describe("load-average load balancing (least-load-* policies)", () => {
		/** An executor whose injected load sample is mutable per test. */
		function loadExecutor(id: string, sample: LoadSample | undefined) {
			const e = makeExecutor(id)
			let current = sample
			return {
				...e,
				load: () => current,
				setLoad: (s: LoadSample | undefined) => {
					current = s
				},
			}
		}

		it("picks the executor with the lowest normalized load for the selected window", async () => {
			const a = loadExecutor("A", { loadavg: [4, 4, 4], cpus: 4 }) // 1.0 normalized
			const b = loadExecutor("B", { loadavg: [1, 2, 3], cpus: 4 }) // 0.25 / 0.5 / 0.75
			const pool = new WorkerPool()
			pool.add({ id: a.id, api: a.api, load: a.load })
			pool.add({ id: b.id, api: b.api, load: b.load })

			pool.setPolicy("least-load-1m")
			expect(pool.getPolicy()).toBe("least-load-1m")
			expect(pool.pickNext()).toBe("B") // 0.25 < 1.0

			// A clear winner does not rotate — repeated picks stay on the least-loaded.
			const t1 = await pool.createTask({ prompt: "1", mode: "code" })
			const t2 = await pool.createTask({ prompt: "2", mode: "code" })
			expect(pool.ownerOf(t1.taskId)).toBe("B")
			expect(pool.ownerOf(t2.taskId)).toBe("B")
		})

		it("selects the 1m/5m/15m window by policy", () => {
			// A wins on 1m; B wins on 5m and 15m.
			const a = loadExecutor("A", { loadavg: [1, 9, 9], cpus: 1 })
			const b = loadExecutor("B", { loadavg: [9, 1, 1], cpus: 1 })
			const pool = new WorkerPool()
			pool.add({ id: a.id, api: a.api, load: a.load })
			pool.add({ id: b.id, api: b.api, load: b.load })

			pool.setPolicy("least-load-1m")
			expect(pool.pickNext()).toBe("A")
			pool.setPolicy("least-load-5m")
			expect(pool.pickNext()).toBe("B")
			pool.setPolicy("least-load-15m")
			expect(pool.pickNext()).toBe("B")
		})

		it("normalizes by cpu count — a high-core worker with higher raw load can still win", () => {
			// A: raw 8 over 16 cores = 0.5. B: raw 3 over 4 cores = 0.75. A wins despite higher raw load.
			const a = loadExecutor("A", { loadavg: [8, 8, 8], cpus: 16 })
			const b = loadExecutor("B", { loadavg: [3, 3, 3], cpus: 4 })
			const pool = new WorkerPool()
			pool.add({ id: a.id, api: a.api, load: a.load })
			pool.add({ id: b.id, api: b.api, load: b.load })

			pool.setPolicy("least-load-1m")
			expect(pool.pickNext()).toBe("A")
		})

		it("excludes executors with no sample; falls back to round-robin when NONE have a sample", async () => {
			// One with a sample, one without → the sampled one is chosen.
			const a = loadExecutor("A", { loadavg: [5, 5, 5], cpus: 1 })
			const b = loadExecutor("B", undefined)
			const pool = new WorkerPool()
			pool.add({ id: a.id, api: a.api, load: a.load })
			pool.add({ id: b.id, api: b.api, load: b.load })
			pool.setPolicy("least-load-1m")
			expect(pool.pickNext()).toBe("A")
			expect(pool.pickNext()).toBe("A") // B still excluded

			// Neither exposes a sample → degrade to round-robin over the pool.
			const c = loadExecutor("C", undefined)
			const d = loadExecutor("D", undefined)
			const rr = new WorkerPool()
			rr.add({ id: c.id, api: c.api, load: c.load })
			rr.add({ id: d.id, api: d.api, load: d.load })
			rr.setPolicy("least-load-5m")
			expect(rr.pickNext()).toBe("C")
			expect(rr.pickNext()).toBe("D")
			expect(rr.pickNext()).toBe("C")
		})

		it("spreads across tied executors (all-equal / all-zero Windows loadavg) via the round-robin cursor", () => {
			const a = loadExecutor("A", { loadavg: [0, 0, 0], cpus: 8 })
			const b = loadExecutor("B", { loadavg: [0, 0, 0], cpus: 4 })
			const c = loadExecutor("C", { loadavg: [0, 0, 0], cpus: 2 })
			const pool = new WorkerPool()
			pool.add({ id: a.id, api: a.api, load: a.load })
			pool.add({ id: b.id, api: b.api, load: b.load })
			pool.add({ id: c.id, api: c.api, load: c.load })
			pool.setPolicy("least-load-1m")
			// All zero-normalized → tied → cursor spreads across the tied set in order.
			expect([pool.pickNext(), pool.pickNext(), pool.pickNext(), pool.pickNext()]).toEqual(["A", "B", "C", "A"])
		})

		it("excludes disabled executors from the least-load comparison", () => {
			const a = loadExecutor("A", { loadavg: [0.1, 0.1, 0.1], cpus: 1 }) // lowest, but disabled
			const b = loadExecutor("B", { loadavg: [1, 1, 1], cpus: 1 })
			const pool = new WorkerPool()
			pool.add({ id: a.id, api: a.api, load: a.load, disabled: true })
			pool.add({ id: b.id, api: b.api, load: b.load })
			pool.setPolicy("least-load-1m")
			expect(pool.pickNext()).toBe("B") // A disabled → excluded despite lower load
		})

		it("loadOf exposes an executor's current sample and is undefined for unknown ids", () => {
			const a = loadExecutor("A", { loadavg: [2, 2, 2], cpus: 2 })
			const pool = new WorkerPool()
			pool.add({ id: a.id, api: a.api, load: a.load })
			expect(pool.loadOf("A")).toEqual({ loadavg: [2, 2, 2], cpus: 2 })
			a.setLoad(undefined)
			expect(pool.loadOf("A")).toBeUndefined()
			expect(pool.loadOf("Z")).toBeUndefined()
		})

		it("default policy is round-robin (unchanged behavior)", async () => {
			const a = loadExecutor("A", { loadavg: [9, 9, 9], cpus: 1 })
			const b = loadExecutor("B", { loadavg: [0, 0, 0], cpus: 1 })
			const pool = new WorkerPool()
			pool.add({ id: a.id, api: a.api, load: a.load })
			pool.add({ id: b.id, api: b.api, load: b.load })
			expect(pool.getPolicy()).toBe("round-robin")
			// Ignores load entirely — strict rotation.
			expect(pool.pickNext()).toBe("A")
			expect(pool.pickNext()).toBe("B")
		})
	})

	describe("config-version gating (config_sync §6)", () => {
		/** An executor exposing config-sync accessors: a mutable version and a managed flag. */
		function cfgExecutor(id: string, version: string | undefined, managed = true) {
			const e = makeExecutor(id)
			let current = version
			return {
				...e,
				configVersion: () => current,
				managed: () => managed,
				setVersion: (v: string | undefined) => {
					current = v
				},
			}
		}

		it("no desired version → all non-disabled executors assignable (baseline)", () => {
			const a = cfgExecutor("A", "v0")
			const b = cfgExecutor("B", undefined)
			const pool = new WorkerPool()
			pool.add({ id: a.id, api: a.api, configVersion: a.configVersion, managed: a.managed })
			pool.add({ id: b.id, api: b.api, configVersion: b.configVersion, managed: b.managed })
			// desiredConfigVersion unset → gating disabled regardless of reported versions.
			expect(pool.assignableIds()).toEqual(["A", "B"])
		})

		it("gates on an exact version match once a desired version is set", () => {
			const a = cfgExecutor("A", "v1") // matches
			const b = cfgExecutor("B", "v0") // stale
			const c = cfgExecutor("C", undefined) // never reported → not current
			const pool = new WorkerPool()
			pool.add({ id: a.id, api: a.api, configVersion: a.configVersion, managed: a.managed })
			pool.add({ id: b.id, api: b.api, configVersion: b.configVersion, managed: b.managed })
			pool.add({ id: c.id, api: c.api, configVersion: c.configVersion, managed: c.managed })

			pool.setDesiredConfigVersion("v1")
			expect(pool.assignableIds()).toEqual(["A"]) // only the exact match
		})

		it("routes new tasks only to a matching managed executor", async () => {
			const a = cfgExecutor("A", "v1")
			const b = cfgExecutor("B", "v0")
			const pool = new WorkerPool()
			pool.add({ id: a.id, api: a.api, configVersion: a.configVersion, managed: a.managed })
			pool.add({ id: b.id, api: b.api, configVersion: b.configVersion, managed: b.managed })

			pool.setDesiredConfigVersion("v1")
			const t1 = await pool.createTask({ prompt: "1", mode: "code" })
			const t2 = await pool.createTask({ prompt: "2", mode: "code" })
			// B is stale → every task lands on A.
			expect(pool.ownerOf(t1.taskId)).toBe("A")
			expect(pool.ownerOf(t2.taskId)).toBe("A")
			expect(b.api.createTask).not.toHaveBeenCalled()
		})

		it("exempts an unmanaged (self-administered) executor from version gating", () => {
			// B is unmanaged and its version does NOT match — still assignable.
			const a = cfgExecutor("A", "v1", true)
			const b = cfgExecutor("B", "v0", false)
			const pool = new WorkerPool()
			pool.add({ id: a.id, api: a.api, configVersion: a.configVersion, managed: a.managed })
			pool.add({ id: b.id, api: b.api, configVersion: b.configVersion, managed: b.managed })

			pool.setDesiredConfigVersion("v1")
			expect(pool.assignableIds()).toEqual(["A", "B"])

			// Even when the unmanaged worker reports no version at all, it stays exempt.
			b.setVersion(undefined)
			expect(pool.assignableIds()).toEqual(["A", "B"])
		})

		it("re-includes everyone when the desired version is cleared back to undefined", () => {
			const a = cfgExecutor("A", "v1")
			const b = cfgExecutor("B", "v0")
			const pool = new WorkerPool()
			pool.add({ id: a.id, api: a.api, configVersion: a.configVersion, managed: a.managed })
			pool.add({ id: b.id, api: b.api, configVersion: b.configVersion, managed: b.managed })

			pool.setDesiredConfigVersion("v1")
			expect(pool.assignableIds()).toEqual(["A"]) // gated

			pool.setDesiredConfigVersion(undefined)
			expect(pool.assignableIds()).toEqual(["A", "B"]) // gate lifted
		})

		it("a stale executor becomes assignable once it reports the desired version", () => {
			const a = cfgExecutor("A", "v0")
			const pool = new WorkerPool()
			pool.add({ id: a.id, api: a.api, configVersion: a.configVersion, managed: a.managed })

			pool.setDesiredConfigVersion("v1")
			expect(pool.assignableIds()).toEqual([]) // stale → excluded

			a.setVersion("v1") // worker applied the new config
			expect(pool.assignableIds()).toEqual(["A"])
		})

		it("still excludes a disabled executor even when its config matches", () => {
			const a = cfgExecutor("A", "v1")
			const pool = new WorkerPool()
			pool.add({ id: a.id, api: a.api, configVersion: a.configVersion, managed: a.managed, disabled: true })
			pool.setDesiredConfigVersion("v1")
			expect(pool.assignableIds()).toEqual([]) // matching version, but admin-disabled
		})
	})

	it("round-robins over enabled executors and skips a runtime-disabled one via setDisabled", async () => {
		const a = makeExecutor("A")
		const b = makeExecutor("B")
		const c = makeExecutor("C")
		const pool = new WorkerPool()
		pool.add({ id: a.id, api: a.api })
		pool.add({ id: b.id, api: b.api })
		pool.add({ id: c.id, api: c.api })

		// Distributes across all three enabled executors.
		const first = await Promise.all([
			pool.createTask({ prompt: "1", mode: "code" }),
			pool.createTask({ prompt: "2", mode: "code" }),
			pool.createTask({ prompt: "3", mode: "code" }),
		])
		expect(first.map((t) => pool.ownerOf(t.taskId)).sort()).toEqual(["A", "B", "C"])

		// Disable B at runtime → subsequent assignments never land on B.
		pool.setDisabled("B", true)
		const after = await Promise.all([
			pool.createTask({ prompt: "4", mode: "code" }),
			pool.createTask({ prompt: "5", mode: "code" }),
			pool.createTask({ prompt: "6", mode: "code" }),
		])
		const owners = after.map((t) => pool.ownerOf(t.taskId))
		expect(owners).not.toContain("B")
		expect(new Set(owners)).toEqual(new Set(["A", "C"]))

		// Re-enable B → it returns to the rotation.
		pool.setDisabled("B", false)
		const backCalls = (b.api.createTask as ReturnType<typeof vi.fn>).mock.calls.length
		for (let i = 0; i < 6; i++) await pool.createTask({ prompt: `re-${i}`, mode: "code" })
		expect((b.api.createTask as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(backCalls)
	})
})
