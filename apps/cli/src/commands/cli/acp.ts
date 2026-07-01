import path from "path"
import { fileURLToPath } from "url"

import { getProviderDefaultModelId } from "@shofer/types"

import { ExtensionHost, type ExtensionHostOptions } from "@/agent/index.js"
import { getDefaultExtensionPath } from "@/lib/utils/extension.js"
import type { SupportedProvider } from "@/types/index.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export interface AcpOptions {
	workspace?: string
	extension?: string
	apiKey?: string
	provider?: string
	model?: string
	debug?: boolean
}

/**
 * `shofer acp` — run Shofer as an Agent Client Protocol (ACP) agent over stdio.
 *
 * Boots a headless extension host (same as the non-interactive CLI), then hands
 * its `ShoferAPI` to the bundle's ACP server (`runAcpAgentOverShoferApi`), which
 * speaks JSON-RPC 2.0 (one object per line) on stdin/stdout. An ACP client (Zed,
 * etc.) drives the agent through it. `disableOutput` keeps ordinary logging off
 * stdout so it doesn't corrupt the protocol stream.
 */
export async function acp(options: AcpOptions = {}): Promise<void> {
	const provider = (options.provider ?? "openrouter") as SupportedProvider
	const hostOptions: ExtensionHostOptions = {
		mode: "code",
		reasoningEffort: undefined,
		user: null,
		provider,
		model: options.model ?? getProviderDefaultModelId(provider),
		apiKey: options.apiKey,
		workspacePath: path.resolve(options.workspace || process.cwd()),
		extensionPath: path.resolve(options.extension || getDefaultExtensionPath(__dirname)),
		nonInteractive: true,
		ephemeral: false,
		debug: options.debug ?? false,
		exitOnComplete: false,
		exitOnError: false,
		disableOutput: true,
	}

	const host = new ExtensionHost(hostOptions)
	await host.activate()
	await host.runAcp({ input: process.stdin, output: process.stdout })
}
