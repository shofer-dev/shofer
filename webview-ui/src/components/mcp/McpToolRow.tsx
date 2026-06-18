import { type McpTool, type ToolGroup, toolGroups } from "@shofer/types"

import { vscode } from "@src/utils/vscode"
import { useAppTranslation } from "@src/i18n/TranslationContext"
import { StandardTooltip, ToggleSwitch } from "@/components/ui"

/**
 * Renders an individual MCP tool row.
 *
 * In addition to showing the tool name/description/parameters, this row lets the
 * user control, per tool (only in the Settings → MCP Servers view, where
 * `serverName`/`serverSource` are supplied):
 *   - **Visibility** — whether the tool is exposed to the model (`disabledTools`).
 *   - **Group** — the auto-approval category override (`toolGroups[toolName]`).
 *
 * Both write back to the server's `mcp.json` entry via the extension. When the
 * server context is omitted (e.g. the chat execution view) the row is purely
 * presentational.
 */
type McpToolRowProps = {
	tool: McpTool
	serverName?: string
	serverSource?: "global" | "project"
}

const McpToolRow = ({ tool, serverName, serverSource }: McpToolRowProps) => {
	const { t } = useAppTranslation()
	const isToolEnabled = tool.enabledForPrompt ?? true
	const currentGroup = tool.group ?? "uncategorized"
	const editable = Boolean(serverName && serverSource)

	const handleToggleEnabled = () => {
		vscode.postMessage({
			type: "toggleToolEnabledForPrompt",
			serverName,
			source: serverSource,
			toolName: tool.name,
			isEnabled: !isToolEnabled,
		})
	}

	const handleGroupChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
		const value = event.target.value
		vscode.postMessage({
			type: "setMcpToolGroup",
			serverName,
			source: serverSource,
			toolName: tool.name,
			// "default" clears the per-tool override (falls back to server-declared).
			toolGroup: value === "default" ? null : (value as ToolGroup),
		})
	}

	return (
		<div key={tool.name} className="py-2 border-b border-vscode-panel-border last:border-b-0">
			<div
				data-testid="tool-row-container"
				className="flex items-center gap-4"
				onClick={(e) => e.stopPropagation()}>
				<div className="flex items-center min-w-0 flex-1">
					<span
						className={`codicon codicon-symbol-method mr-2 flex-shrink-0 ${
							isToolEnabled
								? "text-vscode-symbolIcon-methodForeground"
								: "text-vscode-descriptionForeground opacity-60"
						}`}></span>
					<StandardTooltip content={tool.name}>
						<span
							className={`font-medium truncate ${
								isToolEnabled
									? "text-vscode-foreground"
									: "text-vscode-descriptionForeground opacity-60"
							}`}>
							{tool.name}
						</span>
					</StandardTooltip>
				</div>
				{editable && (
					<StandardTooltip content={t("mcp:tool.togglePromptInclusion")}>
						<div onClick={(e) => e.stopPropagation()}>
							<ToggleSwitch
								checked={isToolEnabled}
								onChange={handleToggleEnabled}
								size="small"
								aria-label={t("mcp:tool.togglePromptInclusion")}
							/>
						</div>
					</StandardTooltip>
				)}
			</div>
			{tool.description && (
				<div
					className={`mt-1 text-xs text-vscode-descriptionForeground ${
						isToolEnabled ? "opacity-80" : "opacity-40"
					}`}>
					{tool.description}
				</div>
			)}
			{/* Auto-approval group selector */}
			{editable && (
				<div className="mt-2 flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
					<span className="text-[11px] uppercase opacity-70 text-vscode-descriptionForeground">
						{t("mcp:tool.group")}
					</span>
					<StandardTooltip content={t("mcp:tool.groupTooltip")}>
						<select
							value={currentGroup}
							onChange={handleGroupChange}
							className="text-xs px-1 py-0.5 rounded-sm cursor-pointer outline-none"
							style={{
								background: "var(--vscode-dropdown-background)",
								color: "var(--vscode-dropdown-foreground)",
								border: "1px solid var(--vscode-dropdown-border)",
							}}>
							<option value="default">{t("mcp:tool.groupDefault")}</option>
							{toolGroups.map((group) => (
								<option key={group} value={group}>
									{group}
								</option>
							))}
						</select>
					</StandardTooltip>
				</div>
			)}
			{isToolEnabled &&
				tool.inputSchema &&
				"properties" in tool.inputSchema &&
				Object.keys(tool.inputSchema.properties as Record<string, any>).length > 0 && (
					<div className="mt-2 text-xs border border-vscode-panel-border rounded p-2">
						<div className="mb-1 text-[11px] uppercase opacity-80 text-vscode-descriptionForeground">
							{t("mcp:tool.parameters")}
						</div>
						{Object.entries(tool.inputSchema.properties as Record<string, any>).map(
							([paramName, schema]) => {
								const isRequired =
									tool.inputSchema &&
									"required" in tool.inputSchema &&
									Array.isArray(tool.inputSchema.required) &&
									tool.inputSchema.required.includes(paramName)

								return (
									<div key={paramName} className="flex items-baseline mt-1">
										<code className="text-vscode-textPreformat-foreground mr-2">
											{paramName}
											{isRequired && <span className="text-vscode-errorForeground">*</span>}
										</code>
										<span className="opacity-80 break-words text-vscode-descriptionForeground">
											{schema.description || t("mcp:tool.noDescription")}
										</span>
									</div>
								)
							},
						)}
					</div>
				)}
		</div>
	)
}

export default McpToolRow
