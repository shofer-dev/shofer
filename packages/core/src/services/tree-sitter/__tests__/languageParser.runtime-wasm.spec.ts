// npx vitest services/tree-sitter/__tests__/languageParser.runtime-wasm.spec.ts

import * as fs from "fs"
import * as os from "os"
import * as path from "path"

/**
 * Where `Parser.init` looks for the tree-sitter RUNTIME wasm.
 *
 * Two different files are in play and conflating them has broken things in both
 * directions. `tree-sitter-<lang>.wasm` are the grammars, loaded explicitly from the
 * `sourceDirectory` a caller passes. `tree-sitter.wasm` is the runtime, resolved by the
 * Emscripten glue beside whatever bundle it was compiled into unless `locateFile`
 * overrides it — fine for the extension host, wrong for the bundled `rag-indexing`
 * plugin, which runs from `dist/plugins/rag-indexing/` and borrows the host's assets.
 *
 * So the override follows the runtime wasm, not the grammars: `tree-sitter-wasms/out/`
 * holds grammars and no runtime, and pointing the glue there would send it after a file
 * that package never shipped.
 */

const initCalls: unknown[] = []

vi.mock("web-tree-sitter", () => ({
	Parser: Object.assign(
		class {
			setLanguage() {}
		},
		{
			init: (options?: unknown) => {
				initCalls.push(options)
				return Promise.resolve()
			},
		},
	),
	Language: { load: () => Promise.resolve({}) },
	Query: class {},
}))

const tempDir = (contents: string[]) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ts-runtime-wasm-"))
	for (const name of contents) fs.writeFileSync(path.join(dir, name), "")
	return dir
}

describe("Parser.init runtime wasm location", () => {
	beforeEach(() => {
		initCalls.length = 0
		vi.resetModules() // `isParserInitialized` is module state; each case needs a fresh copy
	})

	it("points the glue at sourceDirectory when the runtime wasm is there", async () => {
		const dir = tempDir(["tree-sitter.wasm", "tree-sitter-python.wasm"])
		const { loadRequiredLanguageParsers } = await import("../languageParser.js")

		await loadRequiredLanguageParsers(["a.py"], dir)

		expect(initCalls).toHaveLength(1)
		const locateFile = (initCalls[0] as { locateFile: (name: string) => string }).locateFile
		expect(locateFile("tree-sitter.wasm")).toBe(path.join(dir, "tree-sitter.wasm"))
	})

	it("leaves default resolution alone when sourceDirectory holds grammars only", async () => {
		const dir = tempDir(["tree-sitter-python.wasm"])
		const { loadRequiredLanguageParsers } = await import("../languageParser.js")

		await loadRequiredLanguageParsers(["a.py"], dir)

		expect(initCalls).toEqual([undefined])
	})

	it("leaves default resolution alone when no sourceDirectory is given", async () => {
		const { loadRequiredLanguageParsers } = await import("../languageParser.js")

		await loadRequiredLanguageParsers(["a.py"])

		expect(initCalls).toEqual([undefined])
	})
})
