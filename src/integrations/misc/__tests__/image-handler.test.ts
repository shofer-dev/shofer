// npx vitest src/integrations/misc/__tests__/image-handler.test.ts

/**
 * `openImage`/`saveImage` back the chat's image affordances. Both take a value
 * that may be a workspace-relative path, an absolute path or a base64 data URI,
 * and both have a "copy" variant; the branch that decides which is a string
 * prefix test, so the tests here pin each prefix to the path it takes — and pin
 * that every failure surfaces through the host notifier rather than throwing
 * into the message handler.
 */

const hoisted = vi.hoisted(() => ({
	notifier: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
	workspacePath: "/workspace" as string | undefined,
	executeCommand: vi.fn(async () => undefined),
	writeText: vi.fn(async () => undefined),
	fsWriteFile: vi.fn(async (..._args: unknown[]): Promise<void> => undefined),
	fsReadFile: vi.fn(async () => new Uint8Array([1, 2, 3])),
	fsDelete: vi.fn(async () => undefined),
	showSaveDialog: vi.fn(),
}))

vi.mock("vscode", () => ({
	Uri: { file: (p: string) => ({ fsPath: p, path: p, scheme: "file" }) },
	env: { clipboard: { writeText: hoisted.writeText } },
	commands: { executeCommand: hoisted.executeCommand },
	window: { showSaveDialog: hoisted.showSaveDialog },
	workspace: {
		fs: { writeFile: hoisted.fsWriteFile, readFile: hoisted.fsReadFile, delete: hoisted.fsDelete },
	},
}))

vi.mock("@shofer/types", async (importOriginal) => ({
	...(await importOriginal<typeof import("@shofer/types")>()),
	getHost: () => ({ notifier: hoisted.notifier }),
}))

vi.mock("@shofer/core", async (importOriginal) => ({
	...(await importOriginal<typeof import("@shofer/core")>()),
	getWorkspacePath: () => hoisted.workspacePath,
}))

import * as path from "path"

import { openImage, saveImage } from "../image-handler"

const PNG_URI = `data:image/png;base64,${Buffer.from("png-bytes").toString("base64")}`

beforeEach(() => {
	vi.clearAllMocks()
	hoisted.workspacePath = "/workspace"
	hoisted.fsReadFile.mockResolvedValue(new Uint8Array([1, 2, 3]))
})

describe("openImage — file paths", () => {
	it("opens an ABSOLUTE path with the editor's own open command", async () => {
		await openImage("/tmp/shot.png")

		expect(hoisted.executeCommand).toHaveBeenCalledWith(
			"vscode.open",
			expect.objectContaining({ fsPath: "/tmp/shot.png" }),
		)
	})

	it("resolves a RELATIVE path against the workspace", async () => {
		await openImage("docs/shot.png")

		expect(hoisted.executeCommand).toHaveBeenCalledWith(
			"vscode.open",
			expect.objectContaining({ fsPath: path.join("/workspace", "docs/shot.png") }),
		)
	})

	it("leaves a relative path alone when there is no workspace to anchor it to", async () => {
		hoisted.workspacePath = undefined

		await openImage("docs/shot.png")

		expect(hoisted.executeCommand).toHaveBeenCalledWith(
			"vscode.open",
			expect.objectContaining({ fsPath: "docs/shot.png" }),
		)
	})

	it("the copy action puts the PATH on the clipboard and opens nothing", async () => {
		await openImage("/tmp/shot.png", { values: { action: "copy" } })

		expect(hoisted.writeText).toHaveBeenCalledWith("/tmp/shot.png")
		expect(hoisted.executeCommand).not.toHaveBeenCalled()
		expect(hoisted.notifier.info).toHaveBeenCalled()
	})

	it("reports a failure to open through the notifier instead of throwing", async () => {
		hoisted.executeCommand.mockRejectedValueOnce(new Error("no editor"))

		await expect(openImage("/tmp/shot.png")).resolves.toBeUndefined()
		expect(hoisted.notifier.error).toHaveBeenCalled()
	})

	it.each(["http://x/a.png", "https://x/a.png", "vscode-resource:/a.png", "file+.vscode-resource/a.png"])(
		"%s is NOT treated as a file path",
		async (value) => {
			await openImage(value)
			// Not a data URI either, so it is refused as malformed rather than opened.
			expect(hoisted.executeCommand).not.toHaveBeenCalled()
			expect(hoisted.notifier.error).toHaveBeenCalled()
		},
	)
})

describe("openImage — data URIs", () => {
	it("refuses a malformed data URI with an error", async () => {
		await openImage("data:image/png;base64")

		expect(hoisted.notifier.error).toHaveBeenCalled()
		expect(hoisted.fsWriteFile).not.toHaveBeenCalled()
	})

	it("materializes the image in tmp and opens it", async () => {
		await openImage(PNG_URI)

		expect(hoisted.fsWriteFile).toHaveBeenCalled()
		const [uri] = hoisted.fsWriteFile.mock.calls[0] as [{ fsPath: string }]
		expect(uri.fsPath).toMatch(/temp_image_\d+\.png$/)
		expect(hoisted.executeCommand).toHaveBeenCalledWith("vscode.open", expect.anything())
	})

	it("the copy action re-reads the temp file, copies a data URI, and CLEANS UP", async () => {
		await openImage(PNG_URI, { values: { action: "copy" } })

		expect(hoisted.writeText).toHaveBeenCalledWith(
			`data:image/png;base64,${Buffer.from([1, 2, 3]).toString("base64")}`,
		)
		expect(hoisted.fsDelete).toHaveBeenCalled()
		expect(hoisted.executeCommand).not.toHaveBeenCalled()
	})

	it("still cleans up when the copy itself fails", async () => {
		hoisted.fsReadFile.mockRejectedValueOnce(new Error("gone"))

		await openImage(PNG_URI, { values: { action: "copy" } })

		expect(hoisted.notifier.error).toHaveBeenCalled()
		expect(hoisted.fsDelete).toHaveBeenCalled()
	})

	it("a cleanup failure is swallowed — it must not mask the successful copy", async () => {
		hoisted.fsDelete.mockRejectedValueOnce(new Error("EBUSY"))

		await expect(openImage(PNG_URI, { values: { action: "copy" } })).resolves.toBeUndefined()
		expect(hoisted.notifier.info).toHaveBeenCalled()
	})

	it("reports a write failure through the notifier", async () => {
		hoisted.fsWriteFile.mockRejectedValueOnce(new Error("ENOSPC"))

		await openImage(PNG_URI)

		expect(hoisted.notifier.error).toHaveBeenCalled()
	})
})

describe("saveImage", () => {
	const defaultUri = { fsPath: "/home/u/image.png" } as never

	it("refuses a malformed data URI and returns undefined", async () => {
		await expect(saveImage("not-an-image", defaultUri)).resolves.toBeUndefined()
		expect(hoisted.showSaveDialog).not.toHaveBeenCalled()
	})

	it("filters the save dialog on the URI's OWN format", async () => {
		hoisted.showSaveDialog.mockResolvedValueOnce(undefined)

		await saveImage(PNG_URI, defaultUri)

		expect(hoisted.showSaveDialog.mock.calls[0][0].filters.Images).toEqual(["png"])
	})

	it("returns undefined when the user cancels, writing nothing", async () => {
		hoisted.showSaveDialog.mockResolvedValueOnce(undefined)

		await expect(saveImage(PNG_URI, defaultUri)).resolves.toBeUndefined()
		expect(hoisted.fsWriteFile).not.toHaveBeenCalled()
	})

	it("writes the decoded bytes to the chosen location and returns it", async () => {
		const chosen = { fsPath: "/home/u/shot.png" }
		hoisted.showSaveDialog.mockResolvedValueOnce(chosen)

		await expect(saveImage(PNG_URI, defaultUri)).resolves.toBe(chosen)
		expect(hoisted.fsWriteFile).toHaveBeenCalledWith(chosen, Buffer.from("png-bytes"))
		expect(hoisted.notifier.info).toHaveBeenCalled()
	})

	it("returns undefined and notifies when the write fails", async () => {
		hoisted.showSaveDialog.mockResolvedValueOnce({ fsPath: "/ro/shot.png" })
		hoisted.fsWriteFile.mockRejectedValueOnce(new Error("EROFS"))

		await expect(saveImage(PNG_URI, defaultUri)).resolves.toBeUndefined()
		expect(hoisted.notifier.error).toHaveBeenCalled()
	})
})
