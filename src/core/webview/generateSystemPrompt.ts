import { getHost } from "@shofer/types"
import { WebviewMessage } from "@shofer/core"
import { defaultModeSlug } from "@shofer/core"
import { buildApiHandler } from "@shofer/core"

import { SYSTEM_PROMPT } from "@shofer/core"
import { MultiSearchReplaceDiffStrategy } from "@shofer/core"
import { Package } from "@shofer/core"

import { ShoferProvider } from "./ShoferProvider"
import { webviewLog } from "@shofer/core"

export const generateSystemPrompt = async (provider: ShoferProvider, message: WebviewMessage) => {
	const {
		apiConfiguration,
		customModePrompts,
		customInstructions,
		mcpEnabled,
		experiments,
		language,
		enableSubfolderRules,
		useAgentRules,
	} = await provider.getState()

	const diffStrategy = new MultiSearchReplaceDiffStrategy()

	const cwd = provider.cwd

	const mode = message.mode ?? defaultModeSlug
	const customModes = await provider.customModesManager.getCustomModes()

	const shoferIgnoreInstructions = provider.getCurrentTask()?.shoferIgnoreController?.getInstructions()

	// Create a temporary API handler to check model info for stealth mode.
	// This avoids relying on an active Shofer instance which might not exist during preview.
	let modelInfo: { isStealthModel?: boolean } | undefined
	try {
		const tempApiHandler = buildApiHandler(apiConfiguration)
		modelInfo = tempApiHandler.getModel().info
	} catch (error) {
		webviewLog.error("Error fetching model info for system prompt preview:", error)
	}

	const systemPrompt = await SYSTEM_PROMPT(
		provider.context,
		cwd,
		false, // supportsComputerUse — browser removed
		mcpEnabled ? provider.getMcpHub() : undefined,
		diffStrategy,
		mode,
		customModePrompts,
		customModes,
		customInstructions,
		experiments,
		language,
		shoferIgnoreInstructions,
		{
			todoListEnabled: apiConfiguration?.todoListEnabled ?? true,
			useAgentRules: useAgentRules ?? true,
			enableSubfolderRules: enableSubfolderRules ?? true,
			newTaskRequireTodos: getHost().config.get<boolean>(Package.name, "newTaskRequireTodos", false),
			isStealthModel: modelInfo?.isStealthModel,
			// The preview must show the prompt the configuration actually
			// produces — including the conversational (tool-free) variant.
			toolCallingEnabled: apiConfiguration?.toolCallingEnabled,
		},
		undefined, // todoList
		undefined, // modelId
		provider.getSkillsManager(),
	)

	return systemPrompt
}
