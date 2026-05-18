import React, { useState, useEffect, useMemo, useCallback } from "react"
import * as ProgressPrimitive from "@radix-ui/react-progress"

import { type IndexingStatus } from "@shofer/types"

import { vscode } from "@src/utils/vscode"
import { useExtensionState } from "@src/context/ExtensionStateContext"
import { useAppTranslation } from "@src/i18n/TranslationContext"
import { cn } from "@src/lib/utils"
import { Popover, PopoverContent, StandardTooltip, Button } from "@src/components/ui"
import { useShoferPortal } from "@src/components/ui/hooks/useShoferPortal"
import { useEscapeKey } from "@src/hooks/useEscapeKey"

// LLM hint: All embedder / qdrant / secret / advanced configuration UI lives
// in `webview-ui/src/components/settings/CodeIndexConfigForm.tsx`, rendered
// from the Settings → RAG Indexer panel. The master enable toggles for code
// and git indexing AND the Clear Index Data / Clear Git Index buttons also
// live there (RagIndexerSettings). This popover is now a pure status
// dashboard with diagnostic counters (files / commits indexed, last file,
// latest commit hash) and a gear shortcut to the settings panel.

interface GitIndexingStatus {
	systemStatus: string
	message?: string
	processedItems: number
	totalItems: number
	currentItemUnit?: string
	workspacePath?: string
	indexedCommitCount?: number
	latestCommitHash?: string
}

interface CodeIndexPopoverProps {
	children: React.ReactNode
	indexingStatus: IndexingStatus
	gitIndexingStatus?: GitIndexingStatus
}

/**
 * Strip directory portion of a POSIX-style relative path for compact display.
 */
function basename(path: string): string {
	const slash = path.lastIndexOf("/")
	return slash >= 0 ? path.slice(slash + 1) : path
}

export const CodeIndexPopover: React.FC<CodeIndexPopoverProps> = ({
	children,
	indexingStatus: externalIndexingStatus,
	gitIndexingStatus: externalGitIndexingStatus,
}) => {
	const { t } = useAppTranslation()
	const { cwd } = useExtensionState()
	const [open, setOpen] = useState(false)

	const [indexingStatus, setIndexingStatus] = useState<IndexingStatus>(externalIndexingStatus)
	const [gitIndexingStatus, setGitIndexingStatus] = useState<GitIndexingStatus>(
		externalGitIndexingStatus ?? {
			systemStatus: "Standby",
			processedItems: 0,
			totalItems: 0,
			currentItemUnit: "commits",
		},
	)

	useEffect(() => {
		setIndexingStatus(externalIndexingStatus)
	}, [externalIndexingStatus])

	useEffect(() => {
		if (externalGitIndexingStatus) {
			setGitIndexingStatus(externalGitIndexingStatus)
		}
	}, [externalGitIndexingStatus])

	useEffect(() => {
		if (open) {
			vscode.postMessage({ type: "requestIndexingStatus" })
		}
		const handleMessage = (event: MessageEvent) => {
			if (event.data.type === "workspaceUpdated" && open) {
				vscode.postMessage({ type: "requestIndexingStatus" })
			}
		}
		window.addEventListener("message", handleMessage)
		return () => window.removeEventListener("message", handleMessage)
	}, [open])

	useEffect(() => {
		const handleMessage = (event: MessageEvent<any>) => {
			if (event.data.type === "indexingStatusUpdate") {
				if (!event.data.values.workspacePath || event.data.values.workspacePath === cwd) {
					setIndexingStatus({
						systemStatus: event.data.values.systemStatus,
						message: event.data.values.message || "",
						processedItems: event.data.values.processedItems,
						totalItems: event.data.values.totalItems,
						currentItemUnit: event.data.values.currentItemUnit || "items",
						indexedFileCount: event.data.values.indexedFileCount,
						lastFileIndexed: event.data.values.lastFileIndexed,
					})
				}
			} else if (event.data.type === "gitIndexingStatusUpdate") {
				if (!event.data.values.workspacePath || event.data.values.workspacePath === cwd) {
					setGitIndexingStatus({
						systemStatus: event.data.values.systemStatus,
						message: event.data.values.message || "",
						processedItems: event.data.values.processedItems ?? 0,
						totalItems: event.data.values.totalItems ?? 0,
						currentItemUnit: event.data.values.currentItemUnit || "commits",
						indexedCommitCount: event.data.values.indexedCommitCount,
						latestCommitHash: event.data.values.latestCommitHash,
					})
				}
			}
		}
		window.addEventListener("message", handleMessage)
		return () => window.removeEventListener("message", handleMessage)
	}, [cwd])

	const handlePopoverClose = useCallback(() => setOpen(false), [])
	useEscapeKey(open, handlePopoverClose)

	const progressPercentage = useMemo(
		() =>
			indexingStatus.totalItems > 0
				? Math.round((indexingStatus.processedItems / indexingStatus.totalItems) * 100)
				: 0,
		[indexingStatus.processedItems, indexingStatus.totalItems],
	)

	const transformStyleString = `translateX(-${100 - progressPercentage}%)`

	const portalContainer = useShoferPortal("shofer-portal")

	/**
	 * Open the Settings View on the RAG Indexer section. Uses the standard
	 * `switchTab` IPC message with the `codebaseIndex` section key, matching
	 * the registered `sectionNames` in SettingsView.tsx.
	 */
	const openSettings = useCallback(() => {
		vscode.postMessage({
			type: "switchTab",
			tab: "settings",
			values: { section: "codebaseIndex" },
		} as any)
		handlePopoverClose()
	}, [handlePopoverClose])

	return (
		<>
			<Popover
				open={open}
				onOpenChange={(newOpen) => {
					if (!newOpen) {
						handlePopoverClose()
					} else {
						setOpen(newOpen)
					}
				}}>
				{children}
				<PopoverContent
					className="w-[calc(100vw-32px)] max-w-[450px] max-h-[80vh] overflow-y-auto p-0"
					align="end"
					alignOffset={0}
					side="bottom"
					sideOffset={5}
					collisionPadding={16}
					avoidCollisions={true}
					container={portalContainer}>
					<div className="p-3 border-b border-vscode-dropdown-border cursor-default">
						<div className="flex flex-row items-center gap-1 p-0 m-0 w-full">
							<h4 className="m-0 flex-1">{t("settings:codeIndex.title")}</h4>
							<StandardTooltip content={t("settings:codeIndex.openSettingsTooltip")}>
								<Button
									size="icon"
									variant="ghost"
									onClick={openSettings}
									aria-label={t("settings:codeIndex.openSettingsTooltip")}>
									<span className="codicon codicon-gear" />
								</Button>
							</StandardTooltip>
						</div>
					</div>

					<div className="p-4">
						{/* Code Index Status */}
						<div className="space-y-2">
							<h4 className="text-sm font-medium">{t("settings:codeIndex.statusTitle")}</h4>
							<div className="text-sm text-vscode-descriptionForeground">
								<span
									className={cn("inline-block w-3 h-3 rounded-full mr-2", {
										"bg-gray-400": indexingStatus.systemStatus === "Standby",
										"bg-yellow-500 animate-pulse": indexingStatus.systemStatus === "Indexing",
										"bg-green-500": indexingStatus.systemStatus === "Indexed",
										"bg-red-500": indexingStatus.systemStatus === "Error",
									})}
								/>
								{t(`settings:codeIndex.indexingStatuses.${indexingStatus.systemStatus.toLowerCase()}`)}
								{indexingStatus.message ? ` - ${indexingStatus.message}` : ""}
							</div>

							{indexingStatus.systemStatus === "Indexing" && (
								<div className="mt-2">
									<ProgressPrimitive.Root
										className="relative h-2 w-full overflow-hidden rounded-full bg-secondary"
										value={progressPercentage}>
										<ProgressPrimitive.Indicator
											className="h-full w-full flex-1 bg-primary transition-transform duration-300 ease-in-out"
											style={{ transform: transformStyleString }}
										/>
									</ProgressPrimitive.Root>
								</div>
							)}

							{/* Diagnostic counters: cumulative files in the on-disk cache
							    and most recently (re)indexed file. Persist across the
							    watcher's reconciliation passes so they remain visible in
							    "Indexed" state as a "what's in the cache right now"
							    indicator. */}
							{indexingStatus.indexedFileCount !== undefined && (
								<div className="text-xs text-vscode-descriptionForeground">
									{t("settings:codeIndex.filesIndexedCount", {
										count: indexingStatus.indexedFileCount,
									})}
								</div>
							)}
							{indexingStatus.lastFileIndexed && (
								<div className="text-xs text-vscode-descriptionForeground truncate">
									{t("settings:codeIndex.lastFileIndexedLabel")}{" "}
									<StandardTooltip content={indexingStatus.lastFileIndexed}>
										<span className="font-mono">{basename(indexingStatus.lastFileIndexed)}</span>
									</StandardTooltip>
								</div>
							)}
						</div>

						{/* Git History Status */}
						<div className="mt-4 pt-3 border-t border-vscode-dropdown-border space-y-2">
							<h4 className="text-sm font-medium">{t("settings:codeIndex.gitHistoryTitle")}</h4>

							<div className="text-sm text-vscode-descriptionForeground">
								<span
									className={cn("inline-block w-3 h-3 rounded-full mr-2", {
										"bg-gray-400": gitIndexingStatus.systemStatus === "Standby",
										"bg-yellow-500 animate-pulse": gitIndexingStatus.systemStatus === "Indexing",
										"bg-green-500": gitIndexingStatus.systemStatus === "Indexed",
										"bg-red-500": gitIndexingStatus.systemStatus === "Error",
									})}
								/>
								{gitIndexingStatus.systemStatus === "Indexed"
									? t("settings:codeIndex.gitIndexedStatus")
									: gitIndexingStatus.systemStatus === "Indexing"
										? t("settings:codeIndex.gitIndexingStatus")
										: gitIndexingStatus.systemStatus === "Error"
											? t("settings:codeIndex.gitErrorStatus")
											: t("settings:codeIndex.gitStandbyStatus")}
								{gitIndexingStatus.message ? ` - ${gitIndexingStatus.message}` : ""}
							</div>

							{gitIndexingStatus.indexedCommitCount !== undefined && (
								<div className="text-xs text-vscode-descriptionForeground">
									{t("settings:codeIndex.commitsIndexedCount", {
										count: gitIndexingStatus.indexedCommitCount,
									})}
								</div>
							)}
							{gitIndexingStatus.latestCommitHash && (
								<div className="text-xs text-vscode-descriptionForeground">
									{t("settings:codeIndex.latestCommitLabel")}{" "}
									<span className="font-mono">{gitIndexingStatus.latestCommitHash}</span>
								</div>
							)}
						</div>
					</div>
				</PopoverContent>
			</Popover>
		</>
	)
}
