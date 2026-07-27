/**
 * File Changes — the panel above the chat input (`chat-footer` bundle).
 *
 * A collapsible list of the files this task changed, each row showing its net +/− and
 * offering diff, revert and accept, with accept-all / revert-all in the header. It
 * renders nothing when the task changed no files, so a task that only read code costs no
 * chrome.
 *
 * Built from the host's own components and translations (`@shofer/plugin-ui`), so the
 * panel is indistinguishable from a built-in one and follows the user's language. The
 * bundle externalizes React and the kit; the webview's import map resolves both to the
 * host's running instances.
 *
 * BUILD: compiled to `ui/panel.js` (esbuild, ESM — see `build-ui.mjs`, run automatically
 * by the extension bundle).
 */

import { useCallback, useEffect, useRef, useState } from "react"

import {
	Button,
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
	StandardTooltip,
	cn,
	usePluginTranslation,
} from "@shofer/plugin-ui"

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

export default function FileChangesPanel({ api }: { api: PluginUIApi }) {
	const t = usePluginTranslation()
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
		<Collapsible open={expanded} onOpenChange={setExpanded} className="px-3">
			<CollapsibleTrigger className="flex items-center gap-2 w-full py-2 rounded-md text-left text-vscode-foreground hover:bg-vscode-list-hoverBackground">
				<span className={`codicon codicon-chevron-${expanded ? "down" : "right"}`} />
				<span className="codicon codicon-diff-multiple" />
				<span className="text-sm font-medium">{t("panel.header", { count: entries.length })}</span>
				<span className="flex items-center gap-2 ml-auto shrink-0">
					{totals.added > 0 || totals.removed > 0 ? (
						<>
							<span className="text-xs font-medium text-vscode-charts-green">+{totals.added}</span>
							<span className="text-xs font-medium text-vscode-charts-red">-{totals.removed}</span>
						</>
					) : null}
					{/* Bulk actions. Stop propagation so they don't toggle the list. */}
					<span className="flex gap-0.5" onClick={(event) => event.stopPropagation()}>
						<StandardTooltip content={t("panel.acceptAllTooltip")}>
							<Button
								variant="ghost"
								size="icon"
								aria-label={t("panel.acceptAll")}
								onClick={() => void act("accept-all")}>
								<span className="codicon codicon-check-all" />
							</Button>
						</StandardTooltip>
						<StandardTooltip content={t("panel.revertAllTooltip")}>
							<Button
								variant="ghost"
								size="icon"
								aria-label={t("panel.revertAll")}
								onClick={() => void act("revert-all")}>
								<span className="codicon codicon-discard" />
							</Button>
						</StandardTooltip>
					</span>
				</span>
			</CollapsibleTrigger>

			{error ? <div className="text-sm text-vscode-errorForeground pb-1">{error}</div> : null}

			<CollapsibleContent>
				<div
					className="flex flex-col pb-2 pl-6 overflow-y-auto"
					style={{ maxHeight: `${MAX_VISIBLE_ROWS * ROW_HEIGHT_PX}px` }}>
					{entries.map((entry) => (
						<div
							key={entry.path}
							className="flex items-center gap-2 py-1 text-sm rounded hover:bg-vscode-list-hoverBackground">
							<StandardTooltip
								content={entry.hasOriginalContent ? entry.path : t("panel.diffUnavailable")}>
								<button
									type="button"
									className={cn(
										"flex-1 text-left truncate bg-transparent border-none p-0",
										entry.hasOriginalContent
											? "cursor-pointer hover:underline text-vscode-foreground"
											: "cursor-default text-vscode-descriptionForeground",
									)}
									onClick={() => void showDiff(entry)}>
									{entry.path}
								</button>
							</StandardTooltip>
							{entry.binary ? (
								<span className="text-xs text-vscode-descriptionForeground shrink-0">
									{t("panel.binary")}
								</span>
							) : (
								<span className="text-xs shrink-0 flex items-center gap-1">
									<span className="text-vscode-charts-green">+{entry.insertions}</span>
									<span className="text-vscode-charts-red">-{entry.deletions}</span>
								</span>
							)}
							<span className="flex gap-0.5 shrink-0">
								<StandardTooltip content={t("panel.revertTooltip")}>
									<Button
										variant="ghost"
										size="icon"
										aria-label={t("panel.revert")}
										onClick={() => void act("revert", { path: entry.path })}>
										<span className="codicon codicon-discard" />
									</Button>
								</StandardTooltip>
								<StandardTooltip content={t("panel.acceptTooltip")}>
									<Button
										variant="ghost"
										size="icon"
										aria-label={t("panel.accept")}
										onClick={() => void act("accept", { path: entry.path })}>
										<span className="codicon codicon-check" />
									</Button>
								</StandardTooltip>
							</span>
						</div>
					))}
				</div>
			</CollapsibleContent>
		</Collapsible>
	)
}
