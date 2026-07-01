import type {
	HostBridge,
	HostLsp,
	HostReferencesResult,
	HostSymbol,
	HostWorkspace,
	HostWorkspaceEdit,
	Notifier,
	NotifyChoiceOptions,
} from "./host.js"

/**
 * Category I over RPC (v3 architecture — distributed execution).
 *
 * The Category I host interfaces are DTO-based, so they serialize directly over a
 * transport. This module makes the **front-end-bound** slice of the host
 * (notifications/approvals, language services, workspace commands) remoteable: a
 * remote *executor* proxies those calls back to the *controller* that owns the UI,
 * while the workspace-scoped slice (filesystem, watching, config, env) is served
 * locally on the executor. See `docs/v3_architecture.md` → *Distributed execution*.
 *
 * - Executor side: `createSplitHost({ local, channel })` builds a `HostBridge` whose
 *   notifier/lsp/workspace are proxied over the `channel`.
 * - Controller side: `dispatchHostCall(host, …)` routes an inbound call to the real
 *   host and returns the (DTO) result.
 *
 * The capabilities that cross the wire are exactly the ones that are async
 * (or fire-and-forget) — which is the whole `Notifier`, `HostLsp`, and
 * `HostWorkspace` surface. The synchronous, workspace-scoped capabilities
 * (`HostConfig`, `HostEnv`, `HostFileSystem`, `HostWatcher`) stay local.
 */

/** The set of host capabilities that are proxied back to the controller. */
export type RemoteHostCapability = "notifier" | "lsp" | "workspace"

/** Transport for the host-callback channel (executor → controller). */
export interface HostRpcChannel {
	/**
	 * Invoke `capability.method(...params)` on the remote (controller) host and
	 * resolve with the DTO result. Implemented by the session transport.
	 */
	invoke(capability: RemoteHostCapability, method: string, params: unknown[]): Promise<unknown>
}

// ---------------------------------------------------------------------------
// Controller side
// ---------------------------------------------------------------------------

/**
 * Route an inbound host RPC call to the real `host` and return the result. The
 * controller wires its transport's inbound host calls to this.
 */
export async function dispatchHostCall(
	host: HostBridge,
	capability: RemoteHostCapability,
	method: string,
	params: unknown[],
): Promise<unknown> {
	const target = host[capability] as unknown as Record<string, (...args: unknown[]) => unknown>
	const fn = target?.[method]
	if (typeof fn !== "function") {
		throw new Error(`Unknown host call ${capability}.${method}`)
	}
	return await fn.apply(target, params)
}

// ---------------------------------------------------------------------------
// Executor side (proxies)
// ---------------------------------------------------------------------------

function remoteNotifier(channel: HostRpcChannel): Notifier {
	// info/warn/error are fire-and-forget (void); showChoice awaits the result.
	return {
		info: (message: string) => void channel.invoke("notifier", "info", [message]),
		warn: (message: string) => void channel.invoke("notifier", "warn", [message]),
		error: (message: string) => void channel.invoke("notifier", "error", [message]),
		showChoice: (message: string, options: string[], opts?: NotifyChoiceOptions) =>
			channel.invoke("notifier", "showChoice", [message, options, opts]) as Promise<string | undefined>,
	}
}

function remoteLsp(channel: HostRpcChannel): HostLsp {
	const call = (method: string, params: unknown[]) => channel.invoke("lsp", method, params)
	return {
		getDiagnostics: () => call("getDiagnostics", []) as ReturnType<HostLsp["getDiagnostics"]>,
		findReferences: (filePath, line, column, maxResults) =>
			call("findReferences", [filePath, line, column, maxResults]) as Promise<HostReferencesResult>,
		workspaceSymbols: (query) => call("workspaceSymbols", [query]) as Promise<HostSymbol[]>,
		computeRename: (filePath, line, column, newName) =>
			call("computeRename", [filePath, line, column, newName]) as Promise<HostWorkspaceEdit | null>,
		applyWorkspaceEdit: (edit) => call("applyWorkspaceEdit", [edit]) as Promise<boolean>,
	}
}

function remoteWorkspace(channel: HostRpcChannel, local: HostWorkspace): HostWorkspace {
	return {
		// UI actions proxy back to the controller…
		openFolder: (path: string, options?: { newWindow?: boolean }) =>
			channel.invoke("workspace", "openFolder", [path, options]) as Promise<void>,
		executeCommand: <T = unknown>(command: string, ...args: unknown[]) =>
			channel.invoke("workspace", "executeCommand", [command, ...args]) as Promise<T>,
		// …workspace context is served locally (the executor shares the workspace FS).
		workspaceRoots: () => local.workspaceRoots(),
		activeEditorFile: () => local.activeEditorFile(),
		workspaceFolderFor: (filePath: string) => local.workspaceFolderFor(filePath),
		onDidChangeWorkspaceFolders: (handler: () => void) => local.onDidChangeWorkspaceFolders(handler),
	}
}

/**
 * Build a `HostBridge` for a remote executor: notifier/lsp/workspace are proxied to
 * the controller over `channel`; filesystem/config/env/watcher come from the
 * executor-`local` host (which shares the workspace).
 */
export function createSplitHost({ local, channel }: { local: HostBridge; channel: HostRpcChannel }): HostBridge {
	return {
		notifier: remoteNotifier(channel),
		lsp: remoteLsp(channel),
		workspace: remoteWorkspace(channel, local.workspace),
		fs: local.fs,
		config: local.config,
		env: local.env,
		watcher: local.watcher,
	}
}
