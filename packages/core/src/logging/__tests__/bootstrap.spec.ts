import type { LogSink } from "../types.js"

/**
 * The logging bootstrap has a deliberate test-mode carve-out — under
 * `NODE_ENV === "test"` every entry point returns the silent noop logger so a
 * suite is not flooded. That carve-out is also what hides the real paths from
 * every other test in this package, so this suite runs them with the
 * environment flipped and a fresh module graph.
 *
 * The property worth pinning is the one the module's own comment calls
 * critical: the transport and root logger are created EAGERLY at module load,
 * because the subsystem loggers in `subsystems.ts` bind at import time — before
 * activation calls `bootstrapLogging()`. If they bound to the noop, every
 * subsystem line would be dropped forever and the level/category filters would
 * appear to do nothing.
 */

interface Sink extends LogSink {
	lines: string[]
}

function makeSink(): Sink {
	const lines: string[] = []
	return { lines, appendLine: (line: string) => lines.push(line) }
}

/** Import the logging module with `NODE_ENV` set to `value`. */
async function importLogging(value: string) {
	vi.resetModules()
	vi.stubEnv("NODE_ENV", value)
	return import("../index.js")
}

afterEach(() => {
	vi.unstubAllEnvs()
	vi.resetModules()
})

describe("logging bootstrap — under NODE_ENV=test", () => {
	it("returns a silent logger and leaves every accessor at its fallback", async () => {
		const logging = await importLogging("test")

		const sink = makeSink()
		const log = logging.bootstrapLogging(sink)
		log.info("nothing should reach the sink")
		logging.bootstrapHeadlessLogging("debug").info("nor this")

		expect(sink.lines).toEqual([])
		expect(logging.getLogLevel()).toBe("debug")
		expect(logging.getLogKnownCategories()).toEqual([])
		expect(logging.getRecentLogs()).toBe("")
		expect(logging.getTaskLogs("task-1")).toEqual([])
		// The listener registration degrades to an unsubscribe that does nothing.
		expect(typeof logging.addTaskLogListener(() => {})).toBe("function")
		expect(() => logging.clearTaskLogs("task-1")).not.toThrow()
		expect(() => logging.setLogLevel("warn")).not.toThrow()
		expect(() => logging.setLogCategories(["Task"])).not.toThrow()
	})

	it("hands a child logger back that is also silent", async () => {
		const logging = await importLogging("test")

		const child = logging.getLogger().child({ ctx: "Sub" })
		expect(() => child.error("boom")).not.toThrow()
	})
})

describe("logging bootstrap — outside test mode", () => {
	it("binds subsystem loggers to the REAL transport before activation runs", async () => {
		const logging = await importLogging("production")

		// A logger created before `bootstrapLogging()` — as `subsystems.ts` does.
		const early = logging.getLogger().child({ ctx: "Early" })

		const sink = makeSink()
		logging.bootstrapLogging(sink)
		early.info("bound before bootstrap")

		expect(sink.lines.join("\n")).toContain("bound before bootstrap")
		expect(sink.lines.join("\n")).toContain("Log session started")
	})

	it("routes the exported `logger` proxy to the live root logger", async () => {
		const logging = await importLogging("production")
		const sink = makeSink()
		logging.bootstrapLogging(sink)

		logging.logger.warn("via the proxy")

		expect(sink.lines.join("\n")).toContain("via the proxy")
	})

	it("applies a runtime level change and reports it back", async () => {
		const logging = await importLogging("production")
		const sink = makeSink()
		logging.bootstrapLogging(sink)

		logging.setLogLevel("error")
		expect(logging.getLogLevel()).toBe("error")

		sink.lines.length = 0
		logging.getLogger().child({ ctx: "Sub" }).info("below the floor")
		logging.getLogger().child({ ctx: "Sub" }).error("at the floor")

		const written = sink.lines.join("\n")
		expect(written).not.toContain("below the floor")
		expect(written).toContain("at the floor")
	})

	it("filters by category and remembers the categories it has seen", async () => {
		const logging = await importLogging("production")
		const sink = makeSink()
		logging.bootstrapLogging(sink)

		logging.getLogger().child({ ctx: "Kept" }).info("keep me")
		logging.getLogger().child({ ctx: "Dropped" }).info("drop me")
		expect(logging.getLogKnownCategories()).toEqual(expect.arrayContaining(["Kept", "Dropped"]))

		logging.setLogCategories(["Kept"])
		sink.lines.length = 0
		logging.getLogger().child({ ctx: "Kept" }).info("still here")
		logging.getLogger().child({ ctx: "Dropped" }).info("gone")

		expect(sink.lines.join("\n")).toContain("still here")
		expect(sink.lines.join("\n")).not.toContain("gone")
	})

	it("keeps a ring buffer the CLI can read back", async () => {
		const logging = await importLogging("production")
		logging.bootstrapLogging(makeSink())

		logging.getLogger().child({ ctx: "Sub" }).info("recent line")

		expect(logging.getRecentLogs()).toContain("recent line")
	})

	it("writes to stderr for a headless host that has no output channel", async () => {
		const logging = await importLogging("production")
		const written: string[] = []
		const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
			written.push(String(chunk))
			return true
		})

		try {
			logging.bootstrapHeadlessLogging("debug")
			logging.getLogger().child({ ctx: "Mcp" }).debug("headless line")
		} finally {
			spy.mockRestore()
		}

		expect(written.join("")).toContain("Log session started (headless, level: debug)")
		expect(written.join("")).toContain("headless line")
	})

	it("attributes lines to the task whose context they ran in", async () => {
		const logging = await importLogging("production")
		logging.bootstrapLogging(makeSink())

		const seen: unknown[] = []
		const unsubscribe = logging.addTaskLogListener((line) => seen.push(line))

		await logging.runWithLogTaskContext({ taskId: "task-1" }, async () => {
			expect(logging.getLogTaskContext()?.taskId).toBe("task-1")
			logging.getLogger().child({ ctx: "Task" }).info("inside the task")
		})

		expect(logging.getTaskLogs("task-1").length).toBeGreaterThan(0)
		expect(seen.length).toBeGreaterThan(0)

		unsubscribe()
		logging.clearTaskLogs("task-1")
		expect(logging.getTaskLogs("task-1")).toEqual([])
	})
})
