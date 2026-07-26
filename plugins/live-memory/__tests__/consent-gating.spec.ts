import { describe, it, expect, vi } from "vitest"

import plugin from "../main.js"

/**
 * The plugin is bundled and **enabled by default**, but everything it does costs the
 * user money. Until they grant the separate billed-AI consent, `ctx.ai` is a denying
 * stub and the plugin must be completely inert — otherwise "on by default" would mean
 * a tool in every task's catalog that can only fail, prompt tokens describing it, a
 * workspace watcher, and a background service throwing every interval.
 */

function makeCtx(consented: boolean) {
	const writes: string[] = []
	const watched: string[] = []
	const services: string[] = []
	const ctx = {
		workspacePath: "/ws",
		cwd: "/ws",
		taskId: "t1",
		config: {},
		ai: {
			hasConsent: () => consented,
			buildHandler: async () => {
				throw new Error("denied")
			},
			embed: async () => [],
		},
		storage: {
			dir: "/storage",
			readFile: async () => {
				throw new Error("ENOENT")
			},
			writeFile: async (rel: string) => {
				writes.push(rel)
			},
			exists: async () => false,
			delete: async () => {},
			list: async () => [],
		},
		host: {
			log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
			notifier: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
			fs: { readFile: async () => "", writeFile: async () => {}, exists: async () => true },
			watch: (pattern: string) => {
				watched.push(pattern)
				return { dispose: () => {} }
			},
		},
		registerService: (svc: { name: string }) => {
			services.push(svc.name)
			return { dispose: () => {} }
		},
	}
	return { ctx, writes, watched, services }
}

describe("live-memory — inert until AI-consented", () => {
	it("registers no tool, so the model never sees one it cannot use", async () => {
		const { ctx } = makeCtx(false)
		expect(await plugin.registerTools!(ctx as never)).toEqual([])
	})

	it("leaves the system prompt untouched", async () => {
		const { ctx } = makeCtx(false)
		expect(await plugin.transformSystemPrompt!("BASE", ctx as never)).toBe("BASE")
	})

	it("starts no watcher and no background service", async () => {
		const { ctx, watched, services } = makeCtx(false)
		await plugin.initialize!(ctx as never)
		expect(watched).toEqual([])
		expect(services).toEqual([])
	})

	it("records no observations — an unusable memory should not grow on disk", async () => {
		const { ctx, writes } = makeCtx(false)
		plugin.lifecycle!.beforeTaskStart!({ ...ctx, prompt: "do it" } as never)
		plugin.lifecycle!.afterTaskComplete!({ ...ctx, reason: "completed" } as never)
		await plugin.lifecycle!.afterToolCall!("write_to_file", { path: "a.ts" }, "ok", ctx as never)
		plugin.onEvent!({ name: "Task Created" }, ctx as never)
		await new Promise((r) => setTimeout(r, 20)) // the observers persist fire-and-forget
		expect(writes).toEqual([])
	})

	it("comes alive once consent is granted (the same hooks, now contributing)", async () => {
		const { ctx } = makeCtx(true)
		expect(await plugin.registerTools!(ctx as never)).toHaveLength(1)
		expect(await plugin.transformSystemPrompt!("BASE", ctx as never)).not.toBe("BASE")
	})
})
