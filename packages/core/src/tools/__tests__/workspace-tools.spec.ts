import * as path from "path"

import { CreateDirectoryTool } from "../CreateDirectoryTool.js"
import { CreateNewWorkspaceTool } from "../CreateNewWorkspaceTool.js"
import { GetErrorsTool } from "../GetErrorsTool.js"
import { GiveFeedbackTool } from "../GiveFeedbackTool.js"
import { ListCodeUsagesTool } from "../ListCodeUsagesTool.js"
import { ListFilesTool } from "../ListFilesTool.js"
import { LspSearchTool } from "../LspSearchTool.js"
import { ReadProjectStructureTool } from "../ReadProjectStructureTool.js"
import { RenameSymbolTool } from "../RenameSymbolTool.js"
import { ViewImageTool } from "../ViewImageTool.js"
import {
	installHost,
	makeFakeEditTask,
	makeToolCallbacks,
	makeWorkspace,
	toolResults,
	withWorkspaceRoot,
	type FakeWorkspace,
} from "./helpers/fakeEditTask.js"

/**
 * The workspace-facing tools ported from workspace-tools: directory creation,
 * listing, image reading, and the four that speak to the host's language
 * server (`get_errors`, `list_code_usages`, `lsp_search`, `rename_symbol`).
 *
 * The LSP-backed ones are the interesting half. They reach the host through
 * `getHost().lsp` — the host-agnostic seam `@shofer/core` owns instead of
 * importing `vscode` — so a test installs a bridge whose `lsp` answers, and
 * what is under test is the tool's own formatting, filtering and refusal
 * behaviour rather than VS Code's.
 */

let ws: FakeWorkspace
let restore: Array<() => void>

beforeEach(async () => {
	ws = await makeWorkspace("shofer-workspace-tools-")
	restore = [withWorkspaceRoot(ws.cwd)]
})

afterEach(async () => {
	for (const r of restore.reverse()) r()
	await ws.cleanup()
})

describe("CreateDirectoryTool", () => {
	it("creates the directory and its parents after approval", async () => {
		const task = makeFakeEditTask({ cwd: ws.cwd })
		const cbs = makeToolCallbacks()

		await new CreateDirectoryTool().execute({ path: "a/b/c" }, task, cbs)

		expect(await ws.exists("a/b/c")).toBe(true)
		expect(toolResults(cbs)).toContain("Created directory: a/b/c")
	})

	it("creates nothing when the user rejects", async () => {
		const cbs = makeToolCallbacks(false)
		await new CreateDirectoryTool().execute({ path: "a" }, makeFakeEditTask({ cwd: ws.cwd }), cbs)

		expect(await ws.exists("a")).toBe(false)
		expect(cbs.pushToolResult).not.toHaveBeenCalled()
	})

	it("reports a missing path as a usage mistake", async () => {
		const task = makeFakeEditTask({ cwd: ws.cwd })
		const cbs = makeToolCallbacks()

		await new CreateDirectoryTool().execute({ path: "" }, task, cbs)

		expect(task.consecutiveMistakeCount).toBe(1)
		expect(task.didToolFailInCurrentTurn).toBe(true)
		expect(toolResults(cbs)).toContain("Missing path for create_directory")
	})

	it("routes an mkdir failure through handleError rather than throwing", async () => {
		await ws.write("collide", "i am a file\n")
		const cbs = makeToolCallbacks()

		await new CreateDirectoryTool().execute({ path: "collide/child" }, makeFakeEditTask({ cwd: ws.cwd }), cbs)

		expect(cbs.handleError).toHaveBeenCalledWith("creating directory", expect.any(Error))
	})

	it("only renders a partial row once the streamed path has stabilized", async () => {
		const tool = new CreateDirectoryTool()
		const task = makeFakeEditTask({ cwd: ws.cwd })
		const block = { type: "tool_use", name: "create_directory", params: { path: "a/b" }, partial: true } as any

		await tool.handlePartial(task, block)
		expect(task.ask).not.toHaveBeenCalled()

		await tool.handlePartial(task, block)
		expect(task.ask).toHaveBeenCalledWith("tool", expect.stringContaining("createDirectory"), true)
	})
})

describe("ListFilesTool", () => {
	it("lists the directory's entries", async () => {
		await ws.write("one.ts", "1")
		await ws.write("nested/two.ts", "2")
		const cbs = makeToolCallbacks()

		await new ListFilesTool().execute({ path: "." }, makeFakeEditTask({ cwd: ws.cwd }), cbs)

		const out = toolResults(cbs)
		expect(out).toContain("one.ts")
		expect(out).toContain("nested")
	})

	it("descends below the top level when asked to recurse", async () => {
		await ws.write("nested/deep/three.ts", "3")
		const cbs = makeToolCallbacks()

		await new ListFilesTool().execute({ path: ".", recursive: true }, makeFakeEditTask({ cwd: ws.cwd }), cbs)

		// A non-recursive listing stops at `nested/`; the recursive one reaches
		// the directory beneath it.
		expect(toolResults(cbs)).toContain("nested/deep/")
	})

	it("pushes nothing when the user rejects", async () => {
		await ws.write("one.ts", "1")
		const cbs = makeToolCallbacks(false)

		await new ListFilesTool().execute({ path: "." }, makeFakeEditTask({ cwd: ws.cwd }), cbs)

		expect(cbs.pushToolResult).not.toHaveBeenCalled()
	})

	it("reports a missing path as a usage mistake", async () => {
		const task = makeFakeEditTask({ cwd: ws.cwd })
		const cbs = makeToolCallbacks()

		await new ListFilesTool().execute({ path: "" }, task, cbs)

		expect(task.consecutiveMistakeCount).toBe(1)
		expect(toolResults(cbs)).toContain("Missing path for list_files")
	})
})

describe("ViewImageTool", () => {
	it("returns a multimodal image block for a supported raster format", async () => {
		await ws.write("pic.png", "not really png bytes")
		const cbs = makeToolCallbacks()

		await new ViewImageTool().execute({ path: "pic.png" }, makeFakeEditTask({ cwd: ws.cwd }), cbs)

		const blocks = cbs.pushToolResult.mock.calls[0]![0]
		expect(Array.isArray(blocks)).toBe(true)
		expect(blocks[0]).toEqual({ type: "text", text: "Image file: pic.png" })
		expect(blocks[1].source.media_type).toBe("image/png")
		expect(typeof blocks[1].source.data).toBe("string")
	})

	it("falls back to a base64 data URI for a format with no Anthropic media type", async () => {
		await ws.write("pic.svg", "<svg/>")
		const cbs = makeToolCallbacks()

		await new ViewImageTool().execute({ path: "pic.svg" }, makeFakeEditTask({ cwd: ws.cwd }), cbs)

		expect(toolResults(cbs)).toContain("data:image/svg;base64,")
	})

	it("refuses an unsupported extension without reading the file", async () => {
		const task = makeFakeEditTask({ cwd: ws.cwd })
		const cbs = makeToolCallbacks()

		await new ViewImageTool().execute({ path: "notes.txt" }, task, cbs)

		expect(task.didToolFailInCurrentTurn).toBe(true)
		expect(toolResults(cbs)).toContain("Unsupported image format: .txt")
		expect(cbs.askApproval).not.toHaveBeenCalled()
	})

	it("reports a missing path as a usage mistake", async () => {
		const task = makeFakeEditTask({ cwd: ws.cwd })
		const cbs = makeToolCallbacks()

		await new ViewImageTool().execute({ path: "" }, task, cbs)

		expect(task.consecutiveMistakeCount).toBe(1)
		expect(toolResults(cbs)).toContain("Missing path for view_image")
	})

	it("routes a read failure through handleError", async () => {
		const cbs = makeToolCallbacks()
		await new ViewImageTool().execute({ path: "absent.png" }, makeFakeEditTask({ cwd: ws.cwd }), cbs)

		expect(cbs.handleError).toHaveBeenCalledWith("viewing image", expect.any(Error))
	})
})

describe("GetErrorsTool", () => {
	function withDiagnostics(diagnostics: unknown[]) {
		restore.push(installHost({ lsp: { getDiagnostics: async () => diagnostics } }))
	}

	it("groups errors before warnings and counts both", async () => {
		withDiagnostics([
			{ filePath: path.join(ws.cwd, "b.ts"), line: 2, column: 1, severity: "warning", message: "careful" },
			{
				filePath: path.join(ws.cwd, "a.ts"),
				line: 9,
				column: 3,
				severity: "error",
				message: "boom",
				source: "ts",
			},
			// Neither an error nor a warning: dropped.
			{ filePath: path.join(ws.cwd, "c.ts"), line: 1, column: 1, severity: "hint", message: "fyi" },
		])
		const cbs = makeToolCallbacks()

		await new GetErrorsTool().execute({}, makeFakeEditTask({ cwd: ws.cwd }), cbs)

		const out = toolResults(cbs)
		expect(out).toContain("Found 1 error(s), 1 warning(s)")
		expect(out).toContain("9:3 error: [ts] boom")
		expect(out).not.toContain("fyi")
		expect(out.indexOf("a.ts")).toBeLessThan(out.indexOf("b.ts"))
	})

	it("filters to the requested files", async () => {
		withDiagnostics([
			{ filePath: path.join(ws.cwd, "a.ts"), line: 1, column: 1, severity: "error", message: "mine" },
			{ filePath: path.join(ws.cwd, "b.ts"), line: 1, column: 1, severity: "error", message: "theirs" },
		])
		const cbs = makeToolCallbacks()

		await new GetErrorsTool().execute({ filePaths: ["a.ts"] }, makeFakeEditTask({ cwd: ws.cwd }), cbs)

		expect(toolResults(cbs)).toContain("mine")
		expect(toolResults(cbs)).not.toContain("theirs")
	})

	it("says so when the filtered scope is clean", async () => {
		withDiagnostics([])
		const cbs = makeToolCallbacks()

		await new GetErrorsTool().execute({ filePaths: ["a.ts"] }, makeFakeEditTask({ cwd: ws.cwd }), cbs)

		expect(toolResults(cbs)).toBe("No errors or warnings in specified files")
	})

	it("pushes nothing when the user rejects", async () => {
		withDiagnostics([])
		const cbs = makeToolCallbacks(false)

		await new GetErrorsTool().execute({}, makeFakeEditTask({ cwd: ws.cwd }), cbs)

		expect(cbs.pushToolResult).not.toHaveBeenCalled()
	})

	it("routes an LSP failure through handleError", async () => {
		restore.push(
			installHost({
				lsp: {
					getDiagnostics: async () => {
						throw new Error("no language server")
					},
				},
			}),
		)
		const cbs = makeToolCallbacks()

		await new GetErrorsTool().execute({}, makeFakeEditTask({ cwd: ws.cwd }), cbs)

		expect(cbs.handleError).toHaveBeenCalledWith("getting errors", expect.any(Error))
	})
})

describe("ListCodeUsagesTool", () => {
	it("formats the references the host reports", async () => {
		restore.push(
			installHost({
				lsp: {
					findReferences: async () => ({
						total: 2,
						references: [
							{ filePath: path.join(ws.cwd, "a.ts"), line: 3, column: 5, preview: "const x = 1" },
							{ filePath: path.join(ws.cwd, "b.ts"), line: 9, column: 1, preview: "use(x)" },
						],
					}),
				},
			}),
		)
		const cbs = makeToolCallbacks()

		await new ListCodeUsagesTool().execute(
			{ path: "a.ts", line: 3, column: 5 },
			makeFakeEditTask({ cwd: ws.cwd }),
			cbs,
		)

		const out = toolResults(cbs)
		expect(out).toContain("Found 2 reference(s)")
		expect(out).toContain("a.ts:3:5: const x = 1")
	})

	it("explains a zero-reference answer instead of returning an empty list", async () => {
		restore.push(installHost({ lsp: { findReferences: async () => ({ total: 0, references: [] }) } }))
		const cbs = makeToolCallbacks()

		await new ListCodeUsagesTool().execute(
			{ path: "a.ts", line: 1, column: 1 },
			makeFakeEditTask({ cwd: ws.cwd }),
			cbs,
		)

		expect(toolResults(cbs)).toContain("Ensure the language server is active")
	})

	it.each([
		["path", { path: "", line: 1, column: 1 }],
		["line", { path: "a.ts", line: undefined, column: 1 }],
		["column", { path: "a.ts", line: 1, column: undefined }],
	])("reports a missing %s as a usage mistake", async (param, params) => {
		const task = makeFakeEditTask({ cwd: ws.cwd })
		const cbs = makeToolCallbacks()

		await new ListCodeUsagesTool().execute(params as any, task, cbs)

		expect(task.consecutiveMistakeCount).toBe(1)
		expect(toolResults(cbs)).toContain(`Missing ${param} for list_code_usages`)
	})
})

describe("LspSearchTool", () => {
	it("formats workspace symbols and notes the ones it dropped", async () => {
		const symbols = Array.from({ length: 5 }, (_, i) => ({
			name: `Sym${i}`,
			kind: "class",
			filePath: path.join(ws.cwd, `f${i}.ts`),
			line: i + 1,
		}))
		restore.push(installHost({ lsp: { workspaceSymbols: async () => symbols } }))
		const cbs = makeToolCallbacks()

		await new LspSearchTool().execute({ query: "Sym", maxResults: 2 }, makeFakeEditTask({ cwd: ws.cwd }), cbs)

		const out = toolResults(cbs)
		expect(out).toContain('Symbol search results for "Sym" (2 of 5)')
		expect(out).toContain("Sym0 (class) - f0.ts:1")
		expect(out).toContain("... 3 more symbols")
	})

	it("falls back to a scored text search when the symbol provider finds nothing", async () => {
		await ws.write("src/a.ts", "export const findMe = 1\nconst other = 2\n")
		restore.push(
			installHost({
				lsp: { workspaceSymbols: async () => [] },
				fs: {
					findFiles: async () => [path.join(ws.cwd, "src/a.ts")],
					readFile: async () => "export const findMe = 1\nconst other = 2\n",
				},
			}),
		)
		const cbs = makeToolCallbacks()

		await new LspSearchTool().execute({ query: "findMe" }, makeFakeEditTask({ cwd: ws.cwd }), cbs)

		const out = toolResults(cbs)
		expect(out).toContain("Text fallback search results")
		expect(out).toContain("src/a.ts:1: export const findMe = 1")
	})

	it("falls back again when the symbol provider throws", async () => {
		restore.push(
			installHost({
				lsp: {
					workspaceSymbols: async () => {
						throw new Error("no server")
					},
				},
				fs: { findFiles: async () => [], readFile: async () => "" },
			}),
		)
		const cbs = makeToolCallbacks()

		await new LspSearchTool().execute({ query: "anything" }, makeFakeEditTask({ cwd: ws.cwd }), cbs)

		expect(toolResults(cbs)).toContain("No matches found for: anything")
	})

	it("short-circuits a query with no word long enough to search for", async () => {
		restore.push(installHost({ lsp: { workspaceSymbols: async () => [] } }))
		const cbs = makeToolCallbacks()

		await new LspSearchTool().execute({ query: "a b" }, makeFakeEditTask({ cwd: ws.cwd }), cbs)

		expect(toolResults(cbs)).toBe("No results for: a b")
	})

	it("returns the denial response when the user rejects", async () => {
		const cbs = makeToolCallbacks(false)
		await new LspSearchTool().execute({ query: "Task" }, makeFakeEditTask({ cwd: ws.cwd }), cbs)

		expect(toolResults(cbs)).toContain("denied")
	})

	it("reports a missing query as a usage mistake", async () => {
		const task = makeFakeEditTask({ cwd: ws.cwd })
		const cbs = makeToolCallbacks()

		await new LspSearchTool().execute({ query: "" }, task, cbs)

		expect(task.consecutiveMistakeCount).toBe(1)
		expect(toolResults(cbs)).toContain("Missing query for lsp_search")
	})
})

describe("RenameSymbolTool", () => {
	const edit = (cwd: string) => ({
		changes: [{ filePath: path.join(cwd, "a.ts"), edits: [{ range: {}, newText: "y" }] }],
	})

	it("captures originals, applies the edit and tracks every affected file", async () => {
		await ws.write("a.ts", "const x = 1\n")
		const applyWorkspaceEdit = vi.fn(async () => true)
		restore.push(installHost({ lsp: { computeRename: async () => edit(ws.cwd), applyWorkspaceEdit } }))
		const task = makeFakeEditTask({ cwd: ws.cwd })
		const cbs = makeToolCallbacks()

		await new RenameSymbolTool().execute({ path: "a.ts", line: 1, column: 7, newName: "y" }, task, cbs)

		expect(task.fileContextTracker.captureOriginal).toHaveBeenCalledWith("a.ts", "const x = 1\n")
		expect(applyWorkspaceEdit).toHaveBeenCalled()
		expect(task.fileContextTracker.trackFileContext).toHaveBeenCalledWith("a.ts", "shofer_edited")
		expect(task.didEditFile).toBe(true)
		expect(toolResults(cbs)).toContain('Renamed symbol to "y"')
	})

	it("reports an empty edit as no changes", async () => {
		restore.push(installHost({ lsp: { computeRename: async () => ({ changes: [] }) } }))
		const cbs = makeToolCallbacks()

		await new RenameSymbolTool().execute(
			{ path: "a.ts", line: 1, column: 1, newName: "y" },
			makeFakeEditTask({ cwd: ws.cwd }),
			cbs,
		)

		expect(toolResults(cbs)).toBe("No changes to apply")
	})

	it("surfaces the absence of a rename provider through handleError", async () => {
		restore.push(installHost({ lsp: { computeRename: async () => null } }))
		const cbs = makeToolCallbacks()

		await new RenameSymbolTool().execute(
			{ path: "a.ts", line: 1, column: 1, newName: "y" },
			makeFakeEditTask({ cwd: ws.cwd }),
			cbs,
		)

		expect(cbs.handleError).toHaveBeenCalledWith("renaming symbol", expect.any(Error))
	})

	it("surfaces a failed apply through handleError", async () => {
		await ws.write("a.ts", "const x = 1\n")
		restore.push(
			installHost({ lsp: { computeRename: async () => edit(ws.cwd), applyWorkspaceEdit: async () => false } }),
		)
		const cbs = makeToolCallbacks()

		await new RenameSymbolTool().execute(
			{ path: "a.ts", line: 1, column: 1, newName: "y" },
			makeFakeEditTask({ cwd: ws.cwd }),
			cbs,
		)

		expect(cbs.handleError).toHaveBeenCalledWith("renaming symbol", expect.any(Error))
	})

	it("does nothing when the user rejects", async () => {
		const computeRename = vi.fn()
		restore.push(installHost({ lsp: { computeRename } }))
		const cbs = makeToolCallbacks(false)

		await new RenameSymbolTool().execute(
			{ path: "a.ts", line: 1, column: 1, newName: "y" },
			makeFakeEditTask({ cwd: ws.cwd }),
			cbs,
		)

		expect(computeRename).not.toHaveBeenCalled()
		expect(cbs.pushToolResult).not.toHaveBeenCalled()
	})

	it.each([
		["path", { path: "", line: 1, column: 1, newName: "y" }],
		["line", { path: "a.ts", line: undefined, column: 1, newName: "y" }],
		["column", { path: "a.ts", line: 1, column: undefined, newName: "y" }],
		["newName", { path: "a.ts", line: 1, column: 1, newName: "" }],
	])("reports a missing %s as a usage mistake", async (param, params) => {
		const task = makeFakeEditTask({ cwd: ws.cwd })
		const cbs = makeToolCallbacks()

		await new RenameSymbolTool().execute(params as any, task, cbs)

		expect(task.consecutiveMistakeCount).toBe(1)
		expect(toolResults(cbs)).toContain(`Missing ${param} for rename_symbol`)
	})
})

describe("ReadProjectStructureTool", () => {
	it("renders an ASCII tree, directories first, skipping noise directories", async () => {
		await ws.write("src/index.ts", "1")
		await ws.write("src/lib/util.ts", "2")
		await ws.write("README.md", "3")
		await ws.write("node_modules/pkg/index.js", "4")
		await ws.write(".hidden/secret", "5")
		const cbs = makeToolCallbacks()

		await new ReadProjectStructureTool().execute({}, makeFakeEditTask({ cwd: ws.cwd }), cbs)

		const out = toolResults(cbs)
		expect(out).toContain("src/")
		expect(out).toContain("index.ts")
		expect(out).toContain("README.md")
		expect(out).not.toContain("node_modules")
		expect(out).not.toContain(".hidden")
		// Directories sort before files at each level.
		expect(out.indexOf("src/")).toBeLessThan(out.indexOf("README.md"))
	})

	it("includes hidden entries when asked and stops at the requested depth", async () => {
		await ws.write(".config/deep/deeper/file", "x")
		const cbs = makeToolCallbacks()

		await new ReadProjectStructureTool().execute(
			{ includeHidden: true, maxDepth: 1 },
			makeFakeEditTask({ cwd: ws.cwd }),
			cbs,
		)

		const out = toolResults(cbs)
		expect(out).toContain(".config/")
		expect(out).toContain("deep/")
		expect(out).not.toContain("deeper")
	})

	it("pushes nothing when the user rejects", async () => {
		const cbs = makeToolCallbacks(false)
		await new ReadProjectStructureTool().execute({}, makeFakeEditTask({ cwd: ws.cwd }), cbs)

		expect(cbs.pushToolResult).not.toHaveBeenCalled()
	})
})

describe("CreateNewWorkspaceTool", () => {
	it("creates the root and its subfolders and asks the host to open it", async () => {
		const openFolder = vi.fn(async () => {})
		restore.push(installHost({ workspace: { openFolder, workspaceRoots: () => [ws.cwd] } }))
		const cbs = makeToolCallbacks()

		await new CreateNewWorkspaceTool().execute(
			{ path: ".", name: "proj", folders: ["src", "docs"], openInNewWindow: true },
			makeFakeEditTask({ cwd: ws.cwd }),
			cbs,
		)

		expect(await ws.exists("proj/src")).toBe(true)
		expect(await ws.exists("proj/docs")).toBe(true)
		expect(openFolder).toHaveBeenCalledWith(path.join(ws.cwd, "proj"), { newWindow: true })
		expect(toolResults(cbs)).toContain("Opening in new window")
	})

	it("creates nothing when the user rejects", async () => {
		const cbs = makeToolCallbacks(false)
		await new CreateNewWorkspaceTool().execute({ path: ".", name: "proj" }, makeFakeEditTask({ cwd: ws.cwd }), cbs)

		expect(await ws.exists("proj")).toBe(false)
	})

	it.each([
		["path", { path: "", name: "proj" }],
		["name", { path: ".", name: "" }],
	])("reports a missing %s as a usage mistake", async (param, params) => {
		const task = makeFakeEditTask({ cwd: ws.cwd })
		const cbs = makeToolCallbacks()

		await new CreateNewWorkspaceTool().execute(params as any, task, cbs)

		expect(task.consecutiveMistakeCount).toBe(1)
		expect(toolResults(cbs)).toContain(`Missing ${param} for create_new_workspace`)
	})
})

describe("GiveFeedbackTool", () => {
	it("accepts feedback and thanks the model", async () => {
		const task = makeFakeEditTask({ cwd: ws.cwd })
		const cbs = makeToolCallbacks()

		await new GiveFeedbackTool().execute({ feedback: "the diff view is great" }, task, cbs)

		expect(toolResults(cbs)).toBe("Feedback received. Thank you!")
	})

	it("rejects whitespace-only feedback without counting a mistake", async () => {
		const task = makeFakeEditTask({ cwd: ws.cwd })
		const cbs = makeToolCallbacks()

		await new GiveFeedbackTool().execute({ feedback: "   \n  " }, task, cbs)

		expect(task.didToolFailInCurrentTurn).toBe(true)
		expect(task.consecutiveMistakeCount).toBe(0)
		expect(toolResults(cbs)).toContain("cannot be empty or whitespace only")
	})

	it("reports missing feedback as a usage mistake", async () => {
		const task = makeFakeEditTask({ cwd: ws.cwd })
		const cbs = makeToolCallbacks()

		await new GiveFeedbackTool().execute({ feedback: "" }, task, cbs)

		expect(task.consecutiveMistakeCount).toBe(1)
		expect(toolResults(cbs)).toContain("Missing feedback for give_feedback")
	})

	it("pushes nothing when the user rejects", async () => {
		const cbs = makeToolCallbacks(false)
		await new GiveFeedbackTool().execute({ feedback: "hi" }, makeFakeEditTask({ cwd: ws.cwd }), cbs)

		expect(cbs.pushToolResult).not.toHaveBeenCalled()
	})
})
