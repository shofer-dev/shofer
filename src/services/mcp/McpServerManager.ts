import * as vscode from "vscode"
import { McpHub } from "./McpHub"
import { ClineProvider } from "../../core/webview/ClineProvider"
import { mcpLog } from "./mcpLogger"

/**
 * Singleton manager for MCP server instances.
 * Ensures only one set of MCP servers runs across all webviews.
 */
export class McpServerManager {
	private static instance: McpHub | null = null
	private static readonly GLOBAL_STATE_KEY = "mcpHubInstanceId"
	private static providers: Set<ClineProvider> = new Set()
	private static initializationPromise: Promise<McpHub> | null = null

	/**
	 * Get the singleton McpHub instance.
	 * Creates a new instance if one doesn't exist.
	 * Thread-safe implementation using a promise-based lock.
	 */
	static async getInstance(context: vscode.ExtensionContext, provider: ClineProvider): Promise<McpHub> {
		// Register the provider
		this.providers.add(provider)
		mcpLog(
			`[MCP-DEBUG] getInstance called; providers.size=${this.providers.size}, instance=${!!this.instance}, initInProgress=${!!this.initializationPromise}`,
		)

		// If we already have an instance, return it
		if (this.instance) {
			return this.instance
		}

		// If initialization is in progress, wait for it
		if (this.initializationPromise) {
			return this.initializationPromise
		}

		// Create a new initialization promise
		this.initializationPromise = (async () => {
			try {
				// Double-check instance in case it was created while we were waiting
				if (!this.instance) {
					mcpLog(`[MCP-DEBUG] creating new McpHub`)
					const hub = new McpHub(provider)
					// Inject the broadcast callback so hub can notify all providers without
					// a circular import (McpHub → McpServerManager → McpHub would be circular).
					hub.setNotifyAllProviders((message) => McpServerManager.notifyProviders(message))
					mcpLog(`[MCP-DEBUG] notifyAllProviders callback injected; awaiting waitUntilReady`)
					// Wait for all MCP servers to finish connecting (or timing out)
					await hub.waitUntilReady()
					mcpLog(`[MCP-DEBUG] waitUntilReady resolved; servers=${hub.getAllServers().length}`)
					this.instance = hub
					// Store a unique identifier in global state to track the primary instance
					await context.globalState.update(this.GLOBAL_STATE_KEY, Date.now().toString())
				}
				return this.instance
			} finally {
				// Clear the initialization promise after completion or error
				this.initializationPromise = null
			}
		})()

		return this.initializationPromise
	}

	/**
	 * Remove a provider from the tracked set.
	 * This is called when a webview is disposed.
	 */
	static unregisterProvider(provider: ClineProvider): void {
		this.providers.delete(provider)
	}

	/**
	 * Notify all registered providers of server state changes.
	 */
	static notifyProviders(message: any): void {
		const kind = (message && (message as any).type) ?? "?"
		const count = kind === "mcpServers" ? ((message as any).mcpServers?.length ?? 0) : -1
		mcpLog(`[MCP-DEBUG] notifyProviders kind=${kind} servers=${count} providers=${this.providers.size}`)
		this.providers.forEach((provider) => {
			provider.postMessageToWebview(message).catch((error) => {
				mcpLog(`[MCP-DEBUG] Failed to notify provider: ${error}`)
			})
		})
	}

	/**
	 * Clean up the singleton instance and all its resources.
	 */
	static async cleanup(context: vscode.ExtensionContext): Promise<void> {
		if (this.instance) {
			await this.instance.dispose()
			this.instance = null
			await context.globalState.update(this.GLOBAL_STATE_KEY, undefined)
		}
		this.providers.clear()
	}
}
