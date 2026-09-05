// pnpm --filter @shofer/cli test src/ui/hooks/__tests__/useMessageHandlers.test.tsx

import type { ExtensionMessage } from "@shofer/types"

import { useCLIStore } from "../../store.js"
import { useMessageHandlers } from "../useMessageHandlers.js"
import { renderHook } from "./helpers/render-hook.js"

/**
 * The host→TUI translation layer: `ShoferMessage`s in, `TUIMessage`s and pending
 * asks out.
 *
 * Three behaviours are worth stating because they are policy rather than
 * plumbing. (1) The FIRST `say: "text"` of a new task is the prompt echo and is
 * dropped — but NOT when resuming, where every historical message is meant to
 * render. (2) `seenMessageIds` dedups by `ts`, which is what makes a re-delivered
 * final message idempotent while still letting a partial update its own row.
 * (3) In NON-INTERACTIVE mode every ask except `followup` is rendered as a
 * transcript line instead of becoming a `pendingAsk` — a headless host has nobody
 * to answer an approval, so parking one would hang the run.
 */

const say = (ts: number, sayType: string, text = "", partial = false) =>
	({
		type: "messageUpdated",
		shoferMessage: { ts, type: "say", say: sayType, text, partial },
	}) as unknown as ExtensionMessage

const ask = (ts: number, askType: string, text = "", partial = false) =>
	({
		type: "messageUpdated",
		shoferMessage: { ts, type: "ask", ask: askType, text, partial },
	}) as unknown as ExtensionMessage

describe("useMessageHandlers", () => {
	beforeEach(() => {
		useCLIStore.getState().reset()
	})

	const mount = (nonInteractive = false) => renderHook(() => useMessageHandlers({ nonInteractive }))

	const send = (hook: ReturnType<typeof mount>, msg: ExtensionMessage) => {
		hook.act(() => hook.current.handleExtensionMessage(msg))
	}

	describe("say messages", () => {
		it("drops the prompt echo — the first text message of a NEW task", () => {
			const hook = mount()

			send(hook, say(1, "text", "the prompt"))
			expect(useCLIStore.getState().messages).toEqual([])
			expect(hook.current.firstTextMessageSkipped.current).toBe(true)

			send(hook, say(2, "text", "the reply"))
			expect(useCLIStore.getState().messages).toHaveLength(1)
			expect(useCLIStore.getState().messages[0]).toMatchObject({ role: "assistant", content: "the reply" })

			hook.unmount()
		})

		it("keeps the first text message when RESUMING — it is history, not an echo", () => {
			useCLIStore.getState().setIsResumingTask(true)
			const hook = mount()

			send(hook, say(1, "text", "an old reply"))
			expect(useCLIStore.getState().messages).toHaveLength(1)

			hook.unmount()
		})

		it("ignores api_req_started outright and records user_feedback only as seen", () => {
			const hook = mount()
			hook.current.firstTextMessageSkipped.current = true

			send(hook, say(1, "api_req_started", "{}"))
			send(hook, say(2, "user_feedback", "typed"))

			expect(useCLIStore.getState().messages).toEqual([])
			expect(hook.current.seenMessageIds.current.has("2")).toBe(true)
			expect(hook.current.seenMessageIds.current.has("1")).toBe(false)

			hook.unmount()
		})

		it("dedups a re-delivered final message, but lets a partial keep updating", () => {
			const hook = mount()
			hook.current.firstTextMessageSkipped.current = true

			send(hook, say(1, "text", "hello"))
			send(hook, say(1, "text", "hello"))
			expect(useCLIStore.getState().messages).toHaveLength(1)

			send(hook, say(2, "text", "he", true))
			send(hook, say(2, "text", "hello", true))
			expect(useCLIStore.getState().messages).toHaveLength(2)

			hook.unmount()
		})

		it("renders reasoning as its own role", () => {
			const hook = mount()
			hook.current.firstTextMessageSkipped.current = true

			send(hook, say(1, "reasoning", "thinking..."))
			expect(useCLIStore.getState().messages[0]).toMatchObject({ role: "thinking" })

			hook.unmount()
		})

		it("attaches command output to the command that was asked about, then forgets it", () => {
			const hook = mount()
			hook.current.firstTextMessageSkipped.current = true

			// The `command` ask records what is about to run…
			send(hook, ask(1, "command", "ls -la"))
			expect(hook.current.pendingCommandRef.current).toBe("ls -la")

			// …so its output can be rendered with the command beside it.
			send(hook, say(2, "command_output", "a\nb"))
			expect(useCLIStore.getState().messages.at(-1)).toMatchObject({
				role: "tool",
				toolName: "execute_command",
				toolDisplayName: "bash",
				toolDisplayOutput: "a\nb",
				toolData: { tool: "execute_command", command: "ls -la", output: "a\nb" },
			})
			expect(hook.current.pendingCommandRef.current).toBeNull()

			// A second output with no command tracked carries none.
			send(hook, say(3, "command_output", "c"))
			expect(useCLIStore.getState().messages.at(-1)?.toolData?.command).toBeUndefined()

			hook.unmount()
		})

		it("renders an empty text message as empty content rather than dropping it", () => {
			const hook = mount()
			hook.current.firstTextMessageSkipped.current = true

			send(hook, say(1, "text"))
			expect(useCLIStore.getState().messages[0]?.content).toBe("")

			hook.unmount()
		})
	})

	describe("ask messages", () => {
		it("ignores a partial ask — an ask is only real once it is complete", () => {
			const hook = mount()
			send(hook, ask(1, "tool", "{}", true))

			expect(useCLIStore.getState().pendingAsk).toBeNull()
			expect(hook.current.seenMessageIds.current.has("1")).toBe(false)

			hook.unmount()
		})

		it("dedups by ts", () => {
			const hook = mount()
			send(hook, ask(1, "followup", '{"question":"why?"}'))
			useCLIStore.getState().setPendingAsk(null)
			send(hook, ask(1, "followup", '{"question":"why?"}'))

			expect(useCLIStore.getState().pendingAsk).toBeNull()
			hook.unmount()
		})

		it("swallows a command_output ask", () => {
			const hook = mount()
			send(hook, ask(1, "command_output", "output"))

			expect(useCLIStore.getState().pendingAsk).toBeNull()
			expect(hook.current.seenMessageIds.current.has("1")).toBe(true)
			hook.unmount()
		})

		it("parks a followup with its parsed question and suggestions", () => {
			const hook = mount()
			send(hook, ask(1, "followup", JSON.stringify({ question: "Which?", suggest: [{ answer: "a" }] })))

			expect(useCLIStore.getState().pendingAsk).toEqual({
				id: "1",
				type: "followup",
				content: "Which?",
				suggestions: [{ answer: "a" }],
			})
			hook.unmount()
		})

		it("falls back to the raw text for a followup that is not JSON, or carries no question", () => {
			const hook = mount()
			send(hook, ask(1, "followup", "plain question"))
			expect(useCLIStore.getState().pendingAsk?.content).toBe("plain question")

			useCLIStore.getState().setPendingAsk(null)
			send(hook, ask(2, "followup", JSON.stringify({ suggest: "not an array" })))
			expect(useCLIStore.getState().pendingAsk).toMatchObject({
				content: JSON.stringify({ suggest: "not an array" }),
				suggestions: undefined,
			})

			hook.unmount()
		})

		it("parks a tool approval rendered as a human-readable request", () => {
			const hook = mount()
			send(hook, ask(1, "tool", JSON.stringify({ tool: "write_to_file", path: "a.ts" })))

			expect(useCLIStore.getState().pendingAsk).toMatchObject({
				type: "tool",
				content: "Write to file: a.ts",
			})
			hook.unmount()
		})

		it("parks a tool approval whose payload is not JSON, unformatted", () => {
			const hook = mount()
			send(hook, ask(1, "tool", "not json"))

			expect(useCLIStore.getState().pendingAsk?.content).toBe("not json")
			hook.unmount()
		})

		it("resume_task and resume_completed_task unblock the input WITHOUT parking an ask", () => {
			for (const [index, verb] of ["resume_task", "resume_completed_task"].entries()) {
				useCLIStore.getState().reset()
				useCLIStore.getState().setLoading(true)
				useCLIStore.getState().setIsResumingTask(true)

				const hook = mount()
				send(hook, ask(index + 1, verb))

				const state = useCLIStore.getState()
				expect(state.pendingAsk).toBeNull()
				expect(state.isLoading).toBe(false)
				expect(state.hasStartedTask).toBe(true)
				expect(state.isResumingTask).toBe(false)

				hook.unmount()
			}
		})

		it("renders a completion result and marks the task complete", () => {
			const hook = mount()
			send(hook, ask(1, "completion_result", JSON.stringify({ result: "all done" })))

			const state = useCLIStore.getState()
			expect(state.isComplete).toBe(true)
			expect(state.isLoading).toBe(false)
			expect(state.messages[0]).toMatchObject({
				role: "tool",
				toolName: "attempt_completion",
				toolDisplayName: "Task Complete",
				toolDisplayOutput: "✅ all done",
				toolData: { tool: "attempt_completion", result: "all done", content: "all done" },
			})

			hook.unmount()
		})

		it("still reports completion when the payload is not JSON", () => {
			const hook = mount()
			send(hook, ask(1, "completion_result", "just text"))

			expect(useCLIStore.getState().isComplete).toBe(true)
			expect(useCLIStore.getState().messages[0]).toMatchObject({
				content: "just text",
				toolDisplayOutput: "✅ Task completed",
				toolData: { tool: "attempt_completion", content: "just text" },
			})

			hook.unmount()
		})

		it("reports completion with no payload at all", () => {
			const hook = mount()
			send(hook, ask(1, "completion_result"))

			expect(useCLIStore.getState().messages[0]?.content).toBe("Task completed")
			hook.unmount()
		})
	})

	describe("non-interactive mode", () => {
		it("renders an approval as a transcript line instead of parking it", () => {
			const hook = mount(true)
			send(hook, ask(1, "tool", JSON.stringify({ tool: "write_to_file", path: "a.ts" })))

			expect(useCLIStore.getState().pendingAsk).toBeNull()
			expect(useCLIStore.getState().messages[0]).toMatchObject({
				role: "tool",
				toolName: "write_to_file",
				content: "Write to file: a.ts",
				toolDisplayOutput: "📝 a.ts",
			})

			hook.unmount()
		})

		it("still parks a followup — a question has an audience even headless", () => {
			const hook = mount(true)
			send(hook, ask(1, "followup", JSON.stringify({ question: "Which?" })))

			expect(useCLIStore.getState().pendingAsk?.content).toBe("Which?")
			hook.unmount()
		})

		it("renders a non-tool ask as an assistant line", () => {
			const hook = mount(true)
			send(hook, ask(1, "command", "ls"))

			expect(useCLIStore.getState().messages[0]).toMatchObject({ role: "assistant", content: "ls" })
			// The command is still tracked for its later output.
			expect(hook.current.pendingCommandRef.current).toBe("ls")

			hook.unmount()
		})

		it("renders an empty non-tool ask as empty content", () => {
			const hook = mount(true)
			send(hook, ask(1, "api_req_failed"))

			expect(useCLIStore.getState().messages[0]?.content).toBe("")
			hook.unmount()
		})

		it("keeps a tool payload that is not JSON as raw text", () => {
			const hook = mount(true)
			send(hook, ask(1, "tool", "not json"))

			expect(useCLIStore.getState().messages[0]).toMatchObject({ content: "not json", toolName: undefined })
			hook.unmount()
		})

		it("extracts a todo list and rotates the previous one onto the message", () => {
			useCLIStore.getState().setTodos([{ id: "0", content: "old", status: "completed" }])
			const hook = mount(true)

			send(
				hook,
				ask(
					1,
					"tool",
					JSON.stringify({
						tool: "update_todo_list",
						todos: [{ id: "1", content: "new", status: "pending" }],
					}),
				),
			)

			expect(useCLIStore.getState().messages[0]).toMatchObject({
				todos: [{ id: "1", content: "new", status: "pending" }],
				previousTodos: [{ id: "0", content: "old", status: "completed" }],
			})
			expect(useCLIStore.getState().currentTodos).toEqual([{ id: "1", content: "new", status: "pending" }])

			hook.unmount()
		})

		it("does not touch the todo state for an EMPTY todo list", () => {
			useCLIStore.getState().setTodos([{ id: "0", content: "old", status: "completed" }])
			const hook = mount(true)

			send(hook, ask(1, "tool", JSON.stringify({ tool: "updateTodoList", todos: [] })))

			expect(useCLIStore.getState().messages[0]?.todos).toBeUndefined()
			expect(useCLIStore.getState().currentTodos).toEqual([{ id: "0", content: "old", status: "completed" }])

			hook.unmount()
		})
	})

	describe("stateInit", () => {
		it("ignores a state-less snapshot", () => {
			const hook = mount()
			send(hook, { type: "stateInit" } as ExtensionMessage)

			expect(useCLIStore.getState().messages).toEqual([])
			hook.unmount()
		})

		it("adopts the mode and task history", () => {
			const hook = mount()
			send(hook, {
				type: "stateInit",
				state: { mode: "architect", taskHistory: [{ id: "t1", task: "x", ts: 1 }] },
			} as unknown as ExtensionMessage)

			expect(useCLIStore.getState().currentMode).toBe("architect")
			expect(useCLIStore.getState().taskHistory).toHaveLength(1)
			hook.unmount()
		})

		it("replays the message history and computes token usage from it", () => {
			const hook = mount()
			send(hook, {
				type: "stateInit",
				state: {
					shoferMessages: [
						{ ts: 1, type: "say", say: "text", text: "the prompt" },
						{ ts: 2, type: "say", say: "text", text: "a reply" },
						{
							ts: 3,
							type: "say",
							say: "api_req_started",
							text: JSON.stringify({ tokensIn: 10, tokensOut: 20, cost: 0.5 }),
						},
						{ ts: 4, type: "ask", ask: "followup", text: '{"question":"why?"}' },
						{ ts: 5, type: "say" },
						{ ts: 6, type: "ask" },
					],
				},
			} as unknown as ExtensionMessage)

			// The prompt echo is dropped; the reply is kept.
			expect(useCLIStore.getState().messages.map((m) => m.content)).toEqual(["a reply"])
			expect(useCLIStore.getState().pendingAsk?.content).toBe("why?")
			expect(useCLIStore.getState().tokenUsage).toMatchObject({ totalTokensIn: 10, totalTokensOut: 20 })

			hook.unmount()
		})

		it("computes no token usage from a single message", () => {
			const hook = mount()
			send(hook, {
				type: "stateInit",
				state: { shoferMessages: [{ ts: 1, type: "say", say: "text", text: "only" }] },
			} as unknown as ExtensionMessage)

			expect(useCLIStore.getState().tokenUsage).toBeNull()
			hook.unmount()
		})

		it("clears the resuming flag even when no resume ask ever arrives", () => {
			useCLIStore.getState().setIsResumingTask(true)
			const hook = mount()

			send(hook, { type: "stateInit", state: {} } as unknown as ExtensionMessage)

			expect(useCLIStore.getState().isResumingTask).toBe(false)
			hook.unmount()
		})
	})

	describe("catalog messages", () => {
		it("adopts file search results, commands, modes and router models", () => {
			const hook = mount()

			send(hook, { type: "fileSearchResults", results: [{ key: "a.ts", path: "a.ts" }] } as never)
			send(hook, { type: "commands", commands: [{ key: "c", name: "c", source: "global" }] } as never)
			send(hook, { type: "modes", modes: [{ key: "code", slug: "code", name: "Code" }] } as never)
			send(hook, { type: "routerModels", routerModels: { shofer: { m: { contextWindow: 10 } } } } as never)

			const state = useCLIStore.getState()
			expect(state.fileSearchResults).toHaveLength(1)
			expect(state.allSlashCommands).toHaveLength(1)
			expect(state.availableModes).toHaveLength(1)
			expect(state.routerModels).toEqual({ shofer: { m: { contextWindow: 10 } } })

			hook.unmount()
		})

		it("treats a catalog message with nothing in it as an empty catalog", () => {
			const hook = mount()
			useCLIStore.getState().setAvailableModes([{ key: "code", slug: "code", name: "Code" }])

			send(hook, { type: "fileSearchResults" } as never)
			send(hook, { type: "commands" } as never)
			send(hook, { type: "modes" } as never)
			// …except routerModels, which is left alone rather than cleared.
			useCLIStore.getState().setRouterModels({ shofer: { m: {} } })
			send(hook, { type: "routerModels" } as never)

			expect(useCLIStore.getState().availableModes).toEqual([])
			expect(useCLIStore.getState().routerModels).toEqual({ shofer: { m: {} } })

			hook.unmount()
		})
	})

	it("ignores a messageUpdated with no message, and an unrecognised message type", () => {
		const hook = mount()

		send(hook, { type: "messageUpdated" } as ExtensionMessage)
		send(hook, { type: "somethingElse" } as never)

		expect(useCLIStore.getState().messages).toEqual([])
		hook.unmount()
	})
})
