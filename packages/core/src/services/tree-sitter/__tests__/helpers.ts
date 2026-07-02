import { parseSourceCodeDefinitionsForFile, setMinComponentLines } from "../index.js"
import * as fs from "fs/promises"
import * as path from "path"
import { createRequire } from "module"
import tsxQuery from "../queries/tsx.js"
import { Parser, Language } from "web-tree-sitter"

// Resolve WASM assets straight from the installed packages (cwd/location
// independent), rather than a build-time `dist/` copy. Language grammars live
// in `tree-sitter-wasms/out`; the base runtime wasm ships in `web-tree-sitter`.
const require = createRequire(import.meta.url)
const LANG_WASM_DIR = path.dirname(require.resolve("tree-sitter-wasms/out/tree-sitter-typescript.wasm"))
const BASE_WASM_DIR = path.dirname(require.resolve("web-tree-sitter"))
const resolveWasm = (filename: string): string =>
	filename === "tree-sitter.wasm" ? path.join(BASE_WASM_DIR, filename) : path.join(LANG_WASM_DIR, filename)

vi.mock("fs/promises")
export const mockedFs = vi.mocked(fs)

vi.mock("../../../fs/fs.js", () => ({
	fileExistsAtPath: vi.fn().mockImplementation(() => Promise.resolve(true)),
}))

vi.mock("../languageParser.js", () => ({
	loadRequiredLanguageParsers: vi.fn(),
}))

// Global debug flag - read from environment variable or default to 0
export const DEBUG = process.env.DEBUG ? parseInt(process.env.DEBUG, 10) : 0

// Debug function to conditionally log messages
export const debugLog = (message: string, ...args: any[]) => {
	if (DEBUG) {
		console.debug(message, ...args)
	}
}

// Store the initialized TreeSitter for reuse
let initializedTreeSitter: { Parser: typeof Parser; Language: typeof Language } | null = null

// Function to initialize tree-sitter
export async function initializeTreeSitter() {
	if (!initializedTreeSitter) {
		// Initialize directly using the default export or the module itself
		await Parser.init()

		// Override the Parser.Language.load to use dist directory
		const originalLoad = Language.load

		Language.load = async (wasmPath: string) => {
			const filename = path.basename(wasmPath)
			const correctPath = resolveWasm(filename)
			// console.log(`Redirecting WASM load from ${wasmPath} to ${correctPath}`)
			return originalLoad(correctPath)
		}

		initializedTreeSitter = { Parser, Language }
	}

	return initializedTreeSitter
}

// Test helper for parsing source code definitions
export async function testParseSourceCodeDefinitions(
	testFilePath: string,
	content: string,
	options: {
		language?: string
		wasmFile?: string
		queryString?: string
		extKey?: string
	} = {},
): Promise<string | undefined> {
	// Set minimum component lines to 0 for tests
	setMinComponentLines(0)

	// Set default options
	const wasmFile = options.wasmFile || "tree-sitter-tsx.wasm"
	const queryString = options.queryString || tsxQuery
	const extKey = options.extKey || "tsx"

	// Clear any previous mocks and set up fs mock
	vi.clearAllMocks()
	vi.mock("fs/promises")
	const mockedFs = (await vi.importActual("fs/promises")) as typeof import("fs/promises")
	;(fs.readFile as any).mockResolvedValue(content)

	// Get the mock function
	const { loadRequiredLanguageParsers } = await import("../languageParser.js")
	const mockedLoadRequiredLanguageParsers = loadRequiredLanguageParsers as any

	// Initialize TreeSitter and create a real parser
	const { Parser, Language } = await initializeTreeSitter()
	const parser = new Parser()

	// Load language and configure parser
	const wasmPath = resolveWasm(wasmFile)
	const lang = await Language.load(wasmPath)
	parser.setLanguage(lang)

	// Create a real query
	const query = lang.query(queryString)

	// Set up our language parser with real parser and query
	const mockLanguageParser: any = {}
	mockLanguageParser[extKey] = { parser, query }

	// Configure the mock to return our parser
	mockedLoadRequiredLanguageParsers.mockResolvedValue(mockLanguageParser)

	// Call the function under test
	const result = await parseSourceCodeDefinitionsForFile(testFilePath)

	// Verify loadRequiredLanguageParsers was called with the expected file path
	expect(mockedLoadRequiredLanguageParsers).toHaveBeenCalledWith([testFilePath])
	expect(mockedLoadRequiredLanguageParsers).toHaveBeenCalled()

	debugLog(`Result:\n${result}`)
	return result
}

// Helper function to inspect tree structure
export async function inspectTreeStructure(content: string, language: string = "typescript"): Promise<string> {
	const { Parser, Language } = await initializeTreeSitter()
	const parser = new Parser()
	const wasmPath = resolveWasm(`tree-sitter-${language}.wasm`)
	const lang = await Language.load(wasmPath)
	parser.setLanguage(lang)

	// Parse the content
	const tree = parser.parse(content)

	// Print the tree structure
	debugLog(`TREE STRUCTURE (${language}):\n${tree?.rootNode.toString()}`)
	return tree?.rootNode.toString() || ""
}
