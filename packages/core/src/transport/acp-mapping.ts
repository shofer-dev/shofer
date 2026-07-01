/**
 * ACP (Agent Client Protocol) mapping (v3 architecture §12).
 *
 * ACP is a standard inbound protocol: any ACP-speaking client (Zed today, more
 * editors over time) can drive shofer as a backend agent with zero per-editor
 * work. The wire protocol is off-the-shelf (`@agentclientprotocol/sdk`); per the
 * roadmap, "the real work is mapping shofer's session/mode/model/permission/event
 * surface onto ACP methods." This module is exactly that mapping — pure functions,
 * testable without the SDK or a stdio loop. The `shofer acp` stdio entrypoint +
 * SDK wiring is the thin shell on top, and depends on §9's host-agnostic core so
 * the agent runs without VS Code.
 *
 * The ACP shape types here are intentionally minimal local mirrors of the SDK's;
 * when the SDK is wired in, these map onto its generated types 1:1.
 */

/** shofer's auto-approval decision (see core/auto-approval). */
export type ApprovalDecision = "approve" | "ask" | "deny"

/** ACP permission outcome for a `requestPermission` exchange. */
export type AcpPermissionOutcome =
	| { outcome: "selected"; optionId: "allow_once" }
	| { outcome: "selected"; optionId: "reject" }
	| { outcome: "prompt" }

/**
 * Map a shofer auto-approval decision to an ACP permission outcome:
 *  - `approve` → auto-allow (no user prompt),
 *  - `deny`    → auto-reject,
 *  - `ask`     → defer to the client's permission prompt.
 */
export function toAcpPermissionOutcome(decision: ApprovalDecision): AcpPermissionOutcome {
	switch (decision) {
		case "approve":
			return { outcome: "selected", optionId: "allow_once" }
		case "deny":
			return { outcome: "selected", optionId: "reject" }
		case "ask":
			return { outcome: "prompt" }
	}
}

/**
 * shofer modes map 1:1 onto ACP session modes (`setSessionMode`). The mode slug
 * is the ACP mode id; this is a named passthrough so the seam is explicit and
 * has a single place to diverge if needed.
 */
export function shoferModeToAcpSessionMode(modeSlug: string): string {
	return modeSlug
}
export function acpSessionModeToShoferMode(acpModeId: string): string {
	return acpModeId
}

/** A shofer-side event (the shape the event stream / §11 transport emits). */
export interface ShoferStreamEvent {
	type: string
	text?: string
	toolName?: string
	toolCallId?: string
	output?: string
	[key: string]: unknown
}

/** An ACP `sessionUpdate` notification (minimal mirror of the SDK shape). */
export type AcpSessionUpdate =
	| { sessionUpdate: "agent_message_chunk"; content: { type: "text"; text: string } }
	| { sessionUpdate: "agent_thought_chunk"; content: { type: "text"; text: string } }
	| { sessionUpdate: "tool_call"; toolCallId: string; title: string }
	| { sessionUpdate: "tool_call_update"; toolCallId: string; status: "completed"; content?: string }
	| { sessionUpdate: "passthrough"; event: ShoferStreamEvent }

/**
 * Map a shofer stream event to an ACP `sessionUpdate` notification. The common
 * cases (assistant text, reasoning, tool call start/result) map onto ACP's
 * dedicated update variants; anything else is wrapped as a `passthrough` so no
 * event is silently dropped.
 */
export function toAcpSessionUpdate(event: ShoferStreamEvent): AcpSessionUpdate {
	switch (event.type) {
		case "assistant":
		case "text":
			return { sessionUpdate: "agent_message_chunk", content: { type: "text", text: event.text ?? "" } }
		case "thinking":
		case "reasoning":
			return { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: event.text ?? "" } }
		case "tool_use":
			return { sessionUpdate: "tool_call", toolCallId: event.toolCallId ?? "", title: event.toolName ?? "tool" }
		case "tool_result":
			return {
				sessionUpdate: "tool_call_update",
				toolCallId: event.toolCallId ?? "",
				status: "completed",
				content: event.output,
			}
		default:
			return { sessionUpdate: "passthrough", event }
	}
}

/**
 * The ACP method set shofer must implement on the agent side, mapped to the
 * shofer concept that backs each. Documented here (and asserted in tests) so the
 * `shofer acp` entrypoint can be checked for completeness against the protocol.
 */
export const ACP_METHOD_MAP: Record<string, string> = {
	initialize: "capability negotiation",
	authenticate: "provider credentials",
	newSession: "create Task",
	loadSession: "resume Task from history",
	listSessions: "task history",
	prompt: "send user message to Task",
	cancel: "Task.abortTask (§6)",
	setSessionMode: "switch mode (§4 modes)",
	setSessionModel: "select model (§7 catalog)",
	requestPermission: "auto-approval decision (§4)",
	sessionUpdate: "typed events → notifications (§3/§8)",
}
