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
		workspace: {
			...base.workspace,
			workspaceRoots: () =>
				(vscode.workspace.workspaceFolders ?? []).map((f: { uri: { fsPath: string } }) => f.uri.fsPath),
			activeEditorFile: () => vscode.window.activeTextEditor?.document?.uri?.fsPath,
			workspaceFolderFor: (filePath: string) => {
				try {
					return vscode.workspace.getWorkspaceFolder?.(vscode.Uri.file(filePath))?.uri?.fsPath
				} catch {
					return undefined
				}
			},
		},
		watcher: {
			watch: (baseDir: string, pattern: string) => {
				const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(baseDir, pattern))
				return {
					onCreate: (h: () => void) => w.onDidCreate(h),
					onChange: (h: () => void) => w.onDidChange(h),
					onDelete: (h: () => void) => w.onDidDelete(h),
					dispose: () => w.dispose(),
				}
			},
		},
		env: {
			get language() {
				return vscode.env.language
			},
			get appRoot() {
				return vscode.env.appRoot
			},
		},
		config: {
			get: <T>(section: string, key: string, defaultValue: T): T =>
				vscode.workspace.getConfiguration(section).get<T>(key, defaultValue) as T,
		},
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
