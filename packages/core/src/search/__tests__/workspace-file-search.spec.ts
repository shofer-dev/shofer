import { EventEmitter } from "node:events"
import * as fsp from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { PassThrough } from "node:stream"

import { createInMemoryHost, getHost, setHost } from "@shofer/types"

/**
 * The `@`-mention file picker: a ripgrep `--files` enumeration, an fzf ranking
 * over it, and a final stat that corrects each hit's type.
 *
 * Two behaviours carry weight beyond "it finds files". The enumeration synthesizes
 * a FOLDER entry for every ancestor directory it walks past — ripgrep only lists
 * files, so without that the picker could never offer a directory. And the final
 * pass re-stats each hit, because the type ripgrep implied is a guess: a name
 * that is really a directory must come back as `folder` or the mention resolves
 * to the wrong kind of thing.
 */

const spawn = vi.fn()
vi.mock("child_process", () => ({ spawn: (...a: unknown[]) => spawn(...a), execFileSync: vi.fn() }))

const getBinPath = vi.fn()
vi.mock("../../ripgrep/index.js", () => ({ getBinPath: (...a: unknown[]) => getBinPath(...a) }))

import { executeRipgrep, executeRipgrepForFiles, searchWorkspaceFiles } from "../file-search.js"

/** A fake `rg --files` that prints `lines` on stdout, then closes. */
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

/** Install a host whose `config.get` answers from `values`. */
function installConfig(values: Record<string, unknown>) {
	const bridge = createInMemoryHost()
	setHost({
		...bridge,
		config: {
			...bridge.config,
			get: (section: string, key: string, fallback: unknown) => values[`${section}.${key}`] ?? fallback,
		},
	} as never)
}

let workspacePath: string
let previousHost: ReturnType<typeof getHost>

beforeEach(async () => {
	vi.clearAllMocks()
	previousHost = getHost()
	getBinPath.mockResolvedValue("/usr/bin/rg")
	installConfig({})
	workspacePath = await fsp.mkdtemp(path.join(os.tmpdir(), "shofer-file-search-"))
})

afterEach(async () => {
	setHost(previousHost)
	await fsp.rm(workspacePath, { recursive: true, force: true })
})

describe("executeRipgrep", () => {
	it("returns each file relative to the workspace, plus a folder per ancestor", async () => {
		stubRipgrep([path.join(workspacePath, "src/deep/a.ts"), path.join(workspacePath, "README.md")])

		const results = await executeRipgrep({ args: [], workspacePath })

		expect(results.filter((r) => r.type === "file").map((r) => r.path)).toEqual(["src/deep/a.ts", "README.md"])
		expect(
			results
				.filter((r) => r.type === "folder")
				.map((r) => r.path)
				.sort(),
		).toEqual(["src", "src/deep"])
		expect(results[0]!.label).toBe("a.ts")
	})

	it("stops at the limit and kills the process", async () => {
		stubRipgrep(["a.ts", "b.ts", "c.ts"].map((f) => path.join(workspacePath, f)))

		const results = await executeRipgrep({ args: [], workspacePath, limit: 2 })

		expect(results.filter((r) => r.type === "file")).toHaveLength(2)
	})

	it("names the install command when ripgrep is not on the machine", async () => {
		getBinPath.mockResolvedValue(undefined)

		await expect(executeRipgrep({ args: [], workspacePath })).rejects.toThrow(/install ripgrep/)
	})

	it("rejects when ripgrep wrote to stderr and produced nothing", async () => {
		stubRipgrep([], "rg: bad glob")

		await expect(executeRipgrep({ args: [], workspacePath })).rejects.toThrow(/ripgrep process error/)
	})

	it("keeps the results when ripgrep warned but still listed files", async () => {
		stubRipgrep([path.join(workspacePath, "a.ts")], "rg: skipped an unreadable dir")

		const results = await executeRipgrep({ args: [], workspacePath })

		expect(results.map((r) => r.path)).toContain("a.ts")
	})

	it("rejects when the process cannot be spawned", async () => {
		spawn.mockImplementation(() => {
			const proc = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough }
			proc.stdout = new PassThrough()
			proc.stderr = new PassThrough()
			queueMicrotask(() => proc.emit("error", new Error("ENOENT")))
			return proc
		})

		await expect(executeRipgrep({ args: [], workspacePath })).rejects.toThrow(/ENOENT/)
	})
})

describe("executeRipgrepForFiles", () => {
	it("excludes the usual noise directories and follows symlinks", async () => {
		stubRipgrep([])

		await executeRipgrepForFiles(workspacePath)

		const args = spawn.mock.calls[0]![1] as string[]
		expect(args).toContain("--files")
		expect(args).toContain("--follow")
		expect(args).toContain("--hidden")
		for (const glob of ["!**/node_modules/**", "!**/.git/**", "!**/out/**", "!**/dist/**"]) {
			expect(args).toContain(glob)
		}
		expect(args.at(-1)).toBe(workspacePath)
	})

	it("honours the editor's ignore-file settings when they are switched OFF", async () => {
		installConfig({
			"search.useIgnoreFiles": false,
			"search.useGlobalIgnoreFiles": false,
			"search.useParentIgnoreFiles": false,
		})
		stubRipgrep([])

		await executeRipgrepForFiles(workspacePath)

		const args = spawn.mock.calls[0]![1] as string[]
		expect(args).toContain("--no-ignore")
		expect(args).toContain("--no-ignore-global")
		expect(args).toContain("--no-ignore-parent")
	})

	it("passes no ignore overrides when the settings are at their defaults", async () => {
		stubRipgrep([])

		await executeRipgrepForFiles(workspacePath)

		expect(spawn.mock.calls[0]![1]).not.toContain("--no-ignore")
	})
})

describe("searchWorkspaceFiles", () => {
	async function seed(files: string[]) {
		for (const f of files) {
			const abs = path.join(workspacePath, f)
			await fsp.mkdir(path.dirname(abs), { recursive: true })
			await fsp.writeFile(abs, "x", "utf8")
		}
		stubRipgrep(files.map((f) => path.join(workspacePath, f)))
	}

	it("returns the head of the listing when the query is blank", async () => {
		await seed(["a.ts", "b.ts", "c.ts"])

		const results = await searchWorkspaceFiles("   ", workspacePath, 2)

		expect(results).toHaveLength(2)
	})

	it("ranks by fuzzy match against the path and the label", async () => {
		await seed(["src/needle.ts", "src/other.ts"])

		const results = await searchWorkspaceFiles("needle", workspacePath, 5)

		expect(results[0]!.path).toBe("src/needle.ts")
	})

	it("re-stats each hit, so a directory comes back as a folder", async () => {
		await seed(["target/inner.ts"])

		const results = await searchWorkspaceFiles("target", workspacePath, 10)

		const folder = results.find((r) => r.path === "target")
		expect(folder?.type).toBe("folder")
	})

	it("keeps a hit whose path no longer exists rather than dropping it", async () => {
		// ripgrep listed it; the file was removed before the stat.
		stubRipgrep([path.join(workspacePath, "vanished.ts")])

		const results = await searchWorkspaceFiles("vanished", workspacePath, 10)

		expect(results.map((r) => r.path)).toContain("vanished.ts")
	})

	it("returns nothing rather than throwing when the enumeration fails", async () => {
		getBinPath.mockResolvedValue(undefined)

		expect(await searchWorkspaceFiles("anything", workspacePath)).toEqual([])
	})
})
