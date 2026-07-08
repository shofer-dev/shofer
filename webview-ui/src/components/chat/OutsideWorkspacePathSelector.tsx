import React, { useMemo, useState } from "react"
import { Check, ChevronUp, FolderCheck } from "lucide-react"
import { useTranslation } from "react-i18next"

import { vscode } from "@src/utils/vscode"
import { cn } from "../../lib/utils"

/**
 * Derive the parent directory of an absolute path without `node:path` (unavailable in the
 * webview). Splits on both POSIX and Windows separators and drops the final segment.
 * Falls back to the input itself when there is no parent to strip.
 */
export function dirnameLike(absolutePath: string): string {
	const trimmed = absolutePath.replace(/[/\\]+$/, "")
	const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"))
	if (idx <= 0) {
		// Root-level entry (e.g. "/etc" -> "/", or "C:\\x" -> "C:\\").
		return trimmed.slice(0, idx + 1) || trimmed
	}
	return trimmed.slice(0, idx)
}

interface OutsideWorkspacePathSelectorProps {
	/** The resolved absolute path of the file the pending tool ask touches. */
	absolutePath: string
	/** Whether the pending tool is a write-group tool (offers the read+write grant). */
	isWriteTool: boolean
	/** Current allowlists from ExtensionState (used to dedupe before appending). */
	allowedReadPaths: string[]
	allowedWritePaths: string[]
	/** Approve the pending ask (the existing primary/Approve path). */
	onApprove: () => void
}

/**
 * In-chat "approve the whole path" affordance shown next to Approve for a tool ask flagged
 * `isOutsideWorkspace` with an `absolutePath`. Mirrors {@link CommandPatternSelector}: a
 * collapsible panel with an editable directory field and grant buttons. Confirming appends
 * the (deduped) directory to `allowedReadPaths` / `allowedWritePaths`, persists it via a
 * `updateSettings` postMessage (globalState), and approves the current ask.
 */
export const OutsideWorkspacePathSelector: React.FC<OutsideWorkspacePathSelectorProps> = ({
	absolutePath,
	isWriteTool,
	allowedReadPaths,
	allowedWritePaths,
	onApprove,
}) => {
	const { t } = useTranslation()
	const [isExpanded, setIsExpanded] = useState(false)
	const defaultDir = useMemo(() => dirnameLike(absolutePath), [absolutePath])
	const [dir, setDir] = useState(defaultDir)

	const grant = (group: "read" | "write") => {
		const trimmed = dir.trim()
		if (!trimmed) {
			return
		}

		if (group === "write") {
			const current = allowedWritePaths ?? []
			const next = current.includes(trimmed) ? current : [...current, trimmed]
			vscode.postMessage({ type: "updateSettings", updatedSettings: { allowedWritePaths: next } })
		} else {
			const current = allowedReadPaths ?? []
			const next = current.includes(trimmed) ? current : [...current, trimmed]
			vscode.postMessage({ type: "updateSettings", updatedSettings: { allowedReadPaths: next } })
		}

		// Approve the current ask through the existing primary-button path.
		onApprove()
	}

	return (
		<div className="border-t border-vscode-panel-border/50 bg-vscode-sideBar-background/30 rounded-xs">
			<button
				onClick={() => setIsExpanded(!isExpanded)}
				className="w-full px-3 py-2 flex items-center justify-between hover:bg-vscode-list-hoverBackground transition-colors">
				<div className="group flex items-center gap-2 cursor-pointer w-full text-left">
					<span
						className={cn(
							"text-sm flex-1 group-hover:opacity-100",
							isExpanded ? "opacity-100" : "opacity-60",
						)}>
						<FolderCheck className="size-3 inline-block mr-2" />
						{t("chat:outsideWorkspacePath.title")}
					</span>
					<ChevronUp
						className={cn(
							"group-hover:opacity-100 size-4 transition-transform",
							isExpanded ? "opacity-100" : "opacity-60 -rotate-180",
						)}
					/>
				</div>
			</button>

			{isExpanded && (
				<div className="px-3 pt-1 pb-3 space-y-2">
					<div className="text-vscode-descriptionForeground text-xs">
						{t("chat:outsideWorkspacePath.description")}
					</div>
					<label className="block text-xs text-vscode-descriptionForeground">
						{t("chat:outsideWorkspacePath.dirLabel")}
					</label>
					<input
						type="text"
						value={dir}
						onChange={(e) => setDir(e.target.value)}
						className="font-mono text-xs bg-vscode-input-background text-vscode-input-foreground border border-vscode-input-border rounded px-2 py-1.5 w-full focus:outline-0 focus:ring-1 focus:ring-vscode-focusBorder"
						data-testid="outside-workspace-path-input"
					/>
					<div className="flex flex-wrap gap-2 pt-1">
						<button
							onClick={() => grant("read")}
							data-testid="grant-read-path-button"
							className="flex items-center gap-1 px-2 py-1 rounded text-xs cursor-pointer text-vscode-foreground border border-vscode-input-border hover:bg-green-500/10 hover:text-green-500 transition-colors">
							<Check className="size-3.5" />
							{t("chat:outsideWorkspacePath.allowReads")}
						</button>
						{isWriteTool && (
							<button
								onClick={() => grant("write")}
								data-testid="grant-write-path-button"
								className="flex items-center gap-1 px-2 py-1 rounded text-xs cursor-pointer text-vscode-foreground border border-vscode-input-border hover:bg-green-500/10 hover:text-green-500 transition-colors">
								<Check className="size-3.5" />
								{t("chat:outsideWorkspacePath.allowWrites")}
							</button>
						)}
					</div>
				</div>
			)}
		</div>
	)
}
