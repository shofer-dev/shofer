/**
 * LiveMemoryStatusBadge — Shofer chat-input toolbar badge that displays
 * the Live Memory's status as a chat-bubble icon with a colored dot. Now
 * acts as the trigger for LiveMemoryPopover, which exposes the actions
 * previously available from the VS Code status bar quick-pick.
 */
import React, { useState, useEffect, useMemo } from "react"
import { MessageCircle } from "lucide-react"

import { cn } from "@src/lib/utils"

import { useExtensionState } from "@src/context/ExtensionStateContext"
import { vscode } from "@src/utils/vscode"
import { PopoverTrigger, StandardTooltip, Button } from "@src/components/ui"

import { LiveMemoryPopover, type LiveMemoryStatusData } from "./LiveMemoryPopover"

export const LiveMemoryStatusBadge: React.FC<{ className?: string }> = ({ className }) => {
	const { cwd } = useExtensionState()

	const [status, setStatus] = useState<LiveMemoryStatusData>({
		state: "Standby",
	})

	useEffect(() => {
		// Request initial snapshot — periodic updates only fire on state changes.
		vscode.postMessage({ type: "requestLiveMemoryStatus" })

		const handleMessage = (event: MessageEvent<{ type: string; text?: string }>) => {
			if (event.data.type === "liveMemoryStatusUpdate" && event.data.text) {
				try {
					const parsed = JSON.parse(event.data.text) as LiveMemoryStatusData
					setStatus(parsed)
				} catch {
					// Ignore parse errors
				}
			}
		}

		window.addEventListener("message", handleMessage)
		return () => window.removeEventListener("message", handleMessage)
	}, [cwd])

	const fillPct = useMemo(() => {
		if (!status.contextUsage) return undefined
		return Math.round(status.contextUsage.fillFraction * 100)
	}, [status.contextUsage])

	const tooltipText = useMemo(() => {
		const lines: string[] = [`Live Memory: ${status.state}`]
		if (status.stateMessage) lines.push(status.stateMessage)
		if (fillPct !== undefined) lines.push(`Context: ${fillPct}% full`)
		if (status.costSnapshot?.sessionEstimatedCostUSD !== undefined) {
			lines.push(`Cost: $${status.costSnapshot.sessionEstimatedCostUSD.toFixed(4)}`)
		}
		if (status.pendingQuestionCount) lines.push(`Queue: ${status.pendingQuestionCount} pending`)
		return lines.join("\n")
	}, [status, fillPct])

	const statusColorClass = useMemo(() => {
		const stateColors: Record<string, string> = {
			Standby: "bg-vscode-descriptionForeground/60",
			Initializing: "bg-yellow-500 animate-pulse",
			Ready: "bg-green-500",
			Busy: "bg-yellow-500 animate-pulse",
			Error: "bg-red-500",
			Stopping: "bg-amber-500 animate-pulse",
		}
		return stateColors[status.state] || stateColors.Standby
	}, [status.state])

	return (
		<LiveMemoryPopover status={status}>
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
						<MessageCircle className="w-4 h-4" />
						<span
							className={cn(
								"absolute top-0 right-0 w-1.5 h-1.5 rounded-full transition-colors duration-200",
								statusColorClass,
							)}
						/>
					</Button>
				</PopoverTrigger>
			</StandardTooltip>
		</LiveMemoryPopover>
	)
}
