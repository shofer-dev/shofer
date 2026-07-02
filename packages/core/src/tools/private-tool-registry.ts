/**
 * Private-tool invoke registry (v3 architecture).
 *
 * A small host-agnostic registry mirroring the pattern used by
 * `customToolRegistry` / `pluginRegistry`: mutable module state written once at
 * tool-build time (by the VS Code adapter's `build-tools`) and read on the
 * parser / execution hot path.
 *
 * Maps a private tool name → the extension command used to invoke it, so the
 * native-tool parser can recognise private (extension-contributed) tools and the
 * execution layer can route their invocations to the correct provider.
 */
let _privateToolInvokeMap: Map<string, string> | null = null

/**
 * Replace the private-tool invoke lookup with a fresh set of entries.
 * Called by the tool-build path once private providers have been discovered.
 */
export function setPrivateToolInvokeMap(entries: Iterable<[string, string]>): void {
	_privateToolInvokeMap = new Map(entries)
}

/**
 * Return the invoke command for a private tool name, or undefined
 * if the name is not a known private tool.
 */
export function getPrivateToolInvokeCommand(toolName: string): string | undefined {
	return _privateToolInvokeMap?.get(toolName)
}

/**
 * Check whether a tool name belongs to any registered private provider.
 */
export function isPrivateLmTool(toolName: string): boolean {
	return _privateToolInvokeMap?.has(toolName) ?? false
}
