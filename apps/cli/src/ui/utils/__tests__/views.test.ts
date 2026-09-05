// pnpm --filter @shofer/cli test src/ui/utils/__tests__/views.test.ts

import type { PendingAsk, TUIMessage } from "../../types.js"
import { getView } from "../views.js"

/**
 * `getView` is the CLI's whole view router: from the message list plus whatever
 * ask is outstanding it decides which Ink screen is showing. Its ordering is
 * load-bearing — a pending ask outranks everything, because the loop is parked
 * on the user and no amount of streaming state changes that.
 */

const message = (role: TUIMessage["role"], extra: Partial<TUIMessage> = {}): TUIMessage => ({
	id: "m1",
	role,
	content: "hi",
	...extra,
})

const ask = (type: PendingAsk["type"]): PendingAsk => ({ id: "a1", type, content: "?" })

describe("getView", () => {
	it("shows the input while a followup question is outstanding, whatever else is going on", () => {
		expect(getView([message("assistant")], ask("followup"), true)).toBe("UserInput")
	})

	it("shows the input while an approval ask is outstanding", () => {
		expect(getView([message("assistant")], ask("tool"), true)).toBe("UserInput")
	})

	it("shows the input on the home screen", () => {
		expect(getView([], null, false)).toBe("UserInput")
	})

	it("waits for the agent right after the user sends", () => {
		expect(getView([message("user")], null, false)).toBe("AgentResponse")
	})

	it("shows tool use when the assistant's last message still has tool calls pending", () => {
		expect(getView([message("assistant", { hasPendingToolCalls: true })], null, false)).toBe("ToolUse")
	})

	it("keeps waiting on the assistant while the turn is still streaming", () => {
		expect(getView([message("assistant")], null, true)).toBe("AgentResponse")
	})

	it("returns to the input once the assistant's turn is finished", () => {
		expect(getView([message("assistant")], null, false)).toBe("UserInput")
	})

	it("waits for the agent after a tool result lands", () => {
		expect(getView([message("tool")], null, false)).toBe("AgentResponse")
	})

	it("falls through to Default for a role that ends no turn", () => {
		expect(getView([message("system")], null, false)).toBe("Default")
		expect(getView([message("thinking")], null, false)).toBe("Default")
	})

	it("reads the LAST message, not the first", () => {
		expect(getView([message("assistant"), { ...message("user"), id: "m2" }], null, false)).toBe("AgentResponse")
	})

	it("shows the input for a list whose entries are all holes", () => {
		// `messages.at(-1)` is undefined for a sparse array even though length > 0.
		const sparse = new Array<TUIMessage>(2)
		expect(getView(sparse, null, false)).toBe("UserInput")
	})
})
