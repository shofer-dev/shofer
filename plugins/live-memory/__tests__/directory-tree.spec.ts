import { describe, it, expect } from "vitest"

import { LiveMemoryDirectoryTree, SKIP_PARTS } from "../directory-tree.js"
import type { FindFilesOptions, HostFileSystem } from "@shofer/types"

/** Convert a simplified glob (`**`, `*`, `/`) to an anchored RegExp. */
function globToRegExp(pattern: string): RegExp {
	let re = ""
	for (let i = 0; i < pattern.length; i++) {
		const c = pattern[i]!
		if (c === "*") {
			if (pattern[i + 1] === "*") {
				if (pattern[i + 2] === "/") {
					re += "(?:.*/)?"
					i += 2
				} else {
					re += ".*"
					i += 1
				}
			} else {
				re += "[^/]*"
			}
		} else if ("\\^$+?.()|[]{}".includes(c)) {
			re += "\\" + c
		} else {
			re += c
		}
	}
	return new RegExp(`^${re}$`)
}

function makeFs(paths: string[]): HostFileSystem {
	const set = new Set(paths)
	return {
		async readFile() {
			return ""
		},
		async writeFile() {},
		async exists(p) {
			return set.has(p)
		},
		async mkdir() {},
		async delete() {},
		async findFiles(pattern: string, opts: FindFilesOptions) {
			const re = globToRegExp(pattern)
			const excludes = (opts.exclude ?? []).map(globToRegExp)
			const out: string[] = []
			for (const abs of set) {
				if (!abs.startsWith(opts.cwd + "/")) continue
				const rel = abs.slice(opts.cwd.length + 1)
				if (!re.test(rel)) continue
				if (excludes.some((ex) => ex.test(rel))) continue
				out.push(abs)
				if (opts.maxResults && out.length >= opts.maxResults) break
			}
			return out
		},
	}
}

const PATHS = [
	"/ws/package.json",
	"/ws/src/a.ts",
	"/ws/src/sub/b.ts",
	"/ws/node_modules/dep/index.js",
	"/ws/dist/out.js",
	"/ws/.hidden/secret.txt",
]

describe("LiveMemoryDirectoryTree (plugin port)", () => {
	it("renders a nested tree, dirs first, files nested under them", async () => {
		const tree = new LiveMemoryDirectoryTree("/ws", 100_000, makeFs(PATHS))
		const out = await tree.generate()
		expect(out).toContain("src/")
		expect(out).toContain("sub/")
		expect(out).toContain("a.ts")
		expect(out).toContain("b.ts")
		expect(out).toContain("package.json")
		// Directory listed before the root-level file (dirs-first sort).
		expect(out.indexOf("src/")).toBeLessThan(out.indexOf("package.json"))
		// Uses box-drawing connectors like the built-in.
		expect(out).toMatch(/[├└]── /)
	})

	it("prunes SKIP_PARTS directories and hidden entries", async () => {
		const tree = new LiveMemoryDirectoryTree("/ws", 100_000, makeFs(PATHS))
		const out = await tree.generate()
		expect(out).not.toContain("node_modules")
		expect(out).not.toContain("dist")
		expect(out).not.toContain(".hidden")
		expect(out).not.toContain("secret")
		// SKIP_PARTS is the documented set the built-in also prunes.
		expect(SKIP_PARTS.has("node_modules")).toBe(true)
		expect(SKIP_PARTS.has(".turbo")).toBe(true)
	})

	it("truncates when the tree exceeds ~10% of the context budget", async () => {
		// maxTreeTokens = floor(40 * 0.1) = 4 tokens (~16 chars) — far smaller than the tree.
		const tree = new LiveMemoryDirectoryTree("/ws", 40, makeFs(PATHS))
		const out = await tree.generate()
		expect(out).toMatch(/\.\.\. \(truncated \d+ entries\)/)
	})
})
