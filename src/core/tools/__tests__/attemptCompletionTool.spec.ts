import { ShoferEventName, TodoItem } from "@shofer/types"

import { AttemptCompletionToolUse } from "../../../shared/tools"

// Mock the formatResponse module before importing the tool
vi.mock("../../prompts/responses", () => ({
	formatResponse: {
		toolError: vi.fn((msg: string) => `Error: ${msg}`),
		toolResult: vi.fn((msg: string) => `Result: ${msg}`),
		toolDenied: vi.fn(() => "Denied"),
	},
}))

const { mockCaptureTaskCompleted } = vi.hoisted(() => ({
	mockCaptureTaskCompleted: vi.fn(),
}))
vi.mock("@shofer/telemetry", () => ({
	TelemetryService: {
		instance: {
			captureTaskCompleted: mockCaptureTaskCompleted,
		},
	},
}))

const { mockOutputChannel } = vi.hoisted(() => {
	const appendLine = vi.fn()
	return {
		mockOutputChannel: {
			appendLine,
		},
	}
})
vi.mock("../../../utils/outputChannel", () => ({
	getOutputChannel: vi.fn(() => mockOutputChannel),
}))

// Mock vscode module
vi.mock("vscode", () => ({
	workspace: {
		getConfiguration: vi.fn(() => ({
			get: vi.fn(),
		})),
	},
}))

// Mock Package module
vi.mock("../../../shared/package", () => ({
	Package: {
		name: "shofer",
	},
}))

import { attemptCompletionTool, AttemptCompletionCallbacks } from "../AttemptCompletionTool"
import { Task } from "../../task/Task"
import * as vscode from "vscode"

describe("attemptCompletionTool", () => {
	let mockTask: Partial<Task>
	let mockPushToolResult: ReturnType<typeof vi.fn>
	let mockAskApproval: ReturnType<typeof vi.fn>
	let mockHandleError: ReturnType<typeof vi.fn>
	let mockToolDescription: ReturnType<typeof vi.fn>
	let mockAskFinishSubTaskApproval: ReturnType<typeof vi.fn>
	let mockGetConfiguration: ReturnType<typeof vi.fn>

	beforeEach(() => {
		mockCaptureTaskCompleted.mockReset()
		mockOutputChannel.appendLine.mockClear()
		mockPushToolResult = vi.fn()
		mockAskApproval = vi.fn()
		mockHandleError = vi.fn()
		mockToolDescription = vi.fn()
		mockAskFinishSubTaskApproval = vi.fn()
		mockGetConfiguration = vi.fn(() => ({
			get: vi.fn((key: string, defaultValue: any) => {
				if (key === "preventCompletionWithOpenTodos") {
					return defaultValue // Default to false unless overridden in test
				}
				return defaultValue
			}),
		}))

		// Setup vscode mock
		vi.mocked(vscode.workspace.getConfiguration).mockImplementation(mockGetConfiguration)

		mockTask = {
			consecutiveMistakeCount: 0,
			recordToolError: vi.fn(),
			sayAndCreateMissingParamError: vi.fn().mockResolvedValue("Error: missing parameter"),
			todoList: undefined,
			say: vi.fn().mockResolvedValue(undefined),
			ask: vi.fn().mockResolvedValue({ response: "yesButtonClicked", text: "", images: [] }),
			emitFinalTokenUsageUpdate: vi.fn(),
			emit: vi.fn(),
			abortBackgroundChildren: vi.fn().mockResolvedValue(undefined),
			getTokenUsage: vi.fn().mockReturnValue({}),
			toolUsage: {},
			taskId: "task_1",
			apiConfiguration: { apiProvider: "test" } as any,
			api: { getModel: vi.fn().mockReturnValue({ id: "test-model", info: {} }) } as any,
			providerRef: { deref: vi.fn().mockReturnValue({}) } as any,
			messageQueueService: {
				isEmpty: vi.fn().mockReturnValue(true),
				dequeueMessage: vi.fn().mockReturnValue(null),
			} as any,
		}
	})

	describe("todo list validation", () => {
		it("should allow completion when there is no todo list", async () => {
			const block: AttemptCompletionToolUse = {
				type: "tool_use",
				name: "attempt_completion",
				params: { result: "Task completed successfully", rating: "excellent" },
				nativeArgs: { result: "Task completed successfully", rating: "excellent" },
				partial: false,
			}

			mockTask.todoList = undefined

			const callbacks: AttemptCompletionCallbacks = {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
				askFinishSubTaskApproval: mockAskFinishSubTaskApproval,
				toolDescription: mockToolDescription,
			}
			await attemptCompletionTool.handle(mockTask as Task, block, callbacks)

			// Should not call pushToolResult with an error for empty todo list
			expect(mockTask.consecutiveMistakeCount).toBe(0)
			expect(mockTask.recordToolError).not.toHaveBeenCalled()
		})

		it("should allow completion when todo list is empty", async () => {
			const block: AttemptCompletionToolUse = {
				type: "tool_use",
				name: "attempt_completion",
				params: { result: "Task completed successfully", rating: "excellent" },
				nativeArgs: { result: "Task completed successfully", rating: "excellent" },
				partial: false,
			}

			mockTask.todoList = []

			const callbacks: AttemptCompletionCallbacks = {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
				askFinishSubTaskApproval: mockAskFinishSubTaskApproval,
				toolDescription: mockToolDescription,
			}
			await attemptCompletionTool.handle(mockTask as Task, block, callbacks)

			expect(mockTask.consecutiveMistakeCount).toBe(0)
			expect(mockTask.recordToolError).not.toHaveBeenCalled()
		})

		it("should allow completion when all todos are completed", async () => {
			const block: AttemptCompletionToolUse = {
				type: "tool_use",
				name: "attempt_completion",
				params: { result: "Task completed successfully", rating: "excellent" },
				nativeArgs: { result: "Task completed successfully", rating: "excellent" },
				partial: false,
			}

			const completedTodos: TodoItem[] = [
				{ id: "1", content: "First task", status: "completed" },
				{ id: "2", content: "Second task", status: "completed" },
			]

			mockTask.todoList = completedTodos

			const callbacks: AttemptCompletionCallbacks = {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
				askFinishSubTaskApproval: mockAskFinishSubTaskApproval,
				toolDescription: mockToolDescription,
			}
			await attemptCompletionTool.handle(mockTask as Task, block, callbacks)

			expect(mockTask.consecutiveMistakeCount).toBe(0)
			expect(mockTask.recordToolError).not.toHaveBeenCalled()
		})

		it("should prevent completion when there are pending todos", async () => {
			const block: AttemptCompletionToolUse = {
				type: "tool_use",
				name: "attempt_completion",
				params: { result: "Task completed successfully", rating: "excellent" },
				nativeArgs: { result: "Task completed successfully", rating: "excellent" },
				partial: false,
			}

			const todosWithPending: TodoItem[] = [
				{ id: "1", content: "First task", status: "completed" },
				{ id: "2", content: "Second task", status: "pending" },
			]

			mockTask.todoList = todosWithPending

			// Enable the setting to prevent completion with open todos
			mockGetConfiguration.mockReturnValue({
				get: vi.fn((key: string, defaultValue: any) => {
					if (key === "preventCompletionWithOpenTodos") {
						return true // Setting is enabled
					}
					return defaultValue
				}),
			})

			const callbacks: AttemptCompletionCallbacks = {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
				askFinishSubTaskApproval: mockAskFinishSubTaskApproval,
				toolDescription: mockToolDescription,
			}
			await attemptCompletionTool.handle(mockTask as Task, block, callbacks)

			expect(mockTask.consecutiveMistakeCount).toBe(1)
			expect(mockTask.recordToolError).toHaveBeenCalledWith("attempt_completion")
			expect(mockPushToolResult).toHaveBeenCalledWith(
				expect.stringContaining("Cannot complete task while there are incomplete todos"),
			)
		})

		it("should prevent completion when there are in-progress todos", async () => {
			const block: AttemptCompletionToolUse = {
				type: "tool_use",
				name: "attempt_completion",
				params: { result: "Task completed successfully", rating: "excellent" },
				nativeArgs: { result: "Task completed successfully", rating: "excellent" },
				partial: false,
			}

			const todosWithInProgress: TodoItem[] = [
				{ id: "1", content: "First task", status: "completed" },
				{ id: "2", content: "Second task", status: "in_progress" },
			]

			mockTask.todoList = todosWithInProgress

			// Enable the setting to prevent completion with open todos
			mockGetConfiguration.mockReturnValue({
				get: vi.fn((key: string, defaultValue: any) => {
					if (key === "preventCompletionWithOpenTodos") {
						return true // Setting is enabled
					}
					return defaultValue
				}),
			})

			const callbacks: AttemptCompletionCallbacks = {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
				askFinishSubTaskApproval: mockAskFinishSubTaskApproval,
				toolDescription: mockToolDescription,
			}
			await attemptCompletionTool.handle(mockTask as Task, block, callbacks)

			expect(mockTask.consecutiveMistakeCount).toBe(1)
			expect(mockTask.recordToolError).toHaveBeenCalledWith("attempt_completion")
			expect(mockPushToolResult).toHaveBeenCalledWith(
				expect.stringContaining("Cannot complete task while there are incomplete todos"),
			)
		})

		it("should prevent completion when there are mixed incomplete todos", async () => {
			const block: AttemptCompletionToolUse = {
				type: "tool_use",
				name: "attempt_completion",
				params: { result: "Task completed successfully", rating: "excellent" },
				nativeArgs: { result: "Task completed successfully", rating: "excellent" },
				partial: false,
			}

			const mixedTodos: TodoItem[] = [
				{ id: "1", content: "First task", status: "completed" },
				{ id: "2", content: "Second task", status: "pending" },
				{ id: "3", content: "Third task", status: "in_progress" },
			]

			mockTask.todoList = mixedTodos

			// Enable the setting to prevent completion with open todos
			mockGetConfiguration.mockReturnValue({
				get: vi.fn((key: string, defaultValue: any) => {
					if (key === "preventCompletionWithOpenTodos") {
						return true // Setting is enabled
					}
					return defaultValue
				}),
			})

			const callbacks: AttemptCompletionCallbacks = {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
				askFinishSubTaskApproval: mockAskFinishSubTaskApproval,
				toolDescription: mockToolDescription,
			}
			await attemptCompletionTool.handle(mockTask as Task, block, callbacks)

			expect(mockTask.consecutiveMistakeCount).toBe(1)
			expect(mockTask.recordToolError).toHaveBeenCalledWith("attempt_completion")
			expect(mockPushToolResult).toHaveBeenCalledWith(
				expect.stringContaining("Cannot complete task while there are incomplete todos"),
			)
		})

		it("should allow completion when setting is disabled even with incomplete todos", async () => {
			const block: AttemptCompletionToolUse = {
				type: "tool_use",
				name: "attempt_completion",
				params: { result: "Task completed successfully", rating: "excellent" },
				nativeArgs: { result: "Task completed successfully", rating: "excellent" },
				partial: false,
			}

			const todosWithPending: TodoItem[] = [
				{ id: "1", content: "First task", status: "completed" },
				{ id: "2", content: "Second task", status: "pending" },
			]

			mockTask.todoList = todosWithPending

			// Ensure the setting is disabled (default behavior)
			mockGetConfiguration.mockReturnValue({
				get: vi.fn((key: string, defaultValue: any) => {
					if (key === "preventCompletionWithOpenTodos") {
						return false // Setting is disabled
					}
					return defaultValue
				}),
			})

			const callbacks: AttemptCompletionCallbacks = {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
				askFinishSubTaskApproval: mockAskFinishSubTaskApproval,
				toolDescription: mockToolDescription,
			}
			await attemptCompletionTool.handle(mockTask as Task, block, callbacks)

			// Should not prevent completion when setting is disabled
			expect(mockTask.consecutiveMistakeCount).toBe(0)
			expect(mockTask.recordToolError).not.toHaveBeenCalled()
			expect(mockPushToolResult).not.toHaveBeenCalledWith(
				expect.stringContaining("Cannot complete task while there are incomplete todos"),
			)
		})

		it("should prevent completion when setting is enabled with incomplete todos", async () => {
			const block: AttemptCompletionToolUse = {
				type: "tool_use",
				name: "attempt_completion",
				params: { result: "Task completed successfully", rating: "excellent" },
				nativeArgs: { result: "Task completed successfully", rating: "excellent" },
				partial: false,
			}

			const todosWithPending: TodoItem[] = [
				{ id: "1", content: "First task", status: "completed" },
				{ id: "2", content: "Second task", status: "pending" },
			]

			mockTask.todoList = todosWithPending

			// Enable the setting
			mockGetConfiguration.mockReturnValue({
				get: vi.fn((key: string, defaultValue: any) => {
					if (key === "preventCompletionWithOpenTodos") {
						return true // Setting is enabled
					}
					return defaultValue
				}),
			})

			const callbacks: AttemptCompletionCallbacks = {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
				askFinishSubTaskApproval: mockAskFinishSubTaskApproval,
				toolDescription: mockToolDescription,
			}
			await attemptCompletionTool.handle(mockTask as Task, block, callbacks)

			// Should prevent completion when setting is enabled and there are incomplete todos
			expect(mockTask.consecutiveMistakeCount).toBe(1)
			expect(mockTask.recordToolError).toHaveBeenCalledWith("attempt_completion")
			expect(mockPushToolResult).toHaveBeenCalledWith(
				expect.stringContaining("Cannot complete task while there are incomplete todos"),
			)
		})

		it("should allow completion when setting is enabled but all todos are completed", async () => {
			const block: AttemptCompletionToolUse = {
				type: "tool_use",
				name: "attempt_completion",
				params: { result: "Task completed successfully", rating: "excellent" },
				nativeArgs: { result: "Task completed successfully", rating: "excellent" },
				partial: false,
			}

			const completedTodos: TodoItem[] = [
				{ id: "1", content: "First task", status: "completed" },
				{ id: "2", content: "Second task", status: "completed" },
			]

			mockTask.todoList = completedTodos

			// Enable the setting
			mockGetConfiguration.mockReturnValue({
				get: vi.fn((key: string, defaultValue: any) => {
					if (key === "preventCompletionWithOpenTodos") {
						return true // Setting is enabled
					}
					return defaultValue
				}),
			})

			const callbacks: AttemptCompletionCallbacks = {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
				askFinishSubTaskApproval: mockAskFinishSubTaskApproval,
				toolDescription: mockToolDescription,
			}
			await attemptCompletionTool.handle(mockTask as Task, block, callbacks)

			// Should allow completion when setting is enabled but all todos are completed
			expect(mockTask.consecutiveMistakeCount).toBe(0)
			expect(mockTask.recordToolError).not.toHaveBeenCalled()
			expect(mockPushToolResult).not.toHaveBeenCalledWith(
				expect.stringContaining("Cannot complete task while there are incomplete todos"),
			)
		})

		describe("tool failure guardrail", () => {
			it("should prevent completion when a previous tool failed in the current turn", async () => {
				const block: AttemptCompletionToolUse = {
					type: "tool_use",
					name: "attempt_completion",
					params: { result: "Task completed successfully", rating: "excellent" },
					nativeArgs: { result: "Task completed successfully", rating: "excellent" },
					partial: false,
				}

				mockTask.todoList = undefined
				mockTask.didToolFailInCurrentTurn = true

				const callbacks: AttemptCompletionCallbacks = {
					askApproval: mockAskApproval,
					handleError: mockHandleError,
					pushToolResult: mockPushToolResult,
					askFinishSubTaskApproval: mockAskFinishSubTaskApproval,
					toolDescription: mockToolDescription,
				}

				const mockSay = vi.fn()
				mockTask.say = mockSay

				await attemptCompletionTool.handle(mockTask as Task, block, callbacks)

				expect(mockSay).toHaveBeenCalledWith(
					"error",
					expect.stringContaining("errors.attempt_completion_tool_failed"),
				)
				expect(mockPushToolResult).toHaveBeenCalledWith(
					expect.stringContaining("errors.attempt_completion_tool_failed"),
				)
			})

			it("should allow completion when no tools failed", async () => {
				const block: AttemptCompletionToolUse = {
					type: "tool_use",
					name: "attempt_completion",
					params: { result: "Task completed successfully", rating: "excellent" },
					nativeArgs: { result: "Task completed successfully", rating: "excellent" },
					partial: false,
				}

				mockTask.todoList = undefined
				mockTask.didToolFailInCurrentTurn = false

				const callbacks: AttemptCompletionCallbacks = {
					askApproval: mockAskApproval,
					handleError: mockHandleError,
					pushToolResult: mockPushToolResult,
					askFinishSubTaskApproval: mockAskFinishSubTaskApproval,
					toolDescription: mockToolDescription,
				}

				await attemptCompletionTool.handle(mockTask as Task, block, callbacks)

				expect(mockTask.consecutiveMistakeCount).toBe(0)
				expect(mockTask.recordToolError).not.toHaveBeenCalled()
			})
		})

		describe("completion lifecycle", () => {
			it("emits TaskCompleted only when completion is accepted", async () => {
				const block: AttemptCompletionToolUse = {
					type: "tool_use",
					name: "attempt_completion",
					params: { result: "2", rating: "excellent" },
					nativeArgs: { result: "2", rating: "excellent" },
					partial: false,
				}

				mockTask.ask = vi.fn().mockResolvedValue({ response: "yesButtonClicked", text: "", images: [] })

				const callbacks: AttemptCompletionCallbacks = {
					askApproval: mockAskApproval,
					handleError: mockHandleError,
					pushToolResult: mockPushToolResult,
					askFinishSubTaskApproval: mockAskFinishSubTaskApproval,
					toolDescription: mockToolDescription,
				}

				await attemptCompletionTool.handle(mockTask as Task, block, callbacks)

				expect(mockHandleError).not.toHaveBeenCalled()
				expect(mockCaptureTaskCompleted).toHaveBeenCalledWith("task_1")
				expect(mockTask.emit).toHaveBeenCalledWith(
					ShoferEventName.TaskCompleted,
					"task_1",
					expect.anything(),
					expect.anything(),
					{ rating: "excellent", isSubtask: false },
				)
			})

			it("drains queued message and returns instead of completing", async () => {
				const block: AttemptCompletionToolUse = {
					type: "tool_use",
					name: "attempt_completion",
					params: { result: "2", rating: "excellent" },
					nativeArgs: { result: "2", rating: "excellent" },
					partial: false,
				}

				// Simulate a queued message — tool should drain it instead of completing.
				// Use Object.defineProperty because messageQueueService is readonly on Task.
				Object.defineProperty(mockTask, "messageQueueService", {
					value: {
						isEmpty: vi.fn().mockReturnValue(false),
						dequeueMessage: vi
							.fn()
							.mockReturnValue({ text: "Different question now: what is 3+3?", images: [] }),
					},
					writable: true,
					configurable: true,
				})

				const callbacks: AttemptCompletionCallbacks = {
					askApproval: mockAskApproval,
					handleError: mockHandleError,
					pushToolResult: mockPushToolResult,
					askFinishSubTaskApproval: mockAskFinishSubTaskApproval,
					toolDescription: mockToolDescription,
				}

				await attemptCompletionTool.handle(mockTask as Task, block, callbacks)

				expect(mockHandleError).not.toHaveBeenCalled()
				expect(mockCaptureTaskCompleted).not.toHaveBeenCalled()
				expect(mockTask.emit).not.toHaveBeenCalledWith(
					ShoferEventName.TaskCompleted,
					expect.anything(),
					expect.anything(),
					expect.anything(),
					expect.anything(),
				)
				expect(mockPushToolResult).toHaveBeenCalledWith(expect.stringContaining("<user_message>"))
			})
		})

		describe("rating validation", () => {
			it("should default to 'poor' when rating is missing", async () => {
				const block: AttemptCompletionToolUse = {
					type: "tool_use",
					name: "attempt_completion",
					params: { result: "Task completed successfully" },
					nativeArgs: { result: "Task completed successfully" },
					partial: false,
				}

				mockTask.todoList = undefined

				const callbacks: AttemptCompletionCallbacks = {
					askApproval: mockAskApproval,
					handleError: mockHandleError,
					pushToolResult: mockPushToolResult,
					askFinishSubTaskApproval: mockAskFinishSubTaskApproval,
					toolDescription: mockToolDescription,
				}

				await attemptCompletionTool.handle(mockTask as Task, block, callbacks)

				// Should not block completion — defaults to "poor"
				expect(mockTask.consecutiveMistakeCount).toBe(0)
				expect(mockTask.recordToolError).not.toHaveBeenCalled()
				expect(mockPushToolResult).not.toHaveBeenCalledWith(
					expect.stringContaining("Missing value for required parameter"),
				)
			})

			it('should default to "poor" when rating is invalid', async () => {
				const block: AttemptCompletionToolUse = {
					type: "tool_use",
					name: "attempt_completion",
					params: { result: "Task completed successfully", rating: "invalid" },
					nativeArgs: { result: "Task completed successfully", rating: "invalid" },
					partial: false,
				}

				mockTask.todoList = undefined

				const callbacks: AttemptCompletionCallbacks = {
					askApproval: mockAskApproval,
					handleError: mockHandleError,
					pushToolResult: mockPushToolResult,
					askFinishSubTaskApproval: mockAskFinishSubTaskApproval,
					toolDescription: mockToolDescription,
				}

				await attemptCompletionTool.handle(mockTask as Task, block, callbacks)

				// Should not block completion — defaults to "poor"
				expect(mockTask.consecutiveMistakeCount).toBe(0)
				expect(mockTask.recordToolError).not.toHaveBeenCalled()
				expect(mockPushToolResult).not.toHaveBeenCalledWith(
					expect.stringContaining("Missing value for required parameter"),
				)
			})

			it('should accept valid ratings ("poor", "well", "excellent")', async () => {
				for (const rating of ["poor", "well", "excellent"]) {
					const block: AttemptCompletionToolUse = {
						type: "tool_use",
						name: "attempt_completion",
						params: { result: "Done", rating } as any,
						nativeArgs: { result: "Done", rating } as any,
						partial: false,
					}

					mockTask.todoList = undefined
					mockTask.consecutiveMistakeCount = 0
					mockTask.recordToolError = vi.fn()
					mockTask.ask = vi.fn().mockResolvedValue({ response: "yesButtonClicked", text: "", images: [] })
					mockPushToolResult = vi.fn()

					const callbacks: AttemptCompletionCallbacks = {
						askApproval: mockAskApproval,
						handleError: mockHandleError,
						pushToolResult: mockPushToolResult,
						askFinishSubTaskApproval: mockAskFinishSubTaskApproval,
						toolDescription: mockToolDescription,
					}

					await attemptCompletionTool.handle(mockTask as Task, block, callbacks)

					expect(mockTask.recordToolError).not.toHaveBeenCalled()
				}
			})
		})

		describe("feedback parameter", () => {
			it("should route optional feedback to the output channel", async () => {
				const block: AttemptCompletionToolUse = {
					type: "tool_use",
					name: "attempt_completion",
					params: {
						result: "Done",
						rating: "excellent",
						feedback: "The file tool was slow for large directories",
					},
					nativeArgs: {
						result: "Done",
						rating: "excellent",
						feedback: "The file tool was slow for large directories",
					},
					partial: false,
				}

				mockTask.todoList = undefined

				const callbacks: AttemptCompletionCallbacks = {
					askApproval: mockAskApproval,
					handleError: mockHandleError,
					pushToolResult: mockPushToolResult,
					askFinishSubTaskApproval: mockAskFinishSubTaskApproval,
					toolDescription: mockToolDescription,
				}

				await attemptCompletionTool.handle(mockTask as Task, block, callbacks)

				expect(mockOutputChannel.appendLine).toHaveBeenCalled()
				const calls = mockOutputChannel.appendLine.mock.calls.flat()
				expect(calls.some((c: string) => c.includes("[FEEDBACK via attempt_completion]"))).toBe(true)
				expect(calls.some((c: string) => c.includes("The file tool was slow for large directories"))).toBe(true)
			})

			it("should not write to output channel when feedback is empty", async () => {
				const block: AttemptCompletionToolUse = {
					type: "tool_use",
					name: "attempt_completion",
					params: { result: "Done", rating: "excellent", feedback: "" },
					nativeArgs: { result: "Done", rating: "excellent", feedback: "" },
					partial: false,
				}

				mockTask.todoList = undefined

				const callbacks: AttemptCompletionCallbacks = {
					askApproval: mockAskApproval,
					handleError: mockHandleError,
					pushToolResult: mockPushToolResult,
					askFinishSubTaskApproval: mockAskFinishSubTaskApproval,
					toolDescription: mockToolDescription,
				}

				mockOutputChannel.appendLine.mockClear()

				await attemptCompletionTool.handle(mockTask as Task, block, callbacks)

				// Should not have logged anything about feedback
				const calls = mockOutputChannel.appendLine.mock.calls.flat()
				expect(calls.some((c: string) => c.includes("[FEEDBACK via attempt_completion]"))).toBe(false)
			})

			it("should not write to output channel when feedback is whitespace only", async () => {
				const block: AttemptCompletionToolUse = {
					type: "tool_use",
					name: "attempt_completion",
					params: { result: "Done", rating: "excellent", feedback: "   " },
					nativeArgs: { result: "Done", rating: "excellent", feedback: "   " },
					partial: false,
				}

				mockTask.todoList = undefined

				const callbacks: AttemptCompletionCallbacks = {
					askApproval: mockAskApproval,
					handleError: mockHandleError,
					pushToolResult: mockPushToolResult,
					askFinishSubTaskApproval: mockAskFinishSubTaskApproval,
					toolDescription: mockToolDescription,
				}

				mockOutputChannel.appendLine.mockClear()

				await attemptCompletionTool.handle(mockTask as Task, block, callbacks)

				const calls = mockOutputChannel.appendLine.mock.calls.flat()
				expect(calls.some((c: string) => c.includes("[FEEDBACK via attempt_completion]"))).toBe(false)
			})
		})
	})
})
