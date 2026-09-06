// npx vitest src/utils/__tests__/export.test.ts

/**
 * `resolveDefaultSaveUri` is the save-dialog's starting directory, and its whole
 * behaviour is a priority ladder — last-used, then workspace, then a supplied
 * fallback, then the bare filename. The rungs matter because each one is what a
 * user experiences as "it remembered where I put the last one": skipping the
 * last-used rung sends every export back to the workspace root.
 */

vi.mock("vscode", () => ({
	Uri: { file: (p: string) => ({ fsPath: p, path: p, scheme: "file" }) },
	workspace: { workspaceFolders: undefined as unknown },
}))

import * as path from "path"

import * as vscode from "vscode"

import { resolveDefaultSaveUri, saveLastExportPath, type ExportContext } from "../export"

function makeContext(stored?: string): ExportContext & { written: Record<string, unknown> } {
	const written: Record<string, unknown> = {}
	return {
		written,
		getValue: (key: string) => (key === "lastExport" ? stored : undefined),
		setValue: async (key: string, value: unknown) => {
			written[key] = value
		},
	}
}

function setWorkspaceFolders(folders: Array<{ uri: { fsPath: string } }> | undefined) {
	;(vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = folders
}

afterEach(() => setWorkspaceFolders(undefined))

describe("resolveDefaultSaveUri", () => {
	it("prefers the DIRECTORY of the last export, with the new file name", () => {
		const uri = resolveDefaultSaveUri(makeContext("/home/u/exports/old-task.md"), "lastExport", "new-task.md")
		expect(uri.fsPath).toBe(path.join("/home/u/exports", "new-task.md"))
	})

	it("beats the workspace folder — remembering where the user put the last one is the point", () => {
		setWorkspaceFolders([{ uri: { fsPath: "/workspace" } }])
		const uri = resolveDefaultSaveUri(makeContext("/home/u/exports/old.md"), "lastExport", "new.md")
		expect(uri.fsPath).toBe(path.join("/home/u/exports", "new.md"))
	})

	it("falls back to the FIRST workspace folder when nothing was exported yet", () => {
		setWorkspaceFolders([{ uri: { fsPath: "/workspace" } }, { uri: { fsPath: "/other" } }])
		const uri = resolveDefaultSaveUri(makeContext(), "lastExport", "task.md")
		expect(uri.fsPath).toBe(path.join("/workspace", "task.md"))
	})

	it("skips the workspace entirely when the caller says useWorkspace: false", () => {
		setWorkspaceFolders([{ uri: { fsPath: "/workspace" } }])
		const uri = resolveDefaultSaveUri(makeContext(), "lastExport", "task.md", {
			useWorkspace: false,
			fallbackDir: "/home/u/Downloads",
		})
		expect(uri.fsPath).toBe(path.join("/home/u/Downloads", "task.md"))
	})

	it("uses the fallback directory when there is no workspace", () => {
		const uri = resolveDefaultSaveUri(makeContext(), "lastExport", "task.md", { fallbackDir: "/home/u/Documents" })
		expect(uri.fsPath).toBe(path.join("/home/u/Documents", "task.md"))
	})

	it("an EMPTY workspace-folders array is treated as no workspace, not as folder zero", () => {
		setWorkspaceFolders([])
		const uri = resolveDefaultSaveUri(makeContext(), "lastExport", "task.md", { fallbackDir: "/fallback" })
		expect(uri.fsPath).toBe(path.join("/fallback", "task.md"))
	})

	it("degrades to the bare file name when every rung is empty", () => {
		expect(resolveDefaultSaveUri(makeContext(), "lastExport", "task.md").fsPath).toBe("task.md")
	})
})

describe("saveLastExportPath", () => {
	it("records the full fsPath, so the next export can take its directory", async () => {
		const context = makeContext()
		await saveLastExportPath(context, "lastExport", vscode.Uri.file("/home/u/exports/task.md"))
		expect(context.written.lastExport).toBe("/home/u/exports/task.md")
	})
})
