/**
 * ACP agent server (v3 architecture §12).
 *
 * Binds the ACP agent-side methods to shofer's transport-agnostic {@link ShoferApi}
 * using the pure mapping in `acp-mapping.ts`. An ACP client (Zed, etc.) drives it
 * over the {@link JsonRpcPeer} connection: `initialize` → `session/new` →
 * `session/prompt` (streaming `session/update` notifications) → `session/cancel`.
 *
 * Wire method names follow the ACP spec; the shofer-side semantics live in the
 * mapping module. Event correlation (`taskId` extraction) and turn-completion
 * detection are overridable so the server can be unit-tested against synthetic
 * events and reconciled with the real event stream in one place.
 */

import type { ShoferApi, ServerEvent } from "@shofer/types"

import { type JsonRpcPeer } from "./acp-connection.js"
import {
	type ShoferStreamEvent,
	acpSessionModeToShoferMode,
	shoferModeToAcpSessionMode,
	toAcpSessionUpdate,
} from "./acp-mapping.js"

/** ACP protocol version this agent implements. */
export const ACP_PROTOCOL_VERSION = 1

/** Mode a session runs in until the client selects one via `session/set_mode`.
 *  `createTask` requires a mode, and ACP creates the task lazily on first prompt. */
const DEFAULT_SESSION_MODE = "code"

/** shofer stream events that end a prompt turn, → ACP `stopReason`. */
const TURN_END_EVENTS: Record<string, "end_turn" | "cancelled" | "error"> = {
	TaskCompleted: "end_turn",
	TaskAborted: "cancelled",
	TaskError: "error",
}

/** An ACP content block (subset). Only text is consumed on the way in. */
interface AcpContentBlock {
	type: string
	text?: string
}

export interface AcpAgentServerOptions {
	api: ShoferApi
	peer: JsonRpcPeer
	agentVersion?: string
	/** Extract the owning task id from a raw event (default: `taskId` field or first string arg). */
	getEventTaskId?: (event: ServerEvent) => string | undefined
	/** Normalize a raw event to the mapping's stream-event shape (default: best-effort). */
	toStreamEvent?: (event: ServerEvent) => ShoferStreamEvent | null
}

function defaultGetEventTaskId(event: ServerEvent): string | undefined {
	if (typeof event.taskId === "string") return event.taskId
	const args = (event as { args?: unknown }).args
	if (Array.isArray(args) && typeof args[0] === "string") return args[0]
	return undefined
}

function defaultToStreamEvent(event: ServerEvent): ShoferStreamEvent | null {
	// The ServerEvent shape ({ type, … }) is structurally a stream event: known
	// types map to dedicated ACP updates, everything else becomes `passthrough`
	// (the mapping guarantees nothing is silently dropped).
	return event as unknown as ShoferStreamEvent
}

/** The ACP agent: an object handling the agent-side ACP method set. */
export class AcpAgentServer {
	private readonly api: ShoferApi
	private readonly peer: JsonRpcPeer
	private readonly agentVersion: string
	private readonly getEventTaskId: (event: ServerEvent) => string | undefined
	private readonly toStreamEvent: (event: ServerEvent) => ShoferStreamEvent | null

	private sessionSeq = 0
	private readonly taskToSession = new Map<string, string>()
	private readonly sessionToTask = new Map<string, string>()
	/** Current shofer mode per session (seeds the task's mode on lazy create). */
	private readonly sessionMode = new Map<string, string>()
	private readonly turnWaiters = new Map<string, (stopReason: string) => void>()
	private readonly unsubscribe: () => void

	constructor(opts: AcpAgentServerOptions) {
		this.api = opts.api
		this.peer = opts.peer
		this.agentVersion = opts.agentVersion ?? "0.0.0"
		this.getEventTaskId = opts.getEventTaskId ?? defaultGetEventTaskId
		this.toStreamEvent = opts.toStreamEvent ?? defaultToStreamEvent

		this.peer.onRequest("initialize", () => this.initialize())
		this.peer.onRequest("session/new", () => this.newSession())
		this.peer.onRequest("session/prompt", (p) => this.prompt(p))
		this.peer.onRequest("session/set_mode", (p) => this.setMode(p))
		this.peer.onNotification("session/cancel", (p) => void this.cancel(p))

		this.unsubscribe = this.api.subscribe((event) => this.onEvent(event))
	}

	dispose(): void {
		this.unsubscribe()
	}

	private initialize(): unknown {
		return {
			protocolVersion: ACP_PROTOCOL_VERSION,
			agentVersion: this.agentVersion,
			agentCapabilities: { loadSession: false, promptCapabilities: { image: false } },
			authMethods: [],
		}
	}

	private newSession(): { sessionId: string } {
		const sessionId = `sess-${++this.sessionSeq}`
		this.sessionToTask.set(sessionId, "")
		this.sessionMode.set(sessionId, DEFAULT_SESSION_MODE)
		return { sessionId }
	}

	private async prompt(params: unknown): Promise<{ stopReason: string }> {
		const { sessionId, prompt } = (params ?? {}) as { sessionId?: string; prompt?: AcpContentBlock[] }
		if (!sessionId || !this.sessionToTask.has(sessionId)) {
			throw new Error(`Unknown session: ${sessionId}`)
		}
		const text = (prompt ?? [])
			.filter((b) => b.type === "text" && typeof b.text === "string")
			.map((b) => b.text)
			.join("")

		let taskId = this.sessionToTask.get(sessionId) || ""
		if (!taskId) {
			const mode = this.sessionMode.get(sessionId) ?? DEFAULT_SESSION_MODE
			taskId = (await this.api.createTask({ prompt: text, mode })).taskId
			this.sessionToTask.set(sessionId, taskId)
			this.taskToSession.set(taskId, sessionId)
		} else {
			await this.api.sendMessage(taskId, text)
		}

		const stopReason = await new Promise<string>((resolve) => this.turnWaiters.set(taskId, resolve))
		return { stopReason }
	}

	private setMode(params: unknown): { modeId: string } {
		const { sessionId, modeId } = (params ?? {}) as { sessionId?: string; modeId?: string }
		// 1:1 mode mapping. Store it per session so the task created on the next
		// prompt runs in this mode; for an already-created task, switching mid-task
		// still needs ShoferExtensionApi mode switching (not yet wired — see shofer-api.md).
		const shoferMode = acpSessionModeToShoferMode(modeId ?? "")
		if (sessionId && this.sessionMode.has(sessionId)) this.sessionMode.set(sessionId, shoferMode)
		return { modeId: shoferModeToAcpSessionMode(shoferMode) }
	}

	private async cancel(params: unknown): Promise<void> {
		const { sessionId } = (params ?? {}) as { sessionId?: string }
		const taskId = sessionId ? this.sessionToTask.get(sessionId) : undefined
		if (taskId) await this.api.cancelTask(taskId)
	}

	private onEvent(event: ServerEvent): void {
		const taskId = this.getEventTaskId(event)
		const sessionId = taskId ? this.taskToSession.get(taskId) : undefined

		// Stream every event as a session/update (passthrough if unmapped).
		if (sessionId) {
			const streamEvent = this.toStreamEvent(event)
			if (streamEvent) {
				this.peer.notify("session/update", { sessionId, update: toAcpSessionUpdate(streamEvent) })
			}
		}

		// Resolve the outstanding prompt turn on a terminal event.
		const stopReason = TURN_END_EVENTS[event.type]
		if (stopReason && taskId) {
			this.turnWaiters.get(taskId)?.(stopReason)
			this.turnWaiters.delete(taskId)
		}
	}
}
