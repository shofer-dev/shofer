/**
 * Host-agnostic seam for obtaining the {@link McpHub} singleton.
 *
 * The concrete lifecycle owner is the Category II `McpServerManager` (VS Code
 * `src`), which needs a `vscode.ExtensionContext` and the concrete
 * `ShoferProvider`. The portable `Task` core must not depend on either, so it
 * asks for the hub through this registered factory instead.
 *
 * The VS Code extension registers a factory at activation (wrapping
 * `McpServerManager.getInstance`). In headless / non-VS-Code hosts the factory
 * stays unset and the core simply runs without MCP (the factory getter returns
 * `undefined`, and callers treat that as "no MCP hub available").
 */
import type { McpHub } from "./McpHub.js"
import type { TaskProviderLike } from "../../task-provider/index.js"

export type McpHubFactory = (provider: TaskProviderLike) => Promise<McpHub | undefined>

let mcpHubFactory: McpHubFactory | undefined

/** Registers the host factory used to create/fetch the MCP hub singleton. */
export function setMcpHubFactory(factory: McpHubFactory): void {
	mcpHubFactory = factory
}

/** Returns the registered MCP hub factory, or `undefined` when none is set (headless). */
export function getMcpHubFactory(): McpHubFactory | undefined {
	return mcpHubFactory
}
