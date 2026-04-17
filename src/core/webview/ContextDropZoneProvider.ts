/**
 * ContextDropZoneProvider
 *
 * A native VSCode TreeView that acts as a drop target for files/folders from Explorer.
 * This bypasses VSCode Desktop's webview drag overlay limitation, allowing users to
 * drag & drop files without holding Shift.
 *
 * When files are dropped, they are sent to the Roo Code webview as @mentions.
 * The dropped files are displayed in the tree view with the ability to remove them.
 */

import * as vscode from "vscode"
import * as path from "path"

import type { ClineProvider } from "./ClineProvider"

/**
 * Represents an item in the drop zone tree view.
 * Can be either a hint message or a dropped file/folder.
 */
class DropZoneItem extends vscode.TreeItem {
	constructor(
		label: string,
		public readonly itemPath?: string,
		public readonly isFile: boolean = false,
		description?: string,
	) {
		super(label, vscode.TreeItemCollapsibleState.None)
		this.description = description

		if (itemPath) {
			// This is a dropped file/folder - show appropriate icon and add remove command
			this.iconPath = new vscode.ThemeIcon(isFile ? "file" : "folder")
			this.contextValue = "droppedFile"
			// Tooltip shows the full path
			this.tooltip = itemPath
		} else {
			// This is the hint message
			this.iconPath = new vscode.ThemeIcon("inbox")
		}
	}
}

/**
 * TreeDataProvider with DragAndDropController for the context files drop zone.
 * Accepts file drops from Explorer and forwards them to the webview.
 * Maintains a list of dropped files that can be removed individually.
 */
export class ContextDropZoneProvider
	implements vscode.TreeDataProvider<DropZoneItem>, vscode.TreeDragAndDropController<DropZoneItem>
{
	static readonly viewId = "roo-cline.contextDropZone"
	static readonly removeCommand = "roo-cline.removeContextFile"
	static readonly clearAllCommand = "roo-cline.clearAllContextFiles"

	// Accept file drops from Explorer
	readonly dropMimeTypes = ["text/uri-list"]
	readonly dragMimeTypes: string[] = []

	private _onDidChangeTreeData = new vscode.EventEmitter<DropZoneItem | undefined | null | void>()
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event

	private clineProvider: ClineProvider | undefined

	// Track dropped files (workspace-relative paths)
	private droppedFiles: Array<{ path: string; isFile: boolean }> = []

	/**
	 * Sets the ClineProvider reference so we can forward dropped files to the webview.
	 */
	setClineProvider(provider: ClineProvider): void {
		this.clineProvider = provider
	}

	/**
	 * Register commands for removing files from the drop zone.
	 */
	registerCommands(context: vscode.ExtensionContext): void {
		context.subscriptions.push(
			vscode.commands.registerCommand(ContextDropZoneProvider.removeCommand, (item: DropZoneItem) => {
				if (item.itemPath) {
					this.removeFile(item.itemPath)
				}
			}),
			vscode.commands.registerCommand(ContextDropZoneProvider.clearAllCommand, () => {
				this.clearAll()
			}),
		)
	}

	/**
	 * Remove a file from the dropped files list.
	 */
	private removeFile(filePath: string): void {
		const index = this.droppedFiles.findIndex((f) => f.path === filePath)
		if (index !== -1) {
			this.droppedFiles.splice(index, 1)
			this.refresh()
		}
	}

	/**
	 * Clear all dropped files.
	 */
	private clearAll(): void {
		this.droppedFiles = []
		this.refresh()
	}

	/**
	 * Clear the dropped files list (called when a new task starts or chat is reset).
	 */
	clearDroppedFiles(): void {
		this.droppedFiles = []
		this.refresh()
	}

	/**
	 * Get the dropped files as @mentions string and clear the list.
	 * Called when the user sends a chat message.
	 * @returns The @mentions string to prepend to the message, or empty string if no files
	 */
	getAndClearMentions(): string {
		if (this.droppedFiles.length === 0) {
			return ""
		}

		const mentions = this.droppedFiles
			.map((f) => {
				// Escape spaces in the path and prefix with @
				const escapedPath = f.path.replace(/ /g, "\\ ")
				return `@${escapedPath}`
			})
			.join(" ")

		this.droppedFiles = []
		this.refresh()

		return mentions
	}

	/**
	 * Handle files dropped onto the tree view.
	 * Converts URIs to workspace-relative paths and sends to webview.
	 */
	async handleDrop(
		_target: DropZoneItem | undefined,
		dataTransfer: vscode.DataTransfer,
		_token: vscode.CancellationToken,
	): Promise<void> {
		const uriListItem = dataTransfer.get("text/uri-list")
		if (!uriListItem) {
			return
		}

		const uriListString = await uriListItem.asString()
		if (!uriListString) {
			return
		}

		// Parse the URI list (one URI per line)
		const uris = uriListString
			.split("\n")
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

		if (uris.length === 0) {
			return
		}

		// Convert to workspace-relative paths
		const cwd = this.clineProvider?.cwd ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? ""

		const newFiles: Array<{ path: string; isFile: boolean }> = []

		for (const uri of uris) {
			const absPath = uri.fsPath
			let relativePath: string

			if (cwd && absPath.startsWith(cwd)) {
				// Make path relative to cwd, prefixed with /
				const rel = absPath.slice(cwd.length)
				relativePath = rel.startsWith("/") ? rel : "/" + rel
			} else {
				// Path is outside workspace, use absolute path
				relativePath = absPath
			}

			// Check if already added
			if (!this.droppedFiles.some((f) => f.path === relativePath)) {
				// Check if it's a file or folder
				try {
					const stat = await vscode.workspace.fs.stat(uri)
					const isFile = stat.type === vscode.FileType.File
					newFiles.push({ path: relativePath, isFile })
				} catch {
					// Assume file if we can't stat
					newFiles.push({ path: relativePath, isFile: true })
				}
			}
		}

		if (newFiles.length === 0) {
			return
		}

		// Add to our tracked list
		this.droppedFiles.push(...newFiles)
		this.refresh()

		// Show a brief notification
		const fileCount = newFiles.length
		const message =
			fileCount === 1
				? `Added 1 file to context (will be included when you send)`
				: `Added ${fileCount} files to context (will be included when you send)`
		vscode.window.setStatusBarMessage(message, 2000)
	}

	/**
	 * TreeDataProvider: Get the tree item for display.
	 */
	getTreeItem(element: DropZoneItem): vscode.TreeItem {
		return element
	}

	/**
	 * TreeDataProvider: Get children (hint message + dropped files).
	 * Only returns items for root level (element undefined) - no tree hierarchy.
	 */
	getChildren(element?: DropZoneItem): DropZoneItem[] {
		// Only return items at root level - flat list, no children
		if (element) {
			return []
		}

		const items: DropZoneItem[] = []

		// Show dropped files first
		for (const file of this.droppedFiles) {
			const basename = path.basename(file.path)
			const dirname = path.dirname(file.path)
			const description = dirname !== "/" && dirname !== "." ? dirname : undefined
			items.push(new DropZoneItem(basename, file.path, file.isFile, description))
		}

		// Always show the hint at the end (or as the only item if no files)
		if (this.droppedFiles.length === 0) {
			items.push(new DropZoneItem("Drag files from Explorer", undefined, false, "to add to chat context"))
		} else {
			items.push(new DropZoneItem("Drag more files...", undefined, false))
		}

		return items
	}

	/**
	 * Refresh the tree view.
	 */
	refresh(): void {
		this._onDidChangeTreeData.fire()
	}
}
