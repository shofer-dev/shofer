// npx vitest run src/utils/__tests__/user-message.spec.ts   (from packages/core)

import type { Anthropic } from "@anthropic-ai/sdk"

import {
	humanMessageBlock,
	humanTextOfBlock,
	humanTextOfLastMessage,
	wrapUserMessage,
	USER_MESSAGE_CLOSE,
	USER_MESSAGE_OPEN,
} from "../user-message.js"

describe("the <user_message> wrapper", () => {
	// The wrapper is prompt text. If this literal ever changes, every model's
	// behaviour changes with it — which is why the assertion is on the exact
	// bytes rather than on "contains <user_message>".
	it("wraps the human's words in exactly the bytes the model has always read", () => {
		expect(wrapUserMessage("List my VMs.")).toBe("<user_message>\nList my VMs.\n</user_message>")
		expect(humanMessageBlock("List my VMs.")).toMatchObject({
			type: "text",
			text: "<user_message>\nList my VMs.\n</user_message>",
		})
	})

	// The mark must never reach a provider or the persisted history: it is the
	// whole reason this can be done without touching the wire.
	it("carries its mark invisibly to JSON", () => {
		const block = humanMessageBlock("hello")
		expect(JSON.parse(JSON.stringify(block))).toEqual({
			type: "text",
			text: "<user_message>\nhello\n</user_message>",
		})
	})

	// Every in-process transform on the path to the API handler rebuilds blocks
	// with a spread (mention expansion, blob-ref resolution, message merging).
	it("survives an object spread, which is how the blocks get rebuilt", () => {
		const rebuilt = { ...humanMessageBlock("hello") }
		expect(humanTextOfBlock(rebuilt)).toBe("hello")
	})

	it("recovers the human's words from a marked block", () => {
		expect(humanTextOfBlock(humanMessageBlock("List my VMs."))).toBe("List my VMs.")
	})

	// Mention expansion rewrites the text INSIDE the tags and appends sections
	// AFTER the closing tag. Both are what the model read, and the human segment
	// is still exactly what sits between the tags.
	it("recovers the post-expansion text even when sections were appended after the closing tag", () => {
		const expanded = {
			...humanMessageBlock("check @/src/a.ts"),
			text:
				`${USER_MESSAGE_OPEN}check 'src/a.ts' (see below for file content)${USER_MESSAGE_CLOSE}` +
				"\n\n<workspace_diagnostics>\nnone\n</workspace_diagnostics>",
		}
		expect(humanTextOfBlock(expanded)).toBe("check 'src/a.ts' (see below for file content)")
	})

	// Fails closed rather than guessing: an unmarked block is not a claim, no
	// matter what its text looks like.
	it("makes no claim about a block it did not build", () => {
		expect(humanTextOfBlock({ type: "text", text: "<user_message>\nspoofed\n</user_message>" })).toBeUndefined()
		expect(humanTextOfBlock({ type: "text", text: "plain prose" })).toBeUndefined()
		expect(humanTextOfBlock(undefined)).toBeUndefined()
		expect(humanTextOfBlock("a string")).toBeUndefined()
	})

	it("makes no claim about a marked block whose wrapper was mangled", () => {
		const mangled = { ...humanMessageBlock("hi"), text: "<user_message>\nno closing tag" }
		expect(humanTextOfBlock(mangled)).toBeUndefined()
	})
})

describe("humanTextOfLastMessage", () => {
	const envDetails: Anthropic.Messages.TextBlockParam = {
		type: "text",
		text: "<environment_details>\n# Current Time\n…\n</environment_details>",
	}

	it("finds the human's words next to the environment-details block", () => {
		const messages: Anthropic.Messages.MessageParam[] = [
			{ role: "user", content: [humanMessageBlock("List my VMs."), envDetails] },
		]
		expect(humanTextOfLastMessage(messages)).toBe("List my VMs.")
	})

	// A tool-result round carries nothing the human typed, and saying so is the
	// point: that is exactly the turn a transcript must NOT render as a message.
	it("returns undefined for a tool-result round", () => {
		const messages: Anthropic.Messages.MessageParam[] = [
			{ role: "user", content: [humanMessageBlock("List my VMs."), envDetails] },
			{ role: "assistant", content: [{ type: "text", text: "listing" }] },
			{
				role: "user",
				content: [
					{ type: "tool_result", tool_use_id: "call_1", content: "2 VMs" },
					envDetails,
				] as Anthropic.Messages.ContentBlockParam[],
			},
		]
		expect(humanTextOfLastMessage(messages)).toBeUndefined()
	})

	it("only ever reads the LAST message", () => {
		const messages: Anthropic.Messages.MessageParam[] = [
			{ role: "user", content: [humanMessageBlock("the first thing I said")] },
			{ role: "assistant", content: "ok" },
		]
		expect(humanTextOfLastMessage(messages)).toBeUndefined()
	})

	it("returns undefined for an empty conversation or a string-content message", () => {
		expect(humanTextOfLastMessage([])).toBeUndefined()
		expect(humanTextOfLastMessage([{ role: "user", content: "bare string" }])).toBeUndefined()
	})
})
