import { memo } from "react"
import { Text, Box } from "ink"

import type { Toast, ToastType } from "../hooks/useToast.js"
import * as theme from "../theme.js"

interface ToastDisplayProps {
	/** The current toast to display (null if no toast) */
	toast: Toast | null
}

/**
 * Get the color for a toast based on its type
 */
function getToastColor(type: ToastType): string {
	switch (type) {
		case "success":
			return theme.successColor
		case "warning":
			return theme.warningColor
		case "error":
			return theme.errorColor
		case "info":
		default:
			return theme.focusColor // cyan for info
	}
}

/**
 * Get the icon/prefix for a toast based on its type
 */
function getToastIcon(type: ToastType): string {
	switch (type) {
		case "success":
			return "✓"
		case "warning":
			return "⚠"
		case "error":
			return "✗"
		case "info":
		default:
			return "ℹ"
	}
}

/**
 * ToastDisplay component for showing ephemeral messages in the status bar.
 *
 * Displays the current toast with appropriate styling based on type.
 * When no toast is present, renders nothing.
 */
function ToastDisplay({ toast }: ToastDisplayProps) {
	if (!toast) {
		return null
	}

	const color = getToastColor(toast.type)
	const icon = getToastIcon(toast.type)

	return (
		<Box>
			<Text color={color}>
				{icon} {toast.message}
			</Text>
		</Box>
	)
}

export default memo(ToastDisplay)
