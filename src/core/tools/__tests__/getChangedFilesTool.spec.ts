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
			askApproval: vi.fn(),
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

	it("returns 'no files changed' when both sources are empty", async () => {
		vi.mocked(getCheckpointService).mockResolvedValue(undefined as any)

		await getChangedFilesTool.handle(mockTask as Task, block, mockCallbacks)

		expect(mockCallbacks.pushToolResult).toHaveBeenCalledWith(
			"No files have been changed by Roo in the current task.",
		)
	})

	it("reports per-file insertions/deletions from the checkpoint service", async () => {
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
		expect(result).toContain("Changed files in current task: 2 (+12 -10)")
		expect(result).toContain("src/a.ts  +12  -3")
		expect(result).toContain("src/b.ts  +0  -7")
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

	it("falls back to FileContextTracker when checkpoints are unavailable", async () => {
		vi.mocked(getCheckpointService).mockResolvedValue(undefined as any)
		mockTask.fileContextTracker.getFilesEditedByRoo.mockResolvedValue(["src/c.ts"])

		await getChangedFilesTool.handle(mockTask as Task, block, mockCallbacks)

		const result = mockCallbacks.pushToolResult.mock.calls[0][0] as string
		expect(result).toContain("src/c.ts  +?  -?  (not yet in checkpoint)")
	})

	it("merges checkpoint stats with tracker-only files", async () => {
		vi.mocked(getCheckpointService).mockResolvedValue({
			isInitialized: true,
			baseHash: "deadbeef",
			getDiffStat: vi
				.fn()
				.mockResolvedValue([
					{ relative: "src/a.ts", absolute: "/repo/src/a.ts", insertions: 1, deletions: 0, binary: false },
				]),
		} as any)
		mockTask.fileContextTracker.getFilesEditedByRoo.mockResolvedValue(["src/a.ts", "src/d.ts"])

		await getChangedFilesTool.handle(mockTask as Task, block, mockCallbacks)

		const result = mockCallbacks.pushToolResult.mock.calls[0][0] as string
		// src/a.ts came from checkpoint (concrete counts); src/d.ts only from tracker.
		expect(result).toContain("src/a.ts  +1  -0")
		expect(result).toContain("src/d.ts  +?  -?  (not yet in checkpoint)")
		expect(result).toContain("Changed files in current task: 2")
	})

	it("treats checkpoint errors as 'unavailable' and surfaces tracker entries", async () => {
		vi.mocked(getCheckpointService).mockRejectedValue(new Error("boom"))
		mockTask.fileContextTracker.getFilesEditedByRoo.mockResolvedValue(["src/e.ts"])

		await getChangedFilesTool.handle(mockTask as Task, block, mockCallbacks)

		const result = mockCallbacks.pushToolResult.mock.calls[0][0] as string
		expect(result).toContain("src/e.ts  +?  -?  (checkpoints unavailable)")
	})
})
