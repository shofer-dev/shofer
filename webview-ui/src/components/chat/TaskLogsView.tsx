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

/** Severity levels, ordered low → high; drives the filter chips. */
const LEVELS = ["debug", "info", "warn", "error", "fatal"] as const
type LogLevel = (typeof LEVELS)[number]

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
	// Free-text filter (matched against message + ctx) and the set of enabled
	// severities. Both default to "show everything".
	const [query, setQuery] = useState("")
	const [enabledLevels, setEnabledLevels] = useState<Record<LogLevel, boolean>>({
		debug: true,
		info: true,
		warn: true,
		error: true,
		fatal: true,
	})
	const scrollRef = useRef<HTMLDivElement>(null)
	const followRef = useRef(follow)
	followRef.current = follow

	const toggleLevel = useCallback((level: LogLevel) => {
		setEnabledLevels((prev) => ({ ...prev, [level]: !prev[level] }))
	}, [])

	// Apply severity + free-text filters (case-insensitive substring over the
	// message and the ctx tag). Declared before the effects that depend on it.
	const filtered = useMemo(() => {
		const q = query.trim().toLowerCase()
		return logs.filter((line) => {
			if (!enabledLevels[line.level as LogLevel]) return false
			if (!q) return true
			return (line.message ?? "").toLowerCase().includes(q) || (line.ctx ?? "").toLowerCase().includes(q)
		})
	}, [logs, query, enabledLevels])

	const empty = logs.length === 0
	const filterActive = query.trim() !== "" || LEVELS.some((l) => !enabledLevels[l])

	// Request a fresh snapshot whenever the selected task changes (and on mount).
	// On unmount (Logs tab closed / task switch) clear the host-side watch so it
	// stops streaming live lines to a tab no one is looking at.
	useEffect(() => {
		setLogs([])
		if (taskId) {
			vscode.postMessage({ type: "requestTaskLogs", taskId })
		}
		return () => {
			vscode.postMessage({ type: "requestTaskLogs" })
		}
	}, [taskId])

	useEvent("message", (event: MessageEvent) => {
		const message: ExtensionMessage = event.data
		if (!taskId || message.taskLogTaskId !== taskId) return
		if (message.type === "taskLogs") {
			setLogs((message.taskLogs ?? []).slice(-MAX_RENDERED_LINES))
		} else if (message.type === "taskLogAppended" && message.taskLogLines?.length) {
			const incoming = message.taskLogLines
			setLogs((prev) => [...prev, ...incoming].slice(-MAX_RENDERED_LINES))
		}
	})

	// Auto-scroll to the newest line while following (also re-pins on filter change).
	useEffect(() => {
		if (followRef.current && scrollRef.current) {
			scrollRef.current.scrollTop = scrollRef.current.scrollHeight
		}
	}, [filtered])

	// Pause "follow" when the user scrolls up; resume when scrolled to bottom.
	const onScroll = useCallback(() => {
		const el = scrollRef.current
		if (!el) return
		const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24
		setFollow(atBottom)
	}, [])

	const rows = useMemo(
		() =>
			filtered.map((line, i) => (
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
		[filtered],
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
					{empty
						? "No logs for this task yet"
						: filterActive
							? `${filtered.length} of ${logs.length} line${logs.length === 1 ? "" : "s"}`
							: `${logs.length} line${logs.length === 1 ? "" : "s"}`}
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
			{/* Filter bar: free-text + per-severity toggles. */}
			<div
				style={{
					display: "flex",
					alignItems: "center",
					gap: 8,
					padding: "4px 8px",
					borderBottom: "1px solid var(--vscode-panel-border, #333)",
				}}>
				<input
					type="text"
					value={query}
					onChange={(e) => setQuery(e.target.value)}
					placeholder="Filter logs…"
					style={{
						flex: 1,
						minWidth: 0,
						background: "var(--vscode-input-background, #3c3c3c)",
						color: "var(--vscode-input-foreground, #ccc)",
						border: "1px solid var(--vscode-input-border, #555)",
						borderRadius: 3,
						padding: "2px 6px",
						fontSize: 11,
					}}
				/>
				{query && (
					<button
						onClick={() => setQuery("")}
						title="Clear text filter"
						style={{
							background: "transparent",
							color: "var(--vscode-descriptionForeground, #888)",
							border: "none",
							cursor: "pointer",
							fontSize: 12,
							padding: "0 2px",
						}}>
						✕
					</button>
				)}
				<div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
					{LEVELS.map((level) => {
						const on = enabledLevels[level]
						return (
							<button
								key={level}
								onClick={() => toggleLevel(level)}
								title={on ? `Hide ${level} lines` : `Show ${level} lines`}
								style={{
									background: on ? "var(--vscode-button-background, #0e639c)" : "transparent",
									color: on ? LEVEL_COLOR[level] : "var(--vscode-descriptionForeground, #888)",
									border: "1px solid var(--vscode-panel-border, #333)",
									borderRadius: 3,
									padding: "1px 6px",
									cursor: "pointer",
									fontSize: 10,
									textTransform: "uppercase",
									opacity: on ? 1 : 0.6,
								}}>
								{level}
							</button>
						)
					})}
				</div>
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
				) : filtered.length === 0 ? (
					<div style={{ color: "var(--vscode-descriptionForeground, #888)", padding: 8 }}>
						No log lines match the current filter.
					</div>
				) : (
					rows
				)}
			</div>
		</div>
	)
}

export default TaskLogsView
