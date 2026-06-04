// npx vitest utils/logging/__tests__/index.spec.ts

/**
 * Regression guard for the import-ordering noop-binding bug.
 *
 * Subsystem loggers in `subsystems.ts` are created with
 * `getLogger().child({ ctx })` at module-import time, which (because those
 * modules sit in the extension's static import graph) runs BEFORE `activate()`
 * calls `bootstrapLogging()`. If the shared transport + root logger are not
 * created eagerly at `logging/index.ts` module load, `getLogger()` returns the
 * throw-away noop logger (whose `child()` returns itself), permanently binding
 * every subsystem logger to a noop and silently dropping all output.
 *
 * These tests simulate the production path by stubbing `NODE_ENV` away from
 * "test" and re-importing the module so the eager-init branch runs.
 */

import type { CompactLogger } from "../CompactLogger"

describe("logging/index eager initialization", () => {
	afterEach(() => {
		vi.unstubAllEnvs()
		vi.resetModules()
	})

	async function importFreshLoggingModule() {
		vi.resetModules()
		return import("../index")
	}

	test("getLogger() returns a real (non-noop) logger before bootstrapLogging()", async () => {
		vi.stubEnv("NODE_ENV", "production")
		const mod = await importFreshLoggingModule()

		const log = mod.getLogger()

		// The noop logger's child() returns itself; the real CompactLogger
		// returns a distinct instance. This distinguishes the two without
		// reaching into internals.
		expect(log.child({ ctx: "Probe" })).not.toBe(log)
	})

	test("a subsystem logger captured before bootstrap emits to the channel after attach", async () => {
		vi.stubEnv("NODE_ENV", "production")
		const mod = await importFreshLoggingModule()

		// Simulate subsystems.ts capturing a child at import time, before any
		// output channel exists.
		const subsystemLog = mod.getLogger().child({ ctx: "Task" }) as CompactLogger

		const lines: string[] = []
		const fakeChannel = {
			name: "test",
			appendLine: (line: string) => lines.push(line),
			append: () => {},
			clear: () => {},
			replace: () => {},
			show: () => {},
			hide: () => {},
			dispose: () => {},
		}

		mod.bootstrapLogging(fakeChannel as any)
		subsystemLog.info("hello after attach")

		expect(lines.some((l) => l.includes("hello after attach") && l.includes("[Task]"))).toBe(true)
	})

	test("getLogLevel() reflects live level changes via the typed getter", async () => {
		vi.stubEnv("NODE_ENV", "production")
		const mod = await importFreshLoggingModule()

		expect(mod.getLogLevel()).toBe("debug")

		mod.setLogLevel("warn")
		expect(mod.getLogLevel()).toBe("warn")
	})
})
