import * as vscode from "vscode"
import { createInMemoryHost } from "@shofer/types"

import { setHost } from "../host-bridge"

/**
 * Test helper (§9): install a `HostBridge` whose notifier forwards to the
 * (mocked) `vscode.window.show*Message` functions. Lets tests for code migrated
 * onto `getHost().notifier` keep asserting on the existing `vscode.window.show*`
 * spies — mirroring how the real `VsCodeNotifier` routes to vscode. Filesystem is
 * the in-memory reference impl.
 */
export function installVsCodeForwardingHost(): void {
	const base = createInMemoryHost()
	setHost({
		...base,
		notifier: {
			info: (m: string) => void vscode.window.showInformationMessage(m),
			warn: (m: string) => void vscode.window.showWarningMessage(m),
			error: (m: string) => void vscode.window.showErrorMessage(m),
			showChoice: (m: string, options: string[], opts) =>
				Promise.resolve(
					(opts?.severity === "error"
						? vscode.window.showErrorMessage
						: opts?.severity === "warn"
							? vscode.window.showWarningMessage
							: vscode.window.showInformationMessage)(m, ...options),
				),
		},
	})
}
