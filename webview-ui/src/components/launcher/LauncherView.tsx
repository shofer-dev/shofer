import { useCallback } from "react"
import { ListChecks, X } from "lucide-react"

import { Mode } from "@shofer/types"

import { vscode } from "@src/utils/vscode"
import { useAppTranslation } from "@src/i18n/TranslationContext"
import { useExtensionState } from "@src/context/ExtensionStateContext"
import { Tab, TabContent, TabHeader } from "../common/Tab"

/**
 * LauncherView — the full-panel "pick what to start" surface shown when the
 * user picks New Task from the native "+" title-bar dropdown. It deliberately
 * replaces the chat surface while active.
 *
 * One card per available mode; clicking starts a fresh task in that mode via
 * the `launchTask` host message. Once a card is clicked the launcher closes
 * (the host switches the webview back to the chat surface, where live status
 * renders).
 */

/** A selectable mode card. */
interface LauncherMode {
	slug: string
	name: string
	description?: string
}

interface LauncherViewProps {
	/** Available modes (built-in + custom) to offer. */
	modes: LauncherMode[]
	/** Called to dismiss the launcher and return to the chat surface. */
	onClose: () => void
}

/** Single clickable launcher card with an icon, title and optional subtitle. */
const LauncherCard = ({
	icon,
	title,
	subtitle,
	onClick,
}: {
	icon: React.ReactNode
	title: string
	subtitle?: string
	onClick: () => void
}) => (
	<button
		type="button"
		onClick={onClick}
		className="flex w-full items-start gap-3 rounded-md border border-vscode-panel-border bg-vscode-editor-background p-4 text-left transition-colors hover:border-vscode-focusBorder hover:bg-vscode-list-hoverBackground focus:outline-none focus-visible:border-vscode-focusBorder">
		<span className="mt-0.5 shrink-0 text-vscode-foreground/80">{icon}</span>
		<span className="flex min-w-0 flex-col">
			<span className="truncate font-medium text-vscode-foreground">{title}</span>
			{subtitle ? (
				<span className="mt-0.5 line-clamp-2 text-sm text-vscode-descriptionForeground">{subtitle}</span>
			) : null}
		</span>
	</button>
)

export const LauncherView = ({ modes, onClose }: LauncherViewProps) => {
	const { t } = useAppTranslation()
	const { setMode } = useExtensionState()

	const handlePickMode = useCallback(
		(slug: string) => {
			// Set the shared mode draft BEFORE leaving the launcher, mirroring the
			// chat ModeSelector's home-screen path. This makes the chat ModeSelector
			// show the chosen mode and lets ChatTextArea's home-screen effect sync
			// the ApiConfigSelector to modeApiConfigs[mode]. Without this the new
			// task (and both selectors) would keep the previous/stale mode + profile.
			setMode(slug as Mode)
			vscode.postMessage({ type: "launchTask", mode: slug })
			onClose()
		},
		[onClose, setMode],
	)

	return (
		<Tab>
			<TabHeader className="flex items-center justify-between">
				<h3 className="m-0 text-base font-medium">{t("launcher:newTask.title")}</h3>
				<button
					type="button"
					onClick={onClose}
					className="flex items-center text-vscode-foreground/80 hover:text-vscode-foreground focus:outline-none"
					aria-label={t("launcher:close")}>
					<X className="size-4" />
				</button>
			</TabHeader>

			<TabContent className="flex flex-col gap-3">
				{modes.length === 0 ? (
					<p className="text-sm text-vscode-descriptionForeground">{t("launcher:newTask.empty")}</p>
				) : (
					modes.map((mode) => (
						<LauncherCard
							key={mode.slug}
							icon={<ListChecks className="size-5" />}
							title={mode.name}
							subtitle={mode.description}
							onClick={() => handlePickMode(mode.slug)}
						/>
					))
				)}
			</TabContent>
		</Tab>
	)
}
