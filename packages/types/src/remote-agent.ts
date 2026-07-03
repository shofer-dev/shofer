/**
 * Remote-agent (Shofer Node) wire protocol — shared by the agent server
 * (`apps/cli/src/server/agent-server.ts`) and the local bridge
 * (`src/core/webview/RemoteAgentBridge.ts`).
 *
 * The heavy lifting is the existing `ExtensionMessage` / `WebviewMessage`
 * contract — those flow unchanged through the `msg` field. This envelope just
 * tags direction and carries a few transport-level control frames. See
 * `docs/remote-agents.md` (§Wire Protocol).
 */
import type { ExtensionMessage, WebviewMessage } from "./vscode-extension-host.js"

/** Bumped when the envelope or relay semantics change (version handshake). */
export const REMOTE_AGENT_PROTOCOL_VERSION = 1

/** Client (local coordinator / VS Code) → Server (remote node). */
export type ClientFrame =
	/** First frame after connect: protocol/version handshake. */
	| { dir: "hello"; protocolVersion: number; clientVersion?: string }
	/** Relay a webview message to the extension verbatim. */
	| { dir: "vw->ext"; msg: WebviewMessage }
	/** Initial / incremental (non-secret) configuration sync. */
	| { dir: "config"; configJson: string }
	/** Ask the node to re-send its retained message stream (reconnect resync). */
	| { dir: "syncState" }

/** Server (remote node) → Client (local coordinator / VS Code). */
export type ServerFrame =
	/** Sent once the host is activated and ready to relay. */
	| { dir: "ready"; protocolVersion: number; agentVersion?: string; workspaceId: string; reconnected: boolean }
	/** Relay an extension message to the webview verbatim. */
	| { dir: "ext->vw"; msg: ExtensionMessage }
	/** Forwarded ShoferAPI event (richer state tracking; optional). */
	| { dir: "apiEvent"; event: string; args: unknown[] }
	/** Transport / handshake error. */
	| { dir: "error"; message: string }

/** Parse an incoming client frame, returning `null` on malformed JSON. */
export function parseClientFrame(data: unknown): ClientFrame | null {
	try {
		const obj = JSON.parse(String(data))
		if (obj && typeof obj === "object" && typeof (obj as { dir?: unknown }).dir === "string") {
			return obj as ClientFrame
		}
	} catch {
		/* fall through */
	}
	return null
}

/** Parse an incoming server frame, returning `null` on malformed JSON. */
export function parseServerFrame(data: unknown): ServerFrame | null {
	try {
		const obj = JSON.parse(String(data))
		if (obj && typeof obj === "object" && typeof (obj as { dir?: unknown }).dir === "string") {
			return obj as ServerFrame
		}
	} catch {
		/* fall through */
	}
	return null
}

/** Serialize a frame for `ws.send`. */
export function encodeFrame(frame: ClientFrame | ServerFrame): string {
	return JSON.stringify(frame)
}
