import React, { useEffect, useMemo, useRef, useState, useCallback } from "react"
import { useEvent } from "react-use"
import type { ExtensionMessage, TaskLogLine } from "@shofer/types"
import { vscode } from "@src/utils/vscode"

/**
 * "Logs" tab for a single Task / Workflow. Shows every log line emitted while
 * that task's run loop was executing — across all subsystem categories (Task,
 * API, MCP, Git, …) — scoped to the selected task only, not the whole tree.
 *
 * Data flow:
 *   - On mount / taskId change: request a snapshot (`requestTaskLogs`); the host
 *     replies with `taskLogs` (the buffered ring for that task).
 *   - While mounted: new lines for the focused task arrive via `taskLogAppended`
 *     and are appended live.
 *
 * Attribution happens host-side via an AsyncLocalStorage log context (see
 * `src/utils/logging/logContext.ts`); the webview just renders what it's sent.
 */

const LEVEL_COLOR: Record<string, string> = {
	debug: "var(--vscode-descriptionForeground, #888)",
	info: "var(--vscode-foreground, #ccc)",
	warn: "var(--vscode-charts-yellow, #d7a700)",
	error: "var(--vscode-errorForeground, #f14c4c)",
	fatal: "var(--vscode-errorForeground, #f14c4c)",
}

/** Hard cap on rendered lines to keep the DOM light (mirrors the host ring cap). */
const MAX_RENDERED_LINES = 2000

function formatTime(ts: number): string {
	// HH:MM:SS.mmm in local time.
	const d = new Date(ts)
	const pad = (n: number, w = 2) => String(n).padStart(w, "0")
	return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
}

interface TaskLogsViewProps {
	/** The task/workflow id whose logs to show. */
	taskId: string | undefined
}

const TaskLogsView: React.FC<TaskLogsViewProps> = ({ taskId }) => {
	const [logs, setLogs] = useState<TaskLogLine[]>([])
	const [follow, setFollow] = useState(true)
	const scrollRef = useRef<HTMLDivElement>(null)
	const followRef = useRef(follow)
	followRef.current = follow

	// Request a fresh snapshot whenever the selected task changes (and on mount).
	useEffect(() => {
		setLogs([])
		if (taskId) {
			vscode.postMessage({ type: "requestTaskLogs", taskId })
		}
	}, [taskId])

	useEvent("message", (event: MessageEvent) => {
		const message: ExtensionMessage = event.data
		if (!taskId || message.taskLogTaskId !== taskId) return
		if (message.type === "taskLogs") {
			setLogs((message.taskLogs ?? []).slice(-MAX_RENDERED_LINES))
		} else if (message.type === "taskLogAppended" && message.taskLogLine) {
			const line = message.taskLogLine
			setLogs((prev) => {
				const next = prev.length >= MAX_RENDERED_LINES ? prev.slice(prev.length - MAX_RENDERED_LINES + 1) : prev
				return [...next, line]
			})
		}
	})

	// Auto-scroll to the newest line while following.
	useEffect(() => {
		if (followRef.current && scrollRef.current) {
			scrollRef.current.scrollTop = scrollRef.current.scrollHeight
		}
	}, [logs])

	// Pause "follow" when the user scrolls up; resume when scrolled to bottom.
	const onScroll = useCallback(() => {
		const el = scrollRef.current
		if (!el) return
		const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24
		setFollow(atBottom)
	}, [])

	const empty = logs.length === 0

	const rows = useMemo(
		() =>
			logs.map((line, i) => (
				<div
					key={i}
					style={{
						display: "flex",
						gap: 8,
						padding: "1px 0",
						whiteSpace: "pre-wrap",
						wordBreak: "break-word",
					}}>
					<span style={{ color: "var(--vscode-descriptionForeground, #888)", flexShrink: 0 }}>
						{formatTime(line.ts)}
					</span>
					<span
						style={{
							color: LEVEL_COLOR[line.level] ?? "var(--vscode-foreground, #ccc)",
							flexShrink: 0,
							textTransform: "uppercase",
							width: 42,
						}}>
						{line.level}
					</span>
					{line.ctx ? (
						<span style={{ color: "var(--vscode-charts-blue, #4ec9b0)", flexShrink: 0 }}>[{line.ctx}]</span>
					) : null}
					<span style={{ color: LEVEL_COLOR[line.level] ?? "var(--vscode-foreground, #ccc)" }}>
						{line.message}
					</span>
				</div>
			)),
		[logs],
	)

	return (
		<div style={{ display: "flex", flexDirection: "column", flex: 1, width: "100%", height: "100%", minHeight: 0 }}>
			<div
				style={{
					display: "flex",
					alignItems: "center",
					justifyContent: "space-between",
					padding: "4px 8px",
					borderBottom: "1px solid var(--vscode-panel-border, #333)",
					fontSize: 11,
					color: "var(--vscode-descriptionForeground, #888)",
				}}>
				<span>
					{empty ? "No logs for this task yet" : `${logs.length} line${logs.length === 1 ? "" : "s"}`}
				</span>
				<button
					onClick={() => {
						setFollow(true)
						if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
					}}
					style={{
						background: follow ? "var(--vscode-button-background, #0e639c)" : "transparent",
						color: follow ? "var(--vscode-button-foreground, #fff)" : "inherit",
						border: "1px solid var(--vscode-panel-border, #333)",
						borderRadius: 3,
						padding: "1px 8px",
						cursor: "pointer",
						fontSize: 11,
					}}
					title="Scroll to newest and follow live logs">
					{follow ? "Following" : "Follow"}
				</button>
			</div>
			<div
				ref={scrollRef}
				onScroll={onScroll}
				style={{
					flex: 1,
					minHeight: 0,
					overflowY: "auto",
					padding: "6px 8px",
					fontFamily: "var(--vscode-editor-font-family, monospace)",
					fontSize: "var(--vscode-editor-font-size, 12px)",
					lineHeight: 1.5,
				}}>
				{empty ? (
					<div style={{ color: "var(--vscode-descriptionForeground, #888)", padding: 8 }}>
						Logs emitted while this task runs will appear here.
					</div>
				) : (
					rows
				)}
			</div>
		</div>
	)
}

export default TaskLogsView
