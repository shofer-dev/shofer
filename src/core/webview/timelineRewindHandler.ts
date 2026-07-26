import { Task, pluginRegistry } from "@shofer/core"
import { getHost } from "@shofer/types"
import pWaitFor from "p-wait-for"
import { webviewLog } from "@shofer/core"

import { ShoferProvider } from "./ShoferProvider"
import { saveTaskMessages } from "../task-persistence"

/**
 * Timeline rewind — the host half of "take this conversation back to an earlier
 * message", used by the delete-message and edit-message flows.
 *
 * The rewind itself (truncate the chat, restart the task) is core's. Anything a
 * *plugin* anchored to the messages being discarded — a workspace snapshot, an
 * external job — is the plugin's, and it is rolled back through the
 * `onTimelineRewind` lifecycle hook, awaited here BEFORE the messages disappear.
 * That ordering is the whole point: a snapshot plugin that restored afterwards
 * would be restoring to an anchor the host has already forgotten.
 *
 * Core therefore knows nothing about what is being rolled back — only that
 * plugins get told, and whether the user asked for out-of-band state to come back
 * too (`restoreState`).
 */
export interface TimelineRewindConfig {
	provider: ShoferProvider
	currentShofer: Task
	/** Timestamp of the message to rewind to. */
	messageTs: number
	/** Index of that message in `shoferMessages`. */
	messageIndex: number
	/** Delete = the target message stays; edit = it is replaced by `editData`. */
	operation: "delete" | "edit"
	/**
	 * Whether the user asked for plugin-held state (e.g. the workspace) to be rolled
	 * back too. `false` ⇒ chat-only rewind; plugins are still told, so they can drop
	 * anchors, but must not touch the workspace.
	 */
	restoreState: boolean
	editData?: {
		editedContent: string
		images?: string[]
		apiConversationHistoryIndex: number
	}
}

/**
 * Rewind `currentShofer`'s timeline to `messageTs`, giving plugins the chance to
 * roll their own state back first, then reinitializing the task so it continues
 * against the truncated history.
 */
export async function handleTimelineRewind(config: TimelineRewindConfig): Promise<void> {
	const { provider, currentShofer, messageTs, messageIndex, operation, restoreState, editData } = config

	try {
		// A delete may land while an ask is outstanding; aborting first avoids the
		// "current ask promise was ignored" path. An edit skips it — the pending-edit
		// reinitialization below does the cancelling.
		if (operation === "delete" && !currentShofer.abort) {
			currentShofer.abortTask()
			await pWaitFor(() => currentShofer.abort === true, { timeout: 1000, interval: 50 }).catch(() => {
				// Proceed regardless — the abort flag is set synchronously.
			})
		}

		if (operation === "edit" && editData) {
			provider.setPendingEditOperation(`task-${currentShofer.taskId}`, {
				messageTs,
				editedContent: editData.editedContent,
				images: editData.images,
				messageIndex,
				apiConversationHistoryIndex: editData.apiConversationHistoryIndex,
			})
		}

		// Plugins first, while the messages they anchored to still exist.
		await pluginRegistry.notifyTimelineRewind({
			ts: messageTs,
			taskId: currentShofer.taskId,
			operation,
			restoreState,
		})

		// MessageManager (not a raw splice) so orphaned condense/truncation markers go
		// with the messages they describe. An edit drops the target message too — the
		// edited text replaces it.
		await currentShofer.messageManager.rewindToTimestamp(messageTs, {
			includeTargetMessage: operation === "edit",
		})

		if (operation === "delete") {
			await saveTaskMessages({
				messages: currentShofer.shoferMessages,
				taskId: currentShofer.taskId,
				globalStoragePath: provider.contextProxy.globalStorageUri.fsPath,
			})
			const { historyItem } = await provider.getTaskWithId(currentShofer.taskId)
			await provider.createTaskWithHistoryItem(historyItem)
		} else {
			// The reinitialization triggered here picks up the pending edit set above.
			await provider.cancelTask()
		}
	} catch (error) {
		webviewLog.error(`Error in timeline rewind (${operation}):`, error)
		getHost().notifier.error(
			`Error during timeline rewind: ${error instanceof Error ? error.message : String(error)}`,
		)
		throw error
	}
}
