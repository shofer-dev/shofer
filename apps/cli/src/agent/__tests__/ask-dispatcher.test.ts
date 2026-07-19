import type { ShoferMessage, WebviewMessage } from "@shofer/types"

import { AskDispatcher } from "../ask-dispatcher.js"

/**
 * AskDispatcher brokering: on a headless node driven by a controller
 * (`brokerInteractiveAsks: true`), interactive asks (approval + followup) must be
 * left outstanding for the controller — never prompted or auto-answered locally —
 * while idle / flow-control asks are still handled on the node.
 */

// Minimal stubs — the brokered path short-circuits before touching output/prompt,
// and the idle path in nonInteractive mode auto-handles without prompting.
function makeDispatcher(opts: { brokerInteractiveAsks: boolean }) {
	const sent: WebviewMessage[] = []
	const outputManager = { output() {}, markDisplayed() {}, outputMessage() {}, outputCompletionResult() {} }
	const promptManager = {
		promptForYesNo: async () => true,
		promptForInput: async () => "",
		promptWithTimeout: async () => ({ value: "", timedOut: true, cancelled: false }),
	}
	const dispatcher = new AskDispatcher({
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		outputManager: outputManager as any,
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		promptManager: promptManager as any,
		sendMessage: (m: WebviewMessage) => void sent.push(m),
		nonInteractive: true,
		brokerInteractiveAsks: opts.brokerInteractiveAsks,
	})
	return { dispatcher, sent }
}

const ask = (ask: string, ts: number, text = ""): ShoferMessage =>
	({ type: "ask", ask, text, ts, partial: false }) as unknown as ShoferMessage

describe("AskDispatcher brokering", () => {
	it("leaves interactive asks outstanding for the controller (no local response)", async () => {
		const { dispatcher, sent } = makeDispatcher({ brokerInteractiveAsks: true })
		let ts = 1
		for (const kind of ["command", "tool", "use_mcp_server", "followup"]) {
			const res = await dispatcher.handleAsk(ask(kind, ts++, "{}"))
			expect(res.handled).toBe(false)
		}
		// Nothing was answered on the node — the controller will respondToAsk.
		expect(sent).toHaveLength(0)
	})

	it("still handles idle / flow-control asks locally when brokering", async () => {
		const { dispatcher } = makeDispatcher({ brokerInteractiveAsks: true })
		// api_req_failed is node policy (auto-retry in nonInteractive), not a user
		// decision — it must NOT be left for the controller.
		const res = await dispatcher.handleAsk(ask("api_req_failed", 10, "boom"))
		expect(res.handled).toBe(true)
	})

	it("without brokering, interactive asks are handled on the node", async () => {
		const { dispatcher } = makeDispatcher({ brokerInteractiveAsks: false })
		// nonInteractive auto-approves a command ask locally (handled), rather than
		// leaving it outstanding.
		const res = await dispatcher.handleAsk(ask("command", 20, "ls"))
		expect(res.handled).toBe(true)
	})
})
