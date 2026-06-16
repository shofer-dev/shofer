import * as path from "path"
import * as fs from "fs/promises"
import { DIRECTORY_TREE_MAX_CONTEXT_FRACTION } from "@shofer/types"
import type { ShoferIgnoreController } from "../../core/ignore/ShoferIgnoreController"

/**
 * LiveMemoryDirectoryTree — generates a workspace `find .`-style tree
 * for injection into the live memory's system prompt.
 *
 * The tree is:
 * - Capped at ~10% of the context window (token estimate)
 * - Excludes shoferignore-listed paths and .shofer/worktrees/
 * - Truncated deepest nesting levels first when exceeding cap
 *
 * On agent startup and after Clear Context, the tree is regenerated
 * and injected via the {directoryTree} placeholder in the system prompt.
 */
export class LiveMemoryDirectoryTree {
	private readonly _workspacePath: string
	private readonly _maxContextTokens: number
	private readonly _shoferIgnoreController?: ShoferIgnoreController

	constructor(workspacePath: string, maxContextTokens: number, shoferIgnoreController?: ShoferIgnoreController) {
		this._workspacePath = workspacePath
		this._maxContextTokens = maxContextTokens
		this._shoferIgnoreController = shoferIgnoreController
	}

	/** Max tokens allowed for the tree (~10% of context window). */
	private get _maxTreeTokens(): number {
		return Math.floor(this._maxContextTokens * DIRECTORY_TREE_MAX_CONTEXT_FRACTION)
	}

	/**
	 * Generate the directory tree string.
	 * @returns The tree output, capped to fit within the token budget.
	 */
	public async generate(): Promise<string> {
		const entries = await this._scanDirectory(this._workspacePath, "")
		const tree = this._renderTree(entries, "")

		// Estimate tokens (rough: 4 chars per token)
		const estimatedTokens = Math.ceil(tree.length / 4)

		if (estimatedTokens <= this._maxTreeTokens) {
			return tree
		}

		// Truncate: keep only first N lines that fit the budget
		const lines = tree.split("\n")
		let result = ""
		for (const line of lines) {
			const newEstimate = Math.ceil((result + line + "\n").length / 4)
			if (newEstimate > this._maxTreeTokens) {
				result += `... (truncated ${lines.length - lines.indexOf(line)} entries)\n`
				break
			}
			result += line + "\n"
		}

		return result
	}

	/**
	 * Recursively scan a directory and build the tree structure.
	 * Returns sorted entries with directories first.
	 */
	private async _scanDirectory(dirPath: string, relativePrefix: string): Promise<TreeEntry[]> {
		const entries: TreeEntry[] = []

		try {
			const items = await fs.readdir(dirPath, { withFileTypes: true })

			// Sort: directories first, then alphabetical
			items.sort((a, b) => {
				if (a.isDirectory() && !b.isDirectory()) return -1
				if (!a.isDirectory() && b.isDirectory()) return 1
				return a.name.localeCompare(b.name)
			})

			for (const item of items) {
				const relPath = relativePrefix ? `${relativePrefix}/${item.name}` : item.name

				// Skip hidden directories and files
				if (item.name.startsWith(".")) {
					// But include shoferignore and .gitignore
					if (item.name !== "shoferignore" && item.name !== ".gitignore") {
						continue
					}
				}

				// Skip common excluded directories
				if (item.isDirectory() && SKIP_PARTS.has(item.name)) {
					continue
				}

				// Respect .shoferignore patterns
				if (this._shoferIgnoreController && !this._shoferIgnoreController.validateAccess(relPath)) {
					continue
				}

				if (item.isDirectory()) {
					const children = await this._scanDirectory(path.join(dirPath, item.name), relPath)
					entries.push({
						name: item.name,
						isDirectory: true,
						children,
					})
				} else {
					entries.push({
						name: item.name,
						isDirectory: false,
					})
				}
			}
		} catch {
			// Permission error or missing directory — skip
		}

		return entries
	}

	/**
	 * Render the tree entries to a string.
	 */
	private _renderTree(entries: TreeEntry[], indent: string): string {
		let result = ""

		for (let i = 0; i < entries.length; i++) {
			const entry = entries[i]
			const isLast = i === entries.length - 1
			const prefix = isLast ? "└── " : "├── "
			const nextIndent = isLast ? "    " : "│   "

			result += `${indent}${prefix}${entry.name}${entry.isDirectory ? "/" : ""}\n`

			if (entry.isDirectory && entry.children) {
				result += this._renderTree(entry.children, indent + nextIndent)
			}
		}

		return result
	}
}

interface TreeEntry {
	name: string
	isDirectory: boolean
	children?: TreeEntry[]
}

/** Directories to skip during scanning. */
export const SKIP_PARTS = new Set([
	"node_modules",
	".git",
	".shofer",
	"__pycache__",
	".cache",
	"dist",
	"out",
	"build",
	"target",
	".next",
	".turbo",
])
