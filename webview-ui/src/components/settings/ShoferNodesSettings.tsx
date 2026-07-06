import { HTMLAttributes, useEffect, useMemo, useState } from "react"
import { Plus, Pencil, Trash2, Plug, Unplug, Power, PowerOff } from "lucide-react"
import { VSCodeTextField } from "@vscode/webview-ui-toolkit/react"

import type {
	LoadBalancerPolicy,
	ShoferNodeConnState,
	ShoferNodeDef,
	ShoferNodeRequest,
	ShoferNodeView,
} from "@shofer/types"

import { useAppTranslation } from "@/i18n/TranslationContext"
import { useExtensionState } from "@src/context/ExtensionStateContext"
import { vscode } from "@src/utils/vscode"
import {
	Button,
	Input,
	ToggleSwitch,
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@src/components/ui"
import { cn } from "@src/lib/utils"

import { SectionHeader } from "./SectionHeader"
import { Section } from "./Section"

/** Tailwind classes for the status dot, by connection state. */
const STATUS_DOT: Record<ShoferNodeConnState, string> = {
	running: "bg-green-500",
	connected: "bg-green-500",
	connecting: "bg-amber-500 animate-pulse",
	reconnecting: "bg-amber-500 animate-pulse",
	disconnected: "bg-gray-400",
	unauthorized: "bg-red-500",
	"version-mismatch": "bg-red-500",
	error: "bg-red-500",
}

interface NodeForm {
	id: string
	label: string
	host: string
	tls: boolean
	token: string
}

function emptyForm(): NodeForm {
	return { id: "", label: "", host: "", tls: false, token: "" }
}

function post(shoferNode: ShoferNodeRequest) {
	vscode.postMessage({ type: "shoferNode", shoferNode })
}

/** The load-balancer policies in menu order, paired with their i18n label key. */
const LOAD_BALANCER_POLICIES: { value: LoadBalancerPolicy; labelKey: string }[] = [
	{ value: "round-robin", labelKey: "settings:shoferNodes.loadBalancer.roundRobin" },
	{ value: "least-load-1m", labelKey: "settings:shoferNodes.loadBalancer.leastLoad1m" },
	{ value: "least-load-5m", labelKey: "settings:shoferNodes.loadBalancer.leastLoad5m" },
	{ value: "least-load-15m", labelKey: "settings:shoferNodes.loadBalancer.leastLoad15m" },
]

export const ShoferNodesSettings = (props: HTMLAttributes<HTMLDivElement>) => {
	const { t } = useAppTranslation()
	const { shoferNodes } = useExtensionState()
	const [form, setForm] = useState<NodeForm | null>(null)

	// Ask the extension for the current registry whenever this panel mounts.
	useEffect(() => {
		post({ action: "list" })
	}, [])

	const nodes = useMemo<ShoferNodeView[]>(() => shoferNodes?.nodes ?? [], [shoferNodes])

	const startAdd = () => setForm(emptyForm())
	const startEdit = (n: ShoferNodeView) =>
		setForm({
			id: n.id,
			label: n.label,
			host: n.host ?? "",
			tls: n.tls ?? false,
			token: "", // never pre-filled; leave blank to keep the existing token
		})

	const save = () => {
		if (!form) return
		const id = form.id || `remote-${Date.now()}`
		const node: ShoferNodeDef = {
			id,
			kind: "remote",
			label: form.label.trim() || form.host || id,
			host: form.host.trim(),
			tls: form.tls,
		}
		post({ action: "upsert", node, token: form.token ? form.token : undefined })
		setForm(null)
	}

	return (
		<div {...props}>
			<SectionHeader>{t("settings:sections.shoferNodes")}</SectionHeader>
			<Section>
				<div className="text-vscode-descriptionForeground text-sm mb-3">
					Run the Shofer agent locally (built-in) or on a remote node. Remote nodes must run the{" "}
					<span className="font-medium">exact same shofer version</span> as this controller. The connection
					token is stored in VS Code SecretStorage and never synced or exported. Connecting a node also makes
					it reconnect automatically on the next start; disabling a node takes it out of the pool entirely.
				</div>

				{/* Load balancing: how new tasks are spread across enabled nodes. */}
				<label className="flex flex-col gap-1 text-sm mb-3">
					<span className="font-medium">{t("settings:shoferNodes.loadBalancer.label")}</span>
					<Select
						value={shoferNodes?.loadBalancer ?? "round-robin"}
						onValueChange={(value) =>
							post({ action: "setLoadBalancer", policy: value as LoadBalancerPolicy })
						}>
						<SelectTrigger className="w-full">
							<SelectValue placeholder={t("settings:common.select")} />
						</SelectTrigger>
						<SelectContent>
							<SelectGroup>
								{LOAD_BALANCER_POLICIES.map(({ value, labelKey }) => (
									<SelectItem key={value} value={value}>
										{t(labelKey)}
									</SelectItem>
								))}
							</SelectGroup>
						</SelectContent>
					</Select>
					<span className="text-xs text-vscode-descriptionForeground">
						{t("settings:shoferNodes.loadBalancer.description")}
					</span>
				</label>

				<div className="flex flex-col gap-2">
					{nodes.map((n) => {
						const connectedish = n.status === "connected" || n.status === "connecting"
						return (
							<div
								key={n.id}
								className={cn(
									"flex flex-col gap-1 rounded-md border border-vscode-dropdown-border px-3 py-2",
									n.disabled && "opacity-50",
								)}>
								{/* Row 1: name + badges (left) · actions (right) */}
								<div className="flex items-center gap-2">
									<span
										className={cn("w-2 h-2 rounded-full flex-shrink-0", STATUS_DOT[n.status])}
										aria-hidden
									/>
									<span className="text-sm font-medium truncate">{n.label}</span>
									{n.isActive && (
										<span className="text-[10px] uppercase tracking-wide text-green-500 border border-green-500/40 rounded px-1">
											active
										</span>
									)}
									{n.disabled && (
										<span className="text-[10px] uppercase tracking-wide text-vscode-descriptionForeground border border-vscode-dropdown-border rounded px-1">
											disabled
										</span>
									)}
									<div className="flex-1" />

									{/* Connect / Disconnect (remote, only while enabled) */}
									{n.kind === "remote" &&
										!n.disabled &&
										(connectedish ? (
											<Button
												variant="ghost"
												size="sm"
												title="Disconnect"
												onClick={() => post({ action: "disconnect", id: n.id })}>
												<Unplug className="size-3.5" />
											</Button>
										) : (
											<Button
												variant="ghost"
												size="sm"
												title="Connect"
												onClick={() => post({ action: "connect", id: n.id })}>
												<Plug className="size-3.5" />
											</Button>
										))}

									{/* Administrative enable / disable — applies to every node */}
									<Button
										variant="ghost"
										size="sm"
										title={n.disabled ? "Enable (return to pool)" : "Disable (remove from pool)"}
										onClick={() =>
											post({ action: "setDisabled", id: n.id, disabled: !n.disabled })
										}>
										{n.disabled ? (
											<Power className="size-3.5" />
										) : (
											<PowerOff className="size-3.5" />
										)}
									</Button>

									{/* Edit / Remove — remote only */}
									{n.kind === "remote" && (
										<>
											<Button variant="ghost" size="sm" title="Edit" onClick={() => startEdit(n)}>
												<Pencil className="size-3.5" />
											</Button>
											<Button
												variant="ghost"
												size="sm"
												title="Remove"
												onClick={() => post({ action: "remove", id: n.id })}>
												<Trash2 className="size-3.5" />
											</Button>
										</>
									)}
								</div>

								{/* Row 2: full-width status detail (always visible — never hidden by buttons) */}
								<div className="text-xs text-vscode-descriptionForeground break-words pl-4">
									{n.kind === "local"
										? [
												n.disabled ? "disabled" : "running locally",
												n.agentVersion ? `v${n.agentVersion}` : null,
											]
												.filter(Boolean)
												.join(" · ")
										: [
												n.host,
												n.disabled ? "disabled" : n.status,
												n.latencyMs != null ? `${n.latencyMs}ms` : null,
												n.agentVersion ? `v${n.agentVersion}` : null,
												n.error ? `— ${n.error}` : null,
											]
												.filter(Boolean)
												.join(" · ")}
								</div>
							</div>
						)
					})}
				</div>

				{/* Add / edit form */}
				{form ? (
					<div className="mt-4 rounded-md border border-vscode-dropdown-border p-3 flex flex-col gap-3">
						<div className="text-sm font-medium">{form.id ? "Edit node" : "Add remote node"}</div>
						<label className="flex flex-col gap-1 text-sm">
							<span className="font-medium">Label</span>
							<Input
								value={form.label}
								placeholder="e.g. build-box"
								onChange={(e) => setForm({ ...form, label: e.target.value })}
							/>
						</label>
						<label className="flex flex-col gap-1 text-sm">
							<span className="font-medium">Host (IP:port or DNS)</span>
							<Input
								value={form.host}
								placeholder="e.g. 127.0.0.1:30099"
								onChange={(e) => setForm({ ...form, host: e.target.value })}
							/>
						</label>
						<VSCodeTextField
							type="password"
							value={form.token}
							placeholder={
								form.id ? "leave blank to keep current token" : "bearer token (SHOFER_NODE_TOKEN)"
							}
							onInput={(e: any) => setForm({ ...form, token: e.target.value })}
							className="w-full">
							<label className="block font-medium mb-1">Auth token</label>
						</VSCodeTextField>
						<div className="flex items-center gap-2 text-sm">
							<ToggleSwitch
								checked={form.tls}
								onChange={() => setForm({ ...form, tls: !form.tls })}
								size="small"
								aria-label="Use TLS (https)"
							/>
							<span>Use TLS (https)</span>
						</div>
						<div className="flex gap-2 justify-end">
							<Button variant="secondary" size="sm" onClick={() => setForm(null)}>
								Cancel
							</Button>
							<Button variant="primary" size="sm" disabled={!form.host.trim()} onClick={save}>
								Save
							</Button>
						</div>
					</div>
				) : (
					<Button variant="secondary" size="sm" className="mt-4 self-start" onClick={startAdd}>
						<Plus className="size-3.5 mr-1" /> Add remote node
					</Button>
				)}
			</Section>
		</div>
	)
}
