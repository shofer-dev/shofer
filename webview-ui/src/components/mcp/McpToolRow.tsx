import type { McpTool } from "@shofer/types"

import { useAppTranslation } from "@src/i18n/TranslationContext"
import { StandardTooltip } from "@/components/ui"

/**
 * Renders an individual MCP tool row.
 *
 * This component is purely presentational: per-tool enable/disable is owned
 * by the **Settings → Tools** page (single source of truth for tool-level
 * visibility). The MCP Servers page only manages server-level on/off via the
 * server header.
 */
type McpToolRowProps = {
	tool: McpTool
}

const McpToolRow = ({ tool }: McpToolRowProps) => {
	const { t } = useAppTranslation()
	const isToolEnabled = tool.enabledForPrompt ?? true

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
			</div>
			{tool.description && (
				<div
					className={`mt-1 text-xs text-vscode-descriptionForeground ${
						isToolEnabled ? "opacity-80" : "opacity-40"
					}`}>
					{tool.description}
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
