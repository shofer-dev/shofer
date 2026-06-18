import { memo, useCallback, useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { X, AlertCircle, CheckCircle, AlertTriangle } from "lucide-react"

import { cn } from "@src/lib/utils"
import { Button } from "@src/components/ui"

/**
 * Task notification interface.
 */
export interface TaskNotification {
	taskId: string
	type: "needs_input" | "completed" | "error" | "file_conflict"
	message: string
	timestamp: number
}

export interface TaskNotificationProps {
	notification: TaskNotification
	taskName: string
	onDismiss: (taskId: string) => void
	onFocus: (taskId: string) => void
}

/**
 * Notification type configuration with icons and colors.
 */
const NOTIFICATION_CONFIG: Record<
	string,
	{ icon: typeof AlertCircle; color: string; bgColor: string; textColor: string }
> = {
	needs_input: {
		icon: AlertCircle,
		color: "text-yellow-500",
		bgColor: "bg-yellow-500/90",
		textColor: "text-yellow-950",
	},
	completed: { icon: CheckCircle, color: "text-green-500", bgColor: "bg-green-500/90", textColor: "text-green-950" },
	error: { icon: AlertTriangle, color: "text-red-500", bgColor: "bg-red-500/90", textColor: "text-red-950" },
	file_conflict: {
		icon: AlertTriangle,
		color: "text-orange-500",
		bgColor: "bg-orange-500/90",
		textColor: "text-orange-950",
	},
}

/**
 * TaskNotification displays a toast/banner for background task events.
 *
 * LLM hint: This component shows notifications when background tasks need
 * user attention (e.g., approval required). It provides quick actions to switch
 * to the task or dismiss the notification.
 */
export const TaskNotification = memo(({ notification, taskName, onDismiss, onFocus }: TaskNotificationProps) => {
	const { t } = useTranslation()
	const [isVisible, setIsVisible] = useState(true)

	const config = NOTIFICATION_CONFIG[notification.type] || NOTIFICATION_CONFIG.needs_input
	const Icon = config.icon

	// Auto-dismiss after 30 seconds for non-interactive notifications
	useEffect(() => {
		if (notification.type !== "needs_input") {
			const timer = setTimeout(() => {
				setIsVisible(false)
				onDismiss(notification.taskId)
			}, 30000)
			return () => clearTimeout(timer)
		}
	}, [notification.type, notification.taskId, onDismiss])

	const handleFocus = useCallback(() => {
		onFocus(notification.taskId)
		setIsVisible(false)
	}, [notification.taskId, onFocus])

	const handleDismiss = useCallback(() => {
		onDismiss(notification.taskId)
		setIsVisible(false)
	}, [notification.taskId, onDismiss])

	if (!isVisible) {
		return null
	}

	return (
		<div
			className={cn(
				"flex items-center gap-3 px-4 py-3 rounded-lg shadow-lg",
				"border border-[var(--vscode-editorWidget-border,#454545)]",
				config.bgColor,
				config.textColor,
				"animate-slide-in-right",
			)}>
			{/* Icon */}
			<Icon className={cn("w-5 h-5 flex-shrink-0", config.color)} />

			{/* Content */}
			<div className="flex-1 min-w-0">
				<div className={cn("font-medium text-sm truncate", config.textColor)}>{taskName}</div>
				<div className={cn("text-xs truncate opacity-80", config.textColor)}>{notification.message}</div>
			</div>

			{/* Actions */}
			<div className="flex items-center gap-2 flex-shrink-0">
				{notification.type === "needs_input" && (
					<Button size="sm" variant="secondary" onClick={handleFocus}>
						{t("chat:taskNotification.switch", "Switch")}
					</Button>
				)}
				<button
					onClick={handleDismiss}
					className={cn("p-1 hover:bg-black/10 rounded", config.textColor)}
					aria-label={t("chat:taskNotification.dismiss", "Dismiss")}>
					<X className="w-4 h-4" />
				</button>
			</div>
		</div>
	)
})

TaskNotification.displayName = "TaskNotification"

/**
 * TaskNotificationContainer manages multiple task notifications.
 */
export interface TaskNotificationContainerProps {
	notifications: TaskNotification[]
	managedTasks: Array<{ id: string; name: string }>
	onDismiss: (taskId: string) => void
	onFocus: (taskId: string) => void
}

export const TaskNotificationContainer = memo(
	({ notifications, managedTasks, onDismiss, onFocus }: TaskNotificationContainerProps) => {
		if (notifications.length === 0) {
			return null
		}

		return (
			<div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-sm">
				{notifications.map((notification) => {
					const managedTask = managedTasks.find((t) => t.id === notification.taskId)
					return (
						<TaskNotification
							key={`${notification.taskId}-${notification.type}`}
							notification={notification}
							taskName={managedTask?.name || "Unknown Task"}
							onDismiss={onDismiss}
							onFocus={onFocus}
						/>
					)
				})}
			</div>
		)
	},
)

TaskNotificationContainer.displayName = "TaskNotificationContainer"
