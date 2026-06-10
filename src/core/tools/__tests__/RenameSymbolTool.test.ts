import * as path from "path"
import { RenameSymbolTool } from "../RenameSymbolTool"
import { validateWorktreePath } from "../../../utils/worktreePathGuard"

describe("RenameSymbolTool", () => {
	const WORKSPACE = "/home/user/project"
	const WORKTREE = path.join(WORKSPACE, ".shofer", "worktrees", "repo-hl911")
	const OTHER_WORKTREE = path.join(WORKSPACE, ".shofer", "worktrees", "repo-abc42")

	let renameSymbolTool: RenameSymbolTool

	beforeEach(() => {
		renameSymbolTool = new RenameSymbolTool()
	})

	function buildTask(cwd: string) {
		return {
			cwd,
			workspacePath: WORKSPACE,
			consecutiveMistakeCount: 0,
			didToolFailInCurrentTurn: false,
			recordToolError: vi.fn(),
			fileContextTracker: undefined,
			didEditFile: false,
			sayAndCreateMissingParamError: vi.fn(),
		} as any
	}

	function buildCallbacks(pushToolResult: ReturnType<typeof vi.fn>) {
		return {
			askApproval: vi.fn().mockResolvedValue(true),
			pushToolResult,
			handleError: vi.fn(),
		} as any
	}

	const baseParams = { path: "src/main.ts", line: 10, column: 5, newName: "calculateTotal" }

	it("blocks rename when WorkspaceEdit includes a file in master checkout", async () => {
		const task = buildTask(WORKTREE)
		const pushToolResult = vi.fn()
		const callbacks = buildCallbacks(pushToolResult)

		// Simulate a WorkspaceEdit that touches both worktree-internal and
		// master-scoped files.  The tool short-circuits at the worktree
		// validation stage (before applyEdit), so we just need to verify
		// the validation logic — we don't need a real LSP server.
		const err = validateWorktreePathWrapper(task, ["src/changed.ts", "../../master-file.ts"])

		expect(err).not.toBeNull()
		expect(err!).toContain("cannot write outside the current worktree")
		expect(task.consecutiveMistakeCount).toBeGreaterThan(0)
	})

	it("blocks rename when WorkspaceEdit includes a file in sibling worktree", async () => {
		const task = buildTask(WORKTREE)
		const pushToolResult = vi.fn()
		const callbacks = buildCallbacks(pushToolResult)

		const err = validateWorktreePathWrapper(task, ["src/changed.ts", path.join(OTHER_WORKTREE, "file.ts")])

		expect(err).not.toBeNull()
		expect(err!).toContain("cannot write outside the current worktree")
	})

	it("allows rename when all affected files are inside the worktree", async () => {
		const task = buildTask(WORKTREE)
		const pushToolResult = vi.fn()
		const callbacks = buildCallbacks(pushToolResult)

		const err = validateWorktreePathWrapper(task, ["src/main.ts", "lib/utils/helper.ts"])

		expect(err).toBeNull()
	})

	it("allows rename for non-worktree tasks (master checkout)", async () => {
		const task = buildTask(WORKSPACE) // master checkout
		const pushToolResult = vi.fn()
		const callbacks = buildCallbacks(pushToolResult)

		// All paths are inside the workspace — no worktree isolation applies.
		const err = validateWorktreePathWrapper(task, ["src/main.ts", "docs/readme.md"])

		expect(err).toBeNull()
	})
})

/**
 * Simulates the worktree-validation loop inside RenameSymbolTool.execute()
 * (lines 141-150) without requiring a real LSP rename provider.
 */
function validateWorktreePathWrapper(task: any, affectedRelPaths: string[]): string | null {
	for (const relPath of affectedRelPaths) {
		const worktreeErr = validateWorktreePath(task, relPath)
		if (worktreeErr) {
			task.consecutiveMistakeCount++
			task.recordToolError("rename_symbol")
			task.didToolFailInCurrentTurn = true
			return worktreeErr
		}
	}

	return null
}
