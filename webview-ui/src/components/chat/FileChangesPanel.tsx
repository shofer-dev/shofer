import { memo, useCallback, useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { Check, ChevronDown, ChevronRight, FileDiff, RotateCcw, Undo2 } from "lucide-react"

import type { ChangedFileEntry, ChangedFilesPayload, ExtensionMessage } from "@shofer/types"

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui"
import { cn } from "@/lib/utils"
import { vscode } from "@src/utils/vscode"

interface FileChangesPanelProps {
	taskId?: string
	className?: string
}

/**
 * FileChangesPanel — shows the files Shofer edited in the current Task, with
 * net-state-aware accounting and per-file diff/revert/redo/accept actions.
 *
 * Source of truth is the extension-host `ChangedFilesService` (single
 * unified backend), pushed via `changedFiles/update` and pulled on mount via
 * `changedFiles/get`. Accept promotes the final state to the new baseline;
 * accepted files disappear from the panel on the next update.
 */
const MAX_VISIBLE_ROWS = 5
const ROW_HEIGHT_PX = 28 // matches py-1 + text-sm height; used for max-height

const FileChangesPanel = memo(({ taskId, className }: FileChangesPanelProps) => {
	const { t } = useTranslation()
	const [panelExpanded, setPanelExpanded] = useState(false)
	const [payload, setPayload] = useState<ChangedFilesPayload | undefined>(undefined)

	// On task switch, re-pull payload.
	useEffect(() => {
		setPayload(undefined)
		vscode.postMessage({ type: "changedFiles/get" })
	}, [taskId])

	useEffect(() => {
		const handler = (event: MessageEvent) => {
			const message: ExtensionMessage = event.data
			if (message.type !== "changedFiles/update" || !message.changedFiles) return
			// Ignore updates from a different task (defensive — host already filters).
			if (taskId && message.changedFiles.taskId !== taskId) return
			setPayload(message.changedFiles)
		}
		window.addEventListener("message", handler)
		return () => window.removeEventListener("message", handler)
	}, [taskId])

	const entries = useMemo(() => payload?.entries ?? [], [payload])
	const hasEntries = entries.length > 0

	const totalStats = useMemo(
		() =>
			entries.reduce((acc, e) => ({ added: acc.added + e.insertions, removed: acc.removed + e.deletions }), {
				added: 0,
				removed: 0,
			}),
		[entries],
	)

	const handleShowDiff = useCallback((entry: ChangedFileEntry) => {
		if (!entry.hasOriginalContent) return
		vscode.postMessage({ type: "changedFiles/showDiff", text: entry.path })
	}, [])

	const handleRevert = useCallback((entry: ChangedFileEntry) => {
		vscode.postMessage({ type: "changedFiles/revert", text: entry.path })
	}, [])

	const handleAccept = useCallback((entry: ChangedFileEntry) => {
		vscode.postMessage({ type: "changedFiles/accept", text: entry.path })
	}, [])

	const handleAcceptAll = useCallback(() => {
		vscode.postMessage({ type: "changedFiles/acceptAll" })
	}, [])

	const handleRevertAll = useCallback(() => {
		vscode.postMessage({ type: "changedFiles/revertAll" })
	}, [])

	if (!hasEntries) return null

	const fileCount = entries.length

	return (
		<Collapsible open={panelExpanded} onOpenChange={setPanelExpanded} className={cn("px-3", className)}>
			<CollapsibleTrigger
				className={cn(
					"flex items-center gap-2 w-full py-2 rounded-md text-left text-vscode-foreground",
					"hover:bg-vscode-list-hoverBackground",
				)}>
				{panelExpanded ? (
					<ChevronDown className="size-4 shrink-0" aria-hidden />
				) : (
					<ChevronRight className="size-4 shrink-0" aria-hidden />
				)}
				<FileDiff className="size-4 shrink-0" aria-hidden />
				<span className="text-sm font-medium">
					{t("chat:fileChangesInConversation.header", { count: fileCount })}
				</span>
				{totalStats.added > 0 || totalStats.removed > 0 ? (
					<div
						className="flex items-center gap-2 ml-auto shrink-0"
						aria-label={`${totalStats.added} lines added, ${totalStats.removed} lines removed`}>
						<span className="text-xs font-medium text-vscode-charts-green" data-testid="total-added">
							+{totalStats.added}
						</span>
						<span className="text-xs font-medium text-vscode-charts-red" data-testid="total-removed">
							-{totalStats.removed}
						</span>
					</div>
				) : (
					<div className="ml-auto" />
				)}
				{/* Bulk action buttons. Stop propagation so they don't toggle the panel. */}
				<div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
					<button
						type="button"
						className="text-xs px-1.5 py-0.5 rounded hover:bg-vscode-toolbar-hoverBackground"
						title={t("chat:fileChanges.acceptAll") ?? ""}
						onClick={handleAcceptAll}>
						<Check className="size-3.5" aria-label={t("chat:fileChanges.acceptAll") ?? ""} />
					</button>
					<button
						type="button"
						className="text-xs px-1.5 py-0.5 rounded hover:bg-vscode-toolbar-hoverBackground"
						title={t("chat:fileChanges.revertAll") ?? ""}
						onClick={handleRevertAll}>
						<Undo2 className="size-3.5" aria-label={t("chat:fileChanges.revertAll") ?? ""} />
					</button>
				</div>
			</CollapsibleTrigger>
			<CollapsibleContent>
				<div
					className="flex flex-col pb-2 pl-6 overflow-y-auto"
					style={{ maxHeight: `${MAX_VISIBLE_ROWS * ROW_HEIGHT_PX}px` }}>
					{entries.map((entry) => (
						<FileRow
							key={entry.path}
							entry={entry}
							onShowDiff={handleShowDiff}
							onRevert={handleRevert}
							onAccept={handleAccept}
						/>
					))}
				</div>
			</CollapsibleContent>
		</Collapsible>
	)
})

interface FileRowProps {
	entry: ChangedFileEntry
	onShowDiff: (entry: ChangedFileEntry) => void
	onRevert: (entry: ChangedFileEntry) => void
	onAccept: (entry: ChangedFileEntry) => void
}

const FileRow = memo(({ entry, onShowDiff, onRevert, onAccept }: FileRowProps) => {
	const { t } = useTranslation()
	const canDiff = entry.hasOriginalContent
	const canAccept = entry.hasFinalContent
	const reverted = entry.state === "reverted"
	return (
		<div
			className={cn(
				"flex items-center gap-2 py-1 text-sm rounded hover:bg-vscode-list-hoverBackground",
				reverted && "opacity-60",
			)}>
			<button
				type="button"
				className={cn(
					"flex-1 text-left truncate",
					canDiff ? "cursor-pointer hover:underline" : "cursor-default text-vscode-descriptionForeground",
				)}
				title={canDiff ? entry.path : (t("chat:fileChanges.diffUnavailable") ?? entry.path)}
				onClick={() => onShowDiff(entry)}>
				<span className={reverted ? "line-through" : undefined}>{entry.path}</span>
			</button>
			{!entry.binary ? (
				<span className="text-xs shrink-0 flex items-center gap-1">
					<span className="text-vscode-charts-green">+{entry.insertions}</span>
					<span className="text-vscode-charts-red">-{entry.deletions}</span>
				</span>
			) : (
				<span className="text-xs text-vscode-descriptionForeground shrink-0">(binary)</span>
			)}
			<div className="flex items-center gap-0.5 shrink-0">
				<button
					type="button"
					className="px-1 py-0.5 rounded hover:bg-vscode-toolbar-hoverBackground"
					title={t("chat:fileChanges.revert") ?? ""}
					onClick={() => onRevert(entry)}>
					<RotateCcw className="size-3.5" aria-label={t("chat:fileChanges.revert") ?? ""} />
				</button>
				<button
					type="button"
					className={cn(
						"px-1 py-0.5 rounded",
						canAccept
							? "hover:bg-vscode-toolbar-hoverBackground cursor-pointer"
							: "opacity-40 cursor-not-allowed",
					)}
					title={
						canAccept
							? (t("chat:fileChanges.accept") ?? "")
							: (t("chat:fileChanges.acceptUnavailable") ?? "No final snapshot available — accept requires Shofer to have written this file in the current task")
					}
					disabled={!canAccept}
					onClick={() => canAccept && onAccept(entry)}>
					<Check className="size-3.5" aria-label={t("chat:fileChanges.accept") ?? ""} />
				</button>
			</div>
		</div>
	)
})
FileRow.displayName = "FileRow"

FileChangesPanel.displayName = "FileChangesPanel"

export default FileChangesPanel
