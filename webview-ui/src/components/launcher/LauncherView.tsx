import { useCallback, useEffect, useMemo, useState } from "react"
import { ListChecks, Rocket, Beaker, Code, Cog, Search, Shield, Star, X, type LucideIcon } from "lucide-react"

import { vscode } from "@src/utils/vscode"
import { useAppTranslation } from "@src/i18n/TranslationContext"
import { Tab, TabContent, TabHeader } from "../common/Tab"

/**
 * LauncherView — the full-panel "pick what to start" surface shown when the
 * user picks an item from the native "+" title-bar dropdown (New Task / New
 * Workflow). It deliberately replaces the chat surface while active.
 *
 * The dropdown chooses the stage up-front, so the launcher opens directly at:
 *
 *   stage "task"     → one card per available mode (clicking starts a fresh
 *                      task in that mode via the `launchTask` host message)
 *   stage "workflow" → one card per discovered .slang workflow (clicking
 *                      starts it via the existing `createWorkflow` host message)
 *
 * Per-flow input fields are intentionally deferred; selecting a workflow starts
 * it immediately. Once a card is clicked the launcher closes (the host switches
 * the webview back to the chat surface, where live status renders).
 */

/**
 * A discovered .slang workflow as reported by the host `workflowsList` message.
 * Mirrors the `LauncherWorkflow` type in @shofer/types.
 */
interface LauncherWorkflow {
	/** Machine identifier — used for `createWorkflow` IPC. */
	name: string
	/** Human-readable title for the card. Falls back to `name` if unset. */
	title: string
	/** Markdown description. Rendered as secondary text in the card. */
	description?: string
	/** Icon key (e.g. "rocket", "gear", "search", "code"). Mapped to lucide icon. */
	icon?: string
	/** Agent names extracted from `AgentDecl` nodes in the flow body. */
	agents: string[]
	/** Input parameters with optional descriptions. */
	params: Array<{ name: string; type: string; description?: string }>
}

/** A selectable mode card in the "New Task" stage. */
interface LauncherMode {
	slug: string
	name: string
	description?: string
}

interface LauncherViewProps {
	/** Available modes (built-in + custom) to offer in the New Task stage. */
	modes: LauncherMode[]
	/**
	 * Which stage to open at. Chosen by the native New Task / New Workflow
	 * title-bar dropdown — "task" shows the mode cards, "workflow" shows the
	 * discovered .slang workflow cards.
	 */
	initialStage: Stage
	/** Called to dismiss the launcher and return to the chat surface. */
	onClose: () => void
}

type Stage = "task" | "workflow"

/** Map of .slang icon keys → lucide-react components. */
const ICON_MAP: Record<string, LucideIcon> = {
	rocket: Rocket,
	beaker: Beaker,
	code: Code,
	cog: Cog,
	gear: Cog,
	search: Search,
	shield: Shield,
	star: Star,
}

/** Single clickable launcher card with an icon, title and optional subtitle/body. */
const LauncherCard = ({
	icon,
	title,
	subtitle,
	body,
	onClick,
}: {
	icon: React.ReactNode
	title: string
	subtitle?: string
	body?: string
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
			{body ? (
				<span className="mt-1 line-clamp-3 text-xs text-vscode-descriptionForeground whitespace-pre-line">
					{body}
				</span>
			) : null}
		</span>
	</button>
)

export const LauncherView = ({ modes, initialStage, onClose }: LauncherViewProps) => {
	const { t } = useAppTranslation()
	const [workflows, setWorkflows] = useState<LauncherWorkflow[]>([])
	const [workflowsLoaded, setWorkflowsLoaded] = useState(false)

	// Ask the host for the discovered workflows once when the launcher mounts.
	// Results arrive asynchronously via the `workflowsList` window message.
	useEffect(() => {
		vscode.postMessage({ type: "listWorkflows" })
		const onMessage = (e: MessageEvent) => {
			if (e.data?.type === "workflowsList") {
				setWorkflows(e.data.workflows || [])
				setWorkflowsLoaded(true)
			}
		}
		window.addEventListener("message", onMessage)
		return () => window.removeEventListener("message", onMessage)
	}, [])

	const handlePickMode = useCallback(
		(slug: string) => {
			vscode.postMessage({ type: "launchTask", mode: slug })
			onClose()
		},
		[onClose],
	)

	const handlePickWorkflow = useCallback(
		(name: string) => {
			vscode.postMessage({ type: "createWorkflow", flowName: name })
			onClose()
		},
		[onClose],
	)

	const title = useMemo(() => {
		switch (initialStage) {
			case "task":
				return t("launcher:newTask.title")
			case "workflow":
				return t("launcher:newWorkflow.title")
		}
	}, [initialStage, t])

	return (
		<Tab>
			<TabHeader className="flex items-center justify-between">
				<h3 className="m-0 text-base font-medium">{title}</h3>
				<button
					type="button"
					onClick={onClose}
					className="flex items-center text-vscode-foreground/80 hover:text-vscode-foreground focus:outline-none"
					aria-label={t("launcher:close")}>
					<X className="size-4" />
				</button>
			</TabHeader>

			<TabContent className="flex flex-col gap-3">
				{initialStage === "task" ? (
					modes.length === 0 ? (
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
					)
				) : null}

				{initialStage === "workflow" ? (
					!workflowsLoaded ? (
						<p className="text-sm text-vscode-descriptionForeground">{t("launcher:newWorkflow.loading")}</p>
					) : workflows.length === 0 ? (
						<p className="text-sm text-vscode-descriptionForeground">{t("launcher:newWorkflow.empty")}</p>
					) : (
						workflows.map((flow) => {
							// Resolve icon: lookup in map, fall back to Rocket
							const IconComponent = flow.icon ? (ICON_MAP[flow.icon] ?? Rocket) : Rocket

							// Build subtitle: flow name (muted) + agent count badge
							const agentLabel =
								flow.agents.length === 0
									? t("launcher:newWorkflow.noAgents")
									: flow.agents.length === 1
										? t("launcher:newWorkflow.agentsCount", { count: 1 })
										: t("launcher:newWorkflow.agentsCount_plural", { count: flow.agents.length })

							// Build params subtitle: list param names/types with descriptions as tooltip-style text
							const paramsSubtitle =
								flow.params.length > 0
									? flow.params
											.map((p) => {
												const desc = p.description ? ` — ${p.description}` : ""
												return `${p.name}: ${p.type}${desc}`
											})
											.join(", ")
									: undefined

							// Number of params label
							const paramsLabel =
								flow.params.length > 0
									? flow.params.length === 1
										? t("launcher:newWorkflow.paramsCount", { count: 1 })
										: t("launcher:newWorkflow.paramsCount_plural", { count: flow.params.length })
									: undefined

							// Subtitle line: name (muted) | N agents | N params
							const subtitleParts = [flow.name, agentLabel]
							if (paramsLabel) {
								subtitleParts.push(paramsLabel)
							}
							const cardSubtitle = subtitleParts.join(" • ")

							// Body: show the description AND the param list when both exist.
							// `LauncherCard` renders body with `whitespace-pre-line`, so a
							// newline separates them. Previously `paramsSubtitle` shadowed
							// `flow.description` for any workflow that declared params, hiding
							// the description entirely — contrary to the launcher metadata
							// acceptance criteria.
							const cardBody = [flow.description, paramsSubtitle].filter(Boolean).join("\n") || undefined

							return (
								<LauncherCard
									key={flow.name}
									icon={<IconComponent className="size-5" />}
									title={flow.title}
									subtitle={cardSubtitle}
									body={cardBody}
									onClick={() => handlePickWorkflow(flow.name)}
								/>
							)
						})
					)
				) : null}
			</TabContent>
		</Tab>
	)
}
