import { useMemo } from "react"
import { Server } from "lucide-react"

import type { ShoferWorkerConnState, ShoferWorkerView } from "@shofer/types"

import { useExtensionState } from "@src/context/ExtensionStateContext"
import { vscode } from "@src/utils/vscode"
import { Button, Popover, PopoverTrigger, PopoverContent } from "@src/components/ui"
import { cn } from "@src/lib/utils"

const STATUS_DOT: Record<ShoferWorkerConnState, string> = {
	running: "bg-green-500",
	connected: "bg-green-500",
	connecting: "bg-amber-500 animate-pulse",
	reconnecting: "bg-amber-500 animate-pulse",
	disconnected: "bg-gray-400",
	unauthorized: "bg-red-500",
	"version-mismatch": "bg-red-500",
	error: "bg-red-500",
}

const STATUS_LABEL: Record<ShoferWorkerConnState, string> = {
	running: "running (local)",
	connected: "connected",
	connecting: "connecting…",
	reconnecting: "reconnecting…",
	disconnected: "disconnected",
	unauthorized: "unauthorized",
	"version-mismatch": "version mismatch",
	error: "error",
}

function post(action: "connect" | "disconnect", id: string) {
	vscode.postMessage({ type: "shoferWorker", shoferWorker: { action, id } })
}

/**
 * Compact "Workers" button + popover surfacing the live state of every Shofer
 * Worker (Local first, then remotes). Sits in the chat header next to the task
 * title. See `docs/remote-agents.md` §4b.
 */
export const WorkerStatus = () => {
	const { shoferWorkers } = useExtensionState()
	const workers = useMemo<ShoferWorkerView[]>(() => shoferWorkers?.workers ?? [], [shoferWorkers])

	// Only surface the control once there's something beyond the built-in Local
	// worker — keeps the header clean for users who never register a remote.
	const hasRemotes = workers.some((n) => n.kind === "remote")
	const aggregate = useMemo(() => {
		// Count every worker that's up — Local (running, unless disabled) plus any
		// connected remotes — so a Local-only-plus-one-remote setup reads "2".
		const count = workers.filter((n) => !n.disabled && (n.status === "running" || n.status === "connected")).length

		// Health dot considers every non-disabled worker (Local + remotes):
		//   red    — all workers down or disabled (nothing is up)
		//   yellow — at least one non-disabled worker in a failed/error state
		//   green  — all non-disabled workers are up
		const active = workers.filter((n) => !n.disabled)
		const up = active.filter((n) => n.status === "running" || n.status === "connected")
		const failed = active.filter(
			(n) => n.status === "error" || n.status === "unauthorized" || n.status === "version-mismatch",
		)
		const dot = up.length === 0 ? "bg-red-500" : failed.length > 0 ? "bg-yellow-500" : "bg-green-500"
		return { count, dot }
	}, [workers])

	if (!hasRemotes) return null

	return (
		<Popover>
			<PopoverTrigger asChild>
				<Button
					variant="ghost"
					size="sm"
					title="Shofer Workers"
					aria-label="Shofer Workers"
					className={cn(
						"relative h-5 w-5 p-0",
						"text-vscode-foreground opacity-85",
						"hover:opacity-100 hover:bg-[rgba(255,255,255,0.03)]",
						"focus:outline-none focus-visible:ring-1 focus-visible:ring-vscode-focusBorder",
					)}>
					<Server className="w-4 h-4" />
					{/* Health dot, top-right — same position/size as the neighbouring badges. */}
					<span
						className={cn("absolute top-0 right-0 w-1.5 h-1.5 rounded-full", aggregate.dot)}
						aria-hidden
					/>
					{/* Worker count overlaid bottom-right to save horizontal space. */}
					<span className="absolute -bottom-1 -right-1 min-w-[12px] rounded-full bg-vscode-editor-background px-0.5 text-center text-[9px] font-semibold leading-[12px]">
						{aggregate.count}
					</span>
				</Button>
			</PopoverTrigger>
			<PopoverContent align="end" className="w-72 p-0">
				<div className="px-3 py-2 border-b border-vscode-dropdown-border text-xs font-medium uppercase tracking-wide text-vscode-descriptionForeground">
					Shofer Workers
				</div>
				<div className="max-h-80 overflow-y-auto">
					{workers.map((n) => (
						<div key={n.id} className={cn("flex items-center gap-2 px-3 py-2", n.disabled && "opacity-50")}>
							<span
								className={cn("w-2 h-2 rounded-full flex-shrink-0", STATUS_DOT[n.status])}
								aria-hidden
							/>
							<div className="flex flex-col min-w-0 flex-1">
								<div className="flex items-center gap-1.5">
									<span className="text-sm font-medium truncate">{n.label}</span>
									{n.isActive && (
										<span className="text-[10px] uppercase tracking-wide text-green-500">
											active
										</span>
									)}
									{n.disabled && (
										<span className="text-[10px] uppercase tracking-wide text-vscode-descriptionForeground">
											disabled
										</span>
									)}
								</div>
								<div className="text-xs text-vscode-descriptionForeground truncate">
									{[
										n.disabled ? "disabled" : STATUS_LABEL[n.status],
										n.latencyMs != null ? `${n.latencyMs}ms` : null,
										n.agentVersion ? `v${n.agentVersion}` : null,
									]
										.filter(Boolean)
										.join(" · ")}
									{n.error ? ` — ${n.error}` : ""}
								</div>
							</div>
							{n.kind === "remote" &&
								!n.disabled &&
								(n.status === "connected" || n.status === "connecting" ? (
									<Button variant="ghost" size="sm" onClick={() => post("disconnect", n.id)}>
										Disconnect
									</Button>
								) : (
									<Button variant="ghost" size="sm" onClick={() => post("connect", n.id)}>
										Connect
									</Button>
								))}
						</div>
					))}
				</div>
			</PopoverContent>
		</Popover>
	)
}
