// npx vitest core/tools/__tests__/newTaskTool.spec.ts

import { BUILTIN_MODES } from "../../__fixtures__/builtin-config.js"
import type { AskApproval, HandleError, NativeToolArgs, ToolUse } from "@shofer/types"
import { setHost, createInMemoryHost, InMemoryConfig, type HostBridge } from "@shofer/types"

// After the v3 carve-out the tool + its intra-core deps (formatResponse,
// parseMarkdownChecklist) live inside @shofer/core and call each other via RELATIVE
// imports, so a barrel `vi.mock("@shofer/core")` can no longer intercept them. The tool
// now reads its VS Code setting via `getHost().config.get(Package.name, …)` and resolves
// modes via the real `getModeBySlug` / `parseMarkdownChecklist` — drive those directly.

// Import the tool + collaborators core-relative.
import { newTaskTool } from "../NewTaskTool.js"
import { Package } from "../../shared/package.js"

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
	pausedModeSlug: "code",
	taskId: "mock-parent-task-id",
	getTaskMode: vi.fn().mockResolvedValue(undefined),
	backgroundChildren: new Map<string, any>(),
	// Task-viz records the parent→child spawn (and child→parent return) arrows;
	// the blocking path awaits this before registering the completion resolver.
	emitTaskInteraction: vi.fn().mockResolvedValue(undefined),
	providerRef: {
		deref: vi.fn(() => ({
			getState: vi.fn().mockResolvedValue({ customModes: BUILTIN_MODES, mode: "code" }),
			createTask: mockCreateTask,
			registerBlockingChildResolver: mockRegisterBlockingChildResolver,
			getTaskWithId: mockGetTaskWithId,
			updateTaskHistory: mockUpdateTaskHistory,
			taskManager: {
				registerBackgroundTask: mockRegisterBackgroundTask,
				// Global parallel-task limit guard (NewTaskTool): 0 active so the
				// default limit (10) never blocks task creation in these tests.
				countActiveTasks: vi.fn(() => 0),
			},
			contextProxy: { getValue: vi.fn(() => undefined) },
		})),
	},
}

/**
 * Wraps a block with nativeArgs for the BaseTool.handle() native-args path.
 * `is_background` is forwarded so the tool's boolean normalisation runs correctly.
 *
 * Provides reasonable values for `softResultLength` and `softTimeoutSec` (if not
 * already set) so existing tests (which predate those parameters) continue to exercise
 * the post-validation code paths. Since these parameters are now optional with defaults,
 * the helper simply forwards whatever the block already contains.
 */
const withNativeArgs = (block: ToolUse<"new_task">): ToolUse<"new_task"> => {
	const paramsWithDefaults = {
		...block.params,
		softResultLength: (block.params as any).softResultLength ?? 1000,
		softTimeoutSec: (block.params as any).softTimeoutSec ?? 60,
	}
	return {
		...block,
		params: paramsWithDefaults,
		nativeArgs: {
			mode: paramsWithDefaults.mode,
			message: paramsWithDefaults.message,
			todos: paramsWithDefaults.todos,
			is_background: paramsWithDefaults.is_background,
			softResultLength: paramsWithDefaults.softResultLength,
			softTimeoutSec: paramsWithDefaults.softTimeoutSec,
		} as unknown as NativeToolArgs["new_task"],
	}
}

/** Active in-memory host — the tool reads its VS Code setting via getHost().config. */
let host: HostBridge

/** Drive the `newTaskRequireTodos` setting the tool reads via getHost().config.get. */
const setRequireTodos = (value: boolean) =>
	(host.config as InMemoryConfig).set(Package.name, "newTaskRequireTodos", value)

describe("newTaskTool", () => {
	beforeEach(() => {
		host = createInMemoryHost()
		setHost(host)
		vi.clearAllMocks()
		mockAskApproval.mockResolvedValue(true)
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
		// Default: setting is disabled (in-memory host returns the default false).
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
				initialTodos: expect.any(Array),
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
			expect.objectContaining({ initialTodos: expect.any(Array), initialMode: "code" }),
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
				initialTodos: expect.any(Array),
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
				initialTodos: expect.any(Array),
			}),
			undefined,
			undefined,
		)
	})

	describe("VSCode setting: newTaskRequireTodos", () => {
		it("should NOT require todos when VSCode setting is disabled (default)", async () => {
			setRequireTodos(false)

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
				expect.objectContaining({ initialTodos: expect.any(Array), initialMode: "code" }),
				undefined,
				undefined,
			)

			expect(mockPushToolResult).toHaveBeenCalledWith(expect.stringContaining("Subtask child-1 completed"))
		})

		it("should REQUIRE todos when VSCode setting is enabled", async () => {
			setRequireTodos(true)

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
			setRequireTodos(true)

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
					initialMode: "code",
					initialTodos: expect.arrayContaining([
						expect.objectContaining({ content: "First task", status: "pending" }),
						expect.objectContaining({ content: "Second task", status: "pending" }),
					]),
				}),
				undefined,
				undefined,
			)

			expect(mockPushToolResult).toHaveBeenCalledWith(expect.stringContaining("Subtask child-1 completed"))
		})

		it("should work with empty todos string when VSCode setting is enabled", async () => {
			setRequireTodos(true)

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
				expect.objectContaining({ initialTodos: expect.any(Array), initialMode: "code" }),
				undefined,
				undefined,
			)

			expect(mockPushToolResult).toHaveBeenCalledWith(expect.stringContaining("Subtask child-1 completed"))
		})

		it("should check VSCode setting with Package.name configuration key", async () => {
			const getSpy = vi.spyOn(host.config, "get")

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

			// The tool reads the setting via getHost().config.get(Package.name, key, default).
			expect(getSpy).toHaveBeenCalledWith("shofer", "newTaskRequireTodos", false)
		})

		it("should use current Package.name value (shofer-nightly) when accessing host configuration", async () => {
			// Package.name resolves against the active host's appInfo — swap it to nightly.
			host = {
				...createInMemoryHost(),
				env: { ...host.env, appInfo: { ...host.env.appInfo, name: "shofer-nightly" } },
			}
			setHost(host)
			const getSpy = vi.spyOn(host.config, "get")

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

			expect(getSpy).toHaveBeenCalledWith("shofer-nightly", "newTaskRequireTodos", false)
		})
	})
})

describe("softResultLength and softTimeoutSec defaults", () => {
	/**
	 * When the LLM does not provide softResultLength / softTimeoutSec (or provides
	 * invalid values), the tool MUST apply sensible defaults instead of erroring.
	 * This prevents the churn/retry cycle reported where the agent fails to include
	 * these advisory parameters.
	 */

	beforeEach(() => {
		host = createInMemoryHost()
		setHost(host)
		vi.clearAllMocks()
		mockAskApproval.mockResolvedValue(true)
		mockShofer.consecutiveMistakeCount = 0
		mockShofer.didToolFailInCurrentTurn = false
		mockCreateTask.mockResolvedValue({ taskId: "child-1" })
	})

	it("applies defaults when softResultLength and softTimeoutSec are missing from nativeArgs", async () => {
		// Simulate an LLM call that omits both advisory parameters.
		const block: ToolUse<"new_task"> = {
			type: "tool_use",
			name: "new_task",
			params: {
				mode: "code",
				message: "Do work without soft hints",
				is_background: "false",
			},
			partial: false,
			// nativeArgs deliberately lacks softResultLength and softTimeoutSec
			nativeArgs: {
				mode: "code",
				message: "Do work without soft hints",
				is_background: "false",
			} as any,
		}

		await newTaskTool.handle(mockShofer as any, block, {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			pushToolResult: mockPushToolResult,
		})

		// Must NOT error on missing params
		expect(mockSayAndCreateMissingParamError).not.toHaveBeenCalledWith("new_task", "softResultLength")
		expect(mockSayAndCreateMissingParamError).not.toHaveBeenCalledWith("new_task", "softTimeoutSec")

		// Must pass defaults (2000 chars, 300 sec) to the child task
		expect(mockCreateTask).toHaveBeenCalledWith(
			"Do work without soft hints",
			undefined,
			mockShofer,
			expect.objectContaining({
				softResultLength: 2000,
				softTimeoutSec: 300,
			}),
			undefined,
			undefined,
		)
	})

	it("applies defaults when softResultLength is invalid (negative)", async () => {
		const block: ToolUse<"new_task"> = {
			type: "tool_use",
			name: "new_task",
			params: {
				mode: "code",
				message: "Work",
				is_background: "false",
			},
			partial: false,
			nativeArgs: {
				mode: "code",
				message: "Work",
				is_background: "false",
				softResultLength: -5,
				softTimeoutSec: 120,
			} as any,
		}

		await newTaskTool.handle(mockShofer as any, block, {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			pushToolResult: mockPushToolResult,
		})

		expect(mockSayAndCreateMissingParamError).not.toHaveBeenCalled()
		expect(mockCreateTask).toHaveBeenCalledWith(
			"Work",
			undefined,
			mockShofer,
			expect.objectContaining({
				softResultLength: 2000, // default because -5 is invalid
				softTimeoutSec: 120, // provided value is valid
			}),
			undefined,
			undefined,
		)
	})

	it("clamps softResultLength to MAX_SUBTASK_RESULT_LENGTH when value exceeds cap", async () => {
		const block: ToolUse<"new_task"> = {
			type: "tool_use",
			name: "new_task",
			params: {
				mode: "code",
				message: "Huge result",
				is_background: "false",
			},
			partial: false,
			nativeArgs: {
				mode: "code",
				message: "Huge result",
				is_background: "false",
				softResultLength: 200000,
				softTimeoutSec: 60,
			} as any,
		}

		await newTaskTool.handle(mockShofer as any, block, {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			pushToolResult: mockPushToolResult,
		})

		expect(mockCreateTask).toHaveBeenCalledWith(
			"Huge result",
			undefined,
			mockShofer,
			expect.objectContaining({
				softResultLength: 100000, // clamped to MAX_SUBTASK_RESULT_LENGTH
			}),
			undefined,
			undefined,
		)
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
			pausedModeSlug: "code",
			taskId: "mock-parent-task-id",
			getTaskMode: vi.fn().mockResolvedValue(undefined),
			backgroundChildren: new Map<string, any>(),
			emitTaskInteraction: vi.fn().mockResolvedValue(undefined),
			providerRef: {
				deref: vi.fn(() => ({
					getState: vi.fn().mockResolvedValue({ customModes: BUILTIN_MODES, mode: "code" }),
					createTask: localCreateTask,
					registerBlockingChildResolver: localRegisterBlockingChildResolver,
					getTaskWithId: localGetTaskWithId,
					updateTaskHistory: localUpdateTaskHistory,
					taskManager: { registerBackgroundTask: vi.fn(), countActiveTasks: vi.fn(() => 0) },
					contextProxy: { getValue: vi.fn(() => undefined) },
				})),
			},
		}

		setHost(createInMemoryHost())

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
				initialTodos: expect.any(Array),
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
