/**
 * File Changes — the panel above the chat input (`chat-footer` bundle).
 *
 * Plugin-native port of the built-in `FileChangesPanel`: a collapsible list of the
 * files this task changed, each row showing its net +/− and offering diff, revert and
 * accept, with accept-all / revert-all in the header. It renders nothing when the task
 * changed no files, so a task that only read code costs no chrome.
 *
 * A plugin UI bundle may import only the host-shared React — not the host's UI kit,
 * icons or i18n — so the layout is inline styles over VS Code theme variables plus
 * codicons, which the webview already loads.
 *
 * BUILD: compiled to `ui/panel.js` (esbuild, ESM, react externalized — see
 * `build-ui.mjs`, run automatically by the extension bundle).
 */

import { useCallback, useEffect, useRef, useState } from "react"

/** Scoped UI API (mirrors `@shofer/types` `PluginUIApi`; local so the bundle stands alone). */
interface PluginUIApi {
	postMessage(message: unknown): void
	onMessage(listener: (message: unknown) => void): () => void
	request(method: string, params?: unknown, opts?: { mutates?: boolean }): Promise<unknown>
	readonly context: {
		region: string
		pluginName: string
		task?: { taskId?: string; mode?: string; messageCount?: number }
	}
}

interface ChangedFileEntry {
	path: string
	insertions: number
	deletions: number
	binary: boolean
	state: "modified" | "added" | "deleted"
	hasOriginalContent: boolean
	hasFinalContent: boolean
}

interface ChangedFilesPayload {
	taskId: string
	entries: ChangedFileEntry[]
}

const MAX_VISIBLE_ROWS = 5
const ROW_HEIGHT_PX = 28

const ROW: React.CSSProperties = {
	display: "flex",
	alignItems: "center",
	gap: 8,
	padding: "2px 0",
	fontSize: "0.95em",
	borderRadius: 3,
}

function iconButton(): React.CSSProperties {
	return {
		display: "inline-flex",
		alignItems: "center",
		justifyContent: "center",
		width: 20,
		height: 20,
		padding: 0,
		border: "none",
		borderRadius: 3,
		cursor: "pointer",
		background: "transparent",
		color: "var(--vscode-foreground)",
	}
}

export default function FileChangesPanel({ api }: { api: PluginUIApi }) {
	const taskId = api.context.task?.taskId
	const messageCount = api.context.task?.messageCount
	const [payload, setPayload] = useState<ChangedFilesPayload | undefined>()
	const [expanded, setExpanded] = useState(false)
	const [error, setError] = useState<string | undefined>()
	const errorTimer = useRef<number | null>(null)

	const flash = useCallback((message: string) => {
		setError(message)
		if (errorTimer.current) window.clearTimeout(errorTimer.current)
		errorTimer.current = window.setTimeout(() => setError(undefined), 5000)
	}, [])

	const refresh = useCallback(async () => {
		try {
			const result = (await api.request("get")) as ChangedFilesPayload | undefined
			setPayload(result)
		} catch (err) {
			flash(err instanceof Error ? err.message : String(err))
		}
	}, [api, flash])

	// Pull on mount and whenever the focused task changes — the list is per task, and
	// the push below only arrives for a task running on this host.
	useEffect(() => {
		setPayload(undefined)
		void refresh()
	}, [taskId, refresh])

	// A task on a REMOTE executor pushes to its own host's webview, not this one, so
	// there is nothing to receive here — re-read when its conversation moves instead.
	// Throttled: a streaming task produces messages far faster than the list changes.
	const lastPullRef = useRef(0)
	useEffect(() => {
		if (messageCount === undefined) return
		const since = Date.now() - lastPullRef.current
		if (since < 1000) return
		lastPullRef.current = Date.now()
		void refresh()
	}, [messageCount, refresh])

	// Live updates while the agent edits (debounced by the plugin's extension half).
	useEffect(
		() =>
			api.onMessage((message) => {
				const update = message as { type?: string; payload?: ChangedFilesPayload }
				if (update?.type !== "changedFiles" || !update.payload) return
				if (taskId && update.payload.taskId !== taskId) return
				setPayload(update.payload)
			}),
		[api, taskId],
	)

	useEffect(
		() => () => {
			if (errorTimer.current) window.clearTimeout(errorTimer.current)
		},
		[],
	)

	const act = useCallback(
		async (method: string, params?: unknown) => {
			try {
				await api.request(method, params, { mutates: true })
			} catch (err) {
				flash(err instanceof Error ? err.message : String(err))
			}
			// Refresh from the owning host rather than trusting a local guess: on a
			// remote task the mutation happened over there.
			await refresh()
		},
		[api, flash, refresh],
	)

	const showDiff = useCallback(
		async (entry: ChangedFileEntry) => {
			if (!entry.hasOriginalContent) return
			try {
				// Computed where the task's snapshots live (this host, or the executor
				// owning a remote task) …
				const diff = (await api.request("diff", { path: entry.path })) as
					| { title: string; changes: unknown[] }
					| undefined
				if (!diff) return
				// … then opened HERE, because the editor is this host's.
				await api.request("local:show-diff", diff)
			} catch (err) {
				flash(err instanceof Error ? err.message : String(err))
			}
		},
		[api, flash],
	)

	const entries = payload?.entries ?? []
	if (entries.length === 0 && !error) return null

	const totals = entries.reduce(
		(acc, entry) => ({ added: acc.added + entry.insertions, removed: acc.removed + entry.deletions }),
		{ added: 0, removed: 0 },
	)

	return (
		<div style={{ padding: "0 12px" }}>
			<div
				style={{
					display: "flex",
					alignItems: "center",
					gap: 8,
					padding: "6px 0",
					cursor: "pointer",
					color: "var(--vscode-foreground)",
				}}
				onClick={() => setExpanded((open) => !open)}>
				<span className={`codicon codicon-chevron-${expanded ? "down" : "right"}`} />
				<span className="codicon codicon-diff-multiple" />
				<span style={{ fontWeight: 600 }}>
					{entries.length} file{entries.length === 1 ? "" : "s"} changed
				</span>
				<span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
					{totals.added > 0 || totals.removed > 0 ? (
						<>
							<span style={{ color: "var(--vscode-charts-green)", fontSize: "0.9em" }}>
								+{totals.added}
							</span>
							<span style={{ color: "var(--vscode-charts-red)", fontSize: "0.9em" }}>
								-{totals.removed}
							</span>
						</>
					) : null}
					{/* Bulk actions. Stop propagation so they don't toggle the list. */}
					<span style={{ display: "flex", gap: 2 }} onClick={(event) => event.stopPropagation()}>
						<button
							style={iconButton()}
							title="Accept all changes (keep them, stop tracking)"
							aria-label="Accept all"
							onClick={() => void act("accept-all")}>
							<span className="codicon codicon-check-all" />
						</button>
						<button
							style={iconButton()}
							title="Revert all changes"
							aria-label="Revert all"
							onClick={() => void act("revert-all")}>
							<span className="codicon codicon-discard" />
						</button>
					</span>
				</span>
			</div>

			{error ? (
				<div style={{ color: "var(--vscode-errorForeground)", fontSize: "0.9em", paddingBottom: 4 }}>
					{error}
				</div>
			) : null}

			{expanded ? (
				<div
					style={{
						display: "flex",
						flexDirection: "column",
						paddingLeft: 18,
						paddingBottom: 6,
						maxHeight: MAX_VISIBLE_ROWS * ROW_HEIGHT_PX,
						overflowY: "auto",
					}}>
					{entries.map((entry) => (
						<div key={entry.path} style={ROW}>
							<button
								style={{
									flex: 1,
									textAlign: "left",
									overflow: "hidden",
									textOverflow: "ellipsis",
									whiteSpace: "nowrap",
									background: "transparent",
									border: "none",
									padding: 0,
									cursor: entry.hasOriginalContent ? "pointer" : "default",
									color: entry.hasOriginalContent
										? "var(--vscode-foreground)"
										: "var(--vscode-descriptionForeground)",
								}}
								title={
									entry.hasOriginalContent
										? entry.path
										: `${entry.path} — no baseline was captured, so there is nothing to diff against`
								}
								onClick={() => void showDiff(entry)}>
								{entry.path}
							</button>
							{entry.binary ? (
								<span style={{ color: "var(--vscode-descriptionForeground)", fontSize: "0.9em" }}>
									(binary)
								</span>
							) : (
								<span style={{ display: "flex", gap: 4, fontSize: "0.9em" }}>
									<span style={{ color: "var(--vscode-charts-green)" }}>+{entry.insertions}</span>
									<span style={{ color: "var(--vscode-charts-red)" }}>-{entry.deletions}</span>
								</span>
							)}
							<span style={{ display: "flex", gap: 2 }}>
								<button
									style={iconButton()}
									title="Revert this file"
									aria-label="Revert"
									onClick={() => void act("revert", { path: entry.path })}>
									<span className="codicon codicon-discard" />
								</button>
								<button
									style={iconButton()}
									title="Accept this file (keep it, stop tracking)"
									aria-label="Accept"
									onClick={() => void act("accept", { path: entry.path })}>
									<span className="codicon codicon-check" />
								</button>
							</span>
						</div>
					))}
				</div>
			) : null}
		</div>
	)
}
