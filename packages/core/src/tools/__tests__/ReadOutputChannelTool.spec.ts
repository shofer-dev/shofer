import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { ReadOutputChannelTool } from "../ReadOutputChannelTool.js"

/**
 * `read_output_channel` reads VS Code's on-disk session logs rather than the
 * (write-only) OutputChannel API, so it is testable against a real temp tree:
 * lay out the same `<logs>/<session>/window1/exthost/<pub.ext>/<Name>.log`
 * shape VS Code writes, point a fake provider's `context.logUri` at the leaf,
 * and the tool's own session-root climb does the rest.
 */

let tmpRoot: string
let logsDir: string
let sessionRoot: string
let extHostDir: string

async function write(file: string, content: string): Promise<void> {
	await fs.mkdir(path.dirname(file), { recursive: true })
	await fs.writeFile(file, content, "utf8")
}

beforeEach(async () => {
	tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "shofer-outputchannel-"))
	logsDir = path.join(tmpRoot, "logs")
	sessionRoot = path.join(logsDir, "20260101T000000")
	extHostDir = path.join(sessionRoot, "window1", "exthost", "arkware.shofer")
	await fs.mkdir(extHostDir, { recursive: true })
})

afterEach(async () => {
	await fs.rm(tmpRoot, { recursive: true, force: true })
})

function buildTask(logFsPath: string | undefined) {
	const say = vi.fn().mockResolvedValue(undefined)
	return {
		taskId: "task-1",
		consecutiveMistakeCount: 0,
		didToolFailInCurrentTurn: false,
		recordToolError: vi.fn(),
		say,
		providerRef: {
			deref: () => (logFsPath === undefined ? undefined : { context: { logUri: { fsPath: logFsPath } } }),
		},
	} as any
}

function buildCallbacks(approve = true) {
	return {
		askApproval: vi.fn().mockResolvedValue(approve),
		pushToolResult: vi.fn(),
		handleError: vi.fn(),
	} as any
}

/** The single string the tool handed back to the model. */
function result(cbs: { pushToolResult: { mock: { calls: unknown[][] } } }): string {
	expect(cbs.pushToolResult.mock.calls.length).toBe(1)
	return String(cbs.pushToolResult.mock.calls[0]![0])
}

describe("ReadOutputChannelTool — list mode", () => {
	it("classifies channels by their tier and reports the count", async () => {
		await write(path.join(sessionRoot, "main.log"), "core line\n")
		await write(path.join(sessionRoot, "window1", "renderer.log"), "window line\n")
		await write(path.join(extHostDir, "Shofer.log"), "[info] ext line\n")
		await write(path.join(sessionRoot, "window1", "exthost", "output_logging_20260101", "1-Tasks.log"), "task\n")

		const tool = new ReadOutputChannelTool()
		const task = buildTask(extHostDir)
		const cbs = buildCallbacks()

		await tool.execute({}, task, cbs)

		const out = result(cbs)
		expect(out).toContain("Output channels in the current session (4)")
		expect(out).toContain("main\t(core")
		expect(out).toContain("renderer\t(window")
		// An exthost channel names its owning extension folder…
		expect(out).toContain("Shofer\t(extension [arkware.shofer]")
		// …and a plain Output-panel channel drops the numeric prefix.
		expect(out).toContain("Tasks\t(output")
		expect(cbs.askApproval).toHaveBeenCalled()
	})

	it("reports an empty session rather than failing, and treats a blank channel as list mode", async () => {
		const cbs = buildCallbacks()
		await new ReadOutputChannelTool().execute({ channel: "   " }, buildTask(extHostDir), cbs)

		expect(result(cbs)).toContain("No output channels found")
	})

	it("returns nothing when approval is refused", async () => {
		await write(path.join(sessionRoot, "main.log"), "core\n")
		const cbs = buildCallbacks(false)

		await new ReadOutputChannelTool().execute({}, buildTask(extHostDir), cbs)

		expect(cbs.pushToolResult).not.toHaveBeenCalled()
	})
})

describe("ReadOutputChannelTool — read mode", () => {
	beforeEach(async () => {
		await write(path.join(extHostDir, "Shofer.log"), ["[info] one", "[error] two", "[debug] three", ""].join("\n"))
	})

	it("reads a channel by its friendly id", async () => {
		const cbs = buildCallbacks()
		await new ReadOutputChannelTool().execute({ channel: "Shofer" }, buildTask(extHostDir), cbs)

		const out = result(cbs)
		expect(out).toContain("[Output channel: Shofer] (extension [arkware.shofer])")
		expect(out).toContain("(COMPLETE)")
		expect(out).toContain("[error] two")
	})

	it("filters by regex search and numbers the surviving lines", async () => {
		const cbs = buildCallbacks()
		await new ReadOutputChannelTool().execute({ channel: "Shofer", search: "tw?o" }, buildTask(extHostDir), cbs)

		const out = result(cbs)
		expect(out).toContain('1 matching line(s) (search="tw?o")')
		expect(out).toContain("2 | [error] two")
		expect(out).not.toContain("[info] one")
	})

	it("falls back to a literal search when the pattern is not a valid regex", async () => {
		const cbs = buildCallbacks()
		await new ReadOutputChannelTool().execute({ channel: "Shofer", search: "tw(o" }, buildTask(extHostDir), cbs)

		expect(result(cbs)).toContain("No matching lines.")
	})

	it("filters by minimum severity, inheriting the previous line's level", async () => {
		await write(
			path.join(extHostDir, "Shofer.log"),
			["[info] one", "[error] boom", "  at frame()", "[info] after", ""].join("\n"),
		)
		const cbs = buildCallbacks()
		await new ReadOutputChannelTool().execute({ channel: "Shofer", severity: "error" }, buildTask(extHostDir), cbs)

		const out = result(cbs)
		expect(out).toContain("severity≥error")
		expect(out).toContain("[error] boom")
		// The continuation line carries no level token and inherits `error`.
		expect(out).toContain("at frame()")
		expect(out).not.toContain("[info] one")
	})

	it("rejects an unknown severity as a usage mistake without reading anything", async () => {
		const task = buildTask(extHostDir)
		const cbs = buildCallbacks()

		await new ReadOutputChannelTool().execute({ channel: "Shofer", severity: "loud" }, task, cbs)

		expect(task.consecutiveMistakeCount).toBe(1)
		expect(task.recordToolError).toHaveBeenCalledWith("read_output_channel")
		expect(task.didToolFailInCurrentTurn).toBe(true)
		expect(result(cbs)).toContain('Invalid severity "loud"')
		expect(cbs.askApproval).not.toHaveBeenCalled()
	})

	it("tails the most recent bytes and marks the read TRUNCATED", async () => {
		await write(path.join(extHostDir, "Big.log"), "x".repeat(500) + "TAIL")
		const cbs = buildCallbacks()
		await new ReadOutputChannelTool().execute({ channel: "Big", limit: 10 }, buildTask(extHostDir), cbs)

		const out = result(cbs)
		expect(out).toContain("(TRUNCATED)")
		expect(out.endsWith("xxxxxxTAIL")).toBe(true)
	})

	it("honours an explicit byte offset over tailing", async () => {
		await write(path.join(extHostDir, "Big.log"), "ABCDEFGHIJ")
		const cbs = buildCallbacks()
		await new ReadOutputChannelTool().execute(
			{ channel: "Big", offset: 4, limit: 3, tail: true },
			buildTask(extHostDir),
			cbs,
		)

		expect(result(cbs)).toContain("bytes 4-7 of 10")
	})

	it("reads from the start when tail is false", async () => {
		await write(path.join(extHostDir, "Big.log"), "ABCDEFGHIJ")
		const cbs = buildCallbacks()
		await new ReadOutputChannelTool().execute({ channel: "Big", tail: false, limit: 4 }, buildTask(extHostDir), cbs)

		const out = result(cbs)
		expect(out).toContain("bytes 0-4 of 10")
		expect(out.endsWith("ABCD")).toBe(true)
	})

	it("bounds a filtered head read by the byte limit", async () => {
		const lines = Array.from({ length: 40 }, (_, i) => `[info] match ${i}`).join("\n")
		await write(path.join(extHostDir, "Many.log"), lines + "\n")
		const cbs = buildCallbacks()
		await new ReadOutputChannelTool().execute(
			{ channel: "Many", search: "match", tail: false, limit: 40 },
			buildTask(extHostDir),
			cbs,
		)

		expect(result(cbs)).toContain("newer matches omitted by limit")
	})

	it("bounds a filtered tail read by the byte limit, dropping the oldest matches", async () => {
		const lines = Array.from({ length: 40 }, (_, i) => `[info] match ${i}`).join("\n")
		await write(path.join(extHostDir, "Many.log"), lines + "\n")
		const cbs = buildCallbacks()
		await new ReadOutputChannelTool().execute(
			{ channel: "Many", search: "match", limit: 40 },
			buildTask(extHostDir),
			cbs,
		)

		const out = result(cbs)
		expect(out).toContain("older matches omitted by limit")
		expect(out).toContain("match 39")
	})

	it("reports an empty channel log distinctly", async () => {
		await write(path.join(extHostDir, "Empty.log"), "")
		const cbs = buildCallbacks()
		await new ReadOutputChannelTool().execute({ channel: "Empty" }, buildTask(extHostDir), cbs)

		expect(result(cbs)).toContain("(channel log is empty)")
	})

	it("tells the model to list when nothing matches the requested channel", async () => {
		const cbs = buildCallbacks()
		await new ReadOutputChannelTool().execute({ channel: "nope" }, buildTask(extHostDir), cbs)

		expect(result(cbs)).toContain('No output channel matching "nope"')
	})

	it("lists the candidates when the query is ambiguous", async () => {
		await write(path.join(extHostDir, "Alpha One.log"), "a\n")
		await write(path.join(sessionRoot, "window1", "Alpha Two.log"), "b\n")
		const cbs = buildCallbacks()
		await new ReadOutputChannelTool().execute({ channel: "alpha" }, buildTask(extHostDir), cbs)

		const out = result(cbs)
		expect(out).toContain('Multiple channels match "alpha"')
		expect(out).toContain("Alpha One")
		expect(out).toContain("Alpha Two")
	})
})

describe("ReadOutputChannelTool — host without a logs directory", () => {
	it("explains that a headless host exposes no logUri", async () => {
		const task = buildTask(undefined)
		const cbs = buildCallbacks()

		await new ReadOutputChannelTool().execute({}, task, cbs)

		expect(result(cbs)).toContain("Could not locate the VS Code logs directory")
		expect(task.say).toHaveBeenCalledWith("error", expect.stringContaining("context.logUri is unavailable"))
	})

	it("falls back three levels up when the path is not under a `logs` folder", async () => {
		// <root>/other/<session>/window1/exthost/<pub.ext> — no `logs` ancestor,
		// so the climb fails and the up-three fallback names the session dir.
		const oddSession = path.join(tmpRoot, "other", "sess")
		const oddLeaf = path.join(oddSession, "window1", "exthost", "arkware.shofer")
		await fs.mkdir(oddLeaf, { recursive: true })
		await write(path.join(oddSession, "main.log"), "core\n")

		const cbs = buildCallbacks()
		await new ReadOutputChannelTool().execute({}, buildTask(oddLeaf), cbs)

		expect(result(cbs)).toContain("main\t(core")
	})

	it("reports a read failure without throwing out of execute()", async () => {
		await write(path.join(extHostDir, "Gone.log"), "content\n")
		const task = buildTask(extHostDir)
		const cbs = buildCallbacks()
		const tool = new ReadOutputChannelTool()

		// Delete the backing file between discovery and the read.
		cbs.askApproval = vi.fn().mockImplementation(async () => {
			await fs.rm(path.join(extHostDir, "Gone.log"))
			return true
		})

		await tool.execute({ channel: "Gone" }, task, cbs)

		expect(result(cbs)).toContain("Error reading output channel")
		expect(task.didToolFailInCurrentTurn).toBe(true)
	})
})
