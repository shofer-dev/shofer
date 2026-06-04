// npx vitest utils/logging/__tests__/CompactLogger.spec.ts

import { CompactLogger } from "../CompactLogger"
import { MockTransport } from "./MockTransport"

describe("CompactLogger", () => {
	let transport: MockTransport
	let logger: CompactLogger

	beforeEach(() => {
		transport = new MockTransport()
		logger = new CompactLogger(transport)
	})

	afterEach(() => {
		transport.clear()
	})

	describe("Log Levels", () => {
		const levels = ["debug", "info", "warn", "error", "fatal"] as const

		levels.forEach((level) => {
			test(`${level} level logs correctly`, () => {
				const message = `test ${level} message`
				;(logger[level] as (msg: string) => void)(message)

				expect(transport.entries.length).toBeGreaterThan(0)
				expect(transport.entries[0]).toMatchObject({
					l: level,
				})
				expect(transport.entries[0].m).toContain(message)
			})
		})
	})

	describe("Error Handling", () => {
		test("handles Error objects in error level", () => {
			const error = new Error("test error")
			logger.error(error)

			expect(transport.entries[0]).toMatchObject({
				l: "error",
				m: "test error",
			})
			expect(transport.entries[0].d).toMatchObject({
				error: {
					name: "Error",
					message: "test error",
					stack: error.stack,
				},
			})
		})

		test("handles Error objects in fatal level", () => {
			const error = new Error("test fatal")
			logger.fatal(error)

			expect(transport.entries[0]).toMatchObject({
				l: "fatal",
				m: "test fatal",
			})
		})

		test("error with string and extra args appends them", () => {
			logger.error("something failed", new Error("details"))

			expect(transport.entries[0].l).toBe("error")
			expect(transport.entries[0].m).toContain("something failed")
			expect(transport.entries[0].m).toContain("details")
		})
	})

	describe("Child Loggers", () => {
		test("creates child logger with inherited context", () => {
			const parentLogger = new CompactLogger(transport, { ctx: "parent", traceId: "123" })
			const childLogger = parentLogger.child({ ctx: "child", userId: "456" })

			childLogger.info("test message")

			// child.ctx overrides parent.ctx
			expect(transport.entries[0].c).toBe("child")
		})

		test("child logger respects parent context when not overridden", () => {
			const parentLogger = new CompactLogger(transport, { ctx: "parent" })
			const childLogger = parentLogger.child({ userId: "123" })

			childLogger.info("test message")

			expect(transport.entries[0].c).toBe("parent")
		})

		test("registers ctx as a known category at creation, before emitting", () => {
			const parentLogger = new CompactLogger(transport)

			parentLogger.child({ ctx: "EagerlyKnown" })

			// No log line emitted yet, but the category is already discoverable
			// so it appears in the Settings UI immediately.
			expect(transport.getKnownCategories()).toContain("EagerlyKnown")
			expect(transport.entries.length).toBe(0)
		})

		test("does not register a category when child has no ctx", () => {
			const parentLogger = new CompactLogger(transport)

			parentLogger.child({ userId: "123" })

			expect(transport.getKnownCategories()).toEqual([])
		})
	})

	describe("Lifecycle", () => {
		test("closes transport on logger close", () => {
			logger.close()
			expect(transport.closed).toBe(true)
		})
	})

	describe("Timestamp Handling", () => {
		beforeEach(() => {
			vi.useFakeTimers()
		})

		afterEach(() => {
			vi.useRealTimers()
		})

		test("generates increasing timestamps", () => {
			const now = Date.now()
			vi.setSystemTime(now)

			logger.info("first")
			vi.setSystemTime(now + 10)
			logger.info("second")

			expect(transport.entries[0].t).toBeLessThan(transport.entries[1].t)
		})
	})

	describe("Extra Arguments", () => {
		test("appends extra string arguments to message", () => {
			logger.info("hello", "world", 42)
			expect(transport.entries[0].m).toContain("hello")
			expect(transport.entries[0].m).toContain("world")
			expect(transport.entries[0].m).toContain("42")
		})

		test("formats Error extra args with message and stack", () => {
			const err = new Error("boom")
			logger.warn("warning:", err)
			expect(transport.entries[0].m).toContain("warning:")
			expect(transport.entries[0].m).toContain("boom")
		})
	})

	describe("setLevel", () => {
		test("delegates to transport", () => {
			const spy = vi.spyOn(transport, "setLevel")
			logger.setLevel("warn")
			expect(spy).toHaveBeenCalledWith("warn")
		})
	})
})
