// pnpm --filter @shofer/cli test src/agent/__tests__/ask-dispatcher-handlers.test.ts

import type { ShoferAsk, ShoferMessage, WebviewMessage } from "@shofer/types"

import { AskDispatcher, type AskDispatcherOptions } from "../ask-dispatcher.js"
import type { OutputManager } from "../output-manager.js"
import type { PromptManager } from "../prompt-manager.js"

/**
 * Per-category coverage of AskDispatcher's routing and of every handler's three
 * shapes: non-interactive policy, an answered interactive prompt, and a prompt
 * that throws (which must default to a refusal rather than propagate).
 */

interface Harness {
	dispatcher: AskDispatcher
	sent: WebviewMessage[]
	lines: string[]
	displayed: Array<{ ts: number; text: string; partial: boolean }>
	prompt: {
		yesNo: { calls: string[]; answer: boolean; throws: boolean }
		input: { calls: string[]; answer: string; throws: boolean }
		timed: { calls: string[]; result: { value: string; timedOut: boolean; cancelled: boolean } }
	}
	resumeDeclined: number
}

function makeHarness(options: Partial<AskDispatcherOptions> = {}): Harness {
	const sent: WebviewMessage[] = []
	const lines: string[] = []
	const displayed: Array<{ ts: number; text: string; partial: boolean }> = []
	let resumeDeclined = 0

	const promptState: Harness["prompt"] = {
		yesNo: { calls: [], answer: true, throws: false },
		input: { calls: [], answer: "", throws: false },
		timed: { calls: [], result: { value: "", timedOut: false, cancelled: false } },
	}

	const outputManager = {
		output(label: string, text?: string) {
			lines.push(text === undefined ? label : `${label} ${text}`)
		},
		markDisplayed(ts: number, text: string, partial: boolean) {
			displayed.push({ ts, text, partial })
		},
	} as unknown as OutputManager

	const promptManager = {
		async promptForYesNo(prompt: string) {
			promptState.yesNo.calls.push(prompt)
			if (promptState.yesNo.throws) throw new Error("no tty")
			return promptState.yesNo.answer
		},
		async promptForInput(prompt: string) {
			promptState.input.calls.push(prompt)
			if (promptState.input.throws) throw new Error("no tty")
			return promptState.input.answer
		},
		async promptWithTimeout(prompt: string) {
			promptState.timed.calls.push(prompt)
			return promptState.timed.result
		},
	} as unknown as PromptManager

	const dispatcher = new AskDispatcher({
		outputManager,
		promptManager,
		sendMessage: (message) => void sent.push(message),
		onResumeDeclined: () => {
			resumeDeclined += 1
		},
		...options,
	})

	const harness: Harness = {
		dispatcher,
		sent,
		lines,
		displayed,
		prompt: promptState,
		get resumeDeclined() {
			return resumeDeclined
		},
	} as Harness

	return harness
}

let ts = 0
const askMessage = (ask: string, text = "", overrides: Partial<ShoferMessage> = {}): ShoferMessage =>
	({ type: "ask", ask: ask as ShoferAsk, text, ts: ++ts, partial: false, ...overrides }) as unknown as ShoferMessage

describe("AskDispatcher gating", () => {
	it("does nothing when disabled, and resumes work when re-enabled", async () => {
		const h = makeHarness({ disabled: true, nonInteractive: true })
		const message = askMessage("command_output")
		expect(await h.dispatcher.handleAsk(message)).toEqual({ handled: false })

		h.dispatcher.setDisabled(false)
		const result = await h.dispatcher.handleAsk(message)
		expect(result.handled).toBe(true)
		expect(h.sent).toEqual([{ type: "askResponse", askResponse: "yesButtonClicked" }])
	})

	it("ignores non-ask messages and partials", async () => {
		const h = makeHarness({ nonInteractive: true })
		const sayMessage = { type: "say", say: "text", text: "hi", ts: ++ts } as unknown as ShoferMessage
		expect(await h.dispatcher.handleAsk(sayMessage)).toEqual({ handled: false })
		expect(await h.dispatcher.handleAsk(askMessage("tool", "{}", { partial: true }))).toEqual({ handled: false })
	})

	it("dedupes by ts until cleared", async () => {
		const h = makeHarness({ nonInteractive: true })
		const message = askMessage("command_output")
		await h.dispatcher.handleAsk(message)
		expect(h.dispatcher.isHandled(message.ts)).toBe(true)
		await h.dispatcher.handleAsk(message)
		expect(h.sent).toHaveLength(1)

		h.dispatcher.clear()
		expect(h.dispatcher.isHandled(message.ts)).toBe(false)
		await h.dispatcher.handleAsk(message)
		expect(h.sent).toHaveLength(2)
	})

	it("re-allows an ask whose handler threw, and reports the error", async () => {
		const h = makeHarness({ nonInteractive: false })
		h.prompt.yesNo.throws = true
		// handleGenericApproval catches its own prompt failure, so force a failure
		// the dispatcher itself cannot swallow: a null output manager.
		const broken = new AskDispatcher({
			outputManager: undefined as unknown as OutputManager,
			promptManager: {} as unknown as PromptManager,
			sendMessage: () => {},
		})
		const message = askMessage("mistake_limit_reached", "too many")
		const result = await broken.handleAsk(message)
		expect(result.handled).toBe(false)
		expect(result.error).toBeInstanceOf(Error)
		expect(broken.isHandled(message.ts)).toBe(false)
	})
})

describe("AskDispatcher followup questions", () => {
	it("renders suggestions and resolves a numbered pick interactively", async () => {
		const h = makeHarness()
		h.prompt.input.answer = "2"
		const payload = JSON.stringify({
			question: "Which one?",
			suggest: [{ answer: "alpha" }, { answer: "beta", mode: "architect" }],
		})

		const result = await h.dispatcher.handleAsk(askMessage("followup", payload))

		expect(result).toEqual({ handled: true, response: "messageResponse" })
		expect(h.lines).toContain("\n[question] Which one?")
		expect(h.lines).toContain("  1. alpha")
		expect(h.lines).toContain("  2. beta (mode: architect)")
		expect(h.lines).toContain("Selected: beta")
		expect(h.sent).toEqual([{ type: "askResponse", askResponse: "messageResponse", text: "beta" }])
	})

	it("passes free text straight through and tolerates non-JSON payloads", async () => {
		const h = makeHarness()
		h.prompt.input.answer = "just words"
		await h.dispatcher.handleAsk(askMessage("followup", "plain question"))
		expect(h.lines).toContain("\n[question] plain question")
		expect(h.sent[0]).toEqual({ type: "askResponse", askResponse: "messageResponse", text: "just words" })
		expect(h.prompt.input.calls[0]).toBe("Your answer: ")
	})

	it("leaves an out-of-range number untouched", async () => {
		const h = makeHarness()
		h.prompt.input.answer = "9"
		await h.dispatcher.handleAsk(
			askMessage("followup", JSON.stringify({ question: "q", suggest: [{ answer: "a" }] })),
		)
		expect(h.sent[0]).toEqual({ type: "askResponse", askResponse: "messageResponse", text: "9" })
	})

	it("falls back to the first suggestion when the prompt fails", async () => {
		const h = makeHarness()
		h.prompt.input.throws = true
		await h.dispatcher.handleAsk(
			askMessage("followup", JSON.stringify({ question: "q", suggest: [{ answer: "a" }] })),
		)
		expect(h.lines).toContain("[Using default: a]")
		expect(h.sent[0]).toEqual({ type: "askResponse", askResponse: "messageResponse", text: "a" })
	})

	it("labels an empty default when the prompt fails with no suggestions", async () => {
		const h = makeHarness()
		h.prompt.input.throws = true
		await h.dispatcher.handleAsk(askMessage("followup", "q"))
		expect(h.lines).toContain("[Using default: (empty)]")
	})

	it("uses the timed prompt in non-interactive mode and reports the default on timeout", async () => {
		const h = makeHarness({ nonInteractive: true })
		h.prompt.timed.result = { value: "", timedOut: true, cancelled: false }
		await h.dispatcher.handleAsk(
			askMessage("followup", JSON.stringify({ question: "q", suggest: [{ answer: "a" }] })),
		)
		expect(h.prompt.timed.calls[0]).toContain("Enter number (1-1)")
		expect(h.lines).toContain("[Using default: a]")
		expect(h.sent[0]).toEqual({ type: "askResponse", askResponse: "messageResponse", text: "" })
	})

	it("uses the bare timed prompt when there are no suggestions", async () => {
		const h = makeHarness({ nonInteractive: true })
		h.prompt.timed.result = { value: "typed", timedOut: false, cancelled: false }
		await h.dispatcher.handleAsk(askMessage("followup", "q"))
		expect(h.prompt.timed.calls[0]).toContain("Your answer (auto-select in")
		expect(h.sent[0]).toEqual({ type: "askResponse", askResponse: "messageResponse", text: "typed" })
	})
})

describe("AskDispatcher approvals", () => {
	const cases: Array<{ ask: string; text: string; prompt: string; heading: string }> = [
		{ ask: "command", text: "ls -la", prompt: "Execute this command? (y/n): ", heading: "\n[command request]" },
		{
			ask: "tool",
			text: JSON.stringify({ tool: "readFile" }),
			prompt: "Approve this action? (y/n): ",
			heading: "\n[Tool Request] readFile",
		},
		{
			ask: "use_mcp_server",
			text: JSON.stringify({ server_name: "srv", type: "use_mcp_tool", tool_name: "t" }),
			prompt: "Allow MCP access? (y/n): ",
			heading: "\n[mcp request]",
		},
	]

	for (const testCase of cases) {
		it(`approves ${testCase.ask} when the user says yes`, async () => {
			const h = makeHarness()
			h.prompt.yesNo.answer = true
			const result = await h.dispatcher.handleAsk(askMessage(testCase.ask, testCase.text))
			expect(result).toEqual({ handled: true, response: "yesButtonClicked" })
			expect(h.prompt.yesNo.calls).toEqual([testCase.prompt])
			expect(h.lines).toContain(testCase.heading)
			expect(h.sent[0]).toEqual({ type: "askResponse", askResponse: "yesButtonClicked" })
		})

		it(`rejects ${testCase.ask} when the user says no`, async () => {
			const h = makeHarness()
			h.prompt.yesNo.answer = false
			const result = await h.dispatcher.handleAsk(askMessage(testCase.ask, testCase.text))
			expect(result).toEqual({ handled: true, response: "noButtonClicked" })
			expect(h.sent[0]).toEqual({ type: "askResponse", askResponse: "noButtonClicked" })
		})

		it(`defaults ${testCase.ask} to no when the prompt fails`, async () => {
			const h = makeHarness()
			h.prompt.yesNo.throws = true
			const result = await h.dispatcher.handleAsk(askMessage(testCase.ask, testCase.text))
			expect(result).toEqual({ handled: true, response: "noButtonClicked" })
			expect(h.lines).toContain("[Defaulting to: no]")
		})

		it(`auto-approves ${testCase.ask} in non-interactive mode without prompting`, async () => {
			const h = makeHarness({ nonInteractive: true })
			const result = await h.dispatcher.handleAsk(askMessage(testCase.ask, testCase.text))
			expect(result).toEqual({ handled: true })
			expect(h.prompt.yesNo.calls).toHaveLength(0)
			expect(h.sent).toHaveLength(0)
		})
	}

	it("labels a missing command", async () => {
		const h = makeHarness({ nonInteractive: true })
		await h.dispatcher.handleAsk(askMessage("command", ""))
		expect(h.lines).toContain("  Command: (no command specified)")
	})

	it("warns loudly for a protected tool target and renders every detail field", async () => {
		const h = makeHarness({ nonInteractive: true })
		const long = "x".repeat(250)
		const payload = JSON.stringify({
			tool: "editedExistingFile",
			isProtected: true,
			path: ".shofer/settings.json",
			longString: long,
			nested: { a: 1 },
			count: 3,
			flag: null,
		})
		await h.dispatcher.handleAsk(askMessage("tool", payload))

		expect(h.lines).toContain("\n[Tool Request] editedExistingFile [PROTECTED CONFIGURATION FILE]")
		expect(h.lines.some((line) => line.includes("WARNING"))).toBe(true)
		expect(h.lines).toContain("  path: .shofer/settings.json")
		expect(h.lines.some((line) => line.startsWith("  longString: ") && line.endsWith("..."))).toBe(true)
		expect(h.lines).toContain('  nested: {"a":1}')
		expect(h.lines).toContain("  count: 3")
		expect(h.lines).toContain("  flag: null")
	})

	it("truncates a long nested object value", async () => {
		const h = makeHarness({ nonInteractive: true })
		const payload = JSON.stringify({ tool: "t", big: { value: "y".repeat(300) } })
		await h.dispatcher.handleAsk(askMessage("tool", payload))
		expect(h.lines.some((line) => line.startsWith("  big: ") && line.endsWith("..."))).toBe(true)
	})

	it("falls back to an unknown tool name for non-JSON payloads", async () => {
		const h = makeHarness({ nonInteractive: true })
		await h.dispatcher.handleAsk(askMessage("tool", "not json"))
		expect(h.lines).toContain("\n[Tool Request] unknown")
	})

	it("renders an MCP resource request", async () => {
		const h = makeHarness({ nonInteractive: true })
		const payload = JSON.stringify({ server_name: "srv", type: "access_mcp_resource", uri: "res://x" })
		await h.dispatcher.handleAsk(askMessage("use_mcp_server", payload))
		expect(h.lines).toContain("  Server: srv")
		expect(h.lines).toContain("  Resource: res://x")
	})

	it("falls back to an unknown MCP server for non-JSON payloads", async () => {
		const h = makeHarness({ nonInteractive: true })
		await h.dispatcher.handleAsk(askMessage("use_mcp_server", "garbage"))
		expect(h.lines).toContain("  Server: unknown")
	})

	it("leaves an interactive ask with no handler unhandled", async () => {
		const h = makeHarness()
		// budget_limit is an interactive ask with no branch in the switch.
		expect(await h.dispatcher.handleAsk(askMessage("budget_limit", "cap"))).toEqual({ handled: false })
	})
})

describe("AskDispatcher idle asks", () => {
	it("treats completion_result as already handled by the lifecycle event", async () => {
		const h = makeHarness()
		expect(await h.dispatcher.handleAsk(askMessage("completion_result", "done"))).toEqual({ handled: true })
		expect(h.sent).toHaveLength(0)
	})

	it("auto-retries a failed api request in non-interactive mode", async () => {
		const h = makeHarness({ nonInteractive: true })
		expect(await h.dispatcher.handleAsk(askMessage("api_req_failed", "429"))).toEqual({ handled: true })
		expect(h.lines).toContain("\n[api request failed]")
		expect(h.lines).toContain("  Error: 429")
		expect(h.lines).toContain("\n[retrying api request]")
	})

	it("labels an empty api failure", async () => {
		const h = makeHarness({ nonInteractive: true })
		await h.dispatcher.handleAsk(askMessage("api_req_failed", ""))
		expect(h.lines).toContain("  Error: Unknown error")
	})

	it("prompts for a retry interactively", async () => {
		const h = makeHarness()
		h.prompt.yesNo.answer = true
		expect(await h.dispatcher.handleAsk(askMessage("api_req_failed", "boom"))).toEqual({
			handled: true,
			response: "yesButtonClicked",
		})

		const declining = makeHarness()
		declining.prompt.yesNo.throws = true
		expect(await declining.dispatcher.handleAsk(askMessage("api_req_failed", "boom"))).toEqual({
			handled: true,
			response: "noButtonClicked",
		})
	})

	it("exits the process when exitOnError is set", async () => {
		const h = makeHarness({ exitOnError: true, nonInteractive: true })
		const exit = vi.spyOn(process, "exit").mockImplementation((() => {
			throw new Error("process.exit called")
		}) as never)
		const error = vi.spyOn(console, "error").mockImplementation(() => {})

		try {
			const result = await h.dispatcher.handleAsk(askMessage("api_req_failed", "fatal"))
			expect(result.handled).toBe(false)
			expect(result.error?.message).toBe("process.exit called")
			expect(exit).toHaveBeenCalledWith(1)
			expect(error).toHaveBeenCalled()
		} finally {
			exit.mockRestore()
			error.mockRestore()
		}
	})

	for (const [ask, heading, prompt] of [
		["mistake_limit_reached", "\n[mistake limit reached]", "Continue anyway? (y/n): "],
		["auto_approval_max_req_reached", "\n[auto-approval limit reached]", "Continue with manual approval? (y/n): "],
	] as const) {
		it(`auto-proceeds ${ask} in non-interactive mode`, async () => {
			const h = makeHarness({ nonInteractive: true })
			expect(await h.dispatcher.handleAsk(askMessage(ask, "details"))).toEqual({
				handled: true,
				response: "yesButtonClicked",
			})
			expect(h.lines).toContain(heading)
			expect(h.lines).toContain("  Details: details")
			expect(h.sent[0]).toEqual({ type: "askResponse", askResponse: "yesButtonClicked" })
		})

		it(`omits the details line for ${ask} with no text`, async () => {
			const h = makeHarness({ nonInteractive: true })
			await h.dispatcher.handleAsk(askMessage(ask, ""))
			expect(h.lines).toEqual([heading])
		})

		it(`prompts for ${ask} interactively and defaults to no on failure`, async () => {
			const yes = makeHarness()
			yes.prompt.yesNo.answer = true
			expect(await yes.dispatcher.handleAsk(askMessage(ask, "d"))).toEqual({
				handled: true,
				response: "yesButtonClicked",
			})
			expect(yes.prompt.yesNo.calls).toEqual([prompt])

			const broken = makeHarness()
			broken.prompt.yesNo.throws = true
			expect(await broken.dispatcher.handleAsk(askMessage(ask, "d"))).toEqual({
				handled: true,
				response: "noButtonClicked",
			})
		})
	}
})

describe("AskDispatcher resume", () => {
	it("declines to auto-resume when the budget is zero", async () => {
		const h = makeHarness({ nonInteractive: true })
		const result = await h.dispatcher.handleAsk(askMessage("resume_task", "interrupted"))
		expect(result).toEqual({ handled: true })
		expect(h.lines).toContain("\n[Resume Task]")
		expect(h.lines).toContain("  interrupted")
		expect(h.lines).toContain("\n[task interrupted; not auto-resuming (use --retry <n> to enable)]")
		expect(h.resumeDeclined).toBe(1)
		expect(h.sent).toHaveLength(0)
	})

	it("spends the retry budget then declines", async () => {
		const h = makeHarness({ nonInteractive: true, maxResumeRetries: 1 })
		expect(await h.dispatcher.handleAsk(askMessage("resume_task"))).toEqual({
			handled: true,
			response: "yesButtonClicked",
		})
		expect(h.lines).toContain("\n[continuing task]")
		expect(await h.dispatcher.handleAsk(askMessage("resume_task"))).toEqual({ handled: true })
		expect(h.resumeDeclined).toBe(1)
	})

	it("grantResume adds one to the budget, and clear() restores the configured maximum", async () => {
		const h = makeHarness({ nonInteractive: true, maxResumeRetries: 0 })
		h.dispatcher.grantResume()
		expect(await h.dispatcher.handleAsk(askMessage("resume_task"))).toEqual({
			handled: true,
			response: "yesButtonClicked",
		})

		h.dispatcher.clear()
		expect(await h.dispatcher.handleAsk(askMessage("resume_task"))).toEqual({ handled: true })
	})

	it("labels a completed-task resume", async () => {
		const h = makeHarness({ nonInteractive: true, maxResumeRetries: 1 })
		await h.dispatcher.handleAsk(askMessage("resume_completed_task", ""))
		expect(h.lines).toContain("\n[Resume Completed Task]")
	})

	it("prompts for the resume interactively and defaults to no on failure", async () => {
		const yes = makeHarness()
		yes.prompt.yesNo.answer = true
		expect(await yes.dispatcher.handleAsk(askMessage("resume_task"))).toEqual({
			handled: true,
			response: "yesButtonClicked",
		})
		expect(yes.prompt.yesNo.calls).toEqual(["Continue with this task? (y/n): "])

		const broken = makeHarness()
		broken.prompt.yesNo.throws = true
		expect(await broken.dispatcher.handleAsk(askMessage("resume_task"))).toEqual({
			handled: true,
			response: "noButtonClicked",
		})
	})

	it("still handles a resume while brokering interactive asks", async () => {
		const h = makeHarness({ nonInteractive: true, brokerInteractiveAsks: true, maxResumeRetries: 1 })
		expect(await h.dispatcher.handleAsk(askMessage("resume_task"))).toEqual({
			handled: true,
			response: "yesButtonClicked",
		})
	})
})

describe("AskDispatcher unknown asks", () => {
	it("prints the payload and stops in non-interactive mode", async () => {
		const h = makeHarness({ nonInteractive: true })
		expect(await h.dispatcher.handleAsk(askMessage("browser_action_launch", "http://x"))).toEqual({ handled: true })
		expect(h.lines).toContain("\n[browser_action_launch] http://x")
		expect(h.sent).toHaveLength(0)
	})

	it("says nothing for an unknown ask with no text", async () => {
		const h = makeHarness({ nonInteractive: true })
		expect(await h.dispatcher.handleAsk(askMessage("weird_ask", ""))).toEqual({ handled: true })
		expect(h.lines).toHaveLength(0)
	})

	it("asks for a generic approval interactively", async () => {
		const h = makeHarness()
		h.prompt.yesNo.answer = true
		expect(await h.dispatcher.handleAsk(askMessage("weird_ask", "details"))).toEqual({
			handled: true,
			response: "yesButtonClicked",
		})
		expect(h.lines).toContain("\n[weird_ask]")
		expect(h.lines).toContain("  details")
		expect(h.prompt.yesNo.calls).toEqual(["Approve? (y/n): "])
	})

	it("omits the detail line and defaults to no when the generic prompt fails", async () => {
		const h = makeHarness()
		h.prompt.yesNo.throws = true
		expect(await h.dispatcher.handleAsk(askMessage("weird_ask", ""))).toEqual({
			handled: true,
			response: "noButtonClicked",
		})
		expect(h.lines).toEqual(["\n[weird_ask]", "[Defaulting to: no]"])
	})
})
