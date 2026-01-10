import { Text } from "ink"
import { useTerminalSize } from "../hooks/TerminalSizeContext.js"
import * as theme from "../theme.js"

interface HorizontalLineProps {
	active?: boolean
}

/**
 * Full-width horizontal line component - uses terminal size from context
 */
export function HorizontalLine({ active = false }: HorizontalLineProps) {
	const { columns } = useTerminalSize()
	const color = active ? theme.borderColorActive : theme.borderColor
	return <Text color={color}>{"─".repeat(columns)}</Text>
}
