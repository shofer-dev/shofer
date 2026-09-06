import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"

/**
 * `regexGrepSearch` drives the ripgrep binary and turns its `--json` stream
 * into the grouped, context-bearing text the model reads.
 *
 * `child_process` is stubbed rather than a real `rg` invoked, for two reasons
 * that are also what the tests are about: the parsing is line-oriented over a
 * stream whose SHAPE (begin / match / context / end records) is the contract,
 * and the failure modes worth pinning — a missing binary, a stderr-reporting
 * process, a malformed line — are awkward to provoke with a real one.
 */

const spawn = vi.fn()
const execFileSync = vi.fn()

vi.mock("child_process", () => ({
	spawn: (...a: unknown[]) => spawn(...a),
	execFileSync: (...a: unknown[]) => execFileSync(...a),
}))

const fileExistsAtPath = vi.fn()
vi.mock("../../fs/fs.js", () => ({ fileExistsAtPath: (...a: unknown[]) => fileExistsAtPath(...a) }))

import { getBinPath, regexGrepSearch } from "../index.js"

/** A fake `rg` process that emits `lines` on stdout, then closes. */
function stubRipgrep(lines: string[], stderr = "") {
	spawn.mockImplementation(() => {
		const proc = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: () => void }
		proc.stdout = new PassThrough()
		proc.stderr = new PassThrough()
		proc.kill = vi.fn()
		queueMicrotask(() => {
			if (stderr) proc.stderr.write(stderr)
			for (const line of lines) proc.stdout.write(line + "\n")
			proc.stdout.end()
			proc.stderr.end()
		})
		return proc
	})
}

const begin = (file: string) => JSON.stringify({ type: "begin", data: { path: { text: file } } })
const end = () => JSON.stringify({ type: "end" })
const match = (line: number, text: string) =>
	JSON.stringify({ type: "match", data: { line_number: line, lines: { text }, absolute_offset: 7 } })
const context = (line: number, text: string) =>
	JSON.stringify({ type: "context", data: { line_number: line, lines: { text } } })

beforeEach(() => {
	vi.clearAllMocks()
	fileExistsAtPath.mockResolvedValue(true)
})

describe("getBinPath", () => {
	it("prefers the ripgrep shipped inside the VS Code installation", async () => {
		fileExistsAtPath.mockImplementation(async (p: string) => p.includes("node_modules/@vscode/ripgrep/bin/"))

		const found = await getBinPath("/app")

		expect(found).toContain("node_modules/@vscode/ripgrep/bin/")
		expect(execFileSync).not.toHaveBeenCalled()
	})

	it("walks the other bundled locations before giving up on the installation", async () => {
		fileExistsAtPath.mockImplementation(async (p: string) =>
			p.includes("node_modules.asar.unpacked/vscode-ripgrep"),
		)

		expect(await getBinPath("/app")).toContain("node_modules.asar.unpacked/vscode-ripgrep")
	})

	it("falls back to a system ripgrep on PATH", async () => {
		fileExistsAtPath.mockResolvedValue(false)
		execFileSync.mockReturnValue("/usr/bin/rg\n")

		expect(await getBinPath("/app")).toBe("/usr/bin/rg")
	})

	it("returns undefined when ripgrep is nowhere", async () => {
		fileExistsAtPath.mockResolvedValue(false)
		execFileSync.mockImplementation(() => {
			throw new Error("not found")
		})

		expect(await getBinPath("/app")).toBeUndefined()
	})
})

describe("regexGrepSearch", () => {
	it("names the install command when ripgrep cannot be found at all", async () => {
		fileExistsAtPath.mockResolvedValue(false)
		execFileSync.mockImplementation(() => {
			throw new Error("not found")
		})

		await expect(regexGrepSearch("/ws", "/ws/src", "TODO")).rejects.toThrow(/install ripgrep/)
	})

	it("groups matches under a workspace-relative path with their context lines", async () => {
		stubRipgrep([
			begin("/ws/src/a.ts"),
			context(1, "before\n"),
			match(2, "// TODO: fix\n"),
			context(3, "after\n"),
			end(),
		])

		const output = await regexGrepSearch("/ws", "/ws/src", "TODO")

		expect(output).toContain("Found 1 result.")
		expect(output).toContain("# src/a.ts")
		expect(output).toContain("  2 | // TODO: fix")
		expect(output).toContain("  1 | before")
		expect(output).toContain("----")
	})

	it("starts a new result group when the next line is not contiguous", async () => {
		stubRipgrep([begin("/ws/a.ts"), match(2, "one\n"), match(40, "two\n"), end()])

		const output = await regexGrepSearch("/ws", "/ws", "x")

		expect(output).toContain("Found 2 results.")
		expect(output).toContain(" 2 | one")
		expect(output).toContain(" 40 | two")
	})

	it("truncates an over-long matched line", async () => {
		stubRipgrep([begin("/ws/a.ts"), match(1, "x".repeat(600)), end()])

		expect(await regexGrepSearch("/ws", "/ws", "x")).toContain("[truncated...]")
	})

	it("adds a glob argument only when a file pattern was given", async () => {
		stubRipgrep([])
		await regexGrepSearch("/ws", "/ws", "TODO")
		expect(spawn.mock.calls[0]![1]).not.toContain("--glob")

		spawn.mockClear()
		stubRipgrep([])
		await regexGrepSearch("/ws", "/ws", "TODO", "*.ts")
		const args = spawn.mock.calls[0]![1] as string[]
		expect(args).toContain("--glob")
		expect(args[args.indexOf("--glob") + 1]).toBe("*.ts")
	})

	it("drops files the ignore controller refuses", async () => {
		stubRipgrep([begin("/ws/keep.ts"), match(1, "hit\n"), end(), begin("/ws/secret.env"), match(1, "hit\n"), end()])
		const controller = { validateAccess: vi.fn((f: string) => !f.endsWith("secret.env")) }

		const output = await regexGrepSearch("/ws", "/ws", "hit", undefined, controller as never)

		expect(output).toContain("keep.ts")
		expect(output).not.toContain("secret.env")
	})

	it("returns 'No results found' when ripgrep writes to stderr", async () => {
		stubRipgrep([begin("/ws/a.ts"), match(1, "hit\n"), end()], "rg: bad pattern")

		expect(await regexGrepSearch("/ws", "/ws", "(")).toBe("No results found")
	})

	it("returns 'No results found' when the process cannot be spawned", async () => {
		spawn.mockImplementation(() => {
			const proc = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough }
			proc.stdout = new PassThrough()
			proc.stderr = new PassThrough()
			queueMicrotask(() => proc.emit("error", new Error("ENOENT")))
			return proc
		})

		expect(await regexGrepSearch("/ws", "/ws", "x")).toBe("No results found")
	})

	it("skips a malformed JSON line rather than failing the whole search", async () => {
		stubRipgrep([begin("/ws/a.ts"), "{not json", match(1, "hit\n"), end()])

		expect(await regexGrepSearch("/ws", "/ws", "hit")).toContain("  1 | hit")
	})

	it("reports zero results when nothing matched", async () => {
		stubRipgrep([])

		expect(await regexGrepSearch("/ws", "/ws", "nothing")).toBe("Found 0 results.")
	})
})
