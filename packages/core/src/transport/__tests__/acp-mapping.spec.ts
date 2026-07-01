import { describe, it, expect } from "vitest"

import {
	ACP_METHOD_MAP,
	acpSessionModeToShoferMode,
	shoferModeToAcpSessionMode,
	toAcpPermissionOutcome,
	toAcpSessionUpdate,
} from "../acp-mapping.js"

/**
 * §12 ACP mapping — the pure shofer↔ACP translation that backs the (SDK-wired)
 * agent adapter.
 */
describe("ACP mapping (§12)", () => {
	it("maps auto-approval decisions to ACP permission outcomes", () => {
		expect(toAcpPermissionOutcome("approve")).toEqual({ outcome: "selected", optionId: "allow_once" })
		expect(toAcpPermissionOutcome("deny")).toEqual({ outcome: "selected", optionId: "reject" })
		expect(toAcpPermissionOutcome("ask")).toEqual({ outcome: "prompt" })
	})

	it("round-trips mode ↔ ACP session mode", () => {
		expect(shoferModeToAcpSessionMode("code")).toBe("code")
		expect(acpSessionModeToShoferMode("architect")).toBe("architect")
	})

	it("maps stream events to ACP sessionUpdate variants", () => {
		expect(toAcpSessionUpdate({ type: "assistant", text: "hi" })).toEqual({
			sessionUpdate: "agent_message_chunk",
			content: { type: "text", text: "hi" },
		})
		expect(toAcpSessionUpdate({ type: "thinking", text: "hmm" })).toMatchObject({
			sessionUpdate: "agent_thought_chunk",
		})
		expect(toAcpSessionUpdate({ type: "tool_use", toolName: "read_file", toolCallId: "c1" })).toEqual({
			sessionUpdate: "tool_call",
			toolCallId: "c1",
			title: "read_file",
		})
		expect(toAcpSessionUpdate({ type: "tool_result", toolCallId: "c1", output: "ok" })).toMatchObject({
			sessionUpdate: "tool_call_update",
			status: "completed",
			content: "ok",
		})
	})

	it("wraps unknown events as passthrough (no event dropped)", () => {
		const e = { type: "queue", size: 3 }
		expect(toAcpSessionUpdate(e)).toEqual({ sessionUpdate: "passthrough", event: e })
	})

	it("documents the full ACP agent method set", () => {
		for (const m of ["initialize", "newSession", "prompt", "cancel", "setSessionMode", "requestPermission"]) {
			expect(ACP_METHOD_MAP[m]).toBeTruthy()
		}
	})
})
