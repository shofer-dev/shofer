/**
 * LiveMemoryDirectoryTree (plugin port) — generates a workspace `find .`-style tree for
 * injection into the plugin's Live Memory system prompt.
 *
 * The plugin-native reimplementation of the built-in
 * `packages/core/src/services/live-memory/directory-tree.ts`, built ONLY on the public
 * plugin host surface — `ctx.host.fs` ({@link HostFileSystem}) — with no reach into
 * `@shofer/core` internals. The tree is:
 * - Capped at ~10% of the context window ({@link DIRECTORY_TREE_MAX_CONTEXT_FRACTION}).
 * - Pruned of {@link SKIP_PARTS} directories and hidden entries (except `shoferignore` /
 *   `.gitignore`), mirroring the built-in.
 * - Truncated deepest/last lines first when it exceeds the token budget.
 *
 * Reduced-fidelity note vs. the built-in: `HostFileSystem` exposes no directory read, so
 * the tree is reconstructed from a single `findFiles("**\/*")` glob. There is likewise no
 * `ShoferIgnoreController` plugin seam, so `.shoferignore` is only **approximated** here via
 * the {@link SKIP_PARTS} prune + the glob's own default excludes (`vscode.workspace.findFiles`
 * honors `.gitignore` on the VS Code host); genuine `.shoferignore` patterns are not applied.
 */

import { relative as relativePath } from "node:path"

import { EMBEDDED_WORKTREES_DIR, type HostFileSystem } from "@shofer/types"

import { DIRECTORY_TREE_MAX_CONTEXT_FRACTION } from "./types.js"

/**
 * Directories to skip during scanning (mirrors the built-in `SKIP_PARTS`).
 *
 * `.worktrees` is here because a per-task worktree is a whole second checkout of the
 * repository: including it would repeat the entire tree once per worktree. The legacy
 * location needs no entry — it is inside `.shofer`, which is already skipped.
 */
export const SKIP_PARTS = new Set([
	"node_modules",
	".git",
	".shofer",
	EMBEDDED_WORKTREES_DIR,
	"__pycache__",
	".cache",
	"dist",
	"out",
	"build",
	"target",
	".next",
	".turbo",
])

/** Upper bound on files pulled from the glob before the token budget prunes the render. */
const FIND_FILES_CAP = 20_000

interface TreeEntry {
	name: string
	isDirectory: boolean
	children?: TreeEntry[]
}

export class LiveMemoryDirectoryTree {
	private readonly workspacePath: string
	private readonly maxContextTokens: number
	private readonly fs: HostFileSystem

	constructor(workspacePath: string, maxContextTokens: number, fs: HostFileSystem) {
		this.workspacePath = workspacePath
		this.maxContextTokens = maxContextTokens
		this.fs = fs
	}

	/** Max tokens allowed for the tree (~10% of context window). */
	private get maxTreeTokens(): number {
		return Math.floor(this.maxContextTokens * DIRECTORY_TREE_MAX_CONTEXT_FRACTION)
	}

	/**
	 * Generate the directory tree string, capped to fit within the token budget.
	 */
	async generate(): Promise<string> {
		const files = await this.fs.findFiles("**/*", {
			cwd: this.workspacePath,
			exclude: [...SKIP_PARTS].map((p) => `**/${p}/**`),
			maxResults: FIND_FILES_CAP,
		})

		const root: TreeEntry[] = []
		for (const abs of files) {
			const rel = relativePath(this.workspacePath, abs)
			if (!rel || rel.startsWith("..")) continue
			const segments = rel.split(/[\\/]/).filter((s) => s.length > 0)
			if (segments.length === 0 || !this.isVisible(segments)) continue
			this.insert(root, segments)
		}

		this.sort(root)
		const tree = this.renderTree(root, "")

		const estimatedTokens = Math.ceil(tree.length / 4)
		if (estimatedTokens <= this.maxTreeTokens) return tree

		// Truncate: keep only the first N lines that fit the budget (deepest/last first).
		const lines = tree.split("\n")
		let result = ""
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i]!
			const newEstimate = Math.ceil((result + line + "\n").length / 4)
			if (newEstimate > this.maxTreeTokens) {
				result += `... (truncated ${lines.length - i} entries)\n`
				break
			}
			result += line + "\n"
		}
		return result
	}

	/** Whether every segment of a path is visible (not hidden/skipped), per the built-in rules. */
	private isVisible(segments: string[]): boolean {
		for (const seg of segments) {
			if (SKIP_PARTS.has(seg)) return false
			if (seg.startsWith(".") && seg !== "shoferignore" && seg !== ".gitignore") return false
		}
		return true
	}

	/** Insert a file's path segments into the tree, creating intermediate directory nodes. */
	private insert(level: TreeEntry[], segments: string[]): void {
		let current = level
		for (let i = 0; i < segments.length; i++) {
			const name = segments[i]!
			const isDir = i < segments.length - 1
			let node = current.find((e) => e.name === name && e.isDirectory === isDir)
			if (!node) {
				node = { name, isDirectory: isDir, children: isDir ? [] : undefined }
				current.push(node)
			}
			if (isDir) {
				node.children ??= []
				current = node.children
			}
		}
	}

	/** Sort each level: directories first, then alphabetical (matches the built-in). */
	private sort(level: TreeEntry[]): void {
		level.sort((a, b) => {
			if (a.isDirectory && !b.isDirectory) return -1
			if (!a.isDirectory && b.isDirectory) return 1
			return a.name.localeCompare(b.name)
		})
		for (const e of level) if (e.children) this.sort(e.children)
	}

	/** Render the tree entries to a `├──`/`└──` string. */
	private renderTree(entries: TreeEntry[], indent: string): string {
		let result = ""
		for (let i = 0; i < entries.length; i++) {
			const entry = entries[i]!
			const isLast = i === entries.length - 1
			const prefix = isLast ? "└── " : "├── "
			const nextIndent = isLast ? "    " : "│   "
			result += `${indent}${prefix}${entry.name}${entry.isDirectory ? "/" : ""}\n`
			if (entry.isDirectory && entry.children) {
				result += this.renderTree(entry.children, indent + nextIndent)
			}
		}
		return result
	}
}
