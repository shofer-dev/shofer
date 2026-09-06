// npx vitest src/integrations/editor/__tests__/DiffViewProvider.result.test.ts

/**
 * The two halves of the diff view that a TOOL sees rather than a user: the JSON
 * result handed back to the model after a write, and `saveDirectly` — the
 * no-diff-view path taken when focus must not be disrupted.
 *
 * The result payload is a contract with the agent loop and every field in it
 * changes behaviour: the `notice` is what stops the model re-reading the file it
 * just wrote, `user_edits` is what tells it the human changed its work, and
 * `problems` is what makes it fix a lint it caused. A dropped field reads to the
 * model as "none of that happened".
 *
 * `saveDirectly` additionally has to CAPTURE the original bytes itself: it
 * bypasses the diff view, which is where the file-changes baseline normally
 * comes from (File Change Tracking Pattern), so without the capture the panel
 * shows the file with diffing disabled.
 */

const hoisted = vi.hoisted(() => ({
	access: vi.fn(async () => undefined),
	readFile: vi.fn(async () => "original bytes"),
	writeFile: vi.fn(async () => undefined),
	createDirectoriesForFile: vi.fn(async () => [] as string[]),
	getDiagnostics: vi.fn(() => [] as unknown[]),
	diagnosticsToProblemsString: vi.fn(async () => ""),
	getNewDiagnostics: vi.fn(() => [] as unknown[]),
	showTextDocument: vi.fn(async () => undefined),
	openTextDocument: vi.fn(async () => ({ isDirty: false, save: vi.fn(async () => undefined) })),
	captureOriginal: vi.fn(async () => undefined),
	warnings: [] as string[],
}))

vi.mock("delay", () => ({ default: vi.fn(async () => undefined) }))

vi.mock("fs/promises", () => ({
	access: hoisted.access,
	readFile: hoisted.readFile,
	writeFile: hoisted.writeFile,
	unlink: vi.fn(async () => undefined),
	rmdir: vi.fn(async () => undefined),
}))

vi.mock("../../../utils/fs", () => ({ createDirectoriesForFile: hoisted.createDirectoriesForFile }))

vi.mock("vscode", () => ({
	Uri: { file: (p: string) => ({ fsPath: p }) },
	Range: class {
		constructor(
			public start: unknown,
			public end: unknown,
		) {}
	},
	Position: class {},
	WorkspaceEdit: class {
		replace = vi.fn()
	},
	TabInputTextDiff: class {},
	DiagnosticSeverity: { Error: 0, Warning: 1 },
	workspace: {
		openTextDocument: hoisted.openTextDocument,
		onDidOpenTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
		textDocuments: [],
		applyEdit: vi.fn(),
		fs: { stat: vi.fn() },
	},
	window: {
		showTextDocument: hoisted.showTextDocument,
		createTextEditorDecorationType: vi.fn(() => ({ dispose: vi.fn() })),
		onDidChangeVisibleTextEditors: vi.fn(() => ({ dispose: vi.fn() })),
		visibleTextEditors: [],
		tabGroups: { all: [], close: vi.fn() },
	},
	languages: { getDiagnostics: hoisted.getDiagnostics },
	commands: { executeCommand: vi.fn() },
}))

vi.mock("../../diagnostics", () => ({
	diagnosticsToProblemsString: hoisted.diagnosticsToProblemsString,
	getNewDiagnostics: hoisted.getNewDiagnostics,
}))

vi.mock("@shofer/core", async (importOriginal) => ({
	...(await importOriginal<typeof import("@shofer/core")>()),
	getReadablePath: (cwd: string, rel: string) => `${cwd}/${rel}`,
	fsLog: { warn: (m: string) => hoisted.warnings.push(m), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { DiffViewProvider } from "../DiffViewProvider"

function makeTaskHandle(overrides: Record<string, unknown> = {}) {
	return {
		say: vi.fn(async () => undefined),
		fileContextTracker: { captureOriginal: hoisted.captureOriginal },
		providerRef: { deref: () => ({ getState: async () => ({}) }) },
		...overrides,
	} as never
}

function makeProvider(task = makeTaskHandle()) {
	return new DiffViewProvider("/w", task)
}

beforeEach(() => {
	vi.clearAllMocks()
	hoisted.warnings = []
	hoisted.access.mockResolvedValue(undefined)
	hoisted.readFile.mockResolvedValue("original bytes")
	hoisted.diagnosticsToProblemsString.mockResolvedValue("")
	hoisted.getDiagnostics.mockReturnValue([])
})

describe("pushToolWriteResult", () => {
	function withState(provider: DiffViewProvider, state: Record<string, unknown>) {
		Object.assign(provider as unknown as Record<string, unknown>, state)
	}

	it("REFUSES when no file was opened — there is nothing to report on", async () => {
		const provider = makeProvider()

		await expect(provider.pushToolWriteResult(makeTaskHandle(), "/w", true)).rejects.toThrow(
			/No file path available/,
		)
	})

	it("tells the model NOT to re-read the file it just wrote", async () => {
		const provider = makeProvider()
		withState(provider, { relPath: "src/a.ts" })

		const result = JSON.parse(await provider.pushToolWriteResult(makeTaskHandle(), "/w", true))

		expect(result).toMatchObject({ path: "src/a.ts", operation: "created" })
		expect(result.notice).toContain("You do not need to re-read the file")
	})

	it("distinguishes a MODIFIED file from a created one", async () => {
		const provider = makeProvider()
		withState(provider, { relPath: "src/a.ts" })

		const result = JSON.parse(await provider.pushToolWriteResult(makeTaskHandle(), "/w", false))

		expect(result.operation).toBe("modified")
		expect(result.notice).toContain("was modified")
	})

	it("uses a caller-supplied summary and hint in place of the default sentence", async () => {
		const provider = makeProvider()
		withState(provider, { relPath: "src/a.ts" })

		const result = JSON.parse(
			await provider.pushToolWriteResult(makeTaskHandle(), "/w", false, {
				summary: "Applied 3 hunks.",
				hint: "Run the tests.",
			}),
		)

		expect(result.notice).toContain("Applied 3 hunks.")
		expect(result.notice).toContain("Run the tests.")
	})

	it("carries the diff STATS when the caller measured them", async () => {
		const provider = makeProvider()
		withState(provider, { relPath: "src/a.ts" })

		const result = JSON.parse(
			await provider.pushToolWriteResult(makeTaskHandle(), "/w", false, { stats: { added: 3, removed: 1 } }),
		)

		expect(result.diff_stats).toEqual({ added: 3, removed: 1 })
	})

	it("RENDERS the user's own edits in chat and reports them to the model", async () => {
		const provider = makeProvider()
		withState(provider, { relPath: "src/a.ts", userEdits: "@@ -1 +1 @@" })
		const task = makeTaskHandle()

		const result = JSON.parse(await provider.pushToolWriteResult(task, "/w", false))

		expect((task as unknown as { say: ReturnType<typeof vi.fn> }).say).toHaveBeenCalledWith(
			"user_feedback_diff",
			expect.stringContaining("editedExistingFile"),
		)
		expect(result.user_edits).toBe("@@ -1 +1 @@")
		expect(result.notice).toContain("the user's edits")
	})

	it("says NOTHING about user edits when there were none", async () => {
		const provider = makeProvider()
		withState(provider, { relPath: "src/a.ts" })
		const task = makeTaskHandle()

		const result = JSON.parse(await provider.pushToolWriteResult(task, "/w", false))

		expect((task as unknown as { say: ReturnType<typeof vi.fn> }).say).not.toHaveBeenCalled()
		expect(result.user_edits).toBeUndefined()
	})

	it("reports the problems the write introduced", async () => {
		const provider = makeProvider()
		withState(provider, { relPath: "src/a.ts", newProblemsMessage: "a.ts:1 unused variable" })

		const result = JSON.parse(await provider.pushToolWriteResult(makeTaskHandle(), "/w", false))

		expect(result.problems).toBe("a.ts:1 unused variable")
	})
})

describe("saveDirectly", () => {
	it("CAPTURES the original bytes itself — it bypasses the diff view's baseline", async () => {
		const provider = makeProvider()

		await provider.saveDirectly("src/a.ts", "new content")

		expect(hoisted.captureOriginal).toHaveBeenCalledWith("src/a.ts", "original bytes")
	})

	it("captures UNDEFINED for a file that did not exist — a creation has no baseline", async () => {
		hoisted.access.mockRejectedValueOnce(new Error("ENOENT"))
		const provider = makeProvider()

		await provider.saveDirectly("src/new.ts", "content")

		expect(hoisted.captureOriginal).toHaveBeenCalledWith("src/new.ts", undefined)
	})

	it("still WRITES when the capture fails — the baseline is best-effort", async () => {
		hoisted.captureOriginal.mockRejectedValueOnce(new Error("tracker gone"))
		const provider = makeProvider()

		await provider.saveDirectly("src/a.ts", "content")

		expect(hoisted.writeFile).toHaveBeenCalledWith("/w/src/a.ts", "content", "utf-8")
		expect(hoisted.warnings.join(" ")).toContain("captureOriginal failed")
	})

	it("creates the parent directories before writing", async () => {
		const provider = makeProvider()

		await provider.saveDirectly("src/deep/a.ts", "content")

		expect(hoisted.createDirectoriesForFile).toHaveBeenCalledWith("/w/src/deep/a.ts")
	})

	it("SHOWS the document by default, without stealing focus", async () => {
		const provider = makeProvider()

		await provider.saveDirectly("src/a.ts", "content")

		expect(hoisted.showTextDocument).toHaveBeenCalledWith(
			{ fsPath: "/w/src/a.ts" },
			{ preview: false, preserveFocus: true },
		)
	})

	it("opens the document IN MEMORY ONLY when focus must not be disrupted", async () => {
		const provider = makeProvider()

		await provider.saveDirectly("src/a.ts", "content", false)

		expect(hoisted.showTextDocument).not.toHaveBeenCalled()
		expect(hoisted.openTextDocument).toHaveBeenCalled()
	})

	it("saves a dirty in-memory document so the linters actually run", async () => {
		const save = vi.fn(async () => undefined)
		hoisted.openTextDocument.mockResolvedValueOnce({ isDirty: true, save })
		const provider = makeProvider()

		await provider.saveDirectly("src/a.ts", "content", false)

		expect(save).toHaveBeenCalled()
	})

	it("SKIPS the diagnostics pass entirely when the caller disabled it", async () => {
		const provider = makeProvider()

		await provider.saveDirectly("src/a.ts", "content", true, false)

		expect(hoisted.diagnosticsToProblemsString).not.toHaveBeenCalled()
	})

	it("reports the NEW problems the write introduced", async () => {
		hoisted.diagnosticsToProblemsString.mockResolvedValueOnce("a.ts:1 error")
		const provider = makeProvider()

		const result = await provider.saveDirectly("src/a.ts", "content")

		expect(result.newProblemsMessage).toContain("a.ts:1 error")
	})

	it("clamps a NEGATIVE write delay rather than passing it through", async () => {
		const provider = makeProvider()

		await expect(provider.saveDirectly("src/a.ts", "content", true, true, -100)).resolves.toBeDefined()
	})
})

describe("reset", () => {
	it("clears every piece of per-edit state so the next edit starts clean", async () => {
		const provider = makeProvider()
		Object.assign(provider as unknown as Record<string, unknown>, {
			relPath: "src/a.ts",
			originalContent: "old",
			createdDirs: ["/w/src"],
			documentWasOpen: true,
			streamedLines: ["a"],
		})

		await provider.reset()

		const state = provider as unknown as Record<string, unknown>
		expect(state.originalContent).toBeUndefined()
		expect(state.createdDirs).toEqual([])
		expect(state.documentWasOpen).toBe(false)
		expect(state.streamedLines).toEqual([])
	})
})

describe("saveChanges", () => {
	/** A diff editor whose document holds `text`. */
	function withEditor(provider: DiffViewProvider, text: string, extra: Record<string, unknown> = {}) {
		const save = vi.fn(async () => undefined)
		const document = {
			getText: () => text,
			isDirty: false,
			save,
			uri: { fsPath: "/w/src/a.ts" },
			positionAt: (offset: number) => ({ offset }),
			...extra,
		}
		Object.assign(provider as unknown as Record<string, unknown>, {
			relPath: "src/a.ts",
			newContent: "line one\nline two\n",
			activeDiffEditor: { document },
			preDiagnostics: [],
		})
		return { document, save }
	}

	it("REFUSES to report anything when there is no open diff to save", async () => {
		const provider = makeProvider()

		await expect(provider.saveChanges()).resolves.toEqual({
			newProblemsMessage: undefined,
			userEdits: undefined,
			finalContent: undefined,
		})
	})

	it("saves a dirty document first, so the linters see the bytes on disk", async () => {
		const provider = makeProvider()
		const { save } = withEditor(provider, "line one\nline two\n", { isDirty: true })

		await provider.saveChanges()

		expect(save).toHaveBeenCalled()
	})

	it("reports NO user edits when the document matches what the agent wrote", async () => {
		const provider = makeProvider()
		withEditor(provider, "line one\nline two\n")

		const result = await provider.saveChanges()

		expect(result.userEdits).toBeUndefined()
		expect(result.finalContent).toBe("line one\nline two\n")
	})

	it("produces a PATCH when the user changed the agent's work before approving", async () => {
		const provider = makeProvider()
		withEditor(provider, "line one\nline two EDITED\n")

		const result = await provider.saveChanges()

		expect(result.userEdits).toContain("EDITED")
		expect(result.finalContent).toBe("line one\nline two EDITED\n")
	})

	it("normalizes line endings before comparing — a CRLF document is not a user edit", async () => {
		const provider = makeProvider()
		withEditor(provider, "line one\r\nline two\r\n")

		const result = await provider.saveChanges()

		// Otherwise every save on Windows reports the whole file as edited.
		expect(result.userEdits).toBeUndefined()
	})

	it("SKIPS the diagnostics pass entirely when the caller disabled it", async () => {
		const provider = makeProvider()
		withEditor(provider, "line one\nline two\n")

		const result = await provider.saveChanges(false)

		expect(hoisted.diagnosticsToProblemsString).not.toHaveBeenCalled()
		expect(result.newProblemsMessage).toBe("")
	})

	it("reports the NEW problems the edit introduced", async () => {
		hoisted.diagnosticsToProblemsString.mockResolvedValueOnce("a.ts:1 unused import")
		const provider = makeProvider()
		withEditor(provider, "line one\nline two\n")

		const result = await provider.saveChanges()

		expect(result.newProblemsMessage).toContain("a.ts:1 unused import")
	})

	it("still saves when the write delay itself fails", async () => {
		const delayModule = (await import("delay")).default as unknown as ReturnType<typeof vi.fn>
		vi.mocked(delayModule).mockRejectedValueOnce(new Error("timer gone"))
		const provider = makeProvider()
		withEditor(provider, "line one\nline two\n")

		await expect(provider.saveChanges()).resolves.toBeDefined()
		expect(hoisted.warnings.join(" ")).toContain("Failed to apply write delay")
	})

	it("clamps a NEGATIVE write delay", async () => {
		const provider = makeProvider()
		withEditor(provider, "line one\nline two\n")

		await expect(provider.saveChanges(true, -500)).resolves.toBeDefined()
	})
})

describe("revertChanges", () => {
	function withEditor(provider: DiffViewProvider, extra: Record<string, unknown> = {}) {
		const save = vi.fn(async () => undefined)
		const document = {
			getText: () => "agent wrote this",
			isDirty: false,
			save,
			uri: { fsPath: "/w/src/a.ts" },
			positionAt: (offset: number) => ({ offset }),
		}
		Object.assign(provider as unknown as Record<string, unknown>, {
			relPath: "src/a.ts",
			activeDiffEditor: { document },
			...extra,
		})
		return { document, save }
	}

	it("is a no-op with nothing open", async () => {
		const provider = makeProvider()

		await expect(provider.revertChanges()).resolves.toBeUndefined()
	})

	it("DELETES a file it created, and the directories it created for it", async () => {
		const provider = makeProvider()
		const fsPromises = await import("fs/promises")
		withEditor(provider, { editType: "create", createdDirs: ["/w/src", "/w/src/deep"] })

		await provider.revertChanges()

		expect(vi.mocked(fsPromises.unlink)).toHaveBeenCalledWith("/w/src/a.ts")
		// Innermost first: rmdir refuses a directory that still has children.
		expect(vi.mocked(fsPromises.rmdir).mock.calls.map(([d]) => d)).toEqual(["/w/src/deep", "/w/src"])
	})

	it("RESTORES the original bytes for a file it merely modified", async () => {
		const provider = makeProvider()
		const vscodeModule = await import("vscode")
		const { save } = withEditor(provider, { editType: "modify", originalContent: "the original" })

		await provider.revertChanges()

		expect(vi.mocked(vscodeModule.workspace.applyEdit)).toHaveBeenCalled()
		// Saving is what keeps the revert out of the user's local history.
		expect(save).toHaveBeenCalled()
	})

	it("re-opens the document only if it was open before the edit", async () => {
		const provider = makeProvider()
		withEditor(provider, { editType: "modify", originalContent: "x", documentWasOpen: true })

		await provider.revertChanges()

		expect(hoisted.showTextDocument).toHaveBeenCalledWith(
			{ fsPath: "/w/src/a.ts" },
			{ preview: false, preserveFocus: true },
		)
	})

	it("leaves the provider RESET so the next edit starts clean", async () => {
		const provider = makeProvider()
		withEditor(provider, { editType: "modify", originalContent: "x", createdDirs: ["/w/src"] })

		await provider.revertChanges()

		const state = provider as unknown as Record<string, unknown>
		// `reset()` clears the per-edit state; `relPath` is deliberately kept so
		// a caller can still report which file the reverted edit was on.
		expect(state.originalContent).toBeUndefined()
		expect(state.createdDirs).toEqual([])
	})
})
