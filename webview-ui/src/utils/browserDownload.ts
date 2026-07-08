/**
 * Trigger a client-side download from the webview.
 *
 * When the editor is accessed over the web (code-server / vscode.dev), the
 * extension host's filesystem is a remote server, so a host-side "save" never
 * reaches the user's machine. Instead the host streams the file's bytes here and
 * we hand them to the browser as a Blob download, landing the file on the user's
 * own computer. VS Code webview iframes carry `allow-downloads` in their sandbox,
 * so the anchor click below is honoured.
 */
export function triggerBrowserDownload(fileName: string, content: string, mime: string): void {
	const blob = new Blob([content], { type: mime })
	const url = URL.createObjectURL(blob)
	const anchor = document.createElement("a")
	anchor.href = url
	anchor.download = fileName
	document.body.appendChild(anchor)
	anchor.click()
	anchor.remove()
	// Revoke on the next tick so the download has a chance to start first.
	setTimeout(() => URL.revokeObjectURL(url), 1000)
}
