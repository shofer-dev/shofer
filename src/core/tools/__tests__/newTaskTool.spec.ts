// npx vitest core/tools/__tests__/newTaskTool.spec.ts

import type { AskApproval, HandleError, NativeToolArgs, ToolUse } from "../../../shared/tools"

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
		publisher: "shofer",
		version: "1.0.0",
		outputChannel: "Shofer",
	},
}))

// Mock other modules first - these are hoisted to the top
vi.mock("../../../shared/modes", () => ({
	getModeBySlug: vi.fn(),
	defaultModeSlug: "ask",
}))

vi.mock("../../prompts/responses", () => ({
	formatResponse: {
		toolError: vi.fn((msg: string) => `Tool Error: ${msg}`),
	},
}))

vi.mock("../updateTodoListTool", () => ({
	parseMarkdownChecklist: vi.fn((md: string) => {
		// Simple mock implementation
		const lines = md.split("\n").filter((line) => line.trim())
		return lines.map((line, index) => {
			let status = "pending"
			let content = line

			if (line.includes("[x]") || line.includes("[X]")) {
				status = "completed"
				content = line.replace(/^\[x\]\s*/i, "")
			} else if (line.includes("[-]") || line.includes("[~]")) {
				status = "in_progress"
				content = line.replace(/^\[-\]\s*/, "").replace(/^\[~\]\s*/, "")
			} else {
				content = line.replace(/^\[\s*\]\s*/, "")
			}

			return {
				id: `todo-${index}`,
				content,
				status,
			}
		})
	}),
}))

// Provider method mocks — shared across describe blocks
const mockCreateTask = vi.fn().mockResolvedValue({ taskId: "child-1" })
/**
 * Fires the resolver immediately so `await childCompletionPromise` in
 * NewTaskTool.execute() unblocks synchronously in tests.
 */
const mockRegisterBlockingChildResolver = vi.fn((_childTaskId: string, resolver: (result: string) => void) => {
	resolver("Task completed successfully")
})
const mockGetTaskWithId = vi.fn().mockResolvedValue({
	historyItem: { id: "mock-parent-task-id", status: "active", childIds: [] },
})
const mockUpdateTaskHistory = vi.fn().mockResolvedValue([])
const mockRegisterBackgroundTask = vi.fn()

const mockAskApproval = vi.fn<AskApproval>()
const mockHandleError = vi.fn<HandleError>()
const mockPushToolResult = vi.fn()
const mockEmit = vi.fn()
const mockRecordToolError = vi.fn()
const mockSayAndCreateMissingParamError = vi.fn()
const mockCheckpointSave = vi.fn()

// Mock the Shofer instance and its methods/properties.
// backgroundChildren is a real Map so set/get work correctly.
const mockShofer = {
	ask: vi.fn(),
	sayAndCreateMissingParamError: mockSayAndCreateMissingParamError,
	emit: mockEmit,
	recordToolError: mockRecordToolError,
	consecutiveMistakeCount: 0,
	didToolFailInCurrentTurn: false,
	isPaused: false,
	pausedModeSlug: "ask",
	taskId: "mock-parent-task-id",
	enableCheckpoints: false,
	checkpointSave: mockCheckpointSave,
	getTaskMode: vi.fn().mockResolvedValue(undefined),
	backgroundChildren: new Map<string, any>(),
	providerRef: {
		deref: vi.fn(() => ({
			getState: vi.fn().mockResolvedValue({ customModes: [], mode: "ask" }),
			createTask: mockCreateTask,
			registerBlockingChildResolver: mockRegisterBlockingChildResolver,
			getTaskWithId: mockGetTaskWithId,
			updateTaskHistory: mockUpdateTaskHistory,
			taskManager: {
				registerBackgroundTask: mockRegisterBackgroundTask,
			},
		})),
	},
}

// Import the class to test AFTER mocks are set up
import { newTaskTool } from "../NewTaskTool"
import { getModeBySlug } from "../../../shared/modes"
import * as vscode from "vscode"

/**
 * Wraps a block with nativeArgs for the BaseTool.handle() native-args path.
 * `is_background` is forwarded so the tool's boolean normalisation runs correctly.
 *
 * Injects default values for the now-mandatory `result_length` and
 * `estimated_timeout` parameters unless the test already provides them, so
 * the existing test cases (which predate those parameters) continue to exercise
 * the post-validation code paths.
 */
const withNativeArgs = (block: ToolUse<"new_task">): ToolUse<"new_task"> => {
	const paramsWithDefaults = {
		...block.params,
		result_length: (block.params as any).result_length ?? 1000,
		estimated_timeout: (block.params as any).estimated_timeout ?? 60,
	}
	return {
		...block,
		params: paramsWithDefaults,
		nativeArgs: {
			mode: paramsWithDefaults.mode,
			message: paramsWithDefaults.message,
			todos: paramsWithDefaults.todos,
			is_background: paramsWithDefaults.is_background,
			result_length: paramsWithDefaults.result_length,
			estimated_timeout: paramsWithDefaults.estimated_timeout,
		} as unknown as NativeToolArgs["new_task"],
	}
}

describe("newTaskTool", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockAskApproval.mockResolvedValue(true)
		vi.mocked(getModeBySlug).mockReturnValue({
			slug: "code",
			name: "Code Mode",
			roleDefinition: "Test role definition",
			groups: ["execute", "read", "write"],
		})
		mockShofer.consecutiveMistakeCount = 0
		mockShofer.didToolFailInCurrentTurn = false
		mockShofer.isPaused = false
		mockShofer.backgroundChildren.clear()
		// Re-wire the resolver mock: fires immediately to unblock the foreground await.
		mockRegisterBlockingChildResolver.mockImplementation(
			(_childTaskId: string, resolver: (result: string) => void) => {
				resolver("Task completed successfully")
			},
		)
		mockCreateTask.mockResolvedValue({ taskId: "child-1" })
		mockGetTaskWithId.mockResolvedValue({
			historyItem: { id: "mock-parent-task-id", status: "active", childIds: [] },
		})
		// Default: VSCode setting is disabled
		const mockGet = vi.fn().mockReturnValue(false)
		vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
			get: mockGet,
		} as any)
	})

	it("should correctly un-escape \\\\@ to \\@ in the message passed to the new task", async () => {
		const block: ToolUse<"new_task"> = {
			type: "tool_use",
			name: "new_task",
			params: {
				mode: "code",
				message: "Review this: \\\\@file1.txt and also \\\\\\\\@file2.txt",
				todos: "[ ] First task\n[ ] Second task",
				is_background: "false",
			},
			partial: false,
		}

		await newTaskTool.handle(mockShofer as any, withNativeArgs(block), {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			pushToolResult: mockPushToolResult,
		})

		expect(mockAskApproval).toHaveBeenCalled()

		// createTask receives the unescaped message
		expect(mockCreateTask).toHaveBeenCalledWith(
			"Review this: \\@file1.txt and also \\\\\\@file2.txt",
			undefined,
			mockShofer,
			expect.objectContaining({
				initialTodos: [],
				initialMode: "code",
			}),
			undefined,
			undefined,
		)

		expect(mockPushToolResult).toHaveBeenCalledWith(expect.stringContaining("Subtask child-1 completed"))
	})

	it("should not un-escape single escaped \\@", async () => {
		const block: ToolUse<"new_task"> = {
			type: "tool_use",
			name: "new_task",
			params: {
				mode: "code",
				message: "This is already unescaped: \\@file1.txt",
				todos: "[ ] Test todo",
				is_background: "false",
			},
			partial: false,
		}

		await newTaskTool.handle(mockShofer as any, withNativeArgs(block), {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			pushToolResult: mockPushToolResult,
		})

		expect(mockCreateTask).toHaveBeenCalledWith(
			"This is already unescaped: \\@file1.txt",
			undefined,
			mockShofer,
			expect.objectContaining({ initialMode: "code" }),
			undefined,
			undefined,
		)
	})

	it("should not un-escape non-escaped @", async () => {
		const block: ToolUse<"new_task"> = {
			type: "tool_use",
			name: "new_task",
			params: {
				mode: "code",
				message: "A normal mention @file1.txt",
				todos: "[ ] Test todo",
				is_background: "false",
			},
			partial: false,
		}

		await newTaskTool.handle(mockShofer as any, withNativeArgs(block), {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			pushToolResult: mockPushToolResult,
		})

		expect(mockCreateTask).toHaveBeenCalledWith(
			"A normal mention @file1.txt",
			undefined,
			mockShofer,
			expect.objectContaining({ initialMode: "code" }),
			undefined,
			undefined,
		)
	})

	it("should handle mixed escaping scenarios", async () => {
		const block: ToolUse<"new_task"> = {
			type: "tool_use",
			name: "new_task",
			params: {
				mode: "code",
				message: "Mix: @file0.txt, \\@file1.txt, \\\\@file2.txt, \\\\\\\\@file3.txt",
				todos: "[ ] Test todo",
				is_background: "false",
			},
			partial: false,
		}

		await newTaskTool.handle(mockShofer as any, withNativeArgs(block), {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			pushToolResult: mockPushToolResult,
		})

		expect(mockCreateTask).toHaveBeenCalledWith(
			"Mix: @file0.txt, \\@file1.txt, \\@file2.txt, \\\\\\@file3.txt",
			undefined,
			mockShofer,
			expect.objectContaining({ initialMode: "code" }),
			undefined,
			undefined,
		)
	})

	it("should handle missing todos parameter gracefully (backward compatibility)", async () => {
		const block: ToolUse<"new_task"> = {
			type: "tool_use",
			name: "new_task",
			params: {
				mode: "code",
				message: "Test message",
				is_background: "false",
				// todos missing - should work for backward compatibility
			},
			partial: false,
		}

		await newTaskTool.handle(mockShofer as any, withNativeArgs(block), {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			pushToolResult: mockPushToolResult,
		})

		expect(mockSayAndCreateMissingParamError).not.toHaveBeenCalledWith("new_task", "todos")
		expect(mockShofer.consecutiveMistakeCount).toBe(0)
		expect(mockShofer.recordToolError).not.toHaveBeenCalledWith("new_task")

		expect(mockCreateTask).toHaveBeenCalledWith(
			"Test message",
			undefined,
			mockShofer,
			expect.objectContaining({ initialTodos: [], initialMode: "code" }),
			undefined,
			undefined,
		)

		expect(mockPushToolResult).toHaveBeenCalledWith(expect.stringContaining("Subtask child-1 completed"))
	})

	it("should work with todos parameter when provided", async () => {
		const block: ToolUse<"new_task"> = {
			type: "tool_use",
			name: "new_task",
			params: {
				mode: "code",
				message: "Test message with todos",
				todos: "[ ] First task\n[ ] Second task",
				is_background: "false",
			},
			partial: false,
		}

		await newTaskTool.handle(mockShofer as any, withNativeArgs(block), {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			pushToolResult: mockPushToolResult,
		})

		expect(mockCreateTask).toHaveBeenCalledWith(
			"Test message with todos",
			undefined,
			mockShofer,
			expect.objectContaining({
				initialTodos: [],
				initialMode: "code",
			}),
			undefined,
			undefined,
		)

		expect(mockPushToolResult).toHaveBeenCalledWith(expect.stringContaining("Subtask child-1 completed"))
	})

	it("should error when mode parameter is missing", async () => {
		const block: ToolUse<"new_task"> = {
			type: "tool_use",
			name: "new_task",
			params: {
				// mode missing — getTaskMode() returns undefined → error
				message: "Test message",
				todos: "[ ] Test todo",
			},
			partial: false,
		}

		await newTaskTool.handle(mockShofer as any, withNativeArgs(block), {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			pushToolResult: mockPushToolResult,
		})

		expect(mockSayAndCreateMissingParamError).toHaveBeenCalledWith("new_task", "mode")
		expect(mockShofer.consecutiveMistakeCount).toBe(1)
		expect(mockShofer.recordToolError).toHaveBeenCalledWith("new_task")
	})

	it("should error when message parameter is missing", async () => {
		const block: ToolUse<"new_task"> = {
			type: "tool_use",
			name: "new_task",
			params: {
				mode: "code",
				// message missing
				todos: "[ ] Test todo",
			},
			partial: false,
		}

		await newTaskTool.handle(mockShofer as any, withNativeArgs(block), {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			pushToolResult: mockPushToolResult,
		})

		expect(mockSayAndCreateMissingParamError).toHaveBeenCalledWith("new_task", "message")
		expect(mockShofer.consecutiveMistakeCount).toBe(1)
		expect(mockShofer.recordToolError).toHaveBeenCalledWith("new_task")
	})

	it("should parse todos with different statuses correctly", async () => {
		const block: ToolUse<"new_task"> = {
			type: "tool_use",
			name: "new_task",
			params: {
				mode: "code",
				message: "Test message",
				todos: "[ ] Pending task\n[x] Completed task\n[-] In progress task",
				is_background: "false",
			},
			partial: false,
		}

		await newTaskTool.handle(mockShofer as any, withNativeArgs(block), {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			pushToolResult: mockPushToolResult,
		})

		expect(mockCreateTask).toHaveBeenCalledWith(
			"Test message",
			undefined,
			mockShofer,
			expect.objectContaining({
				initialTodos: [],
			}),
			undefined,
			undefined,
		)
	})

	describe("VSCode setting: newTaskRequireTodos", () => {
		it("should NOT require todos when VSCode setting is disabled (default)", async () => {
			const mockGet = vi.fn().mockReturnValue(false)
			vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
				get: mockGet,
			} as any)

			const block: ToolUse<"new_task"> = {
				type: "tool_use",
				name: "new_task",
				params: {
					mode: "code",
					message: "Test message",
					is_background: "false",
					// todos missing - should work when setting is disabled
				},
				partial: false,
			}

			await newTaskTool.handle(mockShofer as any, withNativeArgs(block), {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
			})

			expect(mockSayAndCreateMissingParamError).not.toHaveBeenCalledWith("new_task", "todos")
			expect(mockShofer.consecutiveMistakeCount).toBe(0)
			expect(mockShofer.recordToolError).not.toHaveBeenCalledWith("new_task")

			expect(mockCreateTask).toHaveBeenCalledWith(
				"Test message",
				undefined,
				mockShofer,
				expect.objectContaining({ initialTodos: [], initialMode: "code" }),
				undefined,
				undefined,
			)

			expect(mockPushToolResult).toHaveBeenCalledWith(expect.stringContaining("Subtask child-1 completed"))
		})

		it("should REQUIRE todos when VSCode setting is enabled", async () => {
			const mockGet = vi.fn().mockReturnValue(true)
			vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
				get: mockGet,
			} as any)

			const block: ToolUse<"new_task"> = {
				type: "tool_use",
				name: "new_task",
				params: {
					mode: "code",
					message: "Test message",
					is_background: "false",
					// todos missing - should error when setting is enabled
				},
				partial: false,
			}

			await newTaskTool.handle(mockShofer as any, withNativeArgs(block), {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
			})

			expect(mockSayAndCreateMissingParamError).toHaveBeenCalledWith("new_task", "todos")
			expect(mockShofer.consecutiveMistakeCount).toBe(1)
			expect(mockShofer.recordToolError).toHaveBeenCalledWith("new_task")

			expect(mockCreateTask).not.toHaveBeenCalled()
		})

		it("should work with todos when VSCode setting is enabled", async () => {
			const mockGet = vi.fn().mockReturnValue(true)
			vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
				get: mockGet,
			} as any)

			const block: ToolUse<"new_task"> = {
				type: "tool_use",
				name: "new_task",
				params: {
					mode: "code",
					message: "Test message",
					todos: "[ ] First task\n[ ] Second task",
					is_background: "false",
				},
				partial: false,
			}

			await newTaskTool.handle(mockShofer as any, withNativeArgs(block), {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
			})

			expect(mockSayAndCreateMissingParamError).not.toHaveBeenCalledWith("new_task", "todos")
			expect(mockShofer.consecutiveMistakeCount).toBe(0)

			expect(mockCreateTask).toHaveBeenCalledWith(
				"Test message",
				undefined,
				mockShofer,
				expect.objectContaining({
					initialTodos: [],
					initialMode: "code",
				}),
				undefined,
				undefined,
			)

			expect(mockPushToolResult).toHaveBeenCalledWith(expect.stringContaining("Subtask child-1 completed"))
		})

		it("should work with empty todos string when VSCode setting is enabled", async () => {
			const mockGet = vi.fn().mockReturnValue(true)
			vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
				get: mockGet,
			} as any)

			const block: ToolUse<"new_task"> = {
				type: "tool_use",
				name: "new_task",
				params: {
					mode: "code",
					message: "Test message",
					todos: "", // Empty string should be accepted
					is_background: "false",
				},
				partial: false,
			}

			await newTaskTool.handle(mockShofer as any, withNativeArgs(block), {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
			})

			expect(mockSayAndCreateMissingParamError).not.toHaveBeenCalledWith("new_task", "todos")
			expect(mockShofer.consecutiveMistakeCount).toBe(0)

			expect(mockCreateTask).toHaveBeenCalledWith(
				"Test message",
				undefined,
				mockShofer,
				expect.objectContaining({ initialTodos: [], initialMode: "code" }),
				undefined,
				undefined,
			)

			expect(mockPushToolResult).toHaveBeenCalledWith(expect.stringContaining("Subtask child-1 completed"))
		})

		it("should check VSCode setting with Package.name configuration key", async () => {
			const mockGet = vi.fn().mockReturnValue(false)
			const mockGetConfiguration = vi.fn().mockReturnValue({
				get: mockGet,
			} as any)
			vi.mocked(vscode.workspace.getConfiguration).mockImplementation(mockGetConfiguration)

			const block: ToolUse<"new_task"> = {
				type: "tool_use",
				name: "new_task",
				params: {
					mode: "code",
					message: "Test message",
					is_background: "false",
				},
				partial: false,
			}

			await newTaskTool.handle(mockShofer as any, withNativeArgs(block), {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
			})

			expect(mockGetConfiguration).toHaveBeenCalledWith("shofer")
			expect(mockGet).toHaveBeenCalledWith("newTaskRequireTodos", false)
		})

		it("should use current Package.name value (shofer-nightly) when accessing VSCode configuration", async () => {
			const mockGet = vi.fn().mockReturnValue(false)
			const mockGetConfiguration = vi.fn().mockReturnValue({
				get: mockGet,
			} as any)
			vi.mocked(vscode.workspace.getConfiguration).mockImplementation(mockGetConfiguration)

			const pkg = await import("../../../shared/package")
			;(pkg.Package as any).name = "shofer-nightly"

			const block: ToolUse<"new_task"> = {
				type: "tool_use",
				name: "new_task",
				params: {
					mode: "code",
					message: "Test message",
					is_background: "false",
				},
				partial: false,
			}

			await newTaskTool.handle(mockShofer as any, withNativeArgs(block), {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
			})

			expect(mockGetConfiguration).toHaveBeenCalledWith("shofer-nightly")
			expect(mockGet).toHaveBeenCalledWith("newTaskRequireTodos", false)
		})
	})
})

describe("newTaskTool delegation flow", () => {
	it("creates child via provider.createTask and suspends parent via resolver", async () => {
		// Fresh provider with the same immediate-resolver pattern.
		const localCreateTask = vi.fn().mockResolvedValue({ taskId: "child-1" })
		const localRegisterBlockingChildResolver = vi.fn((_childTaskId: string, resolver: (result: string) => void) => {
			resolver("Work done")
		})
		const localGetTaskWithId = vi.fn().mockResolvedValue({
			historyItem: { id: "mock-parent-task-id", status: "active", childIds: [] },
		})
		const localUpdateTaskHistory = vi.fn().mockResolvedValue([])
		const localEmit = vi.fn()

		const localCline = {
			ask: vi.fn(),
			sayAndCreateMissingParamError: vi.fn(),
			emit: localEmit,
			recordToolError: vi.fn(),
			consecutiveMistakeCount: 0,
			didToolFailInCurrentTurn: false,
			isPaused: false,
			pausedModeSlug: "ask",
			taskId: "mock-parent-task-id",
			enableCheckpoints: false,
			checkpointSave: vi.fn(),
			getTaskMode: vi.fn().mockResolvedValue(undefined),
			backgroundChildren: new Map<string, any>(),
			providerRef: {
				deref: vi.fn(() => ({
					getState: vi.fn().mockResolvedValue({ customModes: [], mode: "ask" }),
					createTask: localCreateTask,
					registerBlockingChildResolver: localRegisterBlockingChildResolver,
					getTaskWithId: localGetTaskWithId,
					updateTaskHistory: localUpdateTaskHistory,
					taskManager: { registerBackgroundTask: vi.fn() },
				})),
			},
		}

		vi.mocked(getModeBySlug).mockReturnValue({
			slug: "code",
			name: "Code Mode",
			roleDefinition: "Test role definition",
			groups: ["execute", "read", "write"],
		})
		vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
			get: vi.fn().mockReturnValue(false),
		} as any)

		const block: ToolUse<"new_task"> = {
			type: "tool_use",
			name: "new_task",
			params: {
				mode: "code",
				message: "Do something",
				is_background: "false",
			},
			partial: false,
		}

		const mockAsk = vi.fn().mockResolvedValue(true)

		await newTaskTool.handle(localCline as any, withNativeArgs(block), {
			askApproval: mockAsk,
			handleError: vi.fn(),
			pushToolResult: mockPushToolResult,
		})

		// createTask called with the unescaped message, no parent image, parent task, and foreground options
		expect(localCreateTask).toHaveBeenCalledWith(
			"Do something",
			undefined,
			localCline,
			expect.objectContaining({
				initialTodos: [],
				initialMode: "code",
				initialState: { lifecycle: "running" },
				openInStack: true,
			}),
			undefined,
			undefined,
		)

		// Resolver registered for the child
		expect(localRegisterBlockingChildResolver).toHaveBeenCalledWith("child-1", expect.any(Function))

		// Parent's result contains child's completion output
		expect(mockPushToolResult).toHaveBeenCalledWith(expect.stringContaining("Subtask child-1 completed"))
		expect(mockPushToolResult).toHaveBeenCalledWith(expect.stringContaining("Work done"))

		// No pause/unpause events emitted
		const pauseEvents = (localEmit as any).mock.calls.filter(
			(c: any[]) => c[0] === "taskPaused" || c[0] === "taskUnpaused",
		)
		expect(pauseEvents.length).toBe(0)
	})
})
