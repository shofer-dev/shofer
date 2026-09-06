import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { createInMemoryHost, getHost, setHost } from "@shofer/types"

/**
 * A duck-typed stand-in for `Task`, sized for the file-editing tools.
 *
 * The tools under test touch a real filesystem through `task.cwd`, so these
 * suites run against a real mkdtemp workspace rather than an `fs` mock: an
 * `fs` mock proves the tool called `writeFile`, a temp dir proves the bytes
 * landed. What stays faked is everything that needs a VS Code host — the diff
 * view, the ignore/protect controllers, the file-context tracker — because
 * those are the seams `@shofer/core` deliberately does not own.
 *
 * The fake diff-view provider is not a bare `vi.fn()` bag: `saveChanges` and
 * `saveDirectly` WRITE, so a test can assert the file's final content and a
 * rejection path can assert nothing was written.
 */

export interface FakeWorkspace {
	cwd: string
	cleanup: () => Promise<void>
	/** Write a file (creating parents) relative to the workspace root. */
	write: (relPath: string, content: string) => Promise<void>
	/** Read a file relative to the workspace root; `undefined` when absent. */
	read: (relPath: string) => Promise<string | undefined>
	exists: (relPath: string) => Promise<boolean>
}

export async function makeWorkspace(prefix = "shofer-tool-"): Promise<FakeWorkspace> {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
	return {
		cwd,
		cleanup: () => fs.rm(cwd, { recursive: true, force: true }),
		write: async (relPath, content) => {
			const abs = path.join(cwd, relPath)
			await fs.mkdir(path.dirname(abs), { recursive: true })
			await fs.writeFile(abs, content, "utf8")
		},
		read: async (relPath) => {
			try {
				return await fs.readFile(path.join(cwd, relPath), "utf8")
			} catch {
				return undefined
			}
		},
		exists: async (relPath) => {
			try {
				await fs.access(path.join(cwd, relPath))
				return true
			} catch {
				return false
			}
		},
	}
}

/**
 * Point the host bridge's workspace at `root` for the duration of a test.
 *
 * `isPathOutsideWorkspace()` asks `getHost().workspace.workspaceRoots()`, and
 * the default in-memory host reports NO roots — which means "outside the
 * workspace" for every path, so a tool's outside-workspace guard fires on a
 * temp workspace that is morally inside it. Installing a root is therefore not
 * scene-setting: it is the difference between exercising the happy path and
 * exercising the refusal.
 */
export function withWorkspaceRoot(root: string): () => void {
	const bridge = createInMemoryHost()
	return installHost({ workspace: { ...bridge.workspace, workspaceRoots: () => [root] } })
}

/**
 * Install a host bridge built from the in-memory default plus `overrides`,
 * returning a restore function. Use for the tools that reach the host's LSP or
 * workspace surfaces (`get_errors`, `list_code_usages`, `rename_symbol`,
 * `lsp_search`, `create_new_workspace`).
 */

export function installHost(overrides: Record<string, any>): () => void {
	const previous = getHost()
	setHost({ ...createInMemoryHost(), ...overrides })
	return () => setHost(previous)
}

export function makeFakeDiffViewProvider(cwd: string): any {
	const saved: Array<{ relPath: string; content: string }> = []
	let openedPath: string | undefined
	let pendingContent = ""

	return {
		saved,
		editType: undefined as string | undefined,
		originalContent: undefined as string | undefined,
		isEditing: false,
		get openedPath() {
			return openedPath
		},
		open: vi.fn(async (relPath: string) => {
			openedPath = relPath
		}),
		update: vi.fn(async (content: string) => {
			pendingContent = content
		}),
		scrollToFirstDiff: vi.fn(),
		revertChanges: vi.fn(async () => {
			pendingContent = ""
		}),
		reset: vi.fn(async () => {
			openedPath = undefined
			pendingContent = ""
		}),
		saveChanges: vi.fn(async () => {
			if (openedPath === undefined) return
			const abs = path.join(cwd, openedPath)
			await fs.mkdir(path.dirname(abs), { recursive: true })
			await fs.writeFile(abs, pendingContent, "utf8")
			saved.push({ relPath: openedPath, content: pendingContent })
		}),
		saveDirectly: vi.fn(async (relPath: string, content: string) => {
			const abs = path.join(cwd, relPath)
			await fs.mkdir(path.dirname(abs), { recursive: true })
			await fs.writeFile(abs, content, "utf8")
			saved.push({ relPath, content })
		}),
		pushToolWriteResult: vi.fn(async (_task: unknown, _cwd: string, isNew: boolean) =>
			isNew ? "File created." : "File updated.",
		),
	}
}

export interface FakeEditTaskOptions {
	cwd: string
	/** `validateAccess` answer for every path (default: allowed). */
	accessAllowed?: boolean
	/** `isWriteProtected` answer for every path (default: not protected). */
	writeProtected?: boolean
	/** Provider state returned by `getState()`. */
	state?: Record<string, unknown>

	overrides?: Record<string, any>
}

/**
 * Build a `Task`-shaped fake wired to a real workspace directory.
 * Returned as `any`: the tools take the concrete `Task` class, and enumerating
 * its ~200 members here would test the shape of the fake, not the tool.
 */

export function makeFakeEditTask(opts: FakeEditTaskOptions): any {
	const { cwd, accessAllowed = true, writeProtected = false, state = {}, overrides = {} } = opts
	const diffViewProvider = makeFakeDiffViewProvider(cwd)

	return {
		taskId: "task-1",
		cwd,
		// `validateWorktreePath` resolves BOTH cwd and workspacePath; leaving the
		// latter undefined makes every guarded tool throw `ERR_INVALID_ARG_TYPE`
		// out of `path.resolve` before it does anything, which reads as the tool
		// being broken. Equal to cwd = "not a worktree task", the ordinary case.
		workspacePath: cwd,
		abort: false,
		didEditFile: false,
		didToolFailInCurrentTurn: false,
		consecutiveMistakeCount: 0,
		diffViewProvider,
		api: { getModel: () => ({ id: "test-model", info: {} }) },
		shoferIgnoreController: { validateAccess: vi.fn(() => accessAllowed) },
		shoferProtectedController: { isWriteProtected: vi.fn(() => writeProtected) },
		fileContextTracker: {
			trackFileContext: vi.fn().mockResolvedValue(undefined),
			captureOriginal: vi.fn().mockResolvedValue(undefined),
		},
		say: vi.fn().mockResolvedValue(undefined),
		ask: vi.fn().mockResolvedValue({ response: "yesButtonClicked" }),
		sayAndCreateMissingParamError: vi.fn(async (tool: string, param: string) => `Missing ${param} for ${tool}`),
		recordToolError: vi.fn(),
		recordToolUsage: vi.fn(),
		processQueuedMessages: vi.fn(),
		providerRef: { deref: () => ({ getState: vi.fn().mockResolvedValue(state) }) },
		...overrides,
	}
}

export function makeToolCallbacks(approve: boolean | (() => boolean) = true): any {
	const decide = typeof approve === "function" ? approve : () => approve
	return {
		askApproval: vi.fn(async () => decide()),
		pushToolResult: vi.fn(),
		handleError: vi.fn().mockResolvedValue(undefined),
	}
}

/** The concatenation of everything the tool handed back to the model. */

export function toolResults(cbs: any): string {
	return cbs.pushToolResult.mock.calls.map((c: any[]) => String(c[0])).join("\n---\n")
}
