import { memo, useCallback, useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { Check, ChevronDown, ChevronRight, FileDiff, RotateCcw, RotateCw, Undo2 } from "lucide-react"

import type { ChangedFileEntry, ChangedFilesPayload, ExtensionMessage } from "@roo-code/types"

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui"
import { cn } from "@/lib/utils"
import { vscode } from "@src/utils/vscode"

interface FileChangesPanelProps {
	taskId?: string
	className?: string
}

/**
 * FileChangesPanel — shows the files Roo edited in the current Task, with
 * net-state-aware accounting and per-file diff/revert/redo/accept actions.
 *
 * Source of truth is the extension-host `ChangedFilesService` (single
 * unified backend), pushed via `changedFiles/update` and pulled on mount via
 * `changedFiles/get`. Per-task accept (review) state is local UI only.
 */
const MAX_VISIBLE_ROWS = 5
const ROW_HEIGHT_PX = 28 // matches py-1 + text-sm height; used for max-height

const FileChangesPanel = memo(({ taskId, className }: FileChangesPanelProps) => {
	const { t } = useTranslation()
	const [panelExpanded, setPanelExpanded] = useState(false)
	const [payload, setPayload] = useState<ChangedFilesPayload | undefined>(undefined)
	// Per-task accepted (reviewed) paths. Session-only — not persisted.
	const [acceptedPaths, setAcceptedPaths] = useState<Set<string>>(new Set())
	// Per-task reverted paths so we know to render Redo button. Session-only.
	const [revertedPaths, setRevertedPaths] = useState<Set<string>>(new Set())

	// On task switch, drop UI-only accept/revert state and re-pull payload.
	useEffect(() => {
		setAcceptedPaths(new Set())
		setRevertedPaths(new Set())
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
		setRevertedPaths((prev) => new Set(prev).add(entry.path))
	}, [])

	const handleRedo = useCallback((entry: ChangedFileEntry) => {
		vscode.postMessage({ type: "changedFiles/redo", text: entry.path })
		setRevertedPaths((prev) => {
			const next = new Set(prev)
			next.delete(entry.path)
			return next
		})
	}, [])

	const handleAccept = useCallback((entry: ChangedFileEntry) => {
		setAcceptedPaths((prev) => {
			const next = new Set(prev)
			if (next.has(entry.path)) next.delete(entry.path)
			else next.add(entry.path)
			return next
		})
	}, [])

	const handleAcceptAll = useCallback(() => {
		setAcceptedPaths(new Set(entries.map((e) => e.path)))
	}, [entries])

	const handleRevertAll = useCallback(() => {
		vscode.postMessage({ type: "changedFiles/revertAll" })
	}, [])

	if (!hasEntries) return null

	const fileCount = entries.length
	const isLimited = payload?.backend === "tracker" || payload?.degraded === true

	const activeEntries = entries.filter((e) => !acceptedPaths.has(e.path))
	const reviewedEntries = entries.filter((e) => acceptedPaths.has(e.path))

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
				{isLimited ? (
					<span
						className="text-[10px] px-1.5 py-0.5 rounded bg-vscode-badge-background text-vscode-badge-foreground shrink-0"
						title={t("chat:fileChanges.limitedModeTooltip") ?? ""}>
						{t("chat:fileChanges.limitedMode")}
					</span>
				) : null}
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
					{activeEntries.map((entry) => (
						<FileRow
							key={entry.path}
							entry={entry}
							reverted={revertedPaths.has(entry.path)}
							onShowDiff={handleShowDiff}
							onRevert={handleRevert}
							onRedo={handleRedo}
							onAccept={handleAccept}
						/>
					))}
				</div>
				{reviewedEntries.length > 0 ? (
					<div className="pl-6 pb-2 text-xs text-vscode-descriptionForeground">
						{t("chat:fileChanges.reviewedSection", { count: reviewedEntries.length })}
					</div>
				) : null}
			</CollapsibleContent>
		</Collapsible>
	)
})

interface FileRowProps {
	entry: ChangedFileEntry
	reverted: boolean
	onShowDiff: (entry: ChangedFileEntry) => void
	onRevert: (entry: ChangedFileEntry) => void
	onRedo: (entry: ChangedFileEntry) => void
	onAccept: (entry: ChangedFileEntry) => void
}

const FileRow = memo(({ entry, reverted, onShowDiff, onRevert, onRedo, onAccept }: FileRowProps) => {
	const { t } = useTranslation()
	const canDiff = entry.hasOriginalContent
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
				{reverted ? (
					<button
						type="button"
						className="px-1 py-0.5 rounded hover:bg-vscode-toolbar-hoverBackground"
						title={t("chat:fileChanges.redo") ?? ""}
						onClick={() => onRedo(entry)}>
						<RotateCw className="size-3.5" aria-label={t("chat:fileChanges.redo") ?? ""} />
					</button>
				) : (
					<button
						type="button"
						className="px-1 py-0.5 rounded hover:bg-vscode-toolbar-hoverBackground"
						title={t("chat:fileChanges.revert") ?? ""}
						onClick={() => onRevert(entry)}>
						<RotateCcw className="size-3.5" aria-label={t("chat:fileChanges.revert") ?? ""} />
					</button>
				)}
				<button
					type="button"
					className="px-1 py-0.5 rounded hover:bg-vscode-toolbar-hoverBackground"
					title={t("chat:fileChanges.accept") ?? ""}
					onClick={() => onAccept(entry)}>
					<Check className="size-3.5" aria-label={t("chat:fileChanges.accept") ?? ""} />
				</button>
			</div>
		</div>
	)
})
FileRow.displayName = "FileRow"

FileChangesPanel.displayName = "FileChangesPanel"

export default FileChangesPanel
