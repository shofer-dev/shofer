/**
 * Checkpoints — the timeline row (`chat-message-addon` bundle).
 *
 * A labelled divider that reveals, on hover, a Diff button, a Restore popover
 * (Restore Files / Restore Files & Task, the latter behind a confirm) and a "more"
 * popover (diff since the first checkpoint / diff against the current workspace).
 *
 * Built from the host's own components and translations (`@shofer/plugin-ui`), so the
 * row is indistinguishable from a built-in one and follows the user's language. The
 * bundle externalizes React and the kit; the webview's import map resolves both to the
 * host's running instances.
 *
 * BUILD: compiled to `ui/row.js` (esbuild, ESM — see `build-ui.mjs`, run automatically
 * by the extension bundle).
 */

import { useCallback, useEffect, useRef, useState } from "react"

import {
	Button,
	Popover,
	PopoverContent,
	PopoverTrigger,
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
		message?: { ts: number; text?: string; kind: string; data?: Record<string, unknown>; restorable?: boolean }
	}
}

type DiffMode = "checkpoint" | "from-init" | "to-current" | "full"

interface DiffResult {
	title?: string
	changes?: unknown[]
	notice?: "no-first" | "no-previous" | "no-changes"
}

const ACCENT = "rgba(0, 188, 255, .65)"

export default function CheckpointRow({ api }: { api: PluginUIApi }) {
	const t = usePluginTranslation()
	const marker = api.context.message
	const [hovering, setHovering] = useState(false)
	const [restoreOpen, setRestoreOpen] = useState(false)
	const [moreOpen, setMoreOpen] = useState(false)
	const [confirming, setConfirming] = useState(false)
	const [status, setStatus] = useState<string | undefined>()
	const statusTimer = useRef<number | null>(null)

	useEffect(
		() => () => {
			if (statusTimer.current) window.clearTimeout(statusTimer.current)
		},
		[],
	)

	/** Surface a transient inline message — a timeline row has no toast of its own. */
	const flash = useCallback((text: string) => {
		setStatus(text)
		if (statusTimer.current) window.clearTimeout(statusTimer.current)
		statusTimer.current = window.setTimeout(() => setStatus(undefined), 4000)
	}, [])

	const showDiff = useCallback(
		async (mode: DiffMode) => {
			if (!marker?.text) return
			setMoreOpen(false)
			try {
				// Computed where the task's shadow repo lives (this host, or the executor
				// that owns a remote task) …
				const result = (await api.request("diff", { commitHash: marker.text, mode })) as DiffResult
				if (result?.notice) {
					flash(t(`notice.${result.notice}`))
					return
				}
				// … then rendered HERE, because the viewer is this host's, not the executor's.
				await api.request("local:show-diff", { title: result.title, changes: result.changes })
			} catch (error) {
				flash(error instanceof Error ? error.message : String(error))
			}
		},
		[api, marker?.text, flash, t],
	)

	const restore = useCallback(
		async (mode: "preview" | "restore") => {
			if (!marker?.text) return
			setRestoreOpen(false)
			setConfirming(false)
			try {
				await api.request("restore", { ts: marker.ts, commitHash: marker.text, mode }, { mutates: true })
			} catch (error) {
				flash(error instanceof Error ? error.message : String(error))
			}
		},
		[api, marker?.ts, marker?.text, flash],
	)

	if (!marker?.text) return null

	const menuVisible = hovering || restoreOpen || moreOpen

	return (
		<div
			className="flex flex-col gap-0.5 pt-2 pb-3"
			onMouseEnter={() => setHovering(true)}
			onMouseLeave={() => setHovering(false)}>
			<div className="flex items-center gap-2">
				<div className="flex items-center gap-1.5 whitespace-nowrap text-vscode-charts-blue">
					<span className="codicon codicon-git-commit" />
					<span className="font-semibold">{t("row.label")}</span>
				</div>
				<span
					className="flex-1 h-0.5 mt-0.5"
					style={{
						backgroundImage: `linear-gradient(90deg, ${ACCENT}, ${ACCENT} 80%, rgba(0, 188, 255, 0) 99%)`,
					}}
				/>

				<div className={cn("flex gap-0.5", menuVisible ? "visible" : "invisible")}>
					<StandardTooltip content={t("row.diffTooltip")}>
						<Button
							variant="ghost"
							size="icon"
							aria-label={t("row.diff")}
							onClick={() => void showDiff("checkpoint")}>
							<span className="codicon codicon-diff-single" />
						</Button>
					</StandardTooltip>

					<Popover
						open={restoreOpen}
						onOpenChange={(open) => {
							setRestoreOpen(open)
							if (!open) setConfirming(false)
						}}>
						<StandardTooltip content={t("row.restore")}>
							<PopoverTrigger asChild>
								<Button variant="ghost" size="icon" aria-label={t("row.restore")}>
									<span className="codicon codicon-history" />
								</Button>
							</PopoverTrigger>
						</StandardTooltip>
						<PopoverContent align="end" className="flex flex-col gap-3 w-72">
							<div className="flex flex-col gap-1">
								<Button variant="secondary" onClick={() => void restore("preview")}>
									{t("restore.filesOnly")}
								</Button>
								<div className="text-vscode-descriptionForeground text-sm">
									{t("restore.filesOnlyHint")}
								</div>
							</div>
							<div className="flex flex-col gap-1">
								{!confirming ? (
									<Button variant="secondary" onClick={() => setConfirming(true)}>
										{t("restore.filesAndTask")}
									</Button>
								) : (
									<div className="flex flex-col gap-1">
										<Button variant="primary" onClick={() => void restore("restore")}>
											{t("restore.confirm")}
										</Button>
										<Button variant="secondary" onClick={() => setConfirming(false)}>
											{t("restore.cancel")}
										</Button>
									</div>
								)}
								<div
									className={cn(
										"text-sm",
										confirming
											? "text-vscode-errorForeground font-bold"
											: "text-vscode-descriptionForeground",
									)}>
									{confirming ? t("restore.irreversible") : t("restore.filesAndTaskHint")}
								</div>
							</div>
						</PopoverContent>
					</Popover>

					<Popover open={moreOpen} onOpenChange={setMoreOpen}>
						<StandardTooltip content={t("row.more")}>
							<PopoverTrigger asChild>
								<Button variant="ghost" size="icon" aria-label={t("row.more")}>
									<span className="codicon codicon-kebab-vertical" />
								</Button>
							</PopoverTrigger>
						</StandardTooltip>
						<PopoverContent align="end" className="flex flex-col gap-1 w-72">
							<Button
								variant="ghost"
								className="justify-start"
								onClick={() => void showDiff("from-init")}>
								<span className="codicon codicon-versions" />
								{t("more.sinceFirst")}
							</Button>
							<Button
								variant="ghost"
								className="justify-start"
								onClick={() => void showDiff("to-current")}>
								<span className="codicon codicon-diff" />
								{t("more.againstCurrent")}
							</Button>
						</PopoverContent>
					</Popover>
				</div>
			</div>

			{status && <div className="text-sm text-vscode-descriptionForeground">{status}</div>}
		</div>
	)
}
