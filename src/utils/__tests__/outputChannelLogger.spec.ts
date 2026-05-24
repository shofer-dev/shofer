import * as vscode from "vscode"

import { createOutputChannelLogger, createDualLogger, stringifyForLog } from "../outputChannelLogger"

// Mock VSCode output channel
const mockOutputChannel = {
	appendLine: vitest.fn(),
} as unknown as vscode.OutputChannel

describe("outputChannelLogger", () => {
	beforeEach(() => {
		vitest.clearAllMocks()
		// Clear console.log mock if it exists
		if (vitest.isMockFunction(console.log)) {
			;(console.log as any).mockClear()
		}
	})

	describe("createOutputChannelLogger", () => {
		it("should log strings to output channel", () => {
			const logger = createOutputChannelLogger(mockOutputChannel)
			logger("test message")

			expect(mockOutputChannel.appendLine).toHaveBeenCalledWith("test message")
		})

		it("should log null values", () => {
			const logger = createOutputChannelLogger(mockOutputChannel)
			logger(null)

			expect(mockOutputChannel.appendLine).toHaveBeenCalledWith("null")
		})

		it("should log undefined values", () => {
			const logger = createOutputChannelLogger(mockOutputChannel)
			logger(undefined)

			expect(mockOutputChannel.appendLine).toHaveBeenCalledWith("undefined")
		})

		it("should log Error objects with stack trace", () => {
			const logger = createOutputChannelLogger(mockOutputChannel)
			const error = new Error("test error")
			logger(error)

			expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(expect.stringContaining("Error: test error"))
		})

		it("should log objects as JSON", () => {
			const logger = createOutputChannelLogger(mockOutputChannel)
			const obj = { key: "value", number: 42 }
			logger(obj)

			expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(JSON.stringify(obj, expect.any(Function), 2))
		})

		it("should handle multiple arguments", () => {
			const logger = createOutputChannelLogger(mockOutputChannel)
			logger("message", 42, { key: "value" })

			expect(mockOutputChannel.appendLine).toHaveBeenCalledTimes(3)
			expect(mockOutputChannel.appendLine).toHaveBeenNthCalledWith(1, "message")
			expect(mockOutputChannel.appendLine).toHaveBeenNthCalledWith(2, "42")
			expect(mockOutputChannel.appendLine).toHaveBeenNthCalledWith(
				3,
				JSON.stringify({ key: "value" }, expect.any(Function), 2),
			)
		})

		it("should cap oversized object output and append a remaining-bytes marker", () => {
			const logger = createOutputChannelLogger(mockOutputChannel)
			// 64 KiB string — far above the 8 KiB per-arg cap.
			const obj = { big: "x".repeat(64 * 1024) }
			logger(obj)

			expect(mockOutputChannel.appendLine).toHaveBeenCalledTimes(1)
			const line = (mockOutputChannel.appendLine as any).mock.calls[0][0] as string
			expect(line.length).toBeLessThan(9 * 1024)
			expect(line).toMatch(/…\[\+\d+ more bytes\]$/)
		})
	})

	describe("stringifyForLog", () => {
		it("should return the full serialised form when under the cap", () => {
			expect(stringifyForLog({ a: 1, b: "x" })).toBe(`{"a":1,"b":"x"}`)
		})

		it("should truncate and annotate when over the byte cap", () => {
			const out = stringifyForLog({ big: "y".repeat(20_000) }, 1024)
			expect(out.length).toBeLessThan(1024 + 64)
			expect(out.endsWith(" more bytes]")).toBe(true)
		})

		it("should return a sentinel for non-serialisable values", () => {
			const cyclic: any = {}
			cyclic.self = cyclic
			const out = stringifyForLog(cyclic)
			expect(out.startsWith("[Non-serializable")).toBe(true)
		})

		it("should render undefined as the string 'undefined'", () => {
			expect(stringifyForLog(undefined)).toBe("undefined")
		})
	})

	describe("createDualLogger", () => {
		it("should log to both output channel and console", () => {
			const consoleSpy = vitest.spyOn(console, "log").mockImplementation(() => {})
			const outputChannelLogger = createOutputChannelLogger(mockOutputChannel)
			const dualLogger = createDualLogger(outputChannelLogger)

			dualLogger("test message", 42)

			expect(mockOutputChannel.appendLine).toHaveBeenCalledTimes(2)
			expect(mockOutputChannel.appendLine).toHaveBeenNthCalledWith(1, "test message")
			expect(mockOutputChannel.appendLine).toHaveBeenNthCalledWith(2, "42")
			expect(consoleSpy).toHaveBeenCalledWith("test message", 42)

			consoleSpy.mockRestore()
		})
	})
})
