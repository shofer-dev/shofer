import path from "path"
import { fileURLToPath } from "url"

import { getProviderDefaultModelId } from "@shofer/types"

import { ExtensionHost, type ExtensionHostOptions } from "@/agent/index.js"
import { getDefaultExtensionPath } from "@/lib/utils/extension.js"
import type { SupportedProvider } from "@/types/index.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export interface ServeOptions {
	port?: string
	host?: string
	workspace?: string
	extension?: string
	apiKey?: string
	provider?: string
	model?: string
	debug?: boolean
}

/**
 * `shofer serve` — run the Shofer HTTP/SSE server over a headless extension host.
 *
 * Boots the agent, then exposes it on `http://<host>:<port>` via the versioned
 * task-control API + SSE event stream (see `@shofer/core` `createHttpServer`), which
 * the typed `ShoferHttpClient` SDK consumes. Runs until interrupted (SIGINT/SIGTERM).
 */
export async function serve(options: ServeOptions = {}): Promise<void> {
	const provider = (options.provider ?? "openrouter") as SupportedProvider
	const port = Number.parseInt(options.port ?? "30099", 10)
	const host = options.host ?? "127.0.0.1"

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
	}

	const extHost = new ExtensionHost(hostOptions)
	await extHost.activate()
	const server = extHost.serve({ port, host })
	console.error(`[shofer] serving on http://${host}:${port}`)

	await new Promise<void>((resolve) => {
		const shutdown = () => server.close(() => resolve())
		process.on("SIGINT", shutdown)
		process.on("SIGTERM", shutdown)
	})
}
