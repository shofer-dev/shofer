import { useState } from "react"

import { type McpTool, toolGroupNameSchema, toolGroups } from "@shofer/types"

import { vscode } from "@src/utils/vscode"
import { useAppTranslation } from "@src/i18n/TranslationContext"
import { useExtensionState } from "@src/context/ExtensionStateContext"
import { StandardTooltip, ToggleSwitch } from "@/components/ui"

/** `<option>` value that opens the free-text field instead of selecting a category. */
const NEW_CATEGORY_OPTION = "__new__"

/** Reserved wildcard in `alwaysAllowGroups` — never a category name. */
const WILDCARD_CATEGORY = "*"

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
 *
 * The group selector is also the UI path that CREATES a category: beside the eight
 * builtins and the dynamic categories already registered this session, it offers a
 * free-text entry whose name is validated against the same slug rule the host applies
 * (`toolGroupNameSchema`) and which refuses the reserved `*` wildcard by name. The host
 * re-validates in `McpHub.setToolGroup` — this check exists to fail at the keystroke
 * rather than silently.
 */
type McpToolRowProps = {
	tool: McpTool
	serverName?: string
	serverSource?: "global" | "project"
}

const McpToolRow = ({ tool, serverName, serverSource }: McpToolRowProps) => {
	const { t } = useAppTranslation()
	const { dynamicToolGroups } = useExtensionState()
	const isToolEnabled = tool.enabledForPrompt ?? true
	const currentGroup = tool.group ?? "uncategorized"
	const editable = Boolean(serverName && serverSource)

	// Free-text entry state for minting a category. `newCategory === undefined` means
	// the field is closed.
	const [newCategory, setNewCategory] = useState<string | undefined>(undefined)
	const [newCategoryError, setNewCategoryError] = useState<string | undefined>(undefined)

	// Builtins first, then the categories something has already declared. The current
	// group is included even when the registry has not caught up with it, so the select
	// never renders with a value none of its options carry.
	const groupOptions = [
		...toolGroups,
		...[...(dynamicToolGroups ?? []), currentGroup].filter(
			(name, index, all) => !(toolGroups as readonly string[]).includes(name) && all.indexOf(name) === index,
		),
	]

	const postGroup = (group: string | null) => {
		vscode.postMessage({
			type: "setMcpToolGroup",
			serverName,
			source: serverSource,
			toolName: tool.name,
			toolGroup: group,
		})
	}

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

		if (value === NEW_CATEGORY_OPTION) {
			setNewCategory("")
			setNewCategoryError(undefined)
			return
		}

		setNewCategory(undefined)
		setNewCategoryError(undefined)
		// "default" clears the per-tool override (falls back to server-declared).
		postGroup(value === "default" ? null : value)
	}

	const handleCreateCategory = () => {
		const value = (newCategory ?? "").trim()

		if (value === WILDCARD_CATEGORY) {
			setNewCategoryError(t("mcp:tool.groupNewWildcardError"))
			return
		}

		if (!toolGroupNameSchema.safeParse(value).success) {
			setNewCategoryError(t("mcp:tool.groupNewInvalidError"))
			return
		}

		setNewCategory(undefined)
		setNewCategoryError(undefined)
		postGroup(value)
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
				<div className="mt-2 flex flex-col gap-1" onClick={(e) => e.stopPropagation()}>
					<div className="flex items-center gap-2">
						<span className="text-[11px] uppercase opacity-70 text-vscode-descriptionForeground">
							{t("mcp:tool.group")}
						</span>
						<StandardTooltip content={t("mcp:tool.groupTooltip")}>
							<select
								value={newCategory === undefined ? currentGroup : NEW_CATEGORY_OPTION}
								onChange={handleGroupChange}
								data-testid="mcp-tool-group-select"
								className="text-xs px-1 py-0.5 rounded-sm cursor-pointer outline-none"
								style={{
									background: "var(--vscode-dropdown-background)",
									color: "var(--vscode-dropdown-foreground)",
									border: "1px solid var(--vscode-dropdown-border)",
								}}>
								<option value="default">{t("mcp:tool.groupDefault")}</option>
								{groupOptions.map((group) => (
									<option key={group} value={group}>
										{group}
									</option>
								))}
								<option value={NEW_CATEGORY_OPTION}>{t("mcp:tool.groupNew")}</option>
							</select>
						</StandardTooltip>
					</div>
					{newCategory !== undefined && (
						<div className="flex flex-col gap-1">
							<div className="flex items-center gap-2">
								<input
									value={newCategory}
									autoFocus
									onChange={(e) => {
										setNewCategory(e.target.value)
										setNewCategoryError(undefined)
									}}
									onKeyDown={(e) => {
										if (e.key === "Enter") {
											e.preventDefault()
											handleCreateCategory()
										}
									}}
									placeholder={t("mcp:tool.groupNewPlaceholder")}
									aria-label={t("mcp:tool.groupNew")}
									data-testid="mcp-tool-group-new-input"
									className="text-xs px-1 py-0.5 rounded-sm outline-none"
									style={{
										background: "var(--vscode-input-background)",
										color: "var(--vscode-input-foreground)",
										border: "1px solid var(--vscode-dropdown-border)",
									}}
								/>
								<button
									type="button"
									onClick={handleCreateCategory}
									data-testid="mcp-tool-group-new-confirm"
									className="text-xs px-2 py-0.5 rounded-sm cursor-pointer"
									style={{
										background: "var(--vscode-button-background)",
										color: "var(--vscode-button-foreground)",
										border: "none",
									}}>
									{t("mcp:tool.groupNewConfirm")}
								</button>
							</div>
							{newCategoryError && (
								<div
									className="text-xs text-vscode-errorForeground"
									data-testid="mcp-tool-group-new-error">
									{newCategoryError}
								</div>
							)}
						</div>
					)}
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
