import type { HostBridge } from "./host.js"
import { createInMemoryHost } from "./host-memory.js"

/**
 * Host registry (v3 architecture, §9). The single, host-agnostic accessor the
 * portable core uses to reach platform capabilities — it lives here (a vscode-free
 * package) precisely so importing `getHost()` never pulls in any front-end adapter.
 *
 * Defaults to the in-memory host so the core works in tests and before a front-end
 * installs its adapter. A front-end (the VS Code extension, the CLI, a headless
 * server) calls {@link setHost} once at startup with its own `HostBridge`
 * implementation (Category I). See `docs/host-boundary.md`.
 */
let host: HostBridge = createInMemoryHost()

/** Install the active host bridge. Called once by the front-end at startup. */
export function setHost(bridge: HostBridge): void {
	host = bridge
}

/** The active host bridge. */
export function getHost(): HostBridge {
	return host
}
