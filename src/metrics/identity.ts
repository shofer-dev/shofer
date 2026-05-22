/**
 * Per-window identity used as a Prometheus label.
 *
 * Multiple VS Code windows on the same host emit overlapping series; the
 * `windowId` default label disambiguates them.  The workspace label is set
 * once at activation by the metrics server.
 *
 * Generated at module load so any code that imports it — including the
 * registry's `setDefaultLabels` — sees a stable value for the lifetime of
 * the extension host.
 */

import { webcrypto } from "crypto"

function randomHex(bytes: number): string {
	const buf = new Uint8Array(bytes)
	try {
		webcrypto.getRandomValues(buf)
	} catch {
		for (let i = 0; i < bytes; i++) buf[i] = Math.floor(Math.random() * 256)
	}
	return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("")
}

const _windowId = randomHex(8)
let _workspaceLabel = "(none)"

export function getWindowId(): string {
	return _windowId
}

export function setWorkspaceLabel(workspace: string | undefined): void {
	_workspaceLabel = workspace && workspace.length > 0 ? workspace : "(none)"
}

export function getWorkspaceLabel(): string {
	return _workspaceLabel
}
