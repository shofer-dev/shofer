import React from "react"
import { useAppTranslation } from "@src/i18n/TranslationContext"
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@src/components/ui"

interface MessageRewindDialogProps {
	open: boolean
	onOpenChange: (open: boolean) => void
	/** `true` ⇒ also roll back the state a plugin anchored here (e.g. the workspace). */
	onConfirm: (restoreState: boolean) => void
	type: "edit" | "delete"
	/** Whether any plugin holds a restorable point after this message. */
	hasRestorableState: boolean
}

/**
 * Confirmation for deleting or editing a message: chat-only, or — when a plugin holds
 * a restorable point after it — chat plus that plugin's state.
 */
export const MessageRewindDialog: React.FC<MessageRewindDialogProps> = ({
	open,
	onOpenChange,
	onConfirm,
	type,
	hasRestorableState,
}) => {
	const { t } = useAppTranslation()

	const isEdit = type === "edit"
	const title = isEdit ? t("common:confirmation.editMessage") : t("common:confirmation.deleteMessage")
	const description = isEdit
		? t("common:confirmation.editQuestionWithCheckpoint")
		: t("common:confirmation.deleteQuestionWithCheckpoint")

	const handleConfirmWithRestore = () => {
		onConfirm(true)
		onOpenChange(false)
	}

	const handleConfirmWithoutRestore = () => {
		onConfirm(false)
		onOpenChange(false)
	}

	return (
		<AlertDialog open={open} onOpenChange={onOpenChange}>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle className="text-lg">{title}</AlertDialogTitle>
					<AlertDialogDescription className="text-base">{description}</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter className="flex-col gap-2">
					<AlertDialogCancel className="bg-vscode-button-secondaryBackground hover:bg-vscode-button-secondaryHoverBackground text-vscode-button-secondaryForeground border-vscode-button-border">
						{t("common:answers.cancel")}
					</AlertDialogCancel>
					<AlertDialogAction
						onClick={handleConfirmWithoutRestore}
						className="bg-vscode-button-background hover:bg-vscode-button-hoverBackground text-vscode-button-foreground border-vscode-button-border">
						{isEdit ? t("common:confirmation.editOnly") : t("common:confirmation.deleteOnly")}
					</AlertDialogAction>
					{hasRestorableState && (
						<AlertDialogAction
							onClick={handleConfirmWithRestore}
							className="bg-vscode-button-background hover:bg-vscode-button-hoverBackground text-vscode-button-foreground border-vscode-button-border">
							{t("common:confirmation.restoreToCheckpoint")}
						</AlertDialogAction>
					)}
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	)
}

export const EditMessageDialog: React.FC<Omit<MessageRewindDialogProps, "type">> = (props) => (
	<MessageRewindDialog {...props} type="edit" />
)

export const DeleteMessageDialog: React.FC<Omit<MessageRewindDialogProps, "type">> = (props) => (
	<MessageRewindDialog {...props} type="delete" />
)
