import { vscode } from "./vscode"

/**
 * Diagnostic logger for the webview. Mirrors a message to:
 *  1. The webview's own DevTools console (visible in F12 / Developer Tools).
 *  2. Roo-Code's OutputChannel via a `webviewLog` message back to the extension.
 *
 * Use this for any diagnostics that should be tailable from `View → Output → Roo Code`
 * without having to open the webview Developer Tools.
 */
export function webviewLog(message: string): void {
	console.log(message)
	try {
		vscode.postMessage({ type: "webviewLog", text: message })
	} catch {
		// Ignore failures to post (e.g. during teardown)
	}
}
