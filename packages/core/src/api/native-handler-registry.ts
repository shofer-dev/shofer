import type { ApiHandlerOptions } from "@shofer/types"

import type { ApiHandler } from "./api-handler-types.js"

/**
 * Factory that constructs a "native" (host-dependent) {@link ApiHandler}.
 *
 * Some providers can only run inside the VS Code extension host — e.g.
 * `vscode-lm` (VS Code Language Model API) and `openai-codex` (relies on the
 * extension's OAuth integration). Their handler classes live in the extension
 * (`src/`) and cannot be imported by host-agnostic `@shofer/core`.
 *
 * The extension registers these factories at activation time; `buildApiHandler`
 * (in core) looks them up by provider name. Headless callers that never
 * register them get a clear error instead of a missing-provider crash.
 */
export type NativeApiHandlerFactory = (options: ApiHandlerOptions) => ApiHandler

const registry = new Map<string, NativeApiHandlerFactory>()

/** Register a native (host-backed) handler factory under a provider name. */
export function registerNativeApiHandler(name: string, factory: NativeApiHandlerFactory): void {
	registry.set(name, factory)
}

/** Look up a previously registered native handler factory, if any. */
export function getNativeApiHandler(name: string): NativeApiHandlerFactory | undefined {
	return registry.get(name)
}
