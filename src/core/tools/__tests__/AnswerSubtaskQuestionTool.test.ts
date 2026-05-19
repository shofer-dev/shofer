import { AnswerSubtaskQuestionTool } from "../AnswerSubtaskQuestionTool"

describe("AnswerSubtaskQuestionTool", () => {
	let tool: AnswerSubtaskQuestionTool

	beforeEach(() => {
		tool = new AnswerSubtaskQuestionTool()
	})

	function buildParentTask(handles: Map<string, any>, liveInstance: any) {
		const provider = {
			taskManager: {
				getManagedTaskInstance: vi.fn().mockReturnValue(liveInstance),
				getManagedTask: vi.fn().mockReturnValue(undefined),
			},
		}
		return {
			backgroundChildren: handles,
			providerRef: { deref: () => provider },
		} as any
	}

	it("resolves the typed pending question on the child and flips handle status", async () => {
		const handle = { taskId: "c1", status: "waiting_for_parent", createdAt: 0, parentTaskId: "p" } as any
		const liveInstance = {
			getPendingParentQuestion: vi.fn().mockReturnValue({ question: "ok?", suggestions: [] }),
			resolvePendingParentQuestion: vi.fn().mockReturnValue(true),
		}
		const task = buildParentTask(new Map([["c1", handle]]), liveInstance)

		const pushToolResult = vi.fn()
		await tool.execute({ task_id: "c1", answer: "yes" }, task, {
			askApproval: vi.fn().mockResolvedValue(true),
			pushToolResult,
			handleError: vi.fn(),
		} as any)

		expect(liveInstance.resolvePendingParentQuestion).toHaveBeenCalledWith("yes")
		expect(handle.status).toBe("running")
		expect(pushToolResult).toHaveBeenCalledWith(expect.stringContaining("Answered question for task c1"))
	})

	it("returns a tool error if no pending question is registered", async () => {
		const handle = { taskId: "c1", status: "running", createdAt: 0, parentTaskId: "p" } as any
		const liveInstance = {
			getPendingParentQuestion: vi.fn().mockReturnValue(undefined),
			resolvePendingParentQuestion: vi.fn(),
		}
		const task = buildParentTask(new Map([["c1", handle]]), liveInstance)

		const pushToolResult = vi.fn()
		await tool.execute({ task_id: "c1", answer: "yes" }, task, {
			askApproval: vi.fn().mockResolvedValue(true),
			pushToolResult,
			handleError: vi.fn(),
		} as any)

		expect(liveInstance.resolvePendingParentQuestion).not.toHaveBeenCalled()
		expect(pushToolResult).toHaveBeenCalledWith(expect.stringContaining("does not have a pending question"))
	})
})
