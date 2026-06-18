import { askFollowupQuestionTool } from "../AskFollowupQuestionTool"
import { ToolUse } from "../../../shared/tools"
import { NativeToolCallParser } from "../../assistant-message/NativeToolCallParser"

describe("askFollowupQuestionTool", () => {
	let mockShofer: any
	let mockPushToolResult: any
	let toolResult: any

	beforeEach(() => {
		vi.clearAllMocks()

		mockShofer = {
			ask: vi.fn().mockResolvedValue({ text: "Test response" }),
			say: vi.fn().mockResolvedValue(undefined),
			sayAndCreateMissingParamError: vi.fn().mockResolvedValue("Missing parameter error"),
			markFollowupFormAnswered: vi.fn().mockResolvedValue(undefined),
			consecutiveMistakeCount: 0,
			recordToolError: vi.fn(),
		}

		mockPushToolResult = vi.fn((result) => {
			toolResult = result
		})
	})

	it("should parse suggestions without mode attributes", async () => {
		const block: ToolUse = {
			type: "tool_use",
			name: "ask_followup_question",
			params: {
				question: "What would you like to do?",
			},
			nativeArgs: {
				question: "What would you like to do?",
				follow_up: [{ text: "Option 1" }, { text: "Option 2" }],
			},
			partial: false,
		}

		await askFollowupQuestionTool.handle(mockShofer, block as ToolUse<"ask_followup_question">, {
			askApproval: vi.fn(),
			handleError: vi.fn(),
			pushToolResult: mockPushToolResult,
		})

		expect(mockShofer.ask).toHaveBeenCalledWith(
			"followup",
			expect.stringContaining('"suggest":[{"answer":"Option 1"},{"answer":"Option 2"}]'),
			false,
		)
	})

	it("should parse suggestions with mode attributes", async () => {
		const block: ToolUse = {
			type: "tool_use",
			name: "ask_followup_question",
			params: {
				question: "What would you like to do?",
			},
			nativeArgs: {
				question: "What would you like to do?",
				follow_up: [
					{ text: "Write code", mode: "code" },
					{ text: "Debug issue", mode: "debug" },
				],
			},
			partial: false,
		}

		await askFollowupQuestionTool.handle(mockShofer, block as ToolUse<"ask_followup_question">, {
			askApproval: vi.fn(),
			handleError: vi.fn(),
			pushToolResult: mockPushToolResult,
		})

		expect(mockShofer.ask).toHaveBeenCalledWith(
			"followup",
			expect.stringContaining(
				'"suggest":[{"answer":"Write code","mode":"code"},{"answer":"Debug issue","mode":"debug"}]',
			),
			false,
		)
	})

	it("should handle mixed suggestions with and without mode attributes", async () => {
		const block: ToolUse = {
			type: "tool_use",
			name: "ask_followup_question",
			params: {
				question: "What would you like to do?",
			},
			nativeArgs: {
				question: "What would you like to do?",
				follow_up: [{ text: "Regular option" }, { text: "Plan architecture", mode: "architect" }],
			},
			partial: false,
		}

		await askFollowupQuestionTool.handle(mockShofer, block as ToolUse<"ask_followup_question">, {
			askApproval: vi.fn(),
			handleError: vi.fn(),
			pushToolResult: mockPushToolResult,
		})

		expect(mockShofer.ask).toHaveBeenCalledWith(
			"followup",
			expect.stringContaining(
				'"suggest":[{"answer":"Regular option"},{"answer":"Plan architecture","mode":"architect"}]',
			),
			false,
		)
	})

	describe("form mode (typed input widgets)", () => {
		it("renders a paramForm followup and returns the JSON answers as the tool result", async () => {
			mockShofer.ask.mockResolvedValue({ text: '{"runtime":"go","replicas":3}' })

			const block: ToolUse = {
				type: "tool_use",
				name: "ask_followup_question",
				params: { question: "Configure the service:" },
				nativeArgs: {
					question: "Configure the service:",
					follow_up: null,
					form: [
						{ name: "runtime", type: "string", widget: "radio", options: ["node", "go"] },
						{ name: "replicas", type: "number", widget: "slider", min: 1, max: 10, step: 1 },
					],
				},
				partial: false,
			}

			await askFollowupQuestionTool.handle(mockShofer, block as ToolUse<"ask_followup_question">, {
				askApproval: vi.fn(),
				handleError: vi.fn(),
				pushToolResult: mockPushToolResult,
			})

			// The followup ask carries paramForm (not suggest) so the webview renders the form.
			const askArg = mockShofer.ask.mock.calls[0][1] as string
			expect(askArg).toContain('"paramForm"')
			expect(askArg).toContain('"name":"runtime"')
			expect(askArg).not.toContain('"suggest"')

			// Submitted values are written back onto the question message for read-only replay.
			expect(mockShofer.markFollowupFormAnswered).toHaveBeenCalledWith({ runtime: "go", replicas: 3 })

			// The model receives the raw JSON answers.
			expect(toolResult).toContain('{"runtime":"go","replicas":3}')
		})

		it("accepts a form with no follow_up suggestions", async () => {
			mockShofer.ask.mockResolvedValue({ text: '{"name":"svc"}' })

			const block: ToolUse = {
				type: "tool_use",
				name: "ask_followup_question",
				params: { question: "Name it:" },
				nativeArgs: {
					question: "Name it:",
					follow_up: null,
					form: [{ name: "name", type: "string" }],
				},
				partial: false,
			}

			await askFollowupQuestionTool.handle(mockShofer, block as ToolUse<"ask_followup_question">, {
				askApproval: vi.fn(),
				handleError: vi.fn(),
				pushToolResult: mockPushToolResult,
			})

			expect(mockShofer.sayAndCreateMissingParamError).not.toHaveBeenCalled()
			expect(mockShofer.ask).toHaveBeenCalled()
		})

		it("errors when neither follow_up nor form is provided", async () => {
			const block: ToolUse = {
				type: "tool_use",
				name: "ask_followup_question",
				params: { question: "Anything?" },
				nativeArgs: {
					question: "Anything?",
					follow_up: null,
					form: null,
				} as any,
				partial: false,
			}

			await askFollowupQuestionTool.handle(mockShofer, block as ToolUse<"ask_followup_question">, {
				askApproval: vi.fn(),
				handleError: vi.fn(),
				pushToolResult: mockPushToolResult,
			})

			expect(mockShofer.sayAndCreateMissingParamError).toHaveBeenCalledWith("ask_followup_question", "follow_up")
			expect(mockShofer.ask).not.toHaveBeenCalled()
		})

		it("rejects providing BOTH follow_up suggestions and a form", async () => {
			const block: ToolUse = {
				type: "tool_use",
				name: "ask_followup_question",
				params: { question: "Pick or fill?" },
				nativeArgs: {
					question: "Pick or fill?",
					follow_up: [{ text: "Option A" }, { text: "Option B" }],
					form: [{ name: "name", type: "string" }],
				} as any,
				partial: false,
			}

			await askFollowupQuestionTool.handle(mockShofer, block as ToolUse<"ask_followup_question">, {
				askApproval: vi.fn(),
				handleError: vi.fn(),
				pushToolResult: mockPushToolResult,
			})

			// Ambiguous call: no question is asked, a tool error is surfaced, and it
			// is reported as a validation error (not a missing-param error).
			expect(mockShofer.ask).not.toHaveBeenCalled()
			expect(mockShofer.sayAndCreateMissingParamError).not.toHaveBeenCalled()
			expect(mockShofer.recordToolError).toHaveBeenCalledWith("ask_followup_question")
			expect(toolResult).toContain("not both")
		})

		it("accepts follow_up suggestions alone (form null)", async () => {
			mockShofer.ask.mockResolvedValue({ text: "Option A" })

			const block: ToolUse = {
				type: "tool_use",
				name: "ask_followup_question",
				params: { question: "Which option?" },
				nativeArgs: {
					question: "Which option?",
					follow_up: [{ text: "Option A" }, { text: "Option B" }],
					form: null,
				} as any,
				partial: false,
			}

			await askFollowupQuestionTool.handle(mockShofer, block as ToolUse<"ask_followup_question">, {
				askApproval: vi.fn(),
				handleError: vi.fn(),
				pushToolResult: mockPushToolResult,
			})

			expect(mockShofer.sayAndCreateMissingParamError).not.toHaveBeenCalled()
			expect(mockShofer.ask).toHaveBeenCalled()
			const askArg = mockShofer.ask.mock.calls[0][1] as string
			expect(askArg).toContain('"suggest"')
		})
	})

	describe("parameter validation", () => {
		it("should handle missing follow_up parameter", async () => {
			const block: ToolUse = {
				type: "tool_use",
				name: "ask_followup_question",
				params: {
					question: "What would you like to do?",
				},
				nativeArgs: {
					question: "What would you like to do?",
					follow_up: undefined as any,
				},
				partial: false,
			}

			await askFollowupQuestionTool.handle(mockShofer, block as ToolUse<"ask_followup_question">, {
				askApproval: vi.fn(),
				handleError: vi.fn(),
				pushToolResult: mockPushToolResult,
			})

			expect(mockShofer.sayAndCreateMissingParamError).toHaveBeenCalledWith("ask_followup_question", "follow_up")
			expect(mockShofer.recordToolError).toHaveBeenCalledWith("ask_followup_question")
			expect(mockShofer.didToolFailInCurrentTurn).toBe(true)
			expect(mockShofer.consecutiveMistakeCount).toBe(1)
			expect(mockShofer.ask).not.toHaveBeenCalled()
		})

		it("should handle null follow_up parameter", async () => {
			const block: ToolUse = {
				type: "tool_use",
				name: "ask_followup_question",
				params: {
					question: "What would you like to do?",
				},
				nativeArgs: {
					question: "What would you like to do?",
					follow_up: null as any,
				},
				partial: false,
			}

			await askFollowupQuestionTool.handle(mockShofer, block as ToolUse<"ask_followup_question">, {
				askApproval: vi.fn(),
				handleError: vi.fn(),
				pushToolResult: mockPushToolResult,
			})

			expect(mockShofer.sayAndCreateMissingParamError).toHaveBeenCalledWith("ask_followup_question", "follow_up")
			expect(mockShofer.recordToolError).toHaveBeenCalledWith("ask_followup_question")
			expect(mockShofer.didToolFailInCurrentTurn).toBe(true)
			expect(mockShofer.consecutiveMistakeCount).toBe(1)
			expect(mockShofer.ask).not.toHaveBeenCalled()
		})

		it("should handle non-array follow_up parameter", async () => {
			const block: ToolUse = {
				type: "tool_use",
				name: "ask_followup_question",
				params: {
					question: "What would you like to do?",
				},
				nativeArgs: {
					question: "What would you like to do?",
					follow_up: "not an array" as any,
				} as any,
				partial: false,
			}

			await askFollowupQuestionTool.handle(mockShofer, block as ToolUse<"ask_followup_question">, {
				askApproval: vi.fn(),
				handleError: vi.fn(),
				pushToolResult: mockPushToolResult,
			})

			expect(mockShofer.sayAndCreateMissingParamError).toHaveBeenCalledWith("ask_followup_question", "follow_up")
			expect(mockShofer.recordToolError).toHaveBeenCalledWith("ask_followup_question")
			expect(mockShofer.didToolFailInCurrentTurn).toBe(true)
			expect(mockShofer.consecutiveMistakeCount).toBe(1)
			expect(mockShofer.ask).not.toHaveBeenCalled()
		})
	})

	describe("handlePartial with native protocol", () => {
		it("should only send question during partial streaming to avoid raw JSON display", async () => {
			const block: ToolUse<"ask_followup_question"> = {
				type: "tool_use",
				name: "ask_followup_question",
				params: {
					question: "What would you like to do?",
				},
				partial: true,
				nativeArgs: {
					question: "What would you like to do?",
					follow_up: [{ text: "Option 1", mode: "code" }, { text: "Option 2" }],
				},
			}

			await askFollowupQuestionTool.handle(mockShofer, block, {
				askApproval: vi.fn(),
				handleError: vi.fn(),
				pushToolResult: mockPushToolResult,
			})

			// During partial streaming, only the question should be sent (not JSON with suggestions)
			expect(mockShofer.ask).toHaveBeenCalledWith("followup", "What would you like to do?", true)
		})

		it("should handle partial with question from params", async () => {
			const block: ToolUse<"ask_followup_question"> = {
				type: "tool_use",
				name: "ask_followup_question",
				params: {
					question: "Choose wisely",
				},
				partial: true,
			}

			await askFollowupQuestionTool.handle(mockShofer, block, {
				askApproval: vi.fn(),
				handleError: vi.fn(),
				pushToolResult: mockPushToolResult,
			})

			expect(mockShofer.ask).toHaveBeenCalledWith("followup", "Choose wisely", true)
		})
	})

	describe("NativeToolCallParser.createPartialToolUse for ask_followup_question", () => {
		beforeEach(() => {
			NativeToolCallParser.clearAllStreamingToolCalls()
			NativeToolCallParser.clearRawChunkState()
		})

		it("should build nativeArgs with question and follow_up during streaming", () => {
			// Start a streaming tool call
			NativeToolCallParser.startStreamingToolCall("call_123", "ask_followup_question")

			// Simulate streaming JSON chunks
			const chunk1 = '{"question":"What would you like?","follow_up":[{"text":"Option 1","mode":"code"}'
			const result1 = NativeToolCallParser.processStreamingChunk("call_123", chunk1)

			expect(result1).not.toBeNull()
			expect(result1?.name).toBe("ask_followup_question")
			expect(result1?.params.question).toBe("What would you like?")
			expect(result1?.nativeArgs).toBeDefined()
			// Use type assertion to access the specific fields
			const nativeArgs = result1?.nativeArgs as {
				question: string
				follow_up?: Array<{ text: string; mode?: string }>
			}
			expect(nativeArgs?.question).toBe("What would you like?")
			// partial-json should parse the incomplete array
			expect(nativeArgs?.follow_up).toBeDefined()
		})

		it("carries the form parameter through to nativeArgs (regression: form was dropped)", () => {
			NativeToolCallParser.startStreamingToolCall("call_form", "ask_followup_question")

			// Model emits follow_up:null + a form (strict-mode shape).
			const completeJson =
				'{"question":"Configure:","follow_up":null,"form":[{"name":"runtime","type":"string","widget":"radio","options":["node","go"]}]}'
			NativeToolCallParser.processStreamingChunk("call_form", completeJson)

			const result = NativeToolCallParser.finalizeStreamingToolCall("call_form")

			expect(result).not.toBeNull()
			if (result?.type === "tool_use") {
				const nativeArgs = result.nativeArgs as {
					question: string
					follow_up?: unknown
					form?: Array<{ name: string }>
				}
				expect(nativeArgs.question).toBe("Configure:")
				expect(nativeArgs.form).toEqual([
					{ name: "runtime", type: "string", widget: "radio", options: ["node", "go"] },
				])
			}
		})

		it("should finalize with complete nativeArgs", () => {
			NativeToolCallParser.startStreamingToolCall("call_456", "ask_followup_question")

			// Add complete JSON
			const completeJson =
				'{"question":"Choose an option","follow_up":[{"text":"Yes","mode":"code"},{"text":"No","mode":null}]}'
			NativeToolCallParser.processStreamingChunk("call_456", completeJson)

			const result = NativeToolCallParser.finalizeStreamingToolCall("call_456")

			expect(result).not.toBeNull()
			expect(result?.type).toBe("tool_use")
			expect(result?.name).toBe("ask_followup_question")
			expect(result?.partial).toBe(false)
			// Type guard: regular tools have type 'tool_use', MCP tools have type 'mcp_tool_use'
			if (result?.type === "tool_use") {
				expect(result.nativeArgs).toEqual({
					question: "Choose an option",
					follow_up: [
						{ text: "Yes", mode: "code" },
						{ text: "No", mode: null },
					],
				})
			}
		})
	})

	describe("background child state transitions", () => {
		let setStateSpy: ReturnType<typeof vi.fn>
		let providerRef: { deref: () => any }
		let handleOnParent: { status: string }

		beforeEach(() => {
			setStateSpy = vi.fn()
			handleOnParent = { status: "running" }

			const parentInstance = {
				backgroundChildren: new Map([["child-task-1", handleOnParent]]),
			}

			const provider = {
				taskManager: {
					setState: setStateSpy,
					getManagedTaskInstance: vi.fn().mockReturnValue(parentInstance),
					emit: vi.fn(),
				},
			}

			providerRef = { deref: () => provider }
		})

		function buildBackgroundChildTask(answerPromise: Promise<string>): typeof mockShofer {
			return {
				...mockShofer,
				taskId: "child-task-1",
				parentTaskId: "parent-task-1",
				isBackgroundTask: true,
				providerRef,
				setPendingParentQuestion: vi.fn().mockReturnValue(answerPromise),
			}
		}

		it("transitions to waiting while awaiting parent answer, then running on resolve", async () => {
			const answerPromise = Promise.resolve("parent's answer")
			const task = buildBackgroundChildTask(answerPromise)

			const block: ToolUse = {
				type: "tool_use",
				name: "ask_followup_question",
				params: { question: "Need help?" },
				nativeArgs: {
					question: "Need help?",
					follow_up: [{ text: "Yes" }],
				},
				partial: false,
			}

			const askApproval = vi.fn().mockResolvedValue(true)

			await askFollowupQuestionTool.handle(task as any, block as ToolUse<"ask_followup_question">, {
				askApproval,
				handleError: vi.fn(),
				pushToolResult: mockPushToolResult,
			})

			expect(setStateSpy).toHaveBeenCalledWith("child-task-1", { lifecycle: "waiting" })
			expect(setStateSpy).toHaveBeenCalledWith("child-task-1", { lifecycle: "running" })
			expect(setStateSpy.mock.calls[0]).toEqual(["child-task-1", { lifecycle: "waiting" }])
			expect(setStateSpy.mock.calls[1]).toEqual(["child-task-1", { lifecycle: "running" }])
		})

		it("transitions to waiting then back to running on rejection", async () => {
			const answerPromise = Promise.reject(new Error("task aborted"))
			const task = buildBackgroundChildTask(answerPromise)

			const block: ToolUse = {
				type: "tool_use",
				name: "ask_followup_question",
				params: { question: "Need help?" },
				nativeArgs: {
					question: "Need help?",
					follow_up: [{ text: "Yes" }],
				},
				partial: false,
			}

			const askApproval = vi.fn().mockResolvedValue(true)

			// The catch block swallows the rejection and emits a tool error,
			// so handle() does not throw.
			await askFollowupQuestionTool.handle(task as any, block as ToolUse<"ask_followup_question">, {
				askApproval,
				handleError: vi.fn(),
				pushToolResult: mockPushToolResult,
			})

			expect(setStateSpy).toHaveBeenCalledWith("child-task-1", { lifecycle: "waiting" })
			expect(setStateSpy).toHaveBeenCalledWith("child-task-1", { lifecycle: "running" })
			expect(setStateSpy.mock.calls[0]).toEqual(["child-task-1", { lifecycle: "waiting" }])
			expect(setStateSpy.mock.calls[1]).toEqual(["child-task-1", { lifecycle: "running" }])

			// The tool error should surface the rejection reason.
			expect(toolResult).toContain("task aborted")
		})

		it("restores running (in finally) when setup throws synchronously — no stranding", async () => {
			// Regression: a synchronous throw during setup (here the
			// needs-parent-input emit, e.g. a wait_for_task listener throwing)
			// must not strand the child in "waiting" nor the parent handle in
			// "waiting_for_parent". The finally restores both.
			const task = buildBackgroundChildTask(Promise.resolve("never awaited"))
			providerRef.deref().taskManager.emit.mockImplementation(() => {
				throw new Error("listener boom")
			})

			const block: ToolUse = {
				type: "tool_use",
				name: "ask_followup_question",
				params: { question: "Need help?" },
				nativeArgs: { question: "Need help?", follow_up: [{ text: "Yes" }] },
				partial: false,
			}

			// Must not throw — the setup error is caught and surfaced as a tool error.
			await askFollowupQuestionTool.handle(task as any, block as ToolUse<"ask_followup_question">, {
				askApproval: vi.fn().mockResolvedValue(true),
				handleError: vi.fn(),
				pushToolResult: mockPushToolResult,
			})

			// waiting was set, and running was STILL restored despite the throw.
			expect(setStateSpy).toHaveBeenCalledWith("child-task-1", { lifecycle: "waiting" })
			expect(setStateSpy).toHaveBeenLastCalledWith("child-task-1", { lifecycle: "running" })
			// Parent's view of the child is restored too (not stranded).
			expect(handleOnParent.status).toBe("running")
			expect(toolResult).toContain("listener boom")
		})

		it("does NOT set waiting when askApproval returns false", async () => {
			const answerPromise = Promise.resolve("parent's answer")
			const task = buildBackgroundChildTask(answerPromise)

			const block: ToolUse = {
				type: "tool_use",
				name: "ask_followup_question",
				params: { question: "Need help?" },
				nativeArgs: {
					question: "Need help?",
					follow_up: [{ text: "Yes" }],
				},
				partial: false,
			}

			const askApproval = vi.fn().mockResolvedValue(false)

			await askFollowupQuestionTool.handle(task as any, block as ToolUse<"ask_followup_question">, {
				askApproval,
				handleError: vi.fn(),
				pushToolResult: mockPushToolResult,
			})

			expect(setStateSpy).not.toHaveBeenCalledWith("child-task-1", { lifecycle: "waiting" })
			expect(setStateSpy).not.toHaveBeenCalled()
		})

		it("foreground task does NOT call setState('waiting')", async () => {
			// Foreground task has no parentTaskId and no isBackgroundTask —
			// it goes through the normal task.ask("followup", ...) path.
			const block: ToolUse = {
				type: "tool_use",
				name: "ask_followup_question",
				params: { question: "What now?" },
				nativeArgs: {
					question: "What now?",
					follow_up: [{ text: "Option 1" }],
				},
				partial: false,
			}

			// Reset mockShofer.ask to the default so the foreground path works.
			mockShofer.ask.mockResolvedValue({ text: "User's answer" })

			// The default mockShofer has no providerRef/parentTaskId/isBackgroundTask,
			// so it falls through to the foreground path.
			await askFollowupQuestionTool.handle(mockShofer as any, block as ToolUse<"ask_followup_question">, {
				askApproval: vi.fn(),
				handleError: vi.fn(),
				pushToolResult: mockPushToolResult,
			})

			// No setState spy on the foreground task — the mock doesn't have
			// taskManager at all. The state transition goes through TaskInteractive
			// → waiting_input, which is out of scope for this test. We just verify
			// that the foreground path was taken (task.ask was called).
			expect(mockShofer.ask).toHaveBeenCalledWith("followup", expect.any(String), false)
		})
	})
})
