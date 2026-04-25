import { describe, it, expect, vi, beforeEach } from "vitest"

import { getChangedFilesTool } from "../GetChangedFilesTool"
import { Task } from "../../task/Task"
import type { ToolUse } from "../../../shared/tools"

vi.mock("../../checkpoints", () => ({
	getCheckpointService: vi.fn(),
}))

import { getCheckpointService } from "../../checkpoints"

describe("getChangedFilesTool", () => {
	let mockTask: any
	let mockCallbacks: any

	beforeEach(() => {
		vi.clearAllMocks()
		mockTask = {
			consecutiveMistakeCount: 0,
			cwd: "/repo",
			fileContextTracker: {
				getFilesEditedByRoo: vi.fn().mockResolvedValue([]),
			},
		}
		mockCallbacks = {
			askApproval: vi.fn().mockResolvedValue(true),
			handleError: vi.fn(),
			pushToolResult: vi.fn(),
		}
	})

	const block: ToolUse<"get_changed_files"> = {
		type: "tool_use",
		name: "get_changed_files",
		params: {},
		partial: false,
		nativeArgs: {},
	}

	it("returns 'no files changed' when both sources are empty and checkpoints succeeded", async () => {
		vi.mocked(getCheckpointService).mockResolvedValue(undefined as any)

		await getChangedFilesTool.handle(mockTask as Task, block, mockCallbacks)

		expect(mockCallbacks.pushToolResult).toHaveBeenCalledWith(
			"No files have been changed by Roo in the current task.",
		)
	})

	it("reports cumulative checkpoint diff with per-file insertions/deletions", async () => {
		vi.mocked(getCheckpointService).mockResolvedValue({
			isInitialized: true,
			baseHash: "deadbeef",
			getDiffStat: vi.fn().mockResolvedValue([
				{ relative: "src/a.ts", absolute: "/repo/src/a.ts", insertions: 12, deletions: 3, binary: false },
				{ relative: "src/b.ts", absolute: "/repo/src/b.ts", insertions: 0, deletions: 7, binary: false },
			]),
		} as any)

		await getChangedFilesTool.handle(mockTask as Task, block, mockCallbacks)

		const result = mockCallbacks.pushToolResult.mock.calls[0][0] as string
		expect(result).toContain("Cumulative changes since task start: 2 file(s) (+12 -10)")
		expect(result).toContain("src/a.ts  +12  -3")
		expect(result).toContain("src/b.ts  +0  -7")
		expect(result).toContain("Files Roo edited in this session: none")
	})

	it("reports binary files without line counts", async () => {
		vi.mocked(getCheckpointService).mockResolvedValue({
			isInitialized: true,
			baseHash: "deadbeef",
			getDiffStat: vi
				.fn()
				.mockResolvedValue([
					{ relative: "image.png", absolute: "/repo/image.png", insertions: 0, deletions: 0, binary: true },
				]),
		} as any)

		await getChangedFilesTool.handle(mockTask as Task, block, mockCallbacks)

		const result = mockCallbacks.pushToolResult.mock.calls[0][0] as string
		expect(result).toContain("image.png  (binary)")
		expect(result).toContain("(+0 -0)")
	})

	it("marks checkpoint section unavailable when service is not initialized", async () => {
		vi.mocked(getCheckpointService).mockResolvedValue(undefined as any)
		mockTask.fileContextTracker.getFilesEditedByRoo.mockResolvedValue(["src/c.ts"])

		await getChangedFilesTool.handle(mockTask as Task, block, mockCallbacks)

		const result = mockCallbacks.pushToolResult.mock.calls[0][0] as string
		expect(result).toContain("Cumulative changes since task start: unavailable (checkpoints not initialized)")
		expect(result).toContain("Files Roo edited in this session: 1")
		expect(result).toContain("src/c.ts")
		// No annotation when checkpoint isn't available — there's nothing to compare against.
		expect(result).not.toContain("not in checkpoint diff")
	})

	it("reports both sources independently and annotates session-only files", async () => {
		vi.mocked(getCheckpointService).mockResolvedValue({
			isInitialized: true,
			baseHash: "deadbeef",
			getDiffStat: vi.fn().mockResolvedValue([
				{ relative: "src/a.ts", absolute: "/repo/src/a.ts", insertions: 1, deletions: 0, binary: false },
				{ relative: "src/x.ts", absolute: "/repo/src/x.ts", insertions: 4, deletions: 2, binary: false },
			]),
		} as any)
		mockTask.fileContextTracker.getFilesEditedByRoo.mockResolvedValue(["src/a.ts", "src/d.ts"])

		await getChangedFilesTool.handle(mockTask as Task, block, mockCallbacks)

		const result = mockCallbacks.pushToolResult.mock.calls[0][0] as string
		// Section 1: cumulative diff lists everything from checkpoint, including
		// files NOT touched in this session (src/x.ts — pre-existing/external).
		expect(result).toContain("Cumulative changes since task start: 2 file(s) (+5 -2)")
		expect(result).toContain("src/a.ts  +1  -0")
		expect(result).toContain("src/x.ts  +4  -2")
		// Section 2: session edits, with annotation for files not in the diff.
		expect(result).toContain("Files Roo edited in this session: 2")
		expect(result).toMatch(/src\/a\.ts$/m)
		expect(result).toContain("src/d.ts  (not in checkpoint diff)")
	})

	it("surfaces checkpoint errors without losing session edits", async () => {
		vi.mocked(getCheckpointService).mockRejectedValue(new Error("boom"))
		mockTask.fileContextTracker.getFilesEditedByRoo.mockResolvedValue(["src/e.ts"])

		await getChangedFilesTool.handle(mockTask as Task, block, mockCallbacks)

		const result = mockCallbacks.pushToolResult.mock.calls[0][0] as string
		expect(result).toContain("Cumulative changes since task start: unavailable (boom)")
		expect(result).toContain("Files Roo edited in this session: 1")
		expect(result).toContain("src/e.ts")
	})
})
