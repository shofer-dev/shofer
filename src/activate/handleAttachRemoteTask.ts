import * as vscode from "vscode"

import { getHost } from "@shofer/types"
import { t } from "@shofer/core"

import { ShoferProvider } from "../core/webview/ShoferProvider"
import { TaskAttachmentManager } from "../core/attach/TaskAttachmentManager"

/** Arguments the attach command accepts directly (a dispatcher UI can pass them all). */
export interface AttachRemoteTaskArgs {
	address?: string
	taskId?: string
	token?: string
}

/**
 * Attach the visible view to a task running on another host.
 *
 * The minimal user-facing door onto the attachment primitive: three prompts, no
 * stored state. In particular the **token is not persisted** — it is another host's
 * machine-trust bearer, and keeping a collection of them here would turn this
 * extension into a credential store for a fleet it deliberately does not manage. A
 * dispatcher plugin that knows the address and token passes them in as arguments and
 * never prompts at all.
 */
export const handleAttachRemoteTask = async (args: AttachRemoteTaskArgs | null | undefined) => {
	const provider = await ShoferProvider.getInstance()
	if (!provider) return

	const address =
		args?.address ??
		(await vscode.window.showInputBox({
			prompt: t("common:attach.input.address_prompt"),
			placeHolder: t("common:attach.input.address_placeholder"),
			ignoreFocusOut: true,
		}))
	if (!address) return

	const taskId =
		args?.taskId ??
		(await vscode.window.showInputBox({
			prompt: t("common:attach.input.task_id_prompt"),
			ignoreFocusOut: true,
		}))
	if (!taskId) return

	// Empty is meaningful here: a host started without `--token` takes no bearer.
	const token =
		args?.token ??
		(await vscode.window.showInputBox({
			prompt: t("common:attach.input.token_prompt"),
			password: true,
			ignoreFocusOut: true,
		}))

	try {
		await TaskAttachmentManager.getInstance().attach(provider, {
			address,
			taskId,
			token: token || undefined,
		})
		await provider.postMessageToWebview({ type: "action", action: "chatButtonClicked" })
	} catch (error) {
		getHost().notifier.error(error instanceof Error ? error.message : String(error))
	}
}

/**
 * Detach the visible view from the task it is watching. The task keeps running; only
 * this host's connection to it goes away.
 */
export const handleDetachRemoteTask = async () => {
	const provider = await ShoferProvider.getInstance()
	if (!provider) return

	const detached = TaskAttachmentManager.getInstance().detach(provider)
	if (!detached) {
		getHost().notifier.info(t("common:attach.errors.not_attached"))
	}
}
