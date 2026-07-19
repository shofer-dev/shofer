import { CancelTasksTool } from "../CancelTasksTool.js"

describe("CancelTasksTool", () => {
	let cancelTasksTool: CancelTasksTool

	beforeEach(() => {
		cancelTasksTool = new CancelTasksTool()
	})

	function buildHandle(status: string) {
		return { taskId: "child-1", status, createdAt: Date.now(), parentTaskId: "parent" } as any
	}

	function buildProvider(liveInstance: any = undefined, overrides: Record<string, any> = {}) {
		return {
			taskManager: {
				getManagedTaskInstance: vi.fn().mockReturnValue(liveInstance),
				getManagedTask: vi.fn().mockReturnValue(undefined),
			},
			taskHistoryStore: {
				get: vi.fn().mockReturnValue(undefined),
				getAll: vi.fn().mockReturnValue([]),
			},
			...overrides,
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

	// ─── Post-restart: persisted-child fallback ────────────────────────

	it("recognizes persisted background child when in-memory handle is missing (post-restart)", async () => {
		// After a restart, backgroundChildren is empty. The tool must still
		// recognize its own persisted background child via taskHistoryStore so
		// it reports an accurate outcome instead of "not found".
		const abortTaskMock = vi.fn(async () => {})
		const provider = buildProvider(
			{ abortTask: abortTaskMock },
			{
				taskHistoryStore: {
					get: vi.fn().mockReturnValue({
						id: "child-1",
						isBackground: true,
						parentTaskId: "parent",
						taskState: { lifecycle: "idle" },
						createdAt: 100,
					}),
					getAll: vi.fn().mockReturnValue([]),
				},
			},
		)
		const task: any = {
			taskId: "parent",
			backgroundChildren: new Map(),
			providerRef: { deref: () => provider },
		}

		const pushToolResult = vi.fn()
		await cancelTasksTool.execute({ task_ids: ["child-1"] }, task, {
			askApproval: vi.fn().mockResolvedValue(true),
			pushToolResult,
			handleError: vi.fn(),
		} as any)

		// Should NOT report "not found" — the persisted child is recognized.
		const result = pushToolResult.mock.calls[0]?.[0] as string
		expect(result).not.toContain("not found")
		// idle-on-disk child has no live instance, so abort is a no-op but the
		// plan still classifies it (was_running=true since idle maps to "running").
		expect(result).toContain("child-1")
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
