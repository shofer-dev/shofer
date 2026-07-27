/**
 * The indexing status chip in the chat input (`chat-input-toolbar`).
 *
 * One glyph and a tooltip: whether the index is ready, building, or in trouble. It exists
 * because a semantic search that quietly returns nothing looks like a bad model rather
 * than an index that never finished — the chip is where that distinction is visible while
 * the user is typing.
 *
 * Hidden entirely when indexing is off, so a workspace that does not use it carries no
 * chrome.
 *
 * BUILD: `ui/status.js` (esbuild ESM; React and `@shofer/plugin-ui` external).
 */

import { useCallback, useEffect, useState } from "react"

import { StandardTooltip, cn, usePluginTranslation } from "@shofer/plugin-ui"

interface PluginUIApi {
	postMessage(message: unknown): void
	onMessage(listener: (message: unknown) => void): () => void
	request(method: string, params?: unknown, opts?: { mutates?: boolean }): Promise<unknown>
	readonly context: { readonly region: string; readonly pluginName: string }
}

interface IndexStatus {
	systemStatus: string
	message?: string
	processedItems?: number
	totalItems?: number
}

/** Codicon + colour per state; the tooltip carries the detail. */
const GLYPH: Record<string, { icon: string; tone: string }> = {
	Indexed: { icon: "codicon-database", tone: "text-vscode-charts-green" },
	Indexing: { icon: "codicon-sync codicon-modifier-spin", tone: "text-vscode-charts-blue" },
	Error: { icon: "codicon-error", tone: "text-vscode-errorForeground" },
	Standby: { icon: "codicon-database", tone: "text-vscode-descriptionForeground" },
}

const POLL_MS = 3000

export default function IndexingStatusChip({ api }: { api: PluginUIApi }): React.JSX.Element | null {
	const t = usePluginTranslation()
	const [status, setStatus] = useState<IndexStatus | null>(null)

	const refresh = useCallback(() => {
		void api
			.request("local:status")
			.then((reply) => setStatus((reply as { code?: IndexStatus })?.code ?? null))
			.catch(() => setStatus(null))
	}, [api])

	useEffect(() => {
		refresh()
		const timer = setInterval(refresh, POLL_MS)
		return () => clearInterval(timer)
	}, [refresh])

	if (!status || status.systemStatus === "Disabled") return null

	const glyph = GLYPH[status.systemStatus] ?? GLYPH.Standby!
	const detail =
		status.systemStatus === "Indexing" && status.totalItems
			? t("chip.indexing", { processed: status.processedItems ?? 0, total: status.totalItems })
			: (status.message ?? t(`chip.${status.systemStatus.toLowerCase()}`))

	return (
		<StandardTooltip content={detail}>
			<span
				className={cn("inline-flex items-center px-1 py-1 text-xs opacity-90", glyph.tone)}
				aria-label={t("chip.aria", { state: status.systemStatus })}>
				<span className={cn("codicon", glyph.icon)} />
			</span>
		</StandardTooltip>
	)
}
