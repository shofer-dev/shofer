import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { createInMemoryHost, setHost, type ShoferPlugin } from "@shofer/types"

import { PluginRegistry, PLUGIN_HOOK_TIMEOUT_MS } from "../plugin-registry.js"

/** Register a plugin *with* the lifecycle grant (the normal case for these tests). */
async function registerLifecycle(reg: PluginRegistry, plugin: ShoferPlugin): Promise<void> {
	await reg.register(plugin, {}, { lifecycle: true })
}

describe("PluginRegistry lifecycle hooks (design §6.9, Phase 3)", () => {
	beforeEach(() => {
		setHost(createInMemoryHost())
	})

	describe("beforeToolCall — allow / modify / block", () => {
		it("allows and reports no arg change when no plugin participates", async () => {
			const reg = new PluginRegistry()
			const result = await reg.applyBeforeToolCall("read_file", { path: "a.ts" })
			expect(result).toEqual({ allow: true, modifiedArgs: undefined })
		})

		it("threads modifiedArgs through plugins in registration order", async () => {
			const reg = new PluginRegistry()
			const seen: Array<Record<string, unknown>> = []
			await registerLifecycle(reg, {
				name: "p1",
				lifecycle: {
					beforeToolCall: (_t, args) => {
						seen.push(args)
						return { allow: true, modifiedArgs: { ...args, step: 1 } }
					},
				},
			})
			await registerLifecycle(reg, {
				name: "p2",
				lifecycle: {
					beforeToolCall: (_t, args) => {
						seen.push(args)
						return { allow: true, modifiedArgs: { ...args, step: 2 } }
					},
				},
			})
			const result = await reg.applyBeforeToolCall("execute_command", { cmd: "ls" })
			// p2 saw p1's output; final args carry both mutations.
			expect(seen[1]).toEqual({ cmd: "ls", step: 1 })
			expect(result).toEqual({ allow: true, modifiedArgs: { cmd: "ls", step: 2 } })
		})

		it("blocks (short-circuits) at the first denying plugin and returns its reason", async () => {
			const reg = new PluginRegistry()
			const laterRan = vi.fn()
			await registerLifecycle(reg, {
				name: "policy",
				lifecycle: { beforeToolCall: () => ({ allow: false, reason: "rm -rf blocked" }) },
			})
			await registerLifecycle(reg, {
				name: "after",
				lifecycle: {
					beforeToolCall: () => {
						laterRan()
						return { allow: true }
					},
				},
			})
			const result = await reg.applyBeforeToolCall("execute_command", { cmd: "rm -rf /" })
			expect(result).toEqual({ allow: false, reason: "rm -rf blocked" })
			expect(laterRan).not.toHaveBeenCalled()
		})
	})

	describe("afterToolCall — observe / transform", () => {
		it("threads the result through plugins in order", async () => {
			const reg = new PluginRegistry()
			await registerLifecycle(reg, {
				name: "p1",
				lifecycle: { afterToolCall: (_t, _a, result) => result + " [p1]" },
			})
			await registerLifecycle(reg, {
				name: "p2",
				lifecycle: { afterToolCall: (_t, _a, result) => result + " [p2]" },
			})
			expect(await reg.applyAfterToolCall("read_file", {}, "base")).toBe("base [p1] [p2]")
		})

		it("keeps the prior result when a plugin observes without returning a string", async () => {
			const reg = new PluginRegistry()
			const observed: string[] = []
			await registerLifecycle(reg, {
				name: "obs",
				lifecycle: {
					afterToolCall: (_t, _a, result) => {
						observed.push(result)
					},
				},
			})
			expect(await reg.applyAfterToolCall("read_file", {}, "unchanged")).toBe("unchanged")
			expect(observed).toEqual(["unchanged"])
		})
	})

	describe("beforeAsk — observe / modify / auto-answer", () => {
		it("returns undefined when no plugin participates (ask proceeds unchanged)", async () => {
			const reg = new PluginRegistry()
			expect(await reg.applyBeforeAsk("tool", "payload")).toBeUndefined()
		})

		it("auto-answers (short-circuit) with a decision and stops later plugins", async () => {
			const reg = new PluginRegistry()
			const laterRan = vi.fn()
			await registerLifecycle(reg, {
				name: "approver",
				lifecycle: { beforeAsk: () => ({ decision: "approve" }) },
			})
			await registerLifecycle(reg, {
				name: "after",
				lifecycle: {
					beforeAsk: () => {
						laterRan()
					},
				},
			})
			expect(await reg.applyBeforeAsk("tool", "p")).toEqual({ decision: "approve", text: undefined })
			expect(laterRan).not.toHaveBeenCalled()
		})

		it("modifies the ask text without short-circuiting", async () => {
			const reg = new PluginRegistry()
			await registerLifecycle(reg, {
				name: "rewriter",
				lifecycle: { beforeAsk: () => ({ text: "modified question" }) },
			})
			expect(await reg.applyBeforeAsk("followup", "orig")).toEqual({
				decision: "ask",
				text: "modified question",
			})
		})
	})

	describe("task observers", () => {
		it("fires beforeTaskStart and afterTaskComplete for permitted plugins", async () => {
			const reg = new PluginRegistry()
			const calls: string[] = []
			await registerLifecycle(reg, {
				name: "obs",
				lifecycle: {
					beforeTaskStart: (ctx) => {
						calls.push(`start:${ctx.taskId}`)
					},
					afterTaskComplete: (ctx) => {
						calls.push(`done:${ctx.reason}`)
					},
				},
			})
			await reg.notifyBeforeTaskStart({ taskId: "t1", prompt: "hi" })
			await reg.notifyAfterTaskComplete({ taskId: "t1", reason: "completed" })
			expect(calls).toEqual(["start:t1", "done:completed"])
		})
	})

	describe("permission gating (design §6.9, §8)", () => {
		it("does not fire lifecycle hooks for a plugin lacking the lifecycle grant", async () => {
			const reg = new PluginRegistry()
			const fired = vi.fn()
			// Registered WITHOUT the lifecycle grant.
			await reg.register({
				name: "ungranted",
				lifecycle: { beforeToolCall: () => ({ allow: false, reason: "should not run" }), afterToolCall: fired },
			})
			expect(reg.hasLifecycleHook("beforeToolCall")).toBe(false)
			expect(await reg.applyBeforeToolCall("read_file", { path: "x" })).toEqual({
				allow: true,
				modifiedArgs: undefined,
			})
			expect(await reg.applyAfterToolCall("read_file", {}, "r")).toBe("r")
			expect(fired).not.toHaveBeenCalled()
		})

		it("hasLifecycleHook reflects the grant + declaration", async () => {
			const reg = new PluginRegistry()
			await registerLifecycle(reg, { name: "g", lifecycle: { beforeAsk: () => ({ decision: "deny" }) } })
			expect(reg.hasLifecycleHook("beforeAsk")).toBe(true)
			expect(reg.hasLifecycleHook("beforeToolCall")).toBe(false)
		})

		it("unregister revokes the grant so hooks stop firing", async () => {
			const reg = new PluginRegistry()
			await registerLifecycle(reg, { name: "g", lifecycle: { beforeToolCall: () => ({ allow: false }) } })
			expect(reg.hasLifecycleHook("beforeToolCall")).toBe(true)
			reg.unregister("g")
			expect(reg.hasLifecycleHook("beforeToolCall")).toBe(false)
			expect(await reg.applyBeforeToolCall("t", {})).toEqual({ allow: true, modifiedArgs: undefined })
		})
	})

	describe("isolation: slow + throwing hooks never break the task", () => {
		it("skips a slow hook after the 500ms budget and keeps other plugins", async () => {
			vi.useFakeTimers()
			try {
				const reg = new PluginRegistry()
				await registerLifecycle(reg, {
					name: "slow",
					lifecycle: { afterToolCall: () => new Promise<string>(() => {}) /* never resolves */ },
				})
				await registerLifecycle(reg, {
					name: "fast",
					lifecycle: { afterToolCall: (_t, _a, r) => r + " [fast]" },
				})
				const promise = reg.applyAfterToolCall("read_file", {}, "base")
				await vi.advanceTimersByTimeAsync(PLUGIN_HOOK_TIMEOUT_MS + 10)
				// slow contributes nothing (timed out); fast still applies.
				expect(await promise).toBe("base [fast]")
			} finally {
				vi.useRealTimers()
			}
		})

		it("isolates a throwing hook and continues to later plugins", async () => {
			const reg = new PluginRegistry()
			await registerLifecycle(reg, {
				name: "boom",
				lifecycle: {
					beforeToolCall: () => {
						throw new Error("kaboom")
					},
				},
			})
			await registerLifecycle(reg, {
				name: "ok",
				lifecycle: { beforeToolCall: (_t, args) => ({ allow: true, modifiedArgs: { ...args, ok: true } }) },
			})
			const result = await reg.applyBeforeToolCall("read_file", { path: "x" })
			expect(result).toEqual({ allow: true, modifiedArgs: { path: "x", ok: true } })
		})

		it("a timed-out beforeToolCall does not block the tool (fails open, task proceeds)", async () => {
			vi.useFakeTimers()
			try {
				const reg = new PluginRegistry()
				await registerLifecycle(reg, {
					name: "hang",
					lifecycle: { beforeToolCall: () => new Promise(() => {}) /* never resolves */ },
				})
				const promise = reg.applyBeforeToolCall("execute_command", { cmd: "ls" })
				await vi.advanceTimersByTimeAsync(PLUGIN_HOOK_TIMEOUT_MS + 10)
				expect(await promise).toEqual({ allow: true, modifiedArgs: undefined })
			} finally {
				vi.useRealTimers()
			}
		})
	})
})
