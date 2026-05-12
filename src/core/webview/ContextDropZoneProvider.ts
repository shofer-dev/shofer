/**
 * ContextDropZoneProvider
 *
 * A native VSCode TreeView that acts as a drop target for files/folders from
 * the Explorer.  This is the only reliable cross-platform drop target for the
 * Shofer chat context: VSCode Desktop's webview overlay swallows DOM drag
 * events at the iframe root, and code-server inherits the same limitation.
 *
 * The view itself is intentionally minimal — it owns no state.  When files
 * are dropped, it forwards them to the chat webview via an `addContextFiles`
 * message; the webview's `droppedContextFiles` state remains the single
 * source of truth and renders the removable file tags above the chat input.
 *
 * The view is registered as collapsed-by-default so it does not visually
 * clutter the Shofer sidebar; it expands on demand when the user wants to
 * use it as a drop target.
 */

import * as vscode from "vscode"

import type { ShoferProvider } from "./ShoferProvider"

/**
 * Convert a list of file/folder URIs into the `addContextFiles` message
 * payload and post it to the chat webview.  Shared between the TreeView
 * drop handler and the Explorer context-menu command so both code paths
 * behave identically.
 */
export async function addUrisToContext(
	uris: readonly vscode.Uri[],
	provider: ShoferProvider | undefined,
): Promise<number> {
	if (!provider || uris.length === 0) return 0

	const cwd = provider.cwd ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? ""

	const newFiles: Array<{ path: string; isFile: boolean }> = []
	for (const uri of uris) {
		const absPath = uri.fsPath
		let relativePath: string
		if (cwd && absPath.startsWith(cwd)) {
			const rel = absPath.slice(cwd.length)
			relativePath = rel.startsWith("/") ? rel : "/" + rel
		} else {
			relativePath = absPath
		}

		let isFile = true
		try {
			const stat = await vscode.workspace.fs.stat(uri)
			isFile = stat.type === vscode.FileType.File
		} catch {
			// Best-effort; default to file.
		}

		newFiles.push({ path: relativePath, isFile })
	}

	// Make sure the sidebar is visible so the user actually sees the tags appear.
	try {
		await vscode.commands.executeCommand("shofer.SidebarProvider.focus")
	} catch {
		// best-effort
	}

	await provider.postMessageToWebview({
		type: "addContextFiles",
		contextFiles: newFiles,
	})

	const message =
		newFiles.length === 1 ? "Added 1 file to chat context" : `Added ${newFiles.length} files to chat context`
	vscode.window.setStatusBarMessage(message, 2000)
	return newFiles.length
}

/**
 * The single placeholder row shown inside the drop-zone tree.
 *
 * The TreeView API requires *some* item to be present; an empty tree shows a
 * generic "no data" message that we do not want.  This hint also tells the
 * user what the view is for the first time they expand it.
 */
class HintItem extends vscode.TreeItem {
	constructor() {
		super("Drag files here to add to chat context", vscode.TreeItemCollapsibleState.None)
		this.iconPath = new vscode.ThemeIcon("inbox")
		this.tooltip =
			"Drag files or folders from the Explorer onto this view to attach them to your next chat message."
	}
}

/**
 * TreeDataProvider + DragAndDropController for the chat context drop zone.
 */
export class ContextDropZoneProvider
	implements vscode.TreeDataProvider<HintItem>, vscode.TreeDragAndDropController<HintItem>
{
	static readonly viewId = "shofer.contextDropZone"

	// Accept Explorer file drops.  VSCode delivers Explorer drags as
	// `text/uri-list`; we do not advertise any drag MIME types because this
	// view is drop-only.
	readonly dropMimeTypes = ["text/uri-list"]
	readonly dragMimeTypes: string[] = []

	private readonly _onDidChangeTreeData = new vscode.EventEmitter<HintItem | undefined | null | void>()
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event

	private clineProvider: ShoferProvider | undefined

	/**
	 * Inject the chat provider so we can post `addContextFiles` messages back
	 * to the webview when files are dropped.
	 */
	setShoferProvider(provider: ShoferProvider): void {
		this.clineProvider = provider
	}

	/**
	 * TreeDragAndDropController: handle file drops.  Converts the dropped
	 * URIs to workspace-relative paths and forwards them to the chat webview.
	 */
	async handleDrop(
		_target: HintItem | undefined,
		dataTransfer: vscode.DataTransfer,
		_token: vscode.CancellationToken,
	): Promise<void> {
		const uriListItem = dataTransfer.get("text/uri-list")
		if (!uriListItem) return

		const uriListString = await uriListItem.asString()
		if (!uriListString) return

		const uris = uriListString
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter((line) => line.length > 0)
			.map((line) => {
				try {
					return vscode.Uri.parse(line)
				} catch {
					return null
				}
			})
			.filter((uri): uri is vscode.Uri => uri !== null)

		await addUrisToContext(uris, this.clineProvider)
	}

	/** TreeDataProvider: return the single hint row. */
	getTreeItem(element: HintItem): vscode.TreeItem {
		return element
	}

	/** TreeDataProvider: only show the hint at the root level. */
	getChildren(element?: HintItem): HintItem[] {
		if (element) return []
		return [new HintItem()]
	}
}
