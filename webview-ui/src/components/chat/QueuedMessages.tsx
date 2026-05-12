import { useState } from "react"
import { useTranslation } from "react-i18next"
import { ChevronDown, ChevronRight, MessageSquareMore } from "lucide-react"

import { QueuedMessage } from "@shofer/shared/types"

import { Button, Collapsible, CollapsibleContent, CollapsibleTrigger } from "@src/components/ui"

import Thumbnails from "../common/Thumbnails"

import { Mention } from "./Mention"

interface QueuedMessagesProps {
	queue: QueuedMessage[]
	onRemove: (index: number) => void
	onUpdate: (index: number, newText: string) => void
	onForceSend?: () => void
}

export const QueuedMessages = ({ queue, onRemove, onUpdate, onForceSend }: QueuedMessagesProps) => {
	const { t } = useTranslation("chat")
	const [panelExpanded, setPanelExpanded] = useState(false)
	const [editingStates, setEditingStates] = useState<Record<string, { isEditing: boolean; value: string }>>({})

	if (queue.length === 0) {
		return null
	}

	const getEditState = (messageId: string, currentText: string) => {
		return editingStates[messageId] || { isEditing: false, value: currentText }
	}

	const setEditState = (messageId: string, isEditing: boolean, value?: string) => {
		setEditingStates((prev) => ({
			...prev,
			[messageId]: { isEditing, value: value ?? prev[messageId]?.value ?? "" },
		}))
	}

	const handleSaveEdit = (index: number, messageId: string, newValue: string) => {
		onUpdate(index, newValue)
		setEditState(messageId, false)
	}

	const messageCount = queue.length

	return (
		<Collapsible open={panelExpanded} onOpenChange={setPanelExpanded} className="px-3">
			<CollapsibleTrigger className="flex items-center gap-2 w-full py-2 rounded-md text-left text-vscode-foreground hover:bg-vscode-list-hoverBackground">
				{panelExpanded ? (
					<ChevronDown className="size-4 shrink-0" aria-hidden />
				) : (
					<ChevronRight className="size-4 shrink-0" aria-hidden />
				)}
				<MessageSquareMore className="size-4 shrink-0" aria-hidden />
				<span className="text-sm font-medium">{t("queuedMessages.header", { count: messageCount })}</span>
				{onForceSend && (
					<div className="flex items-center gap-1 ml-auto shrink-0" onClick={(e) => e.stopPropagation()}>
						<Button
							variant="ghost"
							size="sm"
							onClick={() => onForceSend()}
							title={t("queuedMessages.forceSend")}>
							<span className="codicon codicon-send" />
							<span className="ml-1">{t("queuedMessages.sendNow")}</span>
						</Button>
					</div>
				)}
			</CollapsibleTrigger>
			<CollapsibleContent>
				<div
					className="flex flex-col gap-2 max-h-[300px] overflow-y-auto pb-2 pl-6"
					data-testid="queued-messages">
					{queue.map((message, index) => {
						const editState = getEditState(message.id, message.text)

						return (
							<div
								key={message.id}
								className="bg-vscode-editor-background border rounded-xs p-1 overflow-hidden whitespace-pre-wrap flex-shrink-0">
								<div className="flex justify-between">
									<div className="flex-grow px-2 py-1 wrap-anywhere">
										{editState.isEditing ? (
											<textarea
												ref={(textarea) => {
													if (textarea) {
														// Set cursor at the end
														textarea.setSelectionRange(
															textarea.value.length,
															textarea.value.length,
														)
													}
												}}
												value={editState.value}
												onChange={(e) => setEditState(message.id, true, e.target.value)}
												onBlur={() => handleSaveEdit(index, message.id, editState.value)}
												onKeyDown={(e) => {
													if (e.key === "Enter" && !e.shiftKey) {
														e.preventDefault()
														handleSaveEdit(index, message.id, editState.value)
													}
													if (e.key === "Escape") {
														setEditState(message.id, false, message.text)
													}
												}}
												className="w-full bg-vscode-input-background text-vscode-input-foreground border border-vscode-input-border rounded px-2 py-1 resize-none focus:outline-0 focus:ring-1 focus:ring-vscode-focusBorder"
												placeholder={t("chat:editMessage.placeholder")}
												autoFocus
												rows={Math.min(editState.value.split("\n").length, 10)}
											/>
										) : (
											<div
												onClick={() => setEditState(message.id, true, message.text)}
												className="cursor-pointer hover:bg-vscode-list-hoverBackground px-1 py-0.5 -mx-1 -my-0.5 rounded transition-colors"
												title={t("chat:queuedMessages.clickToEdit")}>
												<Mention text={message.text} withShadow />
											</div>
										)}
									</div>
									<div className="flex">
										<Button
											variant="ghost"
											size="icon"
											className="shrink-0"
											onClick={(e) => {
												e.stopPropagation()
												onRemove(index)
											}}>
											<span className="codicon codicon-trash" />
										</Button>
									</div>
								</div>
								{message.images && message.images.length > 0 && (
									<Thumbnails images={message.images} style={{ marginTop: "8px" }} />
								)}
							</div>
						)
					})}
				</div>
			</CollapsibleContent>
		</Collapsible>
	)
}
