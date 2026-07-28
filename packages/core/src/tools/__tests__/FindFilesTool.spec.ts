import {
	setHost,
	createInMemoryHost,
	EMBEDDED_WORKTREES_DIR,
	LEGACY_EMBEDDED_WORKTREES_DIR,
	type HostBridge,
} from "@shofer/types"

import { FindFilesTool } from "../FindFilesTool.js"
import type { Task } from "../../task/Task.js"
import type { ToolCallbacks } from "../BaseTool.js"

/**
 * `find_files` must not surface the contents of embedded worktrees: each one is a
 * complete second checkout, so a match in every worktree buries the real result.
 * The exclusion is keyed off `EMBEDDED_WORKTREES_DIR` rather than a literal, which
 * is what keeps it aligned with core's worktree guard.
 */
describe("FindFilesTool", () => {
	let host: HostBridge
	let findFiles: ReturnType<typeof vi.fn>

	const task = { cwd: "/ws", consecutiveMistakeCount: 0 } as unknown as Task

	const callbacks = {
		askApproval: vi.fn(async () => true),
		handleError: vi.fn(async () => {}),
		pushToolResult: vi.fn(),
		removeClosingTag: vi.fn(),
	} as unknown as ToolCallbacks

	beforeEach(() => {
		host = createInMemoryHost()
		findFiles = vi.fn(async () => [])
		host.fs.findFiles = findFiles as unknown as typeof host.fs.findFiles
		setHost(host)
	})

	it("excludes the embedded-worktree directories from the search", async () => {
		await new FindFilesTool().execute({ pattern: "**/*.ts" }, task, callbacks)

		expect(findFiles).toHaveBeenCalledTimes(1)
		const exclude = findFiles.mock.calls[0]![1].exclude as string[]
		expect(exclude).toContain(`${EMBEDDED_WORKTREES_DIR}/**`)
		// Transition shim: worktrees created before the move are excluded too.
		expect(exclude).toContain(`${LEGACY_EMBEDDED_WORKTREES_DIR}/**`)
	})
})
