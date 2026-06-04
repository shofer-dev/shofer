// npx vitest utils/logging/__tests__/CompactTransport.spec.ts

import { CompactTransport } from "../CompactTransport"
import fs from "fs"
import path from "path"

/** Minimal mock OutputChannel for testing the human-readable line path. */
class MockOutputChannel {
	lines: string[] = []
	appendLine(line: string): void {
		this.lines.push(line)
	}
}

describe("CompactTransport", () => {
	const testDir = "./test-logs"
	const testLogPath = path.join(testDir, "test.log")
	let transport: CompactTransport
	let outputChannel: MockOutputChannel

	const cleanupTestLogs = () => {
		const rmDirRecursive = (dirPath: string) => {
			if (fs.existsSync(dirPath)) {
				fs.readdirSync(dirPath).forEach((file) => {
					const curPath = path.join(dirPath, file)
					if (fs.lstatSync(curPath).isDirectory()) {
						rmDirRecursive(curPath)
					} else {
						fs.unlinkSync(curPath)
					}
				})
				fs.rmdirSync(dirPath)
			}
		}

		try {
			rmDirRecursive(testDir)
		} catch (err) {
			console.error("Cleanup error:", err)
		}
	}

	beforeEach(() => {
		outputChannel = new MockOutputChannel()
		cleanupTestLogs()
		fs.mkdirSync(testDir, { recursive: true })

		transport = new CompactTransport(outputChannel as any, {
			level: "debug",
			fileOutput: {
				enabled: true,
				path: testLogPath,
			},
		})
	})

	afterEach(() => {
		transport.close()
		cleanupTestLogs()
	})

	describe("File Handling", () => {
		test("creates new log file on initialization", () => {
			const entry = {
				t: Date.now(),
				l: "info",
				m: "test message",
			}

			transport.write(entry)

			const fileContent = fs.readFileSync(testLogPath, "utf-8")
			const lines = fileContent.trim().split("\n")

			expect(lines.length).toBe(2)
			expect(JSON.parse(lines[0])).toMatchObject({
				l: "info",
				m: "Log session started",
			})
			expect(JSON.parse(lines[1])).toMatchObject({
				l: "info",
				m: "test message",
			})
		})

		test("appends entries after initialization", () => {
			transport.write({
				t: Date.now(),
				l: "info",
				m: "first",
			})

			transport.write({
				t: Date.now(),
				l: "info",
				m: "second",
			})

			const fileContent = fs.readFileSync(testLogPath, "utf-8")
			const lines = fileContent.trim().split("\n")

			expect(lines.length).toBe(3)
			expect(JSON.parse(lines[1])).toMatchObject({ m: "first" })
			expect(JSON.parse(lines[2])).toMatchObject({ m: "second" })
		})

		test("writes session end marker on close", () => {
			transport.write({
				t: Date.now(),
				l: "info",
				m: "test",
			})

			transport.close()

			const fileContent = fs.readFileSync(testLogPath, "utf-8")
			const lines = fileContent.trim().split("\n")
			const lastLine = JSON.parse(lines[lines.length - 1])

			expect(lastLine).toMatchObject({
				l: "info",
				m: "Log session ended",
			})
		})
	})

	describe("File System Edge Cases", () => {
		test("handles file path with deep directories", () => {
			const deepDir = path.join(testDir, "deep/nested/path")
			const deepPath = path.join(deepDir, "test.log")
			const deepTransport = new CompactTransport(outputChannel as any, {
				fileOutput: { enabled: true, path: deepPath },
			})

			try {
				deepTransport.write({
					t: Date.now(),
					l: "info",
					m: "test",
				})

				expect(fs.existsSync(deepPath)).toBeTruthy()
			} finally {
				deepTransport.close()
				const rmDirRecursive = (dirPath: string) => {
					if (fs.existsSync(dirPath)) {
						fs.readdirSync(dirPath).forEach((file) => {
							const curPath = path.join(dirPath, file)
							if (fs.lstatSync(curPath).isDirectory()) {
								rmDirRecursive(curPath)
							} else {
								fs.unlinkSync(curPath)
							}
						})
						fs.rmdirSync(dirPath)
					}
				}
				rmDirRecursive(path.join(testDir, "deep"))
			}
		})

		test("handles concurrent writes", async () => {
			const entries = Array(100)
				.fill(null)
				.map((_, i) => ({
					t: Date.now(),
					l: "info",
					m: `test ${i}`,
				}))

			await Promise.all(entries.map((entry) => Promise.resolve(transport.write(entry))))

			const fileContent = fs.readFileSync(testLogPath, "utf-8")
			const lines = fileContent.trim().split("\n")
			expect(lines.length).toBe(entries.length + 1)
		})
	})

	describe("Output Channel", () => {
		test("writes human-readable lines to the output channel", () => {
			transport.write({
				t: Date.now(),
				l: "info",
				m: "hello world",
				c: "TestCtx",
			})

			expect(outputChannel.lines.length).toBeGreaterThanOrEqual(1)
			// Find the log line (skip session start marker)
			const logLine = outputChannel.lines.find((l) => l.includes("hello world"))
			expect(logLine).toBeDefined()
			expect(logLine).toContain("INFO")
			expect(logLine).toContain("[TestCtx]")
			expect(logLine).toContain("hello world")
		})

		test("prefixes with level and context", () => {
			transport.write({
				t: Date.now(),
				l: "warn",
				m: "warning message",
				c: "Git",
			})

			const logLine = outputChannel.lines.find((l) => l.includes("warning message"))
			expect(logLine).toContain("WARN")
			expect(logLine).toContain("[Git]")
		})

		test("respects level filtering for output channel", () => {
			transport.setLevel("warn")

			transport.write({ t: Date.now(), l: "debug", m: "debug msg" })
			transport.write({ t: Date.now(), l: "info", m: "info msg" })
			transport.write({ t: Date.now(), l: "warn", m: "warn msg" })

			const debugMsg = outputChannel.lines.find((l) => l.includes("debug msg"))
			const infoMsg = outputChannel.lines.find((l) => l.includes("info msg"))
			const warnMsg = outputChannel.lines.find((l) => l.includes("warn msg"))

			expect(debugMsg).toBeUndefined()
			expect(infoMsg).toBeUndefined()
			expect(warnMsg).toBeDefined()
		})
	})

	describe("Level Filtering", () => {
		test("setLevel changes the minimum level", () => {
			transport.setLevel("error")

			transport.write({ t: Date.now(), l: "warn", m: "should be filtered" })
			transport.write({ t: Date.now(), l: "error", m: "should be visible" })

			const filtered = outputChannel.lines.find((l) => l.includes("should be filtered"))
			const visible = outputChannel.lines.find((l) => l.includes("should be visible"))

			expect(filtered).toBeUndefined()
			expect(visible).toBeDefined()
		})
	})

	// Regression: subsystem loggers in `subsystems.ts` are created via
	// `getLogger().child({ ctx })` at module-import time, which runs BEFORE
	// `bootstrapLogging()` attaches the Output Channel. The eager-transport fix
	// relies on a channel-less transport that late-binds its channel via
	// `setOutputChannel()` — loggers bound to it before the channel exists must
	// still emit (and still honour level/category filters) once it is attached.
	describe("Late channel binding (setOutputChannel)", () => {
		let lateChannel: MockOutputChannel
		let lateTransport: CompactTransport

		beforeEach(() => {
			lateChannel = new MockOutputChannel()
			// Constructed with NO output channel, exactly like the eager
			// module-load transport in logging/index.ts.
			lateTransport = new CompactTransport(undefined, { level: "debug" })
		})

		afterEach(() => {
			lateTransport.close()
		})

		test("entries written before attach are not lost to the channel after attach", () => {
			lateTransport.write({ t: Date.now(), l: "info", m: "before attach", c: "Task" })

			// No channel yet → nothing buffered to a channel.
			expect(lateChannel.lines.length).toBe(0)

			lateTransport.setOutputChannel(lateChannel as any)
			lateTransport.write({ t: Date.now(), l: "info", m: "after attach", c: "Task" })

			const after = lateChannel.lines.find((l) => l.includes("after attach"))
			expect(after).toBeDefined()
			expect(after).toContain("[Task]")
		})

		test("category filter set before attach is honoured after attach", () => {
			lateTransport.setCategories(["Task"])
			lateTransport.setOutputChannel(lateChannel as any)

			lateTransport.write({ t: Date.now(), l: "info", m: "task line", c: "Task" })
			lateTransport.write({ t: Date.now(), l: "info", m: "git line", c: "Git" })

			expect(lateChannel.lines.find((l) => l.includes("task line"))).toBeDefined()
			expect(lateChannel.lines.find((l) => l.includes("git line"))).toBeUndefined()
		})

		test("level filter changed live after attach takes effect", () => {
			lateTransport.setOutputChannel(lateChannel as any)
			lateTransport.setLevel("warn")

			lateTransport.write({ t: Date.now(), l: "info", m: "info dropped", c: "Task" })
			lateTransport.write({ t: Date.now(), l: "warn", m: "warn kept", c: "Task" })

			expect(lateChannel.lines.find((l) => l.includes("info dropped"))).toBeUndefined()
			expect(lateChannel.lines.find((l) => l.includes("warn kept"))).toBeDefined()
		})
	})
})
