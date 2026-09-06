// npx vitest src/core/webview/__tests__/ContextDropZoneProvider.test.ts

/**
 * The drop zone is a TreeView used as a drop TARGET because the webview iframe
 * swallows DOM drag events. Its contract with the chat is one typed
 * `addContextFiles` message (the Webview Message Routing Rule's host→webview
 * half), and the path in that message is workspace-RELATIVE — the webview
 * renders it as a tag and the agent resolves it against the cwd, so an absolute
 * path leaking through is what a user sees as an unresolvable attachment.
 */

const hoisted = vi.hoisted(() => ({
	stat: vi.fn(async () => ({ type: 1 })),
	executeCommand: vi.fn(async () => undefined),
	setStatusBarMessage: vi.fn(),
	workspaceFolders: undefined as Array<{ uri: { fsPath: string } }> | undefined,
}))

vi.mock("vscode", () => ({
	Uri: {
		file: (p: string) => ({ fsPath: p, path: p, scheme: "file" }),
		parse: (p: string) => {
			if (p === "::invalid::") throw new Error("bad uri")
			return { fsPath: p.replace(/^file:\/\//, ""), path: p, scheme: "file" }
		},
	},
	FileType: { File: 1, Directory: 2, SymbolicLink: 64 },
	TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
	TreeItem: class {
		constructor(
			public label: string,
			public collapsibleState: number,
		) {}
	},
	ThemeIcon: class {
		constructor(public id: string) {}
	},
	EventEmitter: class {
		event = () => ({ dispose: () => {} })
		fire() {}
		dispose() {}
	},
	commands: { executeCommand: hoisted.executeCommand },
	window: { setStatusBarMessage: hoisted.setStatusBarMessage },
	workspace: {
		get workspaceFolders() {
			return hoisted.workspaceFolders
		},
		fs: { stat: hoisted.stat },
	},
}))

import { addUrisToContext, ContextDropZoneProvider } from "../ContextDropZoneProvider"

function makeProvider(cwd?: string) {
	return {
		cwd,
		postMessageToWebview: vi.fn(async () => undefined),
	} as never as import("../ShoferProvider").ShoferProvider & {
		postMessageToWebview: ReturnType<typeof vi.fn>
	}
}

function uri(fsPath: string) {
	return { fsPath } as import("vscode").Uri
}

beforeEach(() => {
	vi.clearAllMocks()
	hoisted.stat.mockResolvedValue({ type: 1 })
	hoisted.workspaceFolders = undefined
})

describe("addUrisToContext", () => {
	it("does nothing without a provider to post to", async () => {
		await expect(addUrisToContext([uri("/w/a.ts")], undefined)).resolves.toBe(0)
	})

	it("does nothing for an empty drop", async () => {
		const provider = makeProvider("/w")
		await expect(addUrisToContext([], provider)).resolves.toBe(0)
		expect(provider.postMessageToWebview).not.toHaveBeenCalled()
	})

	it("posts a typed addContextFiles message with WORKSPACE-RELATIVE paths", async () => {
		const provider = makeProvider("/w")

		await expect(addUrisToContext([uri("/w/src/a.ts")], provider)).resolves.toBe(1)

		expect(provider.postMessageToWebview).toHaveBeenCalledWith({
			type: "addContextFiles",
			contextFiles: [{ path: "/src/a.ts", isFile: true }],
		})
	})

	it("keeps an absolute path when the file is OUTSIDE the cwd", async () => {
		const provider = makeProvider("/w")

		await addUrisToContext([uri("/elsewhere/a.ts")], provider)

		expect(provider.postMessageToWebview.mock.calls[0][0].contextFiles).toEqual([
			{ path: "/elsewhere/a.ts", isFile: true },
		])
	})

	it("falls back to the first workspace folder when the provider has no cwd", async () => {
		hoisted.workspaceFolders = [{ uri: { fsPath: "/ws" } }]
		const provider = makeProvider(undefined)

		await addUrisToContext([uri("/ws/a.ts")], provider)

		expect(provider.postMessageToWebview.mock.calls[0][0].contextFiles[0].path).toBe("/a.ts")
	})

	it("marks a DIRECTORY as such, so the webview can render it differently", async () => {
		hoisted.stat.mockResolvedValueOnce({ type: 2 })
		const provider = makeProvider("/w")

		await addUrisToContext([uri("/w/src")], provider)

		expect(provider.postMessageToWebview.mock.calls[0][0].contextFiles[0].isFile).toBe(false)
	})

	it("defaults to 'file' when stat fails rather than dropping the attachment", async () => {
		hoisted.stat.mockRejectedValueOnce(new Error("ENOENT"))
		const provider = makeProvider("/w")

		await expect(addUrisToContext([uri("/w/gone.ts")], provider)).resolves.toBe(1)
		expect(provider.postMessageToWebview.mock.calls[0][0].contextFiles[0].isFile).toBe(true)
	})

	it("reveals the sidebar so the user sees the tags appear", async () => {
		await addUrisToContext([uri("/w/a.ts")], makeProvider("/w"))
		expect(hoisted.executeCommand).toHaveBeenCalledWith("shofer.SidebarProvider.focus")
	})

	it("still posts when revealing the sidebar fails — the focus is best-effort", async () => {
		hoisted.executeCommand.mockRejectedValueOnce(new Error("no view"))
		const provider = makeProvider("/w")

		await expect(addUrisToContext([uri("/w/a.ts")], provider)).resolves.toBe(1)
		expect(provider.postMessageToWebview).toHaveBeenCalled()
	})

	it("pluralizes the status-bar confirmation", async () => {
		await addUrisToContext([uri("/w/a.ts")], makeProvider("/w"))
		expect(hoisted.setStatusBarMessage).toHaveBeenLastCalledWith("Added 1 file to chat context", 2000)

		await addUrisToContext([uri("/w/a.ts"), uri("/w/b.ts")], makeProvider("/w"))
		expect(hoisted.setStatusBarMessage).toHaveBeenLastCalledWith("Added 2 files to chat context", 2000)
	})
})

describe("ContextDropZoneProvider", () => {
	function dataTransfer(value: string | undefined) {
		return {
			get: () => (value === undefined ? undefined : { asString: async () => value }),
		} as unknown as import("vscode").DataTransfer
	}

	const token = {} as import("vscode").CancellationToken

	it("advertises the Explorer's drop MIME type and no drag types (it is drop-only)", () => {
		const zone = new ContextDropZoneProvider()
		expect(zone.dropMimeTypes).toEqual(["text/uri-list"])
		expect(zone.dragMimeTypes).toEqual([])
	})

	it("shows exactly one hint row at the root and nothing beneath it", () => {
		const zone = new ContextDropZoneProvider()
		const children = zone.getChildren()
		expect(children).toHaveLength(1)
		expect(zone.getTreeItem(children[0])).toBe(children[0])
		expect(zone.getChildren(children[0])).toEqual([])
	})

	it("ignores a drop carrying no uri-list", async () => {
		const zone = new ContextDropZoneProvider()
		const provider = makeProvider("/w")
		zone.setShoferProvider(provider)

		await zone.handleDrop(undefined, dataTransfer(undefined), token)

		expect(provider.postMessageToWebview).not.toHaveBeenCalled()
	})

	it("ignores a drop whose uri-list is empty", async () => {
		const zone = new ContextDropZoneProvider()
		const provider = makeProvider("/w")
		zone.setShoferProvider(provider)

		await zone.handleDrop(undefined, dataTransfer(""), token)

		expect(provider.postMessageToWebview).not.toHaveBeenCalled()
	})

	it("parses a multi-line uri-list, skipping blanks and unparseable lines", async () => {
		const zone = new ContextDropZoneProvider()
		const provider = makeProvider("/w")
		zone.setShoferProvider(provider)

		await zone.handleDrop(undefined, dataTransfer("file:///w/a.ts\r\n\n  \n::invalid::\nfile:///w/b.ts"), token)

		expect(provider.postMessageToWebview.mock.calls[0][0].contextFiles).toEqual([
			{ path: "/a.ts", isFile: true },
			{ path: "/b.ts", isFile: true },
		])
	})

	it("drops harmlessly when no provider has been injected yet", async () => {
		const zone = new ContextDropZoneProvider()
		await expect(zone.handleDrop(undefined, dataTransfer("file:///w/a.ts"), token)).resolves.toBeUndefined()
	})
})
