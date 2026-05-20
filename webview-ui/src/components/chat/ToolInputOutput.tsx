import React, { useState, useCallback } from "react"
import type { ShoferSayTool } from "@shofer/types"
import { useExtensionState } from "@src/context/ExtensionStateContext"
import CodeAccordion from "../common/CodeAccordion"

/**
 * Maximum characters of tool output to show inline before offering
 * a "Show full output" toggle. Matches the truncation philosophy used
 * elsewhere (read_file, grep_search, etc.).
 */
const MAX_INLINE_OUTPUT = 8000

/**
 * Renders an expandable section showing the tool's input parameters.
 * Clicking the header toggles a formatted JSON block of the ShoferSayTool payload.
 *
 * Fields with undefined/null values or large binary content are omitted.
 */
export const ToolInputSection: React.FC<{
	tool: ShoferSayTool
	isExpanded: boolean
	onToggle: () => void
}> = ({ tool, isExpanded, onToggle }) => {
	const { experiments } = useExtensionState()

	// Feature-gated: only render when the user has enabled the experiment.
	if (!experiments?.showToolInputOutput) {
		return null
	}

	// Build a displayable copy: strip batch content blobs and image data
	const displayParams: Record<string, unknown> = {}
	for (const [key, value] of Object.entries(tool)) {
		if (value === undefined || value === null) continue
		// Skip massive content blobs from batch arrays — they'd overwhelm the JSON view
		if (key === "tool") {
			displayParams[key] = value
		} else if (key === "batchFiles") {
			displayParams[key] = `[${(value as any[]).length} files]`
		} else if (key === "batchDiffs") {
			displayParams[key] = `[${(value as any[]).length} diffs]`
		} else if (key === "content" && typeof value === "string" && value.length > 500) {
			displayParams[key] = value.substring(0, 500) + `… (${value.length} chars total)`
		} else if (key === "diff" && typeof value === "string" && value.length > 500) {
			displayParams[key] = value.substring(0, 500) + `… (${value.length} chars total)`
		} else if (key === "imageData" && typeof value === "string") {
			displayParams[key] = `[${value.length} bytes base64]`
		} else if (key === "answer" && typeof value === "string" && value.length > 500) {
			displayParams[key] = value.substring(0, 500) + `… (${value.length} chars total)`
		} else {
			displayParams[key] = value
		}
	}

	const json = JSON.stringify(displayParams, null, 2)

	return (
		<div className="pl-6">
			<div
				className="flex items-center gap-2 cursor-pointer text-xs text-vscode-descriptionForeground hover:text-vscode-foreground mt-1 select-none"
				onClick={onToggle}
				role="button"
				tabIndex={0}
				onKeyDown={(e) => {
					if (e.key === "Enter" || e.key === " ") {
						e.preventDefault()
						onToggle()
					}
				}}>
				<span className={`codicon codicon-chevron-${isExpanded ? "down" : "right"}`} />
				<span>Input</span>
			</div>
			{isExpanded && (
				<div className="mt-1">
					<CodeAccordion code={json} language="json" isExpanded={true} onToggleExpand={() => {}} />
				</div>
			)}
		</div>
	)
}

/**
 * Renders an expandable section showing the raw tool output.
 * Truncates large outputs and provides a "Show full output" toggle.
 */
export const ToolOutputSection: React.FC<{
	tool: string
	output: string
}> = ({ tool: _tool, output }) => {
	const { experiments } = useExtensionState()
	const [expanded, setExpanded] = useState(false)

	const handleToggle = useCallback(() => {
		setExpanded((prev) => !prev)
	}, [])

	// Feature-gated: only render when the user has enabled the experiment.
	if (!experiments?.showToolInputOutput) {
		return null
	}

	const isLarge = output.length > MAX_INLINE_OUTPUT
	const displayContent =
		isLarge && !expanded
			? output.substring(0, MAX_INLINE_OUTPUT) +
				`\n\n[Output truncated: ${output.length} chars total. Click to expand.]`
			: output

	return (
		<div className="pl-6">
			<div
				className="flex items-center gap-2 cursor-pointer text-xs text-vscode-descriptionForeground hover:text-vscode-foreground mt-1 select-none"
				onClick={handleToggle}
				role="button"
				tabIndex={0}
				onKeyDown={(e) => {
					if (e.key === "Enter" || e.key === " ") {
						e.preventDefault()
						handleToggle()
					}
				}}>
				<span className={`codicon codicon-chevron-${expanded ? "down" : "right"}`} />
				<span>Output</span>
			</div>
			{expanded && (
				<div className="mt-1">
					<CodeAccordion code={displayContent} language="text" isExpanded={true} onToggleExpand={() => {}} />
					{isLarge && (
						<div className="text-xs text-vscode-descriptionForeground mt-1">
							{output.length.toLocaleString()} chars total
						</div>
					)}
				</div>
			)}
		</div>
	)
}
