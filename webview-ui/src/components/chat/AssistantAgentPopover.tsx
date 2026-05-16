/**
 * AssistantAgentPopover — info + action panel that opens when the user clicks
 * the Assistant Agent badge on the Shofer chat-input toolbar. Replaces the
 * former VS Code status bar quick-pick menu.
 *
 * Displays:
 *  - State, model, provider
 *  - Context fill (tokens / max), files in context, conversation turns
 *  - Session cost and pending question count
 *
 * Actions:
 *  - View Chat       → shofer.assistantAgent.showChat
 *  - Clear Context   → shofer.assistantAgent.clearContext
 *  - Configure API   → workbench.action.openSettings
 *  - Start / Restart → shofer.assistantAgent.start
 *
 * Action dispatch goes through the `assistantAgentAction` webview message which
 * is routed by webviewMessageHandler.ts to the corresponding extension
 * commands.
 */
import React from "react"
import {
	MessageCircle,
	Trash2,
	Settings,
	Play,
	Square,
	Info,
	Cpu,
	Database,
	Files,
	MessagesSquare,
	CreditCard,
} from "lucide-react"

import { vscode } from "@src/utils/vscode"
import { Popover, PopoverContent, Button } from "@src/components/ui"

export interface AssistantAgentStatusData {
	state: string
	stateMessage?: string
	isAvailable?: boolean
	modelId?: string
	provider?: string
	contextUsage?: { currentTokens: number; maxTokens: number; fillFraction: number; isNearlyFull?: boolean }
	costSnapshot?: {
		sessionEstimatedCostUSD?: number
		sessionInputTokens?: number
		sessionOutputTokens?: number
	}
	conversationTurnCount?: number
	pendingQuestionCount?: number
	contextFiles?: string[]
}

interface AssistantAgentPopoverProps {
	children: React.ReactNode
	status: AssistantAgentStatusData
}

const sendAction = (action: "chat" | "clear" | "start" | "stop") => {
	vscode.postMessage({ type: "assistantAgentAction", text: action })
}

/**
 * Open the in-app SettingsView at the Assistant Agent section.
 * Uses the standard `settingsButtonClicked` action route consumed by App.tsx
 * (see ChatView's AutoApproveDropdown / TooManyToolsWarning for precedent),
 * NOT VS Code's native settings UI — assistantAgent settings live in
 * ContextProxy, not in package.json `configuration` contributions.
 */
const openAssistantAgentSettings = () => {
	window.postMessage({ type: "action", action: "settingsButtonClicked", values: { section: "assistantAgent" } }, "*")
}

export const AssistantAgentPopover: React.FC<AssistantAgentPopoverProps> = ({ children, status }) => {
	const usage = status.contextUsage
	const fillPct = usage ? (usage.fillFraction * 100).toFixed(1) : "0.0"
	const cost = status.costSnapshot
	// Controlled so action handlers can dismiss the popover after dispatching.
	const [open, setOpen] = React.useState(false)
	const runAction = (fn: () => void) => () => {
		fn()
		setOpen(false)
	}
	// Any state in which the manager is alive (initializing, processing, or
	// ready to take questions) is considered "running" so the toggle reads
	// "Stop Agent". Standby/Error → "Start Agent".
	const running = status.state === "Ready" || status.state === "Busy" || status.state === "Initializing"

	return (
		<Popover open={open} onOpenChange={setOpen}>
			{children}
			<PopoverContent
				align="end"
				side="top"
				className="w-80 p-0 bg-vscode-editor-background border border-vscode-panel-border">
				<div className="px-3 py-2 border-b border-vscode-panel-border">
					<div className="flex items-center gap-2 text-sm font-medium">
						<MessageCircle className="w-4 h-4" />
						<span>Assistant Agent</span>
					</div>
				</div>

				<div className="px-3 py-2 space-y-1.5 text-xs text-vscode-foreground">
					<InfoRow
						icon={<Info className="w-3.5 h-3.5" />}
						label="State"
						value={status.state}
						sub={status.stateMessage}
					/>
					{status.modelId ? (
						<InfoRow
							icon={<Cpu className="w-3.5 h-3.5" />}
							label="Model"
							value={status.modelId}
							sub={status.provider ? `Provider: ${status.provider}` : undefined}
						/>
					) : null}
					{usage ? (
						<InfoRow
							icon={<Database className="w-3.5 h-3.5" />}
							label="Context"
							value={`${usage.currentTokens.toLocaleString()} / ${usage.maxTokens.toLocaleString()} (${fillPct}%)`}
							sub={usage.isNearlyFull ? "⚠ Nearly full" : undefined}
						/>
					) : null}
					<InfoRow
						icon={<Files className="w-3.5 h-3.5" />}
						label="Files in context"
						value={String(status.contextFiles?.length ?? 0)}
					/>
					<InfoRow
						icon={<MessagesSquare className="w-3.5 h-3.5" />}
						label="Conversation turns"
						value={String(status.conversationTurnCount ?? 0)}
						sub={
							status.pendingQuestionCount
								? `${status.pendingQuestionCount} question(s) queued`
								: undefined
						}
					/>
					{cost ? (
						<InfoRow
							icon={<CreditCard className="w-3.5 h-3.5" />}
							label="Session cost"
							value={`$${(cost.sessionEstimatedCostUSD ?? 0).toFixed(6)}`}
							sub={
								cost.sessionInputTokens !== undefined && cost.sessionOutputTokens !== undefined
									? `${cost.sessionInputTokens.toLocaleString()} in + ${cost.sessionOutputTokens.toLocaleString()} out`
									: undefined
							}
						/>
					) : null}
				</div>

				<div className="px-2 py-2 border-t border-vscode-panel-border grid grid-cols-2 gap-1.5">
					<ActionButton
						icon={<MessageCircle className="w-3.5 h-3.5" />}
						label="View Chat"
						onClick={runAction(() => sendAction("chat"))}
					/>
					<ActionButton
						icon={<Trash2 className="w-3.5 h-3.5" />}
						label="Clear Context"
						onClick={runAction(() => sendAction("clear"))}
					/>
					<ActionButton
						icon={<Settings className="w-3.5 h-3.5" />}
						label="Configure"
						onClick={runAction(openAssistantAgentSettings)}
					/>
					<ActionButton
						icon={running ? <Square className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
						label={running ? "Stop Agent" : "Start Agent"}
						onClick={runAction(() => sendAction(running ? "stop" : "start"))}
					/>
				</div>
			</PopoverContent>
		</Popover>
	)
}

const InfoRow: React.FC<{
	icon: React.ReactNode
	label: string
	value: string
	sub?: string
}> = ({ icon, label, value, sub }) => (
	<div className="flex items-start gap-2">
		<span className="mt-0.5 opacity-70">{icon}</span>
		<div className="flex-1 min-w-0">
			<div className="flex justify-between gap-2">
				<span className="opacity-70">{label}</span>
				<span className="font-mono truncate">{value}</span>
			</div>
			{sub ? <div className="text-[10px] opacity-60">{sub}</div> : null}
		</div>
	</div>
)

const ActionButton: React.FC<{
	icon: React.ReactNode
	label: string
	onClick: () => void
}> = ({ icon, label, onClick }) => (
	<Button variant="ghost" size="sm" onClick={onClick} className="justify-start gap-1.5 h-7 text-xs">
		{icon}
		<span>{label}</span>
	</Button>
)
