/**
 * The indexer's panel in Settings (`settings-tab`).
 *
 * Deliberately small. Every *setting* — provider, model, store URL and the seven
 * credentials — is declared in `plugin.json`'s `config` schema, which the Plugins panel
 * already renders as a form (with password fields for the `secret: true` ones). What that
 * generic form cannot do is show what the index is DOING and let the user act on it, so
 * that is all this adds: state, progress, and the four buttons.
 *
 * The 990-line bespoke config form this replaces existed because the settings lived in
 * core's global state and needed hand-written plumbing per provider; as plugin config they
 * need none.
 *
 * BUILD: `ui/settings.js` (esbuild ESM; React and `@shofer/plugin-ui` external).
 */

import { useCallback, useEffect, useState } from "react"

import { Badge, Button, ToggleSwitch, cn, usePluginTranslation } from "@shofer/plugin-ui"

/** The restricted API the host hands a plugin UI component (`PluginUIApi` in `@shofer/types`). */
interface PluginUIApi {
	postMessage(message: unknown): void
	onMessage(listener: (message: unknown) => void): () => void
	request(method: string, params?: unknown, opts?: { mutates?: boolean }): Promise<unknown>
	readonly context: { readonly region: string; readonly pluginName: string }
}

/** One index's state, as `manager.getCurrentStatus()` reports it. */
interface IndexStatus {
	systemStatus: string
	message?: string
	processedItems?: number
	totalItems?: number
	currentItemUnit?: string
	workspacePath?: string
	workspaceEnabled?: boolean
	autoEnableDefault?: boolean
}

interface StatusReply {
	code?: IndexStatus
	git?: IndexStatus
}

/** How often the panel re-reads state while it is open. */
const POLL_MS = 2000

const TONE: Record<string, string> = {
	Indexed: "text-vscode-charts-green",
	Indexing: "text-vscode-charts-blue",
	Error: "text-vscode-errorForeground",
	Standby: "text-vscode-descriptionForeground",
	Disabled: "text-vscode-descriptionForeground",
}

function ask<T>(api: PluginUIApi, method: string, params?: unknown, mutates = false): Promise<T> {
	// `local:` — the index lives on the machine with the workspace, so these questions are
	// answered here even while a remote executor's task is focused.
	return api.request(`local:${method}`, params, { mutates }) as Promise<T>
}

function Progress({ status }: { status: IndexStatus }) {
	const t = usePluginTranslation()
	if (status.systemStatus !== "Indexing" || !status.totalItems) return null
	const percent = Math.min(100, Math.round(((status.processedItems ?? 0) / status.totalItems) * 100))
	return (
		<div className="text-xs text-vscode-descriptionForeground">
			{t("panel.progress", {
				processed: status.processedItems ?? 0,
				total: status.totalItems,
				unit: status.currentItemUnit ?? "items",
				percent,
			})}
		</div>
	)
}

export default function RagIndexingSettings({ api }: { api: PluginUIApi }): React.JSX.Element {
	const t = usePluginTranslation()
	const [status, setStatus] = useState<StatusReply | null>(null)
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)

	const refresh = useCallback(() => {
		void ask<StatusReply>(api, "status")
			.then((next) => {
				setStatus(next)
				setError(null)
			})
			.catch((refreshError: unknown) =>
				setError(refreshError instanceof Error ? refreshError.message : String(refreshError)),
			)
	}, [api])

	useEffect(() => {
		refresh()
		const timer = setInterval(refresh, POLL_MS)
		return () => clearInterval(timer)
	}, [refresh])

	const act = useCallback(
		async (method: string, params?: unknown) => {
			setBusy(true)
			setError(null)
			try {
				await ask(api, method, params, true)
			} catch (actionError) {
				setError(actionError instanceof Error ? actionError.message : String(actionError))
			} finally {
				setBusy(false)
				refresh()
			}
		},
		[api, refresh],
	)

	const code = status?.code
	const git = status?.git

	return (
		<div className="flex flex-col gap-3 px-5 py-3">
			<div>
				<h4 className="text-sm font-semibold m-0">{t("panel.title")}</h4>
				<p className="text-xs text-vscode-descriptionForeground m-0 mt-1">{t("panel.description")}</p>
			</div>

			<div className="flex items-center gap-2">
				<span className="text-sm">{t("panel.codeIndex")}</span>
				<Badge variant="secondary" className={cn("text-[0.7em]", TONE[code?.systemStatus ?? "Standby"])}>
					{code?.systemStatus ?? t("panel.unknown")}
				</Badge>
				{code?.message && <span className="text-xs text-vscode-descriptionForeground">{code.message}</span>}
			</div>
			{code && <Progress status={code} />}

			<div className="flex flex-wrap gap-2">
				<Button
					variant="secondary"
					size="sm"
					disabled={busy || code?.systemStatus === "Indexing"}
					onClick={() => void act("start-indexing")}>
					{t("panel.startIndexing")}
				</Button>
				<Button
					variant="secondary"
					size="sm"
					disabled={busy || code?.systemStatus !== "Indexing"}
					onClick={() => void act("stop-indexing")}>
					{t("panel.stopIndexing")}
				</Button>
				<Button variant="destructive" size="sm" disabled={busy} onClick={() => void act("clear-index")}>
					{t("panel.clearIndex")}
				</Button>
			</div>

			<label className="flex items-center gap-2 text-sm">
				<ToggleSwitch
					checked={code?.workspaceEnabled !== false}
					size="small"
					aria-label={t("panel.workspaceEnabled")}
					onChange={(enabled) => void act("set-workspace-enabled", { enabled })}
				/>
				<span>{t("panel.workspaceEnabled")}</span>
			</label>

			<div className="flex items-center gap-2 border-t border-vscode-panel-border pt-3">
				<span className="text-sm">{t("panel.gitIndex")}</span>
				<Badge variant="secondary" className={cn("text-[0.7em]", TONE[git?.systemStatus ?? "Standby"])}>
					{git?.systemStatus ?? t("panel.unknown")}
				</Badge>
				{git?.message && <span className="text-xs text-vscode-descriptionForeground">{git.message}</span>}
			</div>
			{git && <Progress status={git} />}

			<p className="text-xs text-vscode-descriptionForeground m-0">{t("panel.configureHint")}</p>

			{error && <div className="text-xs text-vscode-errorForeground">{error}</div>}
		</div>
	)
}
