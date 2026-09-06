const loadedGrammars: string[] = []
const builtQueries: Array<{ grammar: string; source: string }> = []
const initCalls: Array<unknown> = []
let loadFails: string | undefined
let initFails = false

vi.mock("web-tree-sitter", () => {
	class Language {
		constructor(public readonly name: string) {}
		static async load(wasmPath: string) {
			const name = /tree-sitter-(.+)\.wasm$/.exec(wasmPath)?.[1] ?? wasmPath
			if (loadFails === name) throw new Error(`no wasm for ${name}`)
			loadedGrammars.push(name)
			return new Language(name)
		}
	}
	class Query {
		constructor(language: Language, source: string) {
			builtQueries.push({ grammar: language.name, source })
		}
	}
	class Parser {
		language: unknown
		static async init(options?: unknown) {
			initCalls.push(options)
			if (initFails) throw new Error("wasm runtime unavailable")
		}
		setLanguage(language: unknown) {
			this.language = language
		}
	}
	return { Parser, Query, Language }
})

import * as fs from "fs"

import { CODEBASE_INDEX_FILE_EXTENSIONS } from "@shofer/types"

import { loadRequiredLanguageParsers } from "../languageParser.js"
import { javascriptQuery, htmlQuery, embeddedTemplateQuery } from "../queries/index.js"

/**
 * The extension → GRAMMAR mapping, exercised without any real wasm.
 *
 * The **Tree-Sitter Language Registration Rule** is what this file pins: an
 * extension listed in `CODEBASE_INDEX_FILE_EXTENSIONS` with no `case` here
 * does not fail at build time — it throws `Unsupported language: <ext>` at
 * parse time, which silently drops the file from the RAG index and crashes
 * `list_code_definition_names`. So the two lists are compared directly rather
 * than sampled: adding an extension to the types package and forgetting the
 * parser case fails HERE, at the seam, instead of in a user's index.
 *
 * The grammar loader is mocked at `web-tree-sitter` because the real one reads
 * a ~2 MB wasm per language; what is under test is the routing, and the
 * grammars themselves are covered by the per-language `inspect*` suites.
 */

beforeEach(() => {
	loadedGrammars.length = 0
	builtQueries.length = 0
	initCalls.length = 0
	loadFails = undefined
	initFails = false
})

/** The extensions the parser switch is expected to answer for. */
const MAPPING: Array<[extension: string, grammar: string]> = [
	["js", "javascript"],
	["jsx", "javascript"],
	["json", "javascript"],
	["ts", "typescript"],
	["tsx", "tsx"],
	["py", "python"],
	["rs", "rust"],
	["go", "go"],
	["cpp", "cpp"],
	["hpp", "cpp"],
	["c", "c"],
	["h", "c"],
	["cs", "c_sharp"],
	["rb", "ruby"],
	["java", "java"],
	["php", "php"],
	["swift", "swift"],
	["kt", "kotlin"],
	["kts", "kotlin"],
	["css", "css"],
	["html", "html"],
	["htm", "html"],
	["ml", "ocaml"],
	["mli", "ocaml"],
	["scala", "scala"],
	["sol", "solidity"],
	["toml", "toml"],
	["vue", "vue"],
	["lua", "lua"],
	["rdl", "systemrdl"],
	["tla", "tlaplus"],
	["zig", "zig"],
	["ejs", "embedded_template"],
	["erb", "embedded_template"],
	["el", "elisp"],
	["ex", "elixir"],
	["exs", "elixir"],
]

describe("extension → grammar", () => {
	it.each(MAPPING)("routes .%s to the %s grammar", async (ext, grammar) => {
		await loadRequiredLanguageParsers([`/ws/file.${ext}`])

		expect(loadedGrammars).toEqual([grammar])
		expect(builtQueries).toHaveLength(1)
		expect(builtQueries[0]!.grammar).toBe(grammar)
	})

	it("covers every extension the indexer declares, bar the four that parse elsewhere", async () => {
		// The rule this file exists for: the two lists must not drift. The
		// exemptions are named rather than tolerated as a count —
		//  - `md`/`markdown` are chunked by `markdownParser`, which is a
		//    heading walk rather than a grammar, and never reaches this switch;
		//  - `elm`/`vb` are in the indexer's `fallbackExtensions`, meaning no
		//    tree-sitter grammar exists for them and length-based chunking is
		//    used instead.
		// Anything ELSE the indexer declares and this switch refuses is the
		// silent-drop bug: no build error, no log, just a file missing from the
		// index and a crash in `list_code_definition_names`.
		const PARSED_ELSEWHERE = new Set(["md", "markdown", "elm", "vb"])
		const routed = new Set(MAPPING.map(([ext]) => ext))
		const declared = CODEBASE_INDEX_FILE_EXTENSIONS.map((e) => e.replace(/^\./, ""))
		const unrouted: string[] = []

		for (const ext of declared) {
			if (routed.has(ext) || PARSED_ELSEWHERE.has(ext)) continue
			await loadRequiredLanguageParsers([`/ws/file.${ext}`]).catch(() => unrouted.push(ext))
		}

		expect(unrouted).toEqual([])
		// And the exemptions are exemptions, not stale entries: each is still
		// declared by the indexer.
		expect(declared).toEqual(expect.arrayContaining([...PARSED_ELSEWHERE]))
	})

	it("is case-insensitive about the extension", async () => {
		await loadRequiredLanguageParsers(["/ws/Component.TSX"])

		expect(loadedGrammars).toEqual(["tsx"])
	})

	it("refuses an extension it has no grammar for, naming it", async () => {
		await expect(loadRequiredLanguageParsers(["/ws/notes.xyz"])).rejects.toThrow("Unsupported language: xyz")
	})
})

describe("the returned parser table", () => {
	it("is keyed by extension, so a caller can look one up by the file it holds", async () => {
		const parsers = await loadRequiredLanguageParsers(["/ws/a.ts", "/ws/b.py"])

		expect(Object.keys(parsers).sort()).toEqual(["py", "ts"])
		expect(parsers.ts!.parser).toBeDefined()
		expect(parsers.ts!.query).toBeDefined()
	})

	it("loads each grammar ONCE for a batch of files sharing an extension", async () => {
		// The whole reason the loader takes a batch rather than a file.
		await loadRequiredLanguageParsers(["/ws/a.ts", "/ws/b.ts", "/ws/c.ts"])

		expect(loadedGrammars).toEqual(["typescript"])
	})

	it("collapses .html and .htm onto ONE entry", async () => {
		const parsers = await loadRequiredLanguageParsers(["/ws/a.html", "/ws/b.htm"])

		// Two grammar loads, one key: the second overwrites rather than
		// doubling the table a caller iterates.
		expect(Object.keys(parsers)).toEqual(["html"])
		expect(builtQueries.every((q) => q.source === htmlQuery)).toBe(true)
	})

	it("collapses .ejs and .erb onto ONE embedded_template entry", async () => {
		const parsers = await loadRequiredLanguageParsers(["/ws/a.ejs", "/ws/b.erb"])

		expect(Object.keys(parsers)).toEqual(["embedded_template"])
		expect(builtQueries.every((q) => q.source === embeddedTemplateQuery)).toBe(true)
	})

	it("keeps .js, .jsx and .json apart even though they share a grammar", async () => {
		// One grammar, three keys — the query is the same, the caller's lookup
		// is by extension, and conflating them would lose two of the three.
		const parsers = await loadRequiredLanguageParsers(["/ws/a.js", "/ws/b.jsx", "/ws/c.json"])

		expect(Object.keys(parsers).sort()).toEqual(["js", "json", "jsx"])
		expect(builtQueries.map((q) => q.source)).toEqual([javascriptQuery, javascriptQuery, javascriptQuery])
	})

	it("returns an empty table for no files at all", async () => {
		expect(await loadRequiredLanguageParsers([])).toEqual({})
		expect(loadedGrammars).toEqual([])
	})
})

describe("where the wasm is looked for", () => {
	it("loads each grammar from the supplied source directory", async () => {
		// A directory holding grammars but no runtime wasm — the ordinary case
		// for `tree-sitter-wasms/out/`.
		expect(fs.existsSync("/opt/grammars/tree-sitter.wasm")).toBe(false)

		await loadRequiredLanguageParsers(["/ws/a.go"], "/opt/grammars")

		expect(loadedGrammars).toEqual(["go"])
	})

	it("propagates a grammar that will not load, after logging it", async () => {
		loadFails = "rust"

		await expect(loadRequiredLanguageParsers(["/ws/a.rs"])).rejects.toThrow("no wasm for rust")
	})
})

describe("runtime initialization", () => {
	it("initializes the tree-sitter runtime ONCE across calls", async () => {
		await loadRequiredLanguageParsers(["/ws/a.go"])
		await loadRequiredLanguageParsers(["/ws/b.go"])

		expect(initCalls).toHaveLength(0)
	})

	it("points the runtime at the source directory only when the runtime wasm is THERE", async () => {
		// `sourceDirectory` says where the GRAMMARS are, which is not always
		// where `tree-sitter.wasm` lives — `tree-sitter-wasms/out/` holds
		// grammars only, so an unconditional override sends the Emscripten glue
		// after a file that package never shipped.
		vi.resetModules()
		const existsSync = vi.fn((p: unknown) => String(p).endsWith("tree-sitter.wasm"))
		vi.doMock("fs", () => ({ existsSync, default: { existsSync } }))

		const { loadRequiredLanguageParsers: fresh } = await import("../languageParser.js")
		await fresh(["/ws/a.go"], "/opt/runtime")

		expect(initCalls).toHaveLength(1)
		expect(initCalls[0]).toMatchObject({ locateFile: expect.any(Function) })
		const located = (initCalls[0] as { locateFile: (n: string) => string }).locateFile("tree-sitter.wasm")
		expect(located).toBe("/opt/runtime/tree-sitter.wasm")

		vi.doUnmock("fs")
		vi.resetModules()
	})

	it("propagates a runtime that will not start", async () => {
		vi.resetModules()
		initFails = true

		const { loadRequiredLanguageParsers: fresh } = await import("../languageParser.js")

		await expect(fresh(["/ws/a.go"])).rejects.toThrow("wasm runtime unavailable")
		vi.resetModules()
	})
})
