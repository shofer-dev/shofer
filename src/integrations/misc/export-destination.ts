import * as vscode from "vscode"

import { t } from "@shofer/core"

/**
 * Where a task export should be written.
 *
 * - `"browser"` — stream the bytes to the webview so the user's browser saves
 *   them locally. Only meaningful on a web host (see {@link isWebHost}).
 * - `"remote"` — the classic `showSaveDialog` + `workspace.fs.writeFile` path,
 *   which writes to the machine the extension host runs on.
 */
export type ExportDestination = "browser" | "remote"

/**
 * True when the editor is being accessed through a browser — code-server,
 * vscode.dev, github.dev, etc. In that setup the extension host (and therefore
 * `showSaveDialog` / `workspace.fs`) lives on a remote server, not on the user's
 * machine, so a "save" lands on the server rather than the user's computer. The
 * only way to get a file onto the user's machine is to hand it to the webview
 * and let the browser download it.
 */
export function isWebHost(): boolean {
	return vscode.env.uiKind === vscode.UIKind.Web
}

/**
 * Decide where an export should go.
 *
 * On a desktop host the extension host *is* the user's machine, so we save
 * directly (no prompt, unchanged behaviour). On a web host we can't know whether
 * the user wants the file on their own computer (via the browser) or on the
 * remote server, so we ask. Returns `undefined` if the user dismisses the pick.
 */
export async function pickExportDestination(): Promise<ExportDestination | undefined> {
	if (!isWebHost()) {
		return "remote"
	}

	const browser = {
		label: `$(cloud-download) ${t("common:export_destination.browser_label")}`,
		detail: t("common:export_destination.browser_detail"),
		value: "browser" as const,
	}
	const remote = {
		label: `$(server) ${t("common:export_destination.remote_label")}`,
		detail: t("common:export_destination.remote_detail"),
		value: "remote" as const,
	}

	const choice = await vscode.window.showQuickPick([browser, remote], {
		placeHolder: t("common:export_destination.prompt"),
	})

	return choice?.value
}
