import React, { useState, useEffect, useMemo } from "react"
import { Database } from "lucide-react"

import type { IndexingStatus, IndexingStatusUpdateMessage } from "@shofer/types"

import { cn } from "@src/lib/utils"
import { vscode } from "@src/utils/vscode"
import { useAppTranslation } from "@/i18n/TranslationContext"

import { useExtensionState } from "@src/context/ExtensionStateContext"
import { PopoverTrigger, StandardTooltip, Button } from "@src/components/ui"

import { CodeIndexPopover } from "./CodeIndexPopover"

interface IndexingStatusBadgeProps {
	className?: string
}

interface GitIndexingStatus {
	systemStatus: string
	message?: string
	processedItems: number
	totalItems: number
	currentItemUnit?: string
	workspacePath?: string
	// Diagnostic counters surfaced in the popover (kept optional so older
	// host payloads without the fields still type-check at the boundary).
	indexedCommitCount?: number
	latestCommitHash?: string
}

/**
 * Displays the combined RAG indexing status (code index + git index) as a
 * small database icon with a colored dot in the chat toolbar.
 *
 * Clicking the badge opens {@link CodeIndexPopover} which now includes both
 * the code index and git index sections.
 */
export const IndexingStatusBadge: React.FC<IndexingStatusBadgeProps> = ({ className }) => {
	const { t } = useAppTranslation()
	const { cwd, codebaseIndexConfig } = useExtensionState()

	const [indexingStatus, setIndexingStatus] = useState<IndexingStatus>({
		systemStatus: "Standby",
		processedItems: 0,
		totalItems: 0,
		currentItemUnit: "items",
	})

	const [gitIndexingStatus, setGitIndexingStatus] = useState<GitIndexingStatus>({
		systemStatus: "Standby",
		processedItems: 0,
		totalItems: 0,
		currentItemUnit: "commits",
	})

	useEffect(() => {
		// Request initial indexing status for both indexes.
		vscode.postMessage({ type: "requestIndexingStatus" })
		vscode.postMessage({ type: "requestGitIndexingStatus" })

		// Set up message listener for status updates.
		const handleMessage = (
			event: MessageEvent<IndexingStatusUpdateMessage | { type: string; values: GitIndexingStatus }>,
		) => {
			if (event.data.type === "indexingStatusUpdate") {
				const status = event.data.values
				if (!status.workspacePath || status.workspacePath === cwd) {
					setIndexingStatus(status)
				}
			} else if (event.data.type === "gitIndexingStatusUpdate") {
				const gitStatus = event.data.values
				if (!gitStatus.workspacePath || gitStatus.workspacePath === cwd) {
					setGitIndexingStatus(gitStatus)
				}
			}
		}

		window.addEventListener("message", handleMessage)

		return () => {
			window.removeEventListener("message", handleMessage)
		}
	}, [cwd])

	const progressPercentage = useMemo(
		() =>
			indexingStatus.totalItems > 0
				? Math.round((indexingStatus.processedItems / indexingStatus.totalItems) * 100)
				: 0,
		[indexingStatus.processedItems, indexingStatus.totalItems],
	)

	/** Derive a combined status for the dot color and tooltip. */
	const combinedStatus = useMemo(() => {
		// When the feature is disabled, always show the idle/standby colour.
		if (!codebaseIndexConfig?.codebaseIndexEnabled) {
			return { state: "Idle" as const, colorClass: "bg-vscode-descriptionForeground/60" }
		}

		const codeState = indexingStatus.systemStatus
		const gitState = gitIndexingStatus.systemStatus

		// Priority: Error > Indexing/Stopping > Standby/Indexed
		if (codeState === "Error" || gitState === "Error") {
			return { state: "Error" as const, colorClass: "bg-red-500" }
		}
		if (codeState === "Indexing" || gitState === "Indexing") {
			return { state: "Indexing" as const, colorClass: "bg-yellow-500 animate-pulse" }
		}
		if (codeState === "Stopping" || gitState === "Stopping") {
			return { state: "Stopping" as const, colorClass: "bg-amber-500 animate-pulse" }
		}
		return { state: "Idle" as const, colorClass: "bg-green-500" }
	}, [indexingStatus.systemStatus, gitIndexingStatus.systemStatus, codebaseIndexConfig?.codebaseIndexEnabled])

	const tooltipText = useMemo(() => {
		const parts: string[] = []

		// Code index status
		switch (indexingStatus.systemStatus) {
			case "Standby":
				parts.push(t("chat:indexingStatus.codeReady"))
				break
			case "Indexing":
				parts.push(t("chat:indexingStatus.codeIndexing", { percentage: progressPercentage }))
				break
			case "Indexed":
				parts.push(t("chat:indexingStatus.codeIndexed"))
				break
			case "Stopping":
				parts.push(t("chat:indexingStatus.codeStopping"))
				break
			case "Error":
				parts.push(t("chat:indexingStatus.codeError"))
				break
			default:
				parts.push(t("chat:indexingStatus.codeStatus"))
		}

		// Git index status
		switch (gitIndexingStatus.systemStatus) {
			case "Standby":
				parts.push(t("chat:indexingStatus.gitReady"))
				break
			case "Indexing":
				parts.push(t("chat:indexingStatus.gitIndexing"))
				break
			case "Indexed":
				parts.push(t("chat:indexingStatus.gitIndexed"))
				break
			case "Stopping":
				parts.push(t("chat:indexingStatus.gitStopping"))
				break
			case "Error":
				parts.push(t("chat:indexingStatus.gitError"))
				break
			default:
				parts.push(t("chat:indexingStatus.gitStatus"))
		}

		return parts.join("\n")
	}, [indexingStatus.systemStatus, gitIndexingStatus.systemStatus, progressPercentage, t])

	return (
		<CodeIndexPopover indexingStatus={indexingStatus} gitIndexingStatus={gitIndexingStatus}>
			<StandardTooltip content={tooltipText}>
				<PopoverTrigger asChild>
					<Button
						variant="ghost"
						size="sm"
						aria-label={tooltipText}
						className={cn(
							"relative h-5 w-5 p-0",
							"text-vscode-foreground opacity-85",
							"hover:opacity-100 hover:bg-[rgba(255,255,255,0.03)]",
							"focus:outline-none focus-visible:ring-1 focus-visible:ring-vscode-focusBorder",
							className,
						)}>
						<Database className="w-4 h-4" />
						<span
							className={cn(
								"absolute top-0 right-0 w-1.5 h-1.5 rounded-full transition-colors duration-200",
								combinedStatus.colorClass,
							)}
						/>
					</Button>
				</PopoverTrigger>
			</StandardTooltip>
		</CodeIndexPopover>
	)
}
