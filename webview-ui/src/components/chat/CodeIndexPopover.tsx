import React, { useState, useEffect, useMemo, useCallback } from "react"
import { Trans } from "react-i18next"
import { VSCodeLink, VSCodeCheckbox } from "@vscode/webview-ui-toolkit/react"
import * as ProgressPrimitive from "@radix-ui/react-progress"

import { type IndexingStatus } from "@shofer/types"

import { vscode } from "@src/utils/vscode"
import { useExtensionState } from "@src/context/ExtensionStateContext"
import { useAppTranslation } from "@src/i18n/TranslationContext"
import { buildDocLink } from "@src/utils/docLinks"
import { cn } from "@src/lib/utils"
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
	Popover,
	PopoverContent,
	StandardTooltip,
	Button,
} from "@src/components/ui"
import { useShoferPortal } from "@src/components/ui/hooks/useShoferPortal"
import { useEscapeKey } from "@src/hooks/useEscapeKey"

// LLM hint: All embedder / qdrant / secret / advanced configuration UI lives
// in `webview-ui/src/components/settings/CodeIndexConfigForm.tsx`, rendered
// from the Settings → RAG Indexer panel. This popover only owns status
// display and quick controls (enable toggle, start/stop/clear, auto-enable,
// workspace).

interface GitIndexingStatus {
	systemStatus: string
	message?: string
	processedItems: number
	totalItems: number
	currentItemUnit?: string
	workspacePath?: string
}

interface CodeIndexPopoverProps {
	children: React.ReactNode
	indexingStatus: IndexingStatus
	gitIndexingStatus?: GitIndexingStatus
}

export const CodeIndexPopover: React.FC<CodeIndexPopoverProps> = ({
	children,
	indexingStatus: externalIndexingStatus,
	gitIndexingStatus: externalGitIndexingStatus,
}) => {
	const { t } = useAppTranslation()
	const { codebaseIndexConfig, cwd } = useExtensionState()
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

	const codebaseIndexEnabled = codebaseIndexConfig?.codebaseIndexEnabled ?? true

	// Update indexing status from parent
	useEffect(() => {
		setIndexingStatus(externalIndexingStatus)
	}, [externalIndexingStatus])

	// Update git indexing status from parent
	useEffect(() => {
		if (externalGitIndexingStatus) {
			setGitIndexingStatus(externalGitIndexingStatus)
		}
	}, [externalGitIndexingStatus])

	// Request initial indexing status when the popover opens or workspace changes
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

	// Listen for indexing-status updates pushed by the host
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
						<div className="flex flex-row items-center gap-1 p-0 mt-0 mb-1 w-full">
							<h4 className="m-0 pb-2 flex-1">{t("settings:codeIndex.title")}</h4>
						</div>
						<p className="my-0 pr-4 text-sm w-full">
							<Trans i18nKey="settings:codeIndex.description">
								<VSCodeLink
									href={buildDocLink("features/experimental/codebase-indexing", "settings")}
									style={{ display: "inline" }}
								/>
							</Trans>
						</p>
					</div>

					<div className="p-4">
						{/* Enable/Disable Toggle */}
						<div className="mb-4">
							<div className="flex items-center gap-2">
								<VSCodeCheckbox
									checked={codebaseIndexConfig?.codebaseIndexEnabled ?? true}
									onChange={(e: any) =>
										vscode.postMessage({
											type: "updateCodebaseIndexConfig",
											codebaseIndexConfigPartial: { codebaseIndexEnabled: e.target.checked },
										})
									}>
									<span className="font-medium">{t("settings:codeIndex.enableLabel")}</span>
								</VSCodeCheckbox>
								<StandardTooltip content={t("settings:codeIndex.enableDescription")}>
									<span className="codicon codicon-info text-xs text-vscode-descriptionForeground cursor-help" />
								</StandardTooltip>
							</div>
						</div>

						{/* Status Section */}
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
											style={{
												transform: transformStyleString,
											}}
										/>
									</ProgressPrimitive.Root>
								</div>
							)}
						</div>

						{/* Git History Section */}
						<div className="mt-4 pt-3 border-t border-vscode-dropdown-border">
							<h4 className="text-sm font-medium mb-2">{t("settings:codeIndex.gitHistoryTitle")}</h4>

							{/* Enabled Toggle */}
							<div className="mb-3">
								<div className="flex items-center gap-2">
									<VSCodeCheckbox
										checked={codebaseIndexConfig?.codebaseIndexGitEnabled ?? false}
										onChange={(e: any) =>
											vscode.postMessage({
												type: "updateCodebaseIndexConfig",
												codebaseIndexConfigPartial: {
													codebaseIndexGitEnabled: e.target.checked,
												},
											})
										}>
										<span className="font-medium">{t("settings:codeIndex.gitEnableLabel")}</span>
									</VSCodeCheckbox>
								</div>
							</div>

							{/* Git Status */}
							<div className="space-y-2">
								<div className="text-sm text-vscode-descriptionForeground">
									<span
										className={cn("inline-block w-3 h-3 rounded-full mr-2", {
											"bg-gray-400": gitIndexingStatus.systemStatus === "Standby",
											"bg-yellow-500 animate-pulse":
												gitIndexingStatus.systemStatus === "Indexing",
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
							</div>

							{/* Action Buttons: only Clear remains. Start/Stop dropped — indexing
							   begins automatically when the user enables the feature above and
							   restarts on extension activation via GitIndexManager.initialize(). */}
							<div className="flex gap-2 mt-3">
								{(codebaseIndexConfig?.codebaseIndexGitEnabled ?? false) &&
									(gitIndexingStatus.systemStatus === "Indexed" ||
										gitIndexingStatus.systemStatus === "Error") && (
										<AlertDialog>
											<AlertDialogTrigger asChild>
												<Button size="sm" variant="secondary">
													{t("settings:codeIndex.gitClearButton")}
												</Button>
											</AlertDialogTrigger>
											<AlertDialogContent>
												<AlertDialogHeader>
													<AlertDialogTitle>
														{t("settings:codeIndex.gitClearDialog.title")}
													</AlertDialogTitle>
													<AlertDialogDescription>
														{t("settings:codeIndex.gitClearDialog.description")}
													</AlertDialogDescription>
												</AlertDialogHeader>
												<AlertDialogFooter>
													<AlertDialogCancel>
														{t("settings:codeIndex.gitClearDialog.cancelButton")}
													</AlertDialogCancel>
													<AlertDialogAction
														onClick={() =>
															vscode.postMessage({ type: "clearGitIndexData" })
														}>
														{t("settings:codeIndex.gitClearDialog.confirmButton")}
													</AlertDialogAction>
												</AlertDialogFooter>
											</AlertDialogContent>
										</AlertDialog>
									)}
							</div>
						</div>

						{/* Auto-enable default */}
						{codebaseIndexEnabled && (
							<div className="flex items-center gap-2 pt-4 pb-1">
								<input
									type="checkbox"
									id="auto-enable-default-toggle"
									checked={indexingStatus.autoEnableDefault ?? true}
									onChange={(e) =>
										vscode.postMessage({
											type: "setAutoEnableDefault",
											bool: e.target.checked,
										})
									}
									className="accent-vscode-focusBorder"
								/>
								<label
									htmlFor="auto-enable-default-toggle"
									className="text-xs text-vscode-foreground cursor-pointer">
									{t("settings:codeIndex.autoEnableDefaultLabel")}
								</label>
							</div>
						)}

						{/* Workspace Toggle */}
						{codebaseIndexEnabled && (
							<div className="flex items-center gap-2 pt-1 pb-2">
								<input
									type="checkbox"
									id="workspace-indexing-toggle"
									checked={indexingStatus.workspaceEnabled ?? false}
									onChange={(e) =>
										vscode.postMessage({
											type: "toggleWorkspaceIndexing",
											bool: e.target.checked,
										})
									}
									className="accent-vscode-focusBorder"
								/>
								<label
									htmlFor="workspace-indexing-toggle"
									className="text-xs text-vscode-foreground cursor-pointer">
									{t("settings:codeIndex.workspaceToggleLabel")}
								</label>
							</div>
						)}

						{codebaseIndexEnabled && !indexingStatus.workspaceEnabled && (
							<p className="text-xs text-vscode-descriptionForeground pb-2">
								{t("settings:codeIndex.workspaceDisabledMessage")}
							</p>
						)}

						{/* Action Buttons: only Clear remains. Start/Stop dropped —
						   indexing begins automatically when the user enables the feature
						   above and restarts on extension activation. */}
						<div className="flex items-center gap-2 pt-6">
							{codebaseIndexEnabled &&
								(indexingStatus.systemStatus === "Indexed" ||
									indexingStatus.systemStatus === "Error") && (
									<AlertDialog>
										<AlertDialogTrigger asChild>
											<Button variant="secondary">
												{t("settings:codeIndex.clearIndexDataButton")}
											</Button>
										</AlertDialogTrigger>
										<AlertDialogContent>
											<AlertDialogHeader>
												<AlertDialogTitle>
													{t("settings:codeIndex.clearDataDialog.title")}
												</AlertDialogTitle>
												<AlertDialogDescription>
													{t("settings:codeIndex.clearDataDialog.description")}
												</AlertDialogDescription>
											</AlertDialogHeader>
											<AlertDialogFooter>
												<AlertDialogCancel>
													{t("settings:codeIndex.clearDataDialog.cancelButton")}
												</AlertDialogCancel>
												<AlertDialogAction
													onClick={() => vscode.postMessage({ type: "clearIndexData" })}>
													{t("settings:codeIndex.clearDataDialog.confirmButton")}
												</AlertDialogAction>
											</AlertDialogFooter>
										</AlertDialogContent>
									</AlertDialog>
								)}
						</div>
					</div>
				</PopoverContent>
			</Popover>
		</>
	)
}
