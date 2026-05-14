import React, { useState, useEffect, useMemo } from "react"
import { MessageCircle } from "lucide-react"

import { cn } from "@src/lib/utils"

import { useExtensionState } from "@src/context/ExtensionStateContext"
import { StandardTooltip, Button } from "@src/components/ui"

interface HelperAgentStatus {
	state: string
	stateMessage?: string
	isAvailable?: boolean
	contextUsage?: { currentTokens: number; maxTokens: number; fillFraction: number; isNearlyFull?: boolean }
	costSnapshot?: { sessionEstimatedCostUSD?: number }
	conversationTurnCount?: number
	pendingQuestionCount?: number
	contextFiles?: string[]
}

export const HelperAgentStatusBadge: React.FC<{ className?: string }> = ({ className }) => {
	const { cwd } = useExtensionState()

	const [status, setStatus] = useState<HelperAgentStatus>({
		state: "Standby",
	})

	useEffect(() => {
		const handleMessage = (event: MessageEvent<{ type: string; text?: string }>) => {
			if (event.data.type === "helperAgentStatusUpdate" && event.data.text) {
				try {
					const parsed = JSON.parse(event.data.text) as HelperAgentStatus
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
		const lines: string[] = [`Helper Agent: ${status.state}`]
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
		<StandardTooltip content={tooltipText}>
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
		</StandardTooltip>
	)
}
