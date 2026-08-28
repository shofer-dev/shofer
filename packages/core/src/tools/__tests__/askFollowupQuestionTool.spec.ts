import { askFollowupQuestionTool } from "../AskFollowupQuestionTool.js"
import { setConversationDriverProbe, DRIVER_ATTACH_RECHECK_MS } from "../../transport/conversation-driver.js"
import { createStreamSubscribers, SUBSCRIBER_REATTACH_GRACE_MS } from "../../transport/http-server.js"
import { ToolUse } from "@shofer/types"
import { NativeToolCallParser } from "../../assistant-message/NativeToolCallParser.js"

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

	/**
	 * A CHILD's question is DUAL-CHANNEL: it is delivered to the parent's mailbox
	 * as a `request` AND raised as an ordinary `followup` ask in the child's own
	 * chat. Either side may answer and the first answer wins; the loser's channel
	 * is withdrawn (the request is resolved out of the parent's box).
	 */
	describe("child question routing", () => {
		let providerRef: { deref: () => any }
		let handleOnParent: { status: string }
		let deliverToTask: ReturnType<typeof vi.fn>
		let resolveRequest: ReturnType<typeof vi.fn>
		let setForwardedQuestionSpy: ReturnType<typeof vi.fn>
		let clearForwardedQuestionSpy: ReturnType<typeof vi.fn>

		beforeEach(() => {
			handleOnParent = { status: "running" }
			deliverToTask = vi.fn().mockResolvedValue(undefined)
			resolveRequest = vi.fn().mockResolvedValue(undefined)
			setForwardedQuestionSpy = vi.fn()
			clearForwardedQuestionSpy = vi.fn()

			const parentInstance = {
				backgroundChildren: new Map([["child-task-1", handleOnParent]]),
				mailbox: { resolveRequest },
			}

			const provider = {
				deliverToTask,
				taskManager: {
					getManagedTaskInstance: vi.fn().mockReturnValue(parentInstance),
				},
			}

			providerRef = { deref: () => provider }
		})

		/**
		 * Builds a mock child task. The `ask` mock controls how the followup ask
		 * resolves — by default with a text answer, standing for either channel.
		 */
		function buildBackgroundChildTask(askImpl?: ReturnType<typeof vi.fn>): typeof mockShofer {
			return {
				...mockShofer,
				taskId: "child-task-1",
				parentTaskId: "parent-task-1",
				isBackgroundTask: true,
				providerRef,
				setForwardedQuestion: setForwardedQuestionSpy,
				clearForwardedQuestion: clearForwardedQuestionSpy,
				ask: askImpl ?? vi.fn().mockResolvedValue({ text: "parent's answer" }),
			}
		}

		it("renders the question via task.ask('followup') so both parent and user can answer", async () => {
			const task = buildBackgroundChildTask()

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

			// The question is rendered in the child's chat via task.ask("followup"),
			// so suggestion buttons appear and EITHER the parent or the user can answer.
			expect(task.ask).toHaveBeenCalledWith("followup", expect.stringContaining('"question":"Need help?"'), false)
			// The answer is surfaced to the model as a tool result.
			expect(toolResult).toContain("parent's answer")
		})

		it("delivers the question to the parent's mailbox as a request, and asks it locally too", async () => {
			const task = buildBackgroundChildTask()

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

			await askFollowupQuestionTool.handle(task as any, block as ToolUse<"ask_followup_question">, {
				askApproval: vi.fn().mockResolvedValue(true),
				handleError: vi.fn(),
				pushToolResult: mockPushToolResult,
			})

			// Channel 1: a `request` envelope in the parent's box.
			expect(deliverToTask).toHaveBeenCalledTimes(1)
			const [toTaskId, envelope] = deliverToTask.mock.calls[0]!
			expect(toTaskId).toBe("parent-task-1")
			expect(envelope).toMatchObject({
				from: "child-task-1",
				to: "parent-task-1",
				kind: "request",
				subject: "question: Need help?",
				wake: true,
				plane: "local",
			})
			// The suggestions ride in the body, so the parent can echo one back.
			expect(envelope.body).toContain("Need help?")
			expect(envelope.body).toContain("- Yes")

			// Channel 2: the ask in the child's own chat.
			expect(task.ask).toHaveBeenCalledWith("followup", expect.stringContaining('"question":"Need help?"'), false)

			// The correlation is recorded so a parent `reply` can unpark this ask…
			expect(setForwardedQuestionSpy).toHaveBeenCalledWith({
				envelopeId: envelope.id,
				question: "Need help?",
			})
			// …and forgotten once it resolves.
			expect(clearForwardedQuestionSpy).toHaveBeenCalled()
		})

		it("withdraws the request from the parent's box once the ask is answered", async () => {
			const task = buildBackgroundChildTask()

			const block: ToolUse = {
				type: "tool_use",
				name: "ask_followup_question",
				params: { question: "Need help?" },
				nativeArgs: { question: "Need help?", follow_up: [{ text: "Yes" }] },
				partial: false,
			}

			await askFollowupQuestionTool.handle(task as any, block as ToolUse<"ask_followup_question">, {
				askApproval: vi.fn().mockResolvedValue(true),
				handleError: vi.fn(),
				pushToolResult: mockPushToolResult,
			})

			// Whoever answered, the parent's digest must stop showing a question
			// nobody is waiting on. (When the PARENT answered, `reply` already
			// removed it and this is a no-op.)
			const envelopeId = deliverToTask.mock.calls[0]![1].id
			expect(resolveRequest).toHaveBeenCalledWith(envelopeId)
		})

		it("still asks locally when the parent's mailbox refuses the delivery", async () => {
			deliverToTask.mockRejectedValueOnce(new Error("Mailbox of task parent-task-1 is full"))
			const task = buildBackgroundChildTask()

			const block: ToolUse = {
				type: "tool_use",
				name: "ask_followup_question",
				params: { question: "Need help?" },
				nativeArgs: { question: "Need help?", follow_up: [{ text: "Yes" }] },
				partial: false,
			}

			await askFollowupQuestionTool.handle(task as any, block as ToolUse<"ask_followup_question">, {
				askApproval: vi.fn().mockResolvedValue(true),
				handleError: vi.fn(),
				pushToolResult: mockPushToolResult,
			})

			// The human channel is independent and still live, so the question is
			// asked rather than failed — only the parent's copy is lost.
			expect(task.ask).toHaveBeenCalled()
			expect(toolResult).toContain("parent's answer")
		})

		it("flips parent handle to waiting_for_parent and restores on resolve", async () => {
			const task = buildBackgroundChildTask()

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

			await askFollowupQuestionTool.handle(task as any, block as ToolUse<"ask_followup_question">, {
				askApproval: vi.fn().mockResolvedValue(true),
				handleError: vi.fn(),
				pushToolResult: mockPushToolResult,
			})

			// After the ask resolves, the parent handle is restored to "running".
			expect(handleOnParent.status).toBe("running")
		})

		it("surfaces a tool error when the ask is aborted (task stopped)", async () => {
			// Simulate task.ask throwing an AskIgnoredError (task aborted).
			const task = buildBackgroundChildTask(
				vi.fn().mockRejectedValue(new Error("aborted while awaiting ask response")),
			)

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

			await askFollowupQuestionTool.handle(task as any, block as ToolUse<"ask_followup_question">, {
				askApproval: vi.fn().mockResolvedValue(true),
				handleError: vi.fn(),
				pushToolResult: mockPushToolResult,
			})

			// The abort error is surfaced as a clean tool error.
			expect(toolResult).toContain("cancelled before an answer was received")
			// The finally still clears the metadata and restores the handle.
			expect(clearForwardedQuestionSpy).toHaveBeenCalled()
			expect(handleOnParent.status).toBe("running")
		})

		it("restores handle (in finally) when setup throws synchronously — no stranding", async () => {
			// Regression: a synchronous throw during setup must not strand the
			// parent's handle on this child in "waiting_for_parent".
			const task = buildBackgroundChildTask()
			setForwardedQuestionSpy.mockImplementation(() => {
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

			// Parent's view of the child is restored (not stranded).
			expect(handleOnParent.status).toBe("running")
			expect(toolResult).toContain("listener boom")
		})

		it("does NOT proceed when askApproval returns false", async () => {
			const task = buildBackgroundChildTask()

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

			// The followup ask was never called.
			expect(task.ask).not.toHaveBeenCalled()
			// No metadata stored, no event emitted.
			expect(setForwardedQuestionSpy).not.toHaveBeenCalled()
			expect(deliverToTask).not.toHaveBeenCalled()
		})

		it("foreground task does NOT route to parent — uses normal task.ask('followup')", async () => {
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

			// The foreground path was taken (task.ask was called).
			expect(mockShofer.ask).toHaveBeenCalledWith("followup", expect.any(String), false)
		})
	})

	/**
	 * A synchronously spawned child's question has ONE audience: the human driving
	 * the root conversation. Its parent cannot answer (it is suspended inside
	 * `new_task` waiting for this child), so when nobody is driving the
	 * conversation either, the question must FAIL rather than park — a parked one
	 * takes the parent down with it and shows nothing anywhere.
	 *
	 * "Nobody is driving" is a claim about an INTERVAL, not an instant: the
	 * controller reconnects as a matter of course, so the tool re-asks once after
	 * `DRIVER_ATTACH_RECHECK_MS` before it refuses. These tests therefore drive
	 * fake timers — a call that ends in a refusal only completes once that wait is
	 * advanced.
	 */
	describe("a sync child with no reachable audience", () => {
		const syncChild = (overrides: Record<string, unknown> = {}) => ({
			...mockShofer,
			taskId: "child-1",
			rootTaskId: "root-1",
			parentTaskId: "root-1",
			isBackgroundTask: false,
			...overrides,
		})

		const question: ToolUse = {
			type: "tool_use",
			name: "ask_followup_question",
			params: { question: "Which region?" },
			nativeArgs: { question: "Which region?", follow_up: [{ text: "eu-west" }] },
			partial: false,
		}

		const invoke = (task: any) =>
			askFollowupQuestionTool.handle(task, question as ToolUse<"ask_followup_question">, {
				askApproval: vi.fn(),
				handleError: vi.fn(),
				pushToolResult: mockPushToolResult,
			})

		beforeEach(() => {
			vi.useFakeTimers()
		})

		afterEach(() => {
			vi.useRealTimers()
			setConversationDriverProbe(undefined)
		})

		it("fails fast instead of blocking when the conversation has no driver", async () => {
			setConversationDriverProbe(() => false)
			const task = syncChild()

			const done = invoke(task)
			await vi.advanceTimersByTimeAsync(DRIVER_ATTACH_RECHECK_MS)
			await done

			expect(task.ask).not.toHaveBeenCalled()
			expect(toolResult).toContain("No user is reachable")
			expect(task.recordToolError).toHaveBeenCalledWith("ask_followup_question")
		})

		it("asks normally when a driver IS attached, without paying the re-check wait", async () => {
			setConversationDriverProbe(() => true)
			const task = syncChild()

			// No timer advance: an attached driver is answered on the first sample,
			// so the ask must already have happened.
			await invoke(task)

			expect(task.ask).toHaveBeenCalledWith("followup", expect.any(String), false)
		})

		it("asks normally on a host that is not remotely driven at all", async () => {
			// No probe registered: the VS Code webview / a terminal run, where the
			// host's own ask surface is the audience. `undefined` is not `false`.
			const task = syncChild()

			await invoke(task)

			expect(task.ask).toHaveBeenCalledWith("followup", expect.any(String), false)
		})

		it("does not fail a ROOT task's question when no driver is attached", async () => {
			// A root task's own question is already on the stream a controller
			// subscribes to, and on an interactive host the user is right there.
			setConversationDriverProbe(() => false)
			const task = { ...mockShofer, taskId: "root-1" }

			await invoke(task)

			expect(task.ask).toHaveBeenCalledWith("followup", expect.any(String), false)
		})

		it("asks after all when the driver attaches during the re-check window", async () => {
			// The attach-in-progress race at the start of a turn: the controller has
			// decided to subscribe and its request is in flight. One sample would
			// refuse a question a human is about to be shown.
			let attached = false
			setConversationDriverProbe(() => attached)
			const task = syncChild()

			const done = invoke(task)
			await vi.advanceTimersByTimeAsync(DRIVER_ATTACH_RECHECK_MS - 1)
			expect(task.ask).not.toHaveBeenCalled()

			attached = true
			await vi.advanceTimersByTimeAsync(1)
			await done

			expect(task.ask).toHaveBeenCalledWith("followup", expect.any(String), false)
			expect(task.recordToolError).not.toHaveBeenCalled()
		})
	})

	/**
	 * The other half of the tolerance, one layer down: the probe the transport
	 * registers is the census's `mightReach`, so a controller that dropped and is
	 * reconnecting still counts as the audience. Composed here against a real
	 * census so the two windows are exercised together — a within-grace drop must
	 * reach `task.ask` (the question PARKS for the returning controller), and a
	 * beyond-grace one must not.
	 */
	describe("a sync child whose driver dropped and may come back", () => {
		let clock: number

		const syncChild = () => ({
			...mockShofer,
			taskId: "child-1",
			rootTaskId: "root-1",
			parentTaskId: "root-1",
			isBackgroundTask: false,
		})

		const question: ToolUse = {
			type: "tool_use",
			name: "ask_followup_question",
			params: { question: "Which region?" },
			nativeArgs: { question: "Which region?", follow_up: [{ text: "eu-west" }] },
			partial: false,
		}

		const invoke = (task: any) =>
			askFollowupQuestionTool.handle(task, question as ToolUse<"ask_followup_question">, {
				askApproval: vi.fn(),
				handleError: vi.fn(),
				pushToolResult: mockPushToolResult,
			})

		/** A census wired exactly as `serveHttpOverShoferApi` wires it. */
		const censusWithDetachedRoot = () => {
			const subscribers = createStreamSubscribers({ now: () => clock })
			subscribers.add("root-1")()
			setConversationDriverProbe((taskId) => subscribers.mightReach(taskId))
		}

		beforeEach(() => {
			clock = 1_000
			vi.useFakeTimers()
		})

		afterEach(() => {
			vi.useRealTimers()
			setConversationDriverProbe(undefined)
		})

		it("parks the question when the controller detached within the grace window", async () => {
			censusWithDetachedRoot()
			clock += SUBSCRIBER_REATTACH_GRACE_MS - 1
			const task = syncChild()

			await invoke(task)

			expect(task.ask).toHaveBeenCalledWith("followup", expect.any(String), false)
			expect(task.recordToolError).not.toHaveBeenCalled()
		})

		it("refuses once the detach is older than the grace window", async () => {
			censusWithDetachedRoot()
			clock += SUBSCRIBER_REATTACH_GRACE_MS
			const task = syncChild()

			const done = invoke(task)
			await vi.advanceTimersByTimeAsync(DRIVER_ATTACH_RECHECK_MS)
			await done

			expect(task.ask).not.toHaveBeenCalled()
			expect(toolResult).toContain("No user is reachable")
		})
	})
})
