// npx vitest run src/prompts/sections/__tests__/custom-instructions-scoping.spec.ts
//
// Covers the on-demand rule-loading behavior: `paths:` frontmatter scoping of
// rule files, touched-path gating of subfolder .shofer/rules, and
// touched-path gating of subdirectory AGENTS.md files.

vi.mock("fs/promises")

vi.mock("../../../services/shofer-config/index.js", () => ({
	getRooDirectoriesForCwd: vi.fn(() => ["/ws/.shofer"]),
	discoverSubfolderRooDirectories: vi.fn(async () => ["/ws/packages/api/.shofer"]),
	getAgentsDirectoriesForCwd: vi.fn(async () => ["/ws", "/ws/packages/api"]),
}))

import fs from "fs/promises"
import type { PathLike } from "fs"

import { loadRuleFiles, addCustomInstructions } from "../custom-instructions.js"

const CWD = "/ws"

/** Filesystem fixture: directories that exist, and file path → content. */
const dirs = new Set<string>(["/ws/.shofer/rules", "/ws/packages/api/.shofer/rules"])
const files = new Map<string, string>()

function enoent(): NodeJS.ErrnoException {
	const err = new Error("ENOENT") as NodeJS.ErrnoException
	err.code = "ENOENT"
	return err
}

function installFsMocks() {
	vi.mocked(fs.stat).mockImplementation(async (p: PathLike) => {
		const key = p.toString()
		if (dirs.has(key)) {
			return { isDirectory: () => true, isFile: () => false } as Awaited<ReturnType<typeof fs.stat>>
		}
		if (files.has(key)) {
			return { isDirectory: () => false, isFile: () => true } as Awaited<ReturnType<typeof fs.stat>>
		}
		throw enoent()
	})
	vi.mocked(fs.lstat).mockImplementation(async (p: PathLike) => {
		const key = p.toString()
		if (files.has(key) || dirs.has(key)) {
			return { isSymbolicLink: () => false } as Awaited<ReturnType<typeof fs.lstat>>
		}
		throw enoent()
	})
	vi.mocked(fs.readFile).mockImplementation(async (p) => {
		const key = p.toString()
		const content = files.get(key)
		if (content === undefined) {
			throw enoent()
		}
		return content
	})
	// readdir(dir, { withFileTypes: true, recursive: true }) → Dirent-likes for
	// the files directly under that rules dir.
	vi.mocked(fs.readdir).mockImplementation((async (p: PathLike) => {
		const dir = p.toString()
		if (!dirs.has(dir)) {
			throw enoent()
		}
		return [...files.keys()]
			.filter((f) => f.startsWith(`${dir}/`))
			.map((f) => ({
				name: f.slice(dir.length + 1),
				parentPath: dir,
				isFile: () => true,
				isSymbolicLink: () => false,
			}))
	}) as unknown as typeof fs.readdir)
}

beforeEach(() => {
	vi.clearAllMocks()
	dirs.clear()
	files.clear()
	dirs.add("/ws/.shofer/rules")
	dirs.add("/ws/packages/api/.shofer/rules")
	installFsMocks()
})

describe("paths: frontmatter scoping", () => {
	beforeEach(() => {
		files.set("/ws/.shofer/rules/generic.md", "always-on rule")
		files.set("/ws/.shofer/rules/go-only.md", "---\npaths:\n  - '**/*.go'\n---\ngofmt must pass")
	})

	it("includes a scoped rule when a touched path matches, with frontmatter stripped", async () => {
		const result = await loadRuleFiles(CWD, false, ["src/main.go"])
		expect(result).toContain("always-on rule")
		expect(result).toContain("gofmt must pass")
		expect(result).not.toContain("paths:")
	})

	it("excludes a scoped rule when no touched path matches", async () => {
		const result = await loadRuleFiles(CWD, false, ["src/app.ts"])
		expect(result).toContain("always-on rule")
		expect(result).not.toContain("gofmt must pass")
	})

	it("excludes a scoped rule when nothing has been touched yet", async () => {
		const result = await loadRuleFiles(CWD, false, [])
		expect(result).toContain("always-on rule")
		expect(result).not.toContain("gofmt must pass")
	})

	it("includes everything when the caller passes no touchedPaths (no gating)", async () => {
		const result = await loadRuleFiles(CWD, false)
		expect(result).toContain("always-on rule")
		expect(result).toContain("gofmt must pass")
	})

	it("treats a file with non-paths frontmatter as unscoped, stripping the frontmatter", async () => {
		files.set("/ws/.shofer/rules/meta.md", "---\ndescription: docs rule\n---\ndocs are current-state only")
		const result = await loadRuleFiles(CWD, false, ["src/app.ts"])
		expect(result).toContain("docs are current-state only")
		expect(result).not.toContain("description:")
	})
})

describe("on-demand subfolder .shofer/rules", () => {
	beforeEach(() => {
		files.set("/ws/.shofer/rules/root.md", "root rule")
		files.set("/ws/packages/api/.shofer/rules/api.md", "api-only rule")
	})

	it("loads a subfolder's rules once a file under it is touched", async () => {
		const result = await loadRuleFiles(CWD, true, ["packages/api/handler.go"])
		expect(result).toContain("root rule")
		expect(result).toContain("api-only rule")
	})

	it("does not load a subfolder's rules when the task has not touched it", async () => {
		const result = await loadRuleFiles(CWD, true, ["src/other.ts"])
		expect(result).toContain("root rule")
		expect(result).not.toContain("api-only rule")
	})

	it("loads all subfolder rules when the caller passes no touchedPaths", async () => {
		const result = await loadRuleFiles(CWD, true)
		expect(result).toContain("api-only rule")
	})
})

describe("on-demand subdirectory AGENTS.md", () => {
	beforeEach(() => {
		files.set("/ws/AGENTS.md", "root agents rules")
		files.set("/ws/packages/api/AGENTS.md", "api agents rules")
	})

	async function build(touchedPaths?: string[]): Promise<string> {
		return addCustomInstructions("", "", CWD, "code", {
			settings: {
				todoListEnabled: true,
				useAgentRules: true,
				enableSubfolderRules: true,
				newTaskRequireTodos: false,
				touchedPaths,
			},
		})
	}

	it("loads a subdirectory AGENTS.md once a file under it is touched", async () => {
		const result = await build(["packages/api/handler.go"])
		expect(result).toContain("root agents rules")
		expect(result).toContain("api agents rules")
	})

	it("does not load a subdirectory AGENTS.md the task has not touched", async () => {
		const result = await build(["src/other.ts"])
		expect(result).toContain("root agents rules")
		expect(result).not.toContain("api agents rules")
	})

	it("loads every discovered AGENTS.md when the caller passes no touchedPaths", async () => {
		const result = await build(undefined)
		expect(result).toContain("root agents rules")
		expect(result).toContain("api agents rules")
	})
})
