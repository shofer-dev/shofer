/**
 * Checkpoints — the timeline row (`chat-message-addon` bundle).
 *
 * The plugin-native port of the built-in `CheckpointSaved` + `CheckpointMenu`: a
 * labelled divider that reveals a Diff button, a Restore popover (Restore Files /
 * Restore Files & Task, the latter behind a confirm) and a "more" popover (diff since
 * first checkpoint / diff against current) on hover.
 *
 * A plugin UI bundle may import only the host-shared React — not the host's UI kit,
 * icons or i18n — so the popovers and layout are reimplemented inline with VS Code
 * theme variables and codicons, which the webview already loads.
 *
 * BUILD: compiled to `ui/row.js` (esbuild, ESM, react externalized — see `build-ui.mjs`,
 * run automatically by the extension bundle). NOT typechecked by the extension build.
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
		message?: { ts: number; text?: string; kind: string; data?: Record<string, unknown>; restorable?: boolean }
	}
}

type DiffMode = "checkpoint" | "from-init" | "to-current" | "full"

interface DiffResult {
	title?: string
	changes?: unknown[]
	notice?: "no-first" | "no-previous" | "no-changes"
}

const NOTICE_TEXT: Record<string, string> = {
	"no-first": "No initial checkpoint found for this task.",
	"no-previous": "No earlier checkpoint to compare against.",
	"no-changes": "No changes between these checkpoints.",
}

const ACCENT = "rgba(0, 188, 255, .65)"

function iconButton(active: boolean): React.CSSProperties {
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
		background: active ? "var(--vscode-toolbar-hoverBackground)" : "transparent",
		color: "var(--vscode-foreground)",
	}
}

const POPOVER: React.CSSProperties = {
	position: "absolute",
	right: 0,
	top: 24,
	zIndex: 10,
	minWidth: 240,
	padding: 8,
	display: "flex",
	flexDirection: "column",
	gap: 8,
	borderRadius: 4,
	background: "var(--vscode-editorWidget-background)",
	border: "1px solid var(--vscode-editorWidget-border, var(--vscode-widget-border))",
	boxShadow: "0 2px 8px rgba(0,0,0,.3)",
	fontSize: "0.9em",
}

function button(variant: "primary" | "secondary"): React.CSSProperties {
	return {
		padding: "4px 8px",
		borderRadius: 2,
		border: "none",
		cursor: "pointer",
		textAlign: "center",
		background:
			variant === "primary" ? "var(--vscode-button-background)" : "var(--vscode-button-secondaryBackground)",
		color: variant === "primary" ? "var(--vscode-button-foreground)" : "var(--vscode-button-secondaryForeground)",
	}
}

const MUTED: React.CSSProperties = { color: "var(--vscode-descriptionForeground)" }

export default function CheckpointRow({ api }: { api: PluginUIApi }) {
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

	/** Surface a transient inline message — the bundle has no access to host toasts. */
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
					flash(NOTICE_TEXT[result.notice] ?? "Nothing to show.")
					return
				}
				// … then rendered HERE, because the viewer is this host's, not the executor's.
				await api.request("local:show-diff", { title: result.title, changes: result.changes })
			} catch (error) {
				flash(error instanceof Error ? error.message : String(error))
			}
		},
		[api, marker?.text, flash],
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
			style={{ display: "flex", flexDirection: "column", gap: 2, paddingTop: 8, paddingBottom: 12 }}
			onMouseEnter={() => setHovering(true)}
			onMouseLeave={() => setHovering(false)}>
			<div style={{ display: "flex", alignItems: "center", gap: 8, position: "relative" }}>
				<div
					style={{
						display: "flex",
						alignItems: "center",
						gap: 6,
						whiteSpace: "nowrap",
						color: "var(--vscode-charts-blue, #3794ff)",
					}}>
					<span className="codicon codicon-git-commit" />
					<span style={{ fontWeight: 600 }}>Checkpoint</span>
				</div>
				<span
					style={{
						flex: 1,
						height: 2,
						marginTop: 2,
						backgroundImage: `linear-gradient(90deg, ${ACCENT}, ${ACCENT} 80%, rgba(0, 188, 255, 0) 99%)`,
					}}
				/>

				<div style={{ display: "flex", gap: 2, visibility: menuVisible ? "visible" : "hidden" }}>
					<button
						style={iconButton(false)}
						title="View changes in this checkpoint"
						aria-label="View diff"
						onClick={() => void showDiff("checkpoint")}>
						<span className="codicon codicon-diff-single" />
					</button>
					<button
						style={iconButton(restoreOpen)}
						title="Restore"
						aria-label="Restore"
						onClick={() => {
							setRestoreOpen((open) => !open)
							setConfirming(false)
							setMoreOpen(false)
						}}>
						<span className="codicon codicon-history" />
					</button>
					<button
						style={iconButton(moreOpen)}
						title="More"
						aria-label="More checkpoint actions"
						onClick={() => {
							setMoreOpen((open) => !open)
							setRestoreOpen(false)
						}}>
						<span className="codicon codicon-kebab-vertical" />
					</button>
				</div>

				{restoreOpen && (
					<div style={POPOVER}>
						<div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
							<button style={button("secondary")} onClick={() => void restore("preview")}>
								Restore Files
							</button>
							<div style={MUTED}>
								Restores your project's files back to a snapshot taken at this point.
							</div>
						</div>
						<div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
							{!confirming ? (
								<button style={button("secondary")} onClick={() => setConfirming(true)}>
									Restore Files & Task
								</button>
							) : (
								<>
									<button style={button("primary")} onClick={() => void restore("restore")}>
										Confirm
									</button>
									<button style={button("secondary")} onClick={() => setConfirming(false)}>
										Cancel
									</button>
								</>
							)}
							{confirming ? (
								<div style={{ color: "var(--vscode-errorForeground)", fontWeight: 700 }}>
									This action cannot be undone.
								</div>
							) : (
								<div style={MUTED}>
									Restores your project's files and deletes all messages after this point.
								</div>
							)}
						</div>
					</div>
				)}

				{moreOpen && (
					<div style={{ ...POPOVER, minWidth: 220 }}>
						<button style={button("secondary")} onClick={() => void showDiff("from-init")}>
							<span className="codicon codicon-versions" style={{ marginRight: 6 }} />
							View changes since first checkpoint
						</button>
						<button style={button("secondary")} onClick={() => void showDiff("to-current")}>
							<span className="codicon codicon-diff" style={{ marginRight: 6 }} />
							View changes compared to current
						</button>
					</div>
				)}
			</div>

			{status && <div style={{ ...MUTED, fontSize: "0.9em" }}>{status}</div>}
		</div>
	)
}
