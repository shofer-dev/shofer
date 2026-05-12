import React, { useState } from "react"
import { Trans } from "react-i18next"
import { VSCodeLink } from "@vscode/webview-ui-toolkit/react"

import type { McpServer } from "@shofer/types"

import { vscode } from "@src/utils/vscode"
import { useExtensionState } from "@src/context/ExtensionStateContext"
import { useAppTranslation } from "@src/i18n/TranslationContext"
import { useTooManyTools } from "@src/hooks/useTooManyTools"
import {
	Button,
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
	DialogDescription,
	DialogFooter,
	ToggleSwitch,
	StandardTooltip,
} from "@src/components/ui"
import { buildDocLink } from "@src/utils/docLinks"
import { Section } from "@src/components/settings/Section"
import { SectionHeader } from "@src/components/settings/SectionHeader"

import McpToolRow from "./McpToolRow"
import McpResourceRow from "./McpResourceRow"
import McpEnabledToggle from "./McpEnabledToggle"
import { McpErrorRow } from "./McpErrorRow"

/**
 * A collapsible tree group used to display tools/resources/logs under each MCP server node.
 */
const TreeGroup = ({
	label,
	icon,
	count,
	defaultOpen = false,
	children,
}: {
	label: string
	icon: string
	count: number
	defaultOpen?: boolean
	children: React.ReactNode
}) => {
	const [isOpen, setIsOpen] = useState(defaultOpen)

	return (
		<div>
			<div
				style={{
					display: "flex",
					alignItems: "center",
					padding: "6px 12px",
					cursor: "pointer",
					userSelect: "none",
					borderTop: "1px solid var(--vscode-panel-border)",
				}}
				onClick={() => setIsOpen(!isOpen)}>
				<span
					className={`codicon codicon-chevron-${isOpen ? "down" : "right"}`}
					style={{ marginRight: "6px", fontSize: "11px", opacity: 0.7, flexShrink: 0 }}
				/>
				<span className={`codicon ${icon}`} style={{ marginRight: "6px", opacity: 0.8, flexShrink: 0 }} />
				<span style={{ fontWeight: 500 }}>{label}</span>
				<span
					style={{
						marginLeft: "6px",
						opacity: 0.6,
						fontSize: "11px",
						background: "var(--vscode-badge-background)",
						color: "var(--vscode-badge-foreground)",
						padding: "1px 5px",
						borderRadius: "8px",
					}}>
					{count}
				</span>
			</div>
			{isOpen && (
				<div
					style={{
						marginLeft: "24px",
						paddingRight: "8px",
						borderLeft: "1px solid var(--vscode-panel-border)",
						marginBottom: "4px",
					}}>
					{children}
				</div>
			)}
		</div>
	)
}

const McpView = () => {
	const { mcpServers: servers, mcpEnabled } = useExtensionState()

	const { t } = useAppTranslation()
	const { isOverThreshold, title, message } = useTooManyTools()

	return (
		<div>
			<SectionHeader>{t("mcp:title")}</SectionHeader>

			<Section>
				<div
					style={{
						color: "var(--vscode-foreground)",
						fontSize: "13px",
						marginBottom: "10px",
						marginTop: "5px",
					}}>
					<Trans i18nKey="mcp:description">
						<VSCodeLink
							href={buildDocLink("features/mcp/using-mcp-in-shofer", "mcp_settings")}
							style={{ display: "inline" }}>
							Learn More
						</VSCodeLink>
					</Trans>
				</div>

				<McpEnabledToggle />

				{mcpEnabled && (
					<>
						{/* Too Many Tools Warning */}
						{isOverThreshold && (
							<div style={{ marginBottom: 15 }}>
								<div
									style={{
										display: "flex",
										alignItems: "center",
										gap: "6px",
										fontWeight: "500",
										color: "var(--vscode-editorWarning-foreground)",
										marginBottom: "5px",
									}}>
									<span className="codicon codicon-warning" />
									{title}
								</div>
								<div
									style={{
										fontSize: "12px",
										color: "var(--vscode-descriptionForeground)",
									}}>
									{message}
								</div>
							</div>
						)}

						{/* Server List */}
						{servers.length > 0 && (
							<div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
								{servers.map((server) => (
									<ServerRow key={`${server.name}-${server.source || "global"}`} server={server} />
								))}
							</div>
						)}

						{/* Edit Settings Buttons */}
						<div
							style={{
								marginTop: "10px",
								width: "100%",
								display: "grid",
								gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
								gap: "10px",
							}}>
							<Button
								variant="secondary"
								style={{ width: "100%" }}
								onClick={() => {
									vscode.postMessage({ type: "openMcpSettings" })
								}}>
								<span className="codicon codicon-edit" style={{ marginRight: "6px" }}></span>
								{t("mcp:editGlobalMCP")}
							</Button>
							<Button
								variant="secondary"
								style={{ width: "100%" }}
								onClick={() => {
									vscode.postMessage({ type: "openProjectMcpSettings" })
								}}>
								<span className="codicon codicon-edit" style={{ marginRight: "6px" }}></span>
								{t("mcp:editProjectMCP")}
							</Button>
							<Button
								variant="secondary"
								style={{ width: "100%" }}
								onClick={() => {
									vscode.postMessage({ type: "refreshAllMcpServers" })
								}}>
								<span className="codicon codicon-refresh" style={{ marginRight: "6px" }}></span>
								{t("mcp:refreshMCP")}
							</Button>
							<StandardTooltip content={t("mcp:marketplace")}>
								<Button
									variant="secondary"
									style={{ width: "100%" }}
									onClick={() => {
										window.postMessage(
											{
												type: "action",
												action: "marketplaceButtonClicked",
												values: { marketplaceTab: "mcp" },
											},
											"*",
										)
									}}>
									<span className="codicon codicon-extensions" style={{ marginRight: "6px" }}></span>
									{t("mcp:marketplace")}
								</Button>
							</StandardTooltip>
						</div>
						<div
							style={{
								marginTop: "15px",
								fontSize: "12px",
								color: "var(--vscode-descriptionForeground)",
							}}>
							<VSCodeLink
								href={buildDocLink(
									"features/mcp/using-mcp-in-shofer#editing-mcp-settings-files",
									"mcp_edit_settings",
								)}
								style={{ display: "inline" }}>
								{t("mcp:learnMoreEditingSettings")}
							</VSCodeLink>
						</div>
					</>
				)}
			</Section>
		</div>
	)
}

const ServerRow = ({ server }: { server: McpServer }) => {
	const { t } = useAppTranslation()
	const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
	const [timeoutValue, setTimeoutValue] = useState(() => {
		const configTimeout = JSON.parse(server.config)?.timeout
		return configTimeout ?? 60 // Default 1 minute (60 seconds)
	})

	const isConnected = server.status === "connected" && !server.disabled

	const timeoutOptions = [
		{ value: 15, label: t("mcp:networkTimeout.options.15seconds") },
		{ value: 30, label: t("mcp:networkTimeout.options.30seconds") },
		{ value: 60, label: t("mcp:networkTimeout.options.1minute") },
		{ value: 300, label: t("mcp:networkTimeout.options.5minutes") },
		{ value: 600, label: t("mcp:networkTimeout.options.10minutes") },
		{ value: 900, label: t("mcp:networkTimeout.options.15minutes") },
		{ value: 1800, label: t("mcp:networkTimeout.options.30minutes") },
		{ value: 3600, label: t("mcp:networkTimeout.options.60minutes") },
	]

	const getStatusColor = () => {
		// Disabled servers should always show grey regardless of connection status
		if (server.disabled) {
			return "var(--vscode-descriptionForeground)"
		}

		switch (server.status) {
			case "connected":
				return "var(--vscode-testing-iconPassed)"
			case "connecting":
				return "var(--vscode-charts-yellow)"
			case "disconnected":
				return "var(--vscode-testing-iconFailed)"
		}
	}

	const handleRestart = () => {
		vscode.postMessage({
			type: "restartMcpServer",
			text: server.name,
			source: server.source || "global",
		})
	}

	const handleTimeoutChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
		const seconds = parseInt(event.target.value)
		setTimeoutValue(seconds)
		vscode.postMessage({
			type: "updateMcpTimeout",
			serverName: server.name,
			source: server.source || "global",
			timeout: seconds,
		})
	}

	const handleDelete = () => {
		vscode.postMessage({
			type: "deleteMcpServer",
			serverName: server.name,
			source: server.source || "global",
		})
		setShowDeleteConfirm(false)
	}

	return (
		<div style={{ marginBottom: "10px" }}>
			{/* Server header — always visible, not clickable */}
			<div
				style={{
					display: "flex",
					alignItems: "center",
					padding: "8px",
					background: "var(--vscode-textCodeBlock-background)",
					borderRadius: "4px 4px 0 0",
					opacity: server.disabled ? 0.6 : 1,
				}}>
				<span style={{ flex: 1 }}>
					{server.name}
					{server.source && (
						<span
							style={{
								marginLeft: "8px",
								padding: "1px 6px",
								fontSize: "11px",
								borderRadius: "4px",
								background: "var(--vscode-badge-background)",
								color: "var(--vscode-badge-foreground)",
							}}>
							{server.source}
						</span>
					)}
				</span>
				<div
					style={{ display: "flex", alignItems: "center", marginRight: "8px" }}
					onClick={(e) => e.stopPropagation()}>
					<Button
						variant="ghost"
						size="icon"
						onClick={() => setShowDeleteConfirm(true)}
						style={{ marginRight: "8px" }}>
						<span className="codicon codicon-trash" style={{ fontSize: "14px" }}></span>
					</Button>
					<Button
						variant="ghost"
						size="icon"
						onClick={handleRestart}
						disabled={server.status === "connecting"}
						style={{ marginRight: "8px" }}>
						<span className="codicon codicon-refresh" style={{ fontSize: "14px" }}></span>
					</Button>
				</div>
				<div
					style={{
						width: "8px",
						height: "8px",
						borderRadius: "50%",
						background: getStatusColor(),
						marginLeft: "8px",
					}}
				/>
				<div style={{ marginLeft: "8px" }}>
					<ToggleSwitch
						checked={!server.disabled}
						onChange={() => {
							vscode.postMessage({
								type: "toggleMcpServer",
								serverName: server.name,
								source: server.source || "global",
								disabled: !server.disabled,
							})
						}}
						size="medium"
						aria-label={`Toggle ${server.name} server`}
					/>
				</div>
			</div>

			{/* Tree content — always shown below header */}
			<div
				style={{
					background: "var(--vscode-textCodeBlock-background)",
					padding: "0 0 8px 0",
					fontSize: "13px",
					borderRadius: "0 0 4px 4px",
					opacity: server.disabled ? 0.5 : 1,
				}}>
				{/* Status banner for non-connected servers */}
				{!server.disabled && !isConnected && (
					<div
						style={{
							padding: "8px 12px",
							borderBottom: "1px solid var(--vscode-panel-border)",
						}}>
						{server.status === "connecting" ? (
							<div
								style={{
									display: "flex",
									alignItems: "center",
									gap: "6px",
									color: "var(--vscode-charts-yellow)",
									fontSize: "12px",
								}}>
								<span className="codicon codicon-loading codicon-modifier-spin" />
								{t("mcp:serverStatus.retrying")}
							</div>
						) : (
							<>
								{server.error && (
									<div
										style={{
											color: "var(--vscode-testing-iconFailed)",
											fontSize: "12px",
											marginBottom: "8px",
											overflowWrap: "break-word",
											wordBreak: "break-word",
										}}>
										{server.error.split("\n").map((line, index) => (
											<React.Fragment key={index}>
												{index > 0 && <br />}
												{line}
											</React.Fragment>
										))}
									</div>
								)}
								<Button variant="secondary" onClick={handleRestart} style={{ width: "100%" }}>
									{t("mcp:serverStatus.retryConnection")}
								</Button>
							</>
						)}
					</div>
				)}

				{/* Instructions inline banner — shown only when present */}
				{server.instructions && (
					<div
						style={{
							padding: "8px 12px",
							fontSize: "12px",
							borderBottom: "1px solid var(--vscode-panel-border)",
						}}>
						<div style={{ fontWeight: 500, marginBottom: "4px", opacity: 0.8 }}>
							{t("mcp:instructions")}
						</div>
						<div className="opacity-70 whitespace-pre-wrap break-words">{server.instructions}</div>
					</div>
				)}

				{/* Tools tree group — expanded by default */}
				<TreeGroup
					label={t("mcp:tabs.tools")}
					icon="codicon-symbol-method"
					count={server.tools?.length ?? 0}
					defaultOpen={true}>
					{server.tools && server.tools.length > 0 ? (
						server.tools.map((tool) => (
							<McpToolRow key={`${tool.name}-${server.name}-${server.source || "global"}`} tool={tool} />
						))
					) : (
						<div
							style={{
								padding: "4px 0",
								color: "var(--vscode-descriptionForeground)",
								fontSize: "12px",
							}}>
							{t("mcp:emptyState.noTools")}
						</div>
					)}
				</TreeGroup>

				{/* Resources tree group — collapsed by default */}
				<TreeGroup
					label={t("mcp:tabs.resources")}
					icon="codicon-symbol-file"
					count={[...(server.resourceTemplates || []), ...(server.resources || [])].length}
					defaultOpen={false}>
					{(server.resources && server.resources.length > 0) ||
					(server.resourceTemplates && server.resourceTemplates.length > 0) ? (
						[...(server.resourceTemplates || []), ...(server.resources || [])].map((item) => (
							<McpResourceRow key={"uriTemplate" in item ? item.uriTemplate : item.uri} item={item} />
						))
					) : (
						<div
							style={{
								padding: "4px 0",
								color: "var(--vscode-descriptionForeground)",
								fontSize: "12px",
							}}>
							{t("mcp:emptyState.noResources")}
						</div>
					)}
				</TreeGroup>

				{/* Logs tree group — only rendered when there is error history */}
				{server.errorHistory && server.errorHistory.length > 0 && (
					<TreeGroup
						label={t("mcp:tabs.logs")}
						icon="codicon-output"
						count={server.errorHistory.length}
						defaultOpen={false}>
						{[...server.errorHistory]
							.sort((a, b) => b.timestamp - a.timestamp)
							.map((error, index) => (
								<McpErrorRow key={`${error.timestamp}-${index}`} error={error} />
							))}
					</TreeGroup>
				)}

				{/* Network Timeout */}
				<div style={{ padding: "8px 12px 0 12px" }}>
					<div
						style={{
							display: "flex",
							alignItems: "center",
							gap: "10px",
							marginBottom: "6px",
							borderTop: "1px solid var(--vscode-panel-border)",
							paddingTop: "8px",
						}}>
						<span>{t("mcp:networkTimeout.label")}</span>
						<select
							value={timeoutValue}
							onChange={handleTimeoutChange}
							style={{
								flex: 1,
								padding: "4px",
								background: "var(--vscode-dropdown-background)",
								color: "var(--vscode-dropdown-foreground)",
								border: "1px solid var(--vscode-dropdown-border)",
								borderRadius: "2px",
								outline: "none",
								cursor: "pointer",
							}}>
							{timeoutOptions.map((option) => (
								<option key={option.value} value={option.value}>
									{option.label}
								</option>
							))}
						</select>
					</div>
					<span
						style={{
							fontSize: "12px",
							color: "var(--vscode-descriptionForeground)",
							display: "block",
						}}>
						{t("mcp:networkTimeout.description")}
					</span>
				</div>
			</div>

			{/* Delete Confirmation Dialog */}
			<Dialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>{t("mcp:deleteDialog.title")}</DialogTitle>
						<DialogDescription>
							{t("mcp:deleteDialog.description", { serverName: server.name })}
						</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button variant="secondary" onClick={() => setShowDeleteConfirm(false)}>
							{t("mcp:deleteDialog.cancel")}
						</Button>
						<Button variant="primary" onClick={handleDelete}>
							{t("mcp:deleteDialog.delete")}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	)
}

export default McpView
