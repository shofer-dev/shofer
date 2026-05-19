import { CancelTasksTool } from "../CancelTasksTool"

describe("CancelTasksTool", () => {
	let cancelTasksTool: CancelTasksTool

	beforeEach(() => {
		cancelTasksTool = new CancelTasksTool()
	})

	function buildHandle(status: string) {
		return { taskId: "child-1", status, createdAt: Date.now(), parentTaskId: "parent" } as any
	}

	function buildProvider(liveInstance: any = undefined) {
		return {
			taskManager: {
				getManagedTaskInstance: vi.fn().mockReturnValue(liveInstance),
				getManagedTask: vi.fn().mockReturnValue(undefined),
			},
		}
	}

	it("calls askApproval BEFORE invoking abortTask on the live child instance", async () => {
		const callOrder: string[] = []
		const handle = buildHandle("running")
		const handles = new Map([["child-1", handle]])
		const abortTaskMock = vi.fn(async () => {
			callOrder.push("abortTask")
		})
		const provider = buildProvider({ abortTask: abortTaskMock })
		const task: any = {
			backgroundChildren: handles,
			providerRef: { deref: () => provider },
		}

		const askApproval = vi.fn(async () => {
			callOrder.push("askApproval")
			return true
		})
		const pushToolResult = vi.fn()

		await cancelTasksTool.execute({ task_ids: ["child-1"] }, task, {
			askApproval,
			pushToolResult,
			handleError: vi.fn(),
		} as any)

		expect(callOrder).toEqual(["askApproval", "abortTask"])
		expect(handle.status).toBe("cancelled")
	})

	it("does NOT call abortTask if the user rejects the approval", async () => {
		const handle = buildHandle("running")
		const handles = new Map([["child-1", handle]])
		const abortTaskMock = vi.fn()
		const provider = buildProvider({ abortTask: abortTaskMock })
		const task: any = {
			backgroundChildren: handles,
			providerRef: { deref: () => provider },
		}

		await cancelTasksTool.execute({ task_ids: ["child-1"] }, task, {
			askApproval: vi.fn().mockResolvedValue(false),
			pushToolResult: vi.fn(),
			handleError: vi.fn(),
		} as any)

		expect(abortTaskMock).not.toHaveBeenCalled()
		expect(handle.status).toBe("running")
	})

	it("uses status 'cancelled' (not 'error') for successfully aborted children", async () => {
		const handle = buildHandle("running")
		const handles = new Map([["child-1", handle]])
		const provider = buildProvider({ abortTask: vi.fn().mockResolvedValue(undefined) })
		const task: any = {
			backgroundChildren: handles,
			providerRef: { deref: () => provider },
		}

		let summary = ""
		await cancelTasksTool.execute({ task_ids: ["child-1"] }, task, {
			askApproval: vi.fn().mockResolvedValue(true),
			pushToolResult: (s: string) => {
				summary = s
			},
			handleError: vi.fn(),
		} as any)

		expect(handle.status).toBe("cancelled")
		expect(summary).toContain("cancelled")
	})

	it("downgrades handle status to 'error' when abortTask throws", async () => {
		const handle = buildHandle("running")
		const handles = new Map([["child-1", handle]])
		const provider = buildProvider({ abortTask: vi.fn().mockRejectedValue(new Error("boom")) })
		const task: any = {
			backgroundChildren: handles,
			providerRef: { deref: () => provider },
		}

		await cancelTasksTool.execute({ task_ids: ["child-1"] }, task, {
			askApproval: vi.fn().mockResolvedValue(true),
			pushToolResult: vi.fn(),
			handleError: vi.fn(),
		} as any)

		expect(handle.status).toBe("error")
	})

	it("is a no-op for already-terminal children (completed, error, cancelled)", async () => {
		for (const terminal of ["completed", "error", "cancelled"]) {
			const handle = buildHandle(terminal)
			const handles = new Map([["child-1", handle]])
			const abortTaskMock = vi.fn()
			const provider = buildProvider({ abortTask: abortTaskMock })
			const task: any = {
				backgroundChildren: handles,
				providerRef: { deref: () => provider },
			}

			await cancelTasksTool.execute({ task_ids: ["child-1"] }, task, {
				askApproval: vi.fn().mockResolvedValue(true),
				pushToolResult: vi.fn(),
				handleError: vi.fn(),
			} as any)

			expect(abortTaskMock).not.toHaveBeenCalled()
			expect(handle.status).toBe(terminal)
		}
	})
})
