/* eslint-disable @typescript-eslint/no-explicit-any -- McpHub validates and
   normalizes arbitrary user MCP config JSON (mcp.json / settings) whose shape is
   dynamic by nature; the parsed values are `any` until Zod-validated. */
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { getHost } from "@shofer/types"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js"
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import ReconnectingEventSource from "reconnecting-eventsource"
import {
	CallToolResultSchema,
	ListResourcesResultSchema,
	ListResourceTemplatesResultSchema,
	ListToolsResultSchema,
	ReadResourceResultSchema,
} from "@modelcontextprotocol/sdk/types.js"
import chokidar, { FSWatcher } from "chokidar"
import delay from "delay"
import deepEqual from "fast-deep-equal"
import { z } from "zod"

import type {
	HostDisposable,
	HostFileWatcher,
	McpResource,
	McpResourceResponse,
	McpResourceTemplate,
	McpServer,
	McpTool,
	McpToolCallResponse,
	ToolGroup,
} from "@shofer/types"
import { toolGroupNameSchema } from "@shofer/types"
import {
	recordMcpDuration,
	incMcpCalls,
	incMcpErrors,
	classifyMcpError,
	mcpErrorTypeToStatus,
} from "../../metrics/registry.js"

import { t } from "../../i18n/index.js"

import type { TaskProviderLike } from "../../task-provider/index.js"
import { mcpLog as mcpSysLog } from "../../logging/subsystems.js"
import { registerToolGroup } from "../../tool-groups/category-registry.js"

import { fileExistsAtPath } from "../../fs/fs.js"
import { getWorkspacePath } from "../../path/path.js"
import { injectVariables } from "../../utils/config.js"
import { isPathLocked, type LockedManifest } from "../../config/layered-config.js"
import { loadLockedManifestFromDisk, resolveScopeRoots, type ScopeRoots } from "../../config/scope-roots.js"
import { safeWriteJson } from "../../utils/safeWriteJson.js"
import { sanitizeMcpName, toolNamesMatch } from "../../utils/mcp-name.js"
import { getSharedPluginManager } from "../../plugins/plugin-manager.js"
import { fetchWithMcpCallHeaders, resolveMcpCallHeaders, withMcpCallHeaders } from "./call-headers.js"

/**
 * The `shofer.dev/` prefix both `_meta` keys below carry.
 *
 * MCP (2025-06-18, "General fields → `_meta`") splits a key into an optional
 * PREFIX and a name, and defines a prefix as "a series of labels separated by
 * dots, followed by a slash". **The slash is what makes it a prefix.** Without
 * one — as in the earlier `vscode.taskId` / `shofer.toolCallId` — the spec reads
 * the entire dotted string as the *name*: legal, because names may contain dots,
 * but namespaced in spelling only, obtaining none of the collision avoidance the
 * mechanism exists for.
 *
 * `shofer.dev` is this project's own domain (`package.json` `homepage`), and it
 * sits safely outside MCP's reserved space, which covers any prefix ending
 * `…mcp.<label>/` or `…modelcontextprotocol.<label>/`.
 */
const MCP_META_PREFIX = "shofer.dev/"

/**
 * `_meta` key carrying the id of the task a `tools/call` belongs to.
 */
export const MCP_META_TASK_ID = `${MCP_META_PREFIX}taskId`

/**
 * `_meta` key carrying the PROVIDER's own tool-call id for a `tools/call` — the
 * `tool_calls[].id` the model emitted, unmodified.
 *
 * A server brokering the call can persist it beside the call it actually ran,
 * which is what lets an audit of executions be joined to the transcript by
 * identity instead of by tool name and timing. Only calls that originate in a
 * native provider tool call have one; anything synthesized host-side omits the
 * key rather than inventing a value — a receiver can then tell "not applicable"
 * from "lost", which an empty string would erase.
 */
export const MCP_META_TOOL_CALL_ID = `${MCP_META_PREFIX}toolCallId`

/**
 * `_meta` key by which a SERVER declares the {@link ToolGroup} of a tool it
 * advertises in `tools/list`. The only key here that travels server → client.
 *
 * It has to live in `_meta`, and a plain top-level `group` field cannot replace
 * it, because such a field **does not survive the parse**: the SDK validates
 * `tools/list` against `ToolSchema`, a plain `z.object`, and zod strips unknown
 * keys — so a server's `"group": "read"` was deleted before this file ever saw
 * it. The result was silent and total: every tool of every server resolved
 * `uncategorized`, and on a headless node — whose posture must NOT auto-approve
 * that group, since it is by definition the tools nobody classified — every
 * single call parked on a `use_mcp_server` approval with nobody present to
 * answer it. `_meta` is declared in `ToolSchema` itself, which is exactly why
 * the spec reserves it for metadata like this.
 */
export const MCP_META_TOOL_GROUP = `${MCP_META_PREFIX}toolGroup`

/**
 * `_meta` key by which a SERVER declares the per-OPERATION groups of a
 * verb-multiplexing tool — one that takes an `operation` argument naming the
 * verb to run. The value is an object mapping each accepted `operation` to its
 * own {@link ToolGroup}.
 *
 * It exists so a catalog can be small without approval becoming coarse. Folding
 * a family's verbs into one tool keeps the number of tool descriptions in front
 * of the model down, but a group carried only per TOOL then collapses "allow the
 * read verbs, gate the mutating ones" into all-or-nothing. With this map the
 * gate is resolved per CALL, from the `operation` the call will actually run.
 *
 * It REFINES {@link MCP_META_TOOL_GROUP}, which is always sent alongside and is
 * the maximum over the same operations — so a client that ignores this key, or
 * a call whose operation is absent from the map, gates at the most dangerous
 * verb. Every failure mode here therefore over-gates; none of them widens.
 *
 * A `_meta` value need not be a string (the schema is
 * `z.record(z.string(), z.unknown())`), which is what lets this one be an
 * object.
 */
export const MCP_META_OP_GROUPS = `${MCP_META_PREFIX}opGroups`

// Discriminated union for connection states
export type ConnectedMcpConnection = {
	type: "connected"
	server: McpServer
	client: Client
	transport: StdioClientTransport | SSEClientTransport | StreamableHTTPClientTransport
}

export type DisconnectedMcpConnection = {
	type: "disconnected"
	server: McpServer
	client: null
	transport: null
}

export type McpConnection = ConnectedMcpConnection | DisconnectedMcpConnection

// Enum for disable reasons
export enum DisableReason {
	MCP_DISABLED = "mcpDisabled",
	SERVER_DISABLED = "serverDisabled",
}

// Base configuration schema for common settings
const BaseConfigSchema = z.object({
	disabled: z.boolean().optional(),
	timeout: z.number().min(1).max(3600).optional().default(60),
	watchPaths: z.array(z.string()).optional(), // paths to watch for changes and restart server
	disabledTools: z.array(z.string()).default([]),
	// Per-tool group assignments. Keys are tool names; values must be a valid
	// category NAME — a builtin or any slug, since naming a category nobody has
	// used yet is how a user mints one. A value that is not a slug is malformed
	// input and fails config load (surface user errors early).
	toolGroups: z.record(toolGroupNameSchema).optional(),
})

// Custom error messages for better user feedback
const typeErrorMessage = "Server type must be 'stdio', 'sse', or 'streamable-http'"
const stdioFieldsErrorMessage =
	"For 'stdio' type servers, you must provide a 'command' field and can optionally include 'args' and 'env'"
const sseFieldsErrorMessage =
	"For 'sse' type servers, you must provide a 'url' field and can optionally include 'headers'"
const streamableHttpFieldsErrorMessage =
	"For 'streamable-http' type servers, you must provide a 'url' field and can optionally include 'headers'"
const mixedFieldsErrorMessage =
	"Cannot mix 'stdio' and ('sse' or 'streamable-http') fields. For 'stdio' use 'command', 'args', and 'env'. For 'sse'/'streamable-http' use 'url' and 'headers'"
const missingFieldsErrorMessage =
	"Server configuration must include either 'command' (for stdio) or 'url' (for sse/streamable-http) and a corresponding 'type' if 'url' is used."

// Helper function to create a refined schema with better error messages
const createServerTypeSchema = () => {
	return z.union([
		// Stdio config (has command field)
		BaseConfigSchema.extend({
			type: z.enum(["stdio"]).optional(),
			command: z.string().min(1, "Command cannot be empty"),
			args: z.array(z.string()).optional(),
			cwd: z.string().default(() => getHost().workspace.workspaceRoots()[0] ?? process.cwd()),
			env: z.record(z.string()).optional(),
			// Ensure no SSE fields are present
			url: z.undefined().optional(),
			headers: z.undefined().optional(),
		})
			.transform((data) => ({
				...data,
				type: "stdio" as const,
			}))
			.refine((data) => data.type === undefined || data.type === "stdio", { message: typeErrorMessage }),
		// SSE config (has url field)
		BaseConfigSchema.extend({
			type: z.enum(["sse"]).optional(),
			url: z.string().url("URL must be a valid URL format"),
			headers: z.record(z.string()).optional(),
			// Ensure no stdio fields are present
			command: z.undefined().optional(),
			args: z.undefined().optional(),
			env: z.undefined().optional(),
		})
			.transform((data) => ({
				...data,
				type: "sse" as const,
			}))
			.refine((data) => data.type === undefined || data.type === "sse", { message: typeErrorMessage }),
		// StreamableHTTP config (has url field)
		BaseConfigSchema.extend({
			type: z.enum(["streamable-http"]).optional(),
			url: z.string().url("URL must be a valid URL format"),
			headers: z.record(z.string()).optional(),
			// Ensure no stdio fields are present
			command: z.undefined().optional(),
			args: z.undefined().optional(),
			env: z.undefined().optional(),
		})
			.transform((data) => ({
				...data,
				type: "streamable-http" as const,
			}))
			.refine((data) => data.type === undefined || data.type === "streamable-http", {
				message: typeErrorMessage,
			}),
	])
}

// Server configuration schema with automatic type inference and validation
export const ServerConfigSchema = createServerTypeSchema()

// Settings schema
const McpSettingsSchema = z.object({
	mcpServers: z.record(ServerConfigSchema),
})

export class McpHub {
	private providerRef: WeakRef<TaskProviderLike>
	private disposables: HostDisposable[] = []
	/** Org-defined global servers the org `locked.json` makes final. */
	private lockedGlobalServerNames: string[] = []
	private settingsWatchers: HostFileWatcher[] = []
	private fileWatchers: Map<string, FSWatcher[]> = new Map()
	private projectMcpWatcher?: HostFileWatcher
	private isDisposed: boolean = false
	connections: McpConnection[] = []
	isConnecting: boolean = false
	private refCount: number = 0 // Reference counter for active clients
	private configChangeDebounceTimers: Map<string, NodeJS.Timeout> = new Map()
	// Injected by McpServerManager to broadcast to all registered providers.
	// Avoids circular import: McpHub cannot import McpServerManager directly.
	private notifyAllProvidersFn?: (message: any) => void
	private isProgrammaticUpdate: boolean = false
	private flagResetTimer?: NodeJS.Timeout
	private sanitizedNameRegistry: Map<string, string> = new Map()
	private initializationPromise: Promise<void>

	constructor(provider: TaskProviderLike) {
		this.providerRef = new WeakRef(provider)
		this.watchMcpSettingsFile()
		this.watchProjectMcpFile().catch((e: unknown) => mcpSysLog.error("McpHub watch error:", { error: String(e) }))
		this.setupWorkspaceFoldersWatcher()
		this.initializationPromise = Promise.all([
			this.initializeGlobalMcpServers(),
			this.initializeProjectMcpServers(),
		]).then(() => {})
	}

	/**
	 * Sets the callback used to broadcast server changes to all registered providers.
	 * Called by McpServerManager immediately after hub creation to avoid circular imports.
	 */
	public setNotifyAllProviders(fn: (message: any) => void): void {
		this.notifyAllProvidersFn = fn
	}

	/**
	 * Waits until all MCP servers have finished their initial connection attempts.
	 * Each server individually handles its own timeout, so this will not block indefinitely.
	 */
	async waitUntilReady(): Promise<void> {
		await this.initializationPromise
	}
	/**
	 * Registers a client (e.g., ShoferProvider) using this hub.
	 * Increments the reference count.
	 */
	public registerClient(): void {
		this.refCount++
		// mcpSysLog.info(`McpHub: Client registered. Ref count: ${this.refCount}`)
	}

	/**
	 * Unregisters a client. Decrements the reference count.
	 * If the count reaches zero, disposes the hub.
	 */
	public async unregisterClient(): Promise<void> {
		this.refCount--

		// mcpSysLog.info(`McpHub: Client unregistered. Ref count: ${this.refCount}`)

		if (this.refCount <= 0) {
			mcpSysLog.info("McpHub: Last client unregistered. Disposing hub.")
			await this.dispose()
		}
	}

	/**
	 * Validates and normalizes server configuration
	 * @param config The server configuration to validate
	 * @param serverName Optional server name for error messages
	 * @returns The validated configuration
	 * @throws Error if the configuration is invalid
	 */
	private validateServerConfig(config: any, serverName?: string): z.infer<typeof ServerConfigSchema> {
		// Detect configuration issues before validation
		const hasStdioFields = config.command !== undefined
		const hasUrlFields = config.url !== undefined // Covers sse and streamable-http

		// Check for mixed fields (stdio vs url-based)
		if (hasStdioFields && hasUrlFields) {
			throw new Error(mixedFieldsErrorMessage)
		}

		// Infer type for stdio if not provided
		if (!config.type && hasStdioFields) {
			config.type = "stdio"
		}

		// For url-based configs, type must be provided by the user
		if (hasUrlFields && !config.type) {
			throw new Error("Configuration with 'url' must explicitly specify 'type' as 'sse' or 'streamable-http'.")
		}

		// Validate type if provided
		if (config.type && !["stdio", "sse", "streamable-http"].includes(config.type)) {
			throw new Error(typeErrorMessage)
		}

		// Check for type/field mismatch
		if (config.type === "stdio" && !hasStdioFields) {
			throw new Error(stdioFieldsErrorMessage)
		}
		if (config.type === "sse" && !hasUrlFields) {
			throw new Error(sseFieldsErrorMessage)
		}
		if (config.type === "streamable-http" && !hasUrlFields) {
			throw new Error(streamableHttpFieldsErrorMessage)
		}

		// If neither command nor url is present (type alone is not enough)
		if (!hasStdioFields && !hasUrlFields) {
			throw new Error(missingFieldsErrorMessage)
		}

		// Validate the config against the schema
		try {
			return ServerConfigSchema.parse(config)
		} catch (validationError) {
			if (validationError instanceof z.ZodError) {
				// Extract and format validation errors
				const errorMessages = validationError.errors
					.map((err) => `${err.path.join(".")}: ${err.message}`)
					.join("; ")
				throw new Error(
					serverName
						? `Invalid configuration for server "${serverName}": ${errorMessages}`
						: `Invalid server configuration: ${errorMessages}`,
				)
			}
			throw validationError
		}
	}

	/**
	 * Formats and displays error messages to the user
	 * @param message The error message prefix
	 * @param error The error object
	 */
	private showErrorMessage(message: string, error: unknown): void {
		mcpSysLog.error(`${message}:`, error)
	}

	public setupWorkspaceFoldersWatcher(): void {
		// Skip if test environment is detected
		if (process.env.NODE_ENV === "test") {
			return
		}

		this.disposables.push(
			getHost().workspace.onDidChangeWorkspaceFolders(async () => {
				await this.updateProjectMcpServers()
				await this.watchProjectMcpFile()
			}),
		)
	}

	/**
	 * Debounced wrapper for handling config file changes
	 */
	private debounceConfigChange(filePath: string, source: "global" | "project"): void {
		// Skip processing if this is a programmatic update to prevent unnecessary server restarts
		if (this.isProgrammaticUpdate) {
			return
		}

		const key = `${source}-${filePath}`

		// Clear existing timer if any
		const existingTimer = this.configChangeDebounceTimers.get(key)
		if (existingTimer) {
			clearTimeout(existingTimer)
		}

		// Set new timer
		const timer = setTimeout(async () => {
			this.configChangeDebounceTimers.delete(key)
			await this.handleConfigFileChange(filePath, source)
		}, 500) // 500ms debounce

		this.configChangeDebounceTimers.set(key, timer)
	}

	private async handleConfigFileChange(filePath: string, source: "global" | "project"): Promise<void> {
		if (source === "global") {
			// Any global-scope file event (org or user, incl. deletion) re-merges
			// both scopes; per-file errors are surfaced inside the merged read.
			try {
				const servers = await this.loadGlobalScopeServers()
				await this.updateServerConnections(servers, source)
			} catch (error) {
				this.showErrorMessage(`Failed to update global MCP servers`, error)
			}
			return
		}

		try {
			const content = await fs.readFile(filePath, "utf-8")
			let config: any

			try {
				config = JSON.parse(content)
			} catch (parseError) {
				const errorMessage = t("mcp:errors.invalid_settings_syntax")
				mcpSysLog.error(errorMessage, parseError)
				getHost().notifier.error(errorMessage)
				return
			}

			const result = McpSettingsSchema.safeParse(config)

			if (!result.success) {
				const errorMessages = result.error.errors
					.map((err) => `${err.path.join(".")}: ${err.message}`)
					.join("\n")
				getHost().notifier.error(t("mcp:errors.invalid_settings_validation", { errorMessages }))
				return
			}

			await this.updateServerConnections(result.data.mcpServers || {}, source)
		} catch (error) {
			// Check if the error is because the file doesn't exist
			if ((error as NodeJS.ErrnoException).code === "ENOENT" && source === "project") {
				// File was deleted, clean up project MCP servers
				await this.cleanupProjectMcpServers()
				await this.notifyWebviewOfServerChanges()
				getHost().notifier.info(t("mcp:info.project_config_deleted"))
			} else {
				this.showErrorMessage(t("mcp:errors.failed_update_project"), error)
			}
		}
	}

	private async watchProjectMcpFile(): Promise<void> {
		// Skip if test environment is detected
		if (process.env.NODE_ENV === "test") {
			return
		}

		// Clean up existing project MCP watcher if it exists
		if (this.projectMcpWatcher) {
			this.projectMcpWatcher.dispose()
			this.projectMcpWatcher = undefined
		}

		if (!getHost().workspace.workspaceRoots().length) {
			return
		}

		const workspaceFolder = this.providerRef.deref()?.cwd ?? getWorkspacePath()
		const projectMcpPath = path.join(workspaceFolder, ".shofer", "mcp.json")

		// Create a file system watcher for the project MCP file
		this.projectMcpWatcher = getHost().watcher.watch(workspaceFolder, ".shofer/mcp.json")

		// Watch for file changes
		this.projectMcpWatcher.onChange(() => {
			this.debounceConfigChange(projectMcpPath, "project")
		})

		// Watch for file creation
		this.projectMcpWatcher.onCreate(() => {
			this.debounceConfigChange(projectMcpPath, "project")
		})

		// Watch for file deletion
		this.projectMcpWatcher.onDelete(async () => {
			// Clean up all project MCP servers when the file is deleted
			await this.cleanupProjectMcpServers()
			await this.notifyWebviewOfServerChanges()
			getHost().notifier.info(t("mcp:info.project_config_deleted"))
		})

		this.disposables.push(this.projectMcpWatcher)
	}

	private async updateProjectMcpServers(): Promise<void> {
		await this.syncProjectMcpServers()
	}

	/**
	 * MCP server configs contributed by enabled plugins (design §6.6 Mode A). Keyed
	 * by server name; each value is a loose config object re-validated per-server by
	 * {@link updateServerConnections}. Empty when no plugin manager is wired ⇒ no
	 * plugin servers ⇒ behavior identical to the pre-plugin hub.
	 */
	private getPluginMcpServers(): Record<string, unknown> {
		const pluginManager = getSharedPluginManager()
		if (!pluginManager) return {}
		const servers: Record<string, unknown> = {}
		for (const { name, config } of pluginManager.getContributedMcpServers()) {
			servers[name] = config
		}
		return servers
	}

	/**
	 * Recompute the "project"-source server set as `.shofer/mcp.json` servers merged
	 * with plugin-contributed servers, and reconcile the connections. `.shofer/mcp.json`
	 * takes precedence on a name collision. Plugin servers are preserved even when the
	 * project config file is absent or invalid.
	 */
	private async syncProjectMcpServers(): Promise<void> {
		const pluginServers = this.getPluginMcpServers()
		const projectMcpPath = await this.getProjectMcpPath()

		if (!projectMcpPath) {
			await this.updateServerConnections(pluginServers, "project", false)
			return
		}

		try {
			const content = await fs.readFile(projectMcpPath, "utf-8")
			let config: any
			try {
				config = JSON.parse(content)
			} catch (parseError) {
				const errorMessage = t("mcp:errors.invalid_settings_syntax")
				mcpSysLog.error(errorMessage, parseError)
				getHost().notifier.error(errorMessage)
				await this.updateServerConnections(pluginServers, "project", false)
				return
			}

			const result = McpSettingsSchema.safeParse(config)
			if (result.success) {
				await this.updateServerConnections(
					{ ...pluginServers, ...(result.data.mcpServers || {}) },
					"project",
					false,
				)
			} else {
				const errorMessages = result.error.errors
					.map((err) => `${err.path.join(".")}: ${err.message}`)
					.join("\n")
				mcpSysLog.error("Invalid project MCP settings format:", errorMessages)
				getHost().notifier.error(t("mcp:errors.invalid_settings_validation", { errorMessages }))
				await this.updateServerConnections(pluginServers, "project", false)
			}
		} catch (error) {
			this.showErrorMessage(t("mcp:errors.failed_update_project"), error)
		}
	}

	/**
	 * Public re-sync hook: call after plugins are enabled/disabled so plugin-
	 * contributed MCP servers (dis)connect and the webview is notified.
	 */
	async refreshProjectMcpServers(): Promise<void> {
		await this.syncProjectMcpServers()
		await this.notifyWebviewOfServerChanges()
	}

	private async cleanupProjectMcpServers(): Promise<void> {
		// Disconnect and remove file-based project MCP servers, but keep plugin-
		// contributed servers connected (they don't come from `.shofer/mcp.json`).
		await this.updateServerConnections(this.getPluginMcpServers(), "project", false)
	}

	getServers(): McpServer[] {
		// Only return enabled servers, deduplicating by name with project servers taking priority
		const enabledConnections = this.connections.filter((conn) => !conn.server.disabled)

		// Deduplicate by server name: project servers take priority over global servers
		const serversByName = new Map<string, McpServer>()
		for (const conn of enabledConnections) {
			const existing = serversByName.get(conn.server.name)
			if (!existing) {
				serversByName.set(conn.server.name, conn.server)
			} else if (conn.server.source === "project" && existing.source !== "project") {
				// Project server overrides global server with the same name
				serversByName.set(conn.server.name, conn.server)
			}
			// If existing is project and current is global, keep existing (project wins)
		}

		return Array.from(serversByName.values())
	}

	getAllServers(): McpServer[] {
		// Return all servers regardless of state
		return this.connections.map((conn) => conn.server)
	}

	/**
	 * Returns metadata about MCP tools including group assignments and the\n	 * server name they belong to. Used by mode-based tool filtering, where\n	 * server-qualified lookups are required to disambiguate tools sharing the\n	 * same name across different servers.
	 *
	 * @returns Array of `{ serverName, ...McpTool }` entries, deduplicated by\n	 *   `serverName + toolName` and excluding tools disabled for prompting.
	 */
	getMcpToolMetadata(): Array<McpTool & { serverName: string }> {
		const servers = this.getServers()
		const allTools: Array<McpTool & { serverName: string }> = []
		const seenKeys = new Set<string>()

		for (const server of servers) {
			if (!server.tools) {
				continue
			}
			for (const tool of server.tools) {
				if (tool.enabledForPrompt === false) {
					continue
				}

				const key = `${server.name}:${tool.name}`
				if (seenKeys.has(key)) {
					continue
				}
				seenKeys.add(key)

				allTools.push({ ...tool, serverName: server.name })
			}
		}

		return allTools
	}

	async getMcpServersPath(): Promise<string> {
		const provider = this.providerRef.deref()
		if (!provider) {
			throw new Error("Provider not available")
		}
		const mcpServersPath = await provider.ensureMcpServersDirectoryExists()
		return mcpServersPath
	}

	/**
	 * The **user** scope's MCP config (`~/.shofer/mcp.json`) — the writable home
	 * of every "global"-source server, and the file every edit path (add/delete/
	 * toggle/timeout) writes. Created with an empty template on first access so
	 * the "Edit Global MCP" UI can open it.
	 */
	async getMcpSettingsFilePath(): Promise<string> {
		const userRoot = path.join(os.homedir(), ".shofer")
		const mcpSettingsFilePath = path.join(userRoot, "mcp.json")
		const fileExists = await fileExistsAtPath(mcpSettingsFilePath)
		if (!fileExists) {
			await fs.mkdir(userRoot, { recursive: true })
			await fs.writeFile(
				mcpSettingsFilePath,
				`{
  "mcpServers": {

  }
}`,
			)
		}
		return mcpSettingsFilePath
	}

	/**
	 * The `.shofer/` scope roots for MCP files — the same resolution the layered
	 * settings overlay uses. `globalStorageFsPath` is derived from the provider's
	 * settings directory (its parent is the — possibly custom — storage base), so
	 * the org-global default agrees with every other scope-file consumer.
	 */
	private async resolveMcpScopeRoots(): Promise<ScopeRoots> {
		let globalStorageFsPath: string | undefined
		try {
			const settingsDir = await this.providerRef.deref()?.ensureSettingsDirectoryExists()
			globalStorageFsPath = settingsDir ? path.dirname(settingsDir) : undefined
		} catch {
			globalStorageFsPath = undefined
		}

		let workspaceFolder: string | undefined
		try {
			workspaceFolder = (this.providerRef.deref()?.cwd ?? getWorkspacePath()) || undefined
		} catch {
			workspaceFolder = undefined
		}

		return resolveScopeRoots({ globalStorageFsPath, homeDir: os.homedir(), workspaceFolder })
	}

	/**
	 * Read + validate one scope's `.shofer/mcp.json`. A missing file is the
	 * normal empty layer; a malformed or schema-invalid file is surfaced to the
	 * user and contributes its raw `mcpServers` best-effort (each server is
	 * re-validated individually in `updateServerConnections`).
	 */
	private async readScopeMcpServers(root: string | undefined): Promise<Record<string, any>> {
		if (!root) {
			return {}
		}
		const filePath = path.join(root, "mcp.json")

		let content: string
		try {
			content = await fs.readFile(filePath, "utf-8")
		} catch {
			return {}
		}

		let config: any
		try {
			config = JSON.parse(content)
		} catch (parseError) {
			const errorMessage = t("mcp:errors.invalid_settings_syntax")
			mcpSysLog.error(`${errorMessage} (${filePath})`, parseError)
			getHost().notifier.error(errorMessage)
			return {}
		}

		const result = McpSettingsSchema.safeParse(config)
		if (!result.success) {
			const errorMessages = result.error.errors.map((err) => `${err.path.join(".")}: ${err.message}`).join("\n")
			mcpSysLog.error(`Invalid MCP settings format (${filePath}):`, errorMessages)
			getHost().notifier.error(t("mcp:errors.invalid_settings_validation", { errorMessages }))
			// Best-effort: per-server validation still happens downstream.
			return config?.mcpServers && typeof config.mcpServers === "object" ? config.mcpServers : {}
		}

		return result.data.mcpServers || {}
	}

	/**
	 * The effective "global"-source server set: the org-global and user scopes'
	 * `.shofer/mcp.json` merged per server name. The user's entry wins unless the
	 * org-global scope's `locked.json` names the server (`mcp/<name>`) or the
	 * whole collection (`mcp`) — then the org entry is final, matching the
	 * layered-config rule everywhere else.
	 */
	private async loadGlobalScopeServers(): Promise<Record<string, any>> {
		const roots = await this.resolveMcpScopeRoots()
		const [orgServers, userServers, manifest] = await Promise.all([
			this.readScopeMcpServers(roots.global),
			this.readScopeMcpServers(roots.user),
			loadLockedManifestFromDisk(roots.global),
		])

		// The org-locked server-name set: org-defined servers the manifest makes
		// final. Cached beside the merge for the Settings UI and mutation guards.
		this.lockedGlobalServerNames = Object.keys(orgServers).filter((name) => this.isMcpServerLocked(name, manifest))

		const merged: Record<string, any> = { ...orgServers }
		for (const [name, config] of Object.entries(userServers)) {
			if (name in orgServers && this.isMcpServerLocked(name, manifest)) {
				continue
			}
			merged[name] = config
		}
		return merged
	}

	/**
	 * The org-locked "global"-source server names (org-defined + named by the
	 * org `locked.json`), as of the last global-scope merge. The Settings UI
	 * marks these read-only; {@link assertServerNotLocked} refuses mutations.
	 */
	public getLockedServerNames(): string[] {
		return [...this.lockedGlobalServerNames]
	}

	/** Refuse a mutation of an org-locked global server loudly instead of
	 *  writing to the user file where the org merge silently shadows it. */
	private assertServerNotLocked(serverName: string, source: "global" | "project"): void {
		if (source === "global" && this.lockedGlobalServerNames.includes(serverName)) {
			throw new Error(t("mcp:errors.org_locked", { serverName }))
		}
	}

	/** True when the org-global scope locks this server name (or all of `mcp`). */
	private isMcpServerLocked(name: string, manifest: LockedManifest): boolean {
		return isPathLocked("mcp", manifest) || isPathLocked(`mcp/${name}`, manifest)
	}

	private async watchMcpSettingsFile(): Promise<void> {
		// Skip if test environment is detected
		if (process.env.NODE_ENV === "test") {
			return
		}

		// Clean up existing settings watchers if they exist
		for (const watcher of this.settingsWatchers) {
			watcher.dispose()
		}
		this.settingsWatchers = []

		// Watch the user and org-global scopes' mcp.json. Deletion matters too: a
		// removed user file may leave org servers behind, so every event re-merges.
		const roots = await this.resolveMcpScopeRoots()
		const watchRoots = [...new Set([roots.user, roots.global].filter((root): root is string => !!root))]

		for (const root of watchRoots) {
			const filePath = path.join(root, "mcp.json")
			const watcher = getHost().watcher.watch(root, "mcp.json")
			watcher.onChange(() => this.debounceConfigChange(filePath, "global"))
			watcher.onCreate(() => this.debounceConfigChange(filePath, "global"))
			watcher.onDelete(() => this.debounceConfigChange(filePath, "global"))
			this.settingsWatchers.push(watcher)
			this.disposables.push(watcher)
		}
	}

	private async initializeMcpServers(source: "global" | "project"): Promise<void> {
		try {
			if (source === "global") {
				// The merged org-global + user server set; scope files that are
				// missing or invalid have already been handled (empty layer + notify).
				const servers = await this.loadGlobalScopeServers()
				await this.updateServerConnections(servers, source, false)
				return
			}

			const configPath = await this.getProjectMcpPath()

			if (!configPath) {
				return
			}

			const content = await fs.readFile(configPath, "utf-8")
			const config = JSON.parse(content)
			const result = McpSettingsSchema.safeParse(config)

			if (result.success) {
				// Pass all servers including disabled ones - they'll be handled in updateServerConnections
				await this.updateServerConnections(result.data.mcpServers || {}, source, false)
			} else {
				const errorMessages = result.error.errors
					.map((err) => `${err.path.join(".")}: ${err.message}`)
					.join("\n")
				mcpSysLog.error(`Invalid ${source} MCP settings format:`, errorMessages)
				getHost().notifier.error(t("mcp:errors.invalid_settings_validation", { errorMessages }))
			}
		} catch (error) {
			if (error instanceof SyntaxError) {
				const errorMessage = t("mcp:errors.invalid_settings_syntax")
				mcpSysLog.error(errorMessage, error)
				getHost().notifier.error(errorMessage)
			} else {
				this.showErrorMessage(`Failed to initialize ${source} MCP servers`, error)
			}
		}
	}

	private async initializeGlobalMcpServers(): Promise<void> {
		await this.initializeMcpServers("global")
	}

	// Get project-level MCP configuration path
	private async getProjectMcpPath(): Promise<string | null> {
		const workspacePath = this.providerRef.deref()?.cwd ?? getWorkspacePath()
		const projectMcpDir = path.join(workspacePath, ".shofer")
		const projectMcpPath = path.join(projectMcpDir, "mcp.json")

		try {
			await fs.access(projectMcpPath)
			return projectMcpPath
		} catch {
			return null
		}
	}

	// Initialize project-level MCP servers (file-based + plugin-contributed).
	private async initializeProjectMcpServers(): Promise<void> {
		await this.syncProjectMcpServers()
	}

	/**
	 * Creates a placeholder connection for disabled servers or when MCP is globally disabled
	 * @param name The server name
	 * @param config The server configuration
	 * @param source The source of the server (global or project)
	 * @param reason The reason for creating a placeholder (mcpDisabled or serverDisabled)
	 * @returns A placeholder DisconnectedMcpConnection object
	 */
	private createPlaceholderConnection(
		name: string,
		config: z.infer<typeof ServerConfigSchema>,
		source: "global" | "project",
		reason: DisableReason,
	): DisconnectedMcpConnection {
		return {
			type: "disconnected",
			server: {
				name,
				config: JSON.stringify(config),
				status: "disconnected",
				disabled: reason === DisableReason.SERVER_DISABLED ? true : config.disabled,
				source,
				projectPath: source === "project" ? getHost().workspace.workspaceRoots()[0] : undefined,
				errorHistory: [],
			},
			client: null,
			transport: null,
		}
	}

	/**
	 * Checks if MCP is globally enabled
	 * @returns Promise<boolean> indicating if MCP is enabled
	 */
	private async isMcpEnabled(): Promise<boolean> {
		const provider = this.providerRef.deref()
		if (!provider) {
			return true // Default to enabled if provider is not available
		}
		const state = await provider.getState()
		return state.mcpEnabled ?? true
	}

	private async connectToServer(
		name: string,
		config: z.infer<typeof ServerConfigSchema>,
		source: "global" | "project" = "global",
	): Promise<void> {
		// Remove existing connection if it exists with the same source
		await this.deleteConnection(name, source)

		// Register the sanitized name for O(1) lookup
		const sanitizedName = sanitizeMcpName(name)
		this.sanitizedNameRegistry.set(sanitizedName, name)

		// Check if MCP is globally enabled
		const mcpEnabled = await this.isMcpEnabled()
		if (!mcpEnabled) {
			// Still create a connection object to track the server, but don't actually connect
			const connection = this.createPlaceholderConnection(name, config, source, DisableReason.MCP_DISABLED)
			this.connections.push(connection)
			return
		}

		// Skip connecting to disabled servers
		if (config.disabled) {
			// Still create a connection object to track the server, but don't actually connect
			const connection = this.createPlaceholderConnection(name, config, source, DisableReason.SERVER_DISABLED)
			this.connections.push(connection)
			return
		}

		// Set up file watchers for enabled servers
		this.setupFileWatcher(name, config, source)

		try {
			// `context` is opaque (`unknown`) on TaskProviderLike; narrow structurally
			// to read the host extension's package version without importing vscode.
			const hostContext = this.providerRef.deref()?.context as
				| { extension?: { packageJSON?: { version?: string } } }
				| undefined
			const client = new Client(
				{
					name: "Shofer",
					version: hostContext?.extension?.packageJSON?.version ?? "1.0.0",
				},
				{
					capabilities: {},
				},
			)

			let transport: StdioClientTransport | SSEClientTransport | StreamableHTTPClientTransport

			// Inject variables to the config (environment, magic variables,...)
			const configInjected = (await injectVariables(config, {
				env: process.env,
				workspaceFolder: getHost().workspace.workspaceRoots()[0] ?? "",
			})) as typeof config

			if (configInjected.type === "stdio") {
				// On Windows, wrap commands with cmd.exe to handle non-exe executables like npx.ps1
				// This is necessary for node version managers (fnm, nvm-windows, volta) that implement
				// commands as PowerShell scripts rather than executables.
				// Note: This adds a small overhead as commands go through an additional shell layer.
				const isWindows = process.platform === "win32"

				// Check if command is already cmd.exe to avoid double-wrapping
				const isAlreadyWrapped =
					configInjected.command.toLowerCase() === "cmd.exe" || configInjected.command.toLowerCase() === "cmd"

				const command = isWindows && !isAlreadyWrapped ? "cmd.exe" : configInjected.command
				const args =
					isWindows && !isAlreadyWrapped
						? ["/c", configInjected.command, ...(configInjected.args || [])]
						: configInjected.args

				transport = new StdioClientTransport({
					command,
					args,
					cwd: configInjected.cwd,
					env: {
						...getDefaultEnvironment(),
						...(configInjected.env || {}),
					},
					stderr: "pipe",
				})

				// Set up stdio specific error handling
				transport.onerror = async (error) => {
					// AbortError during teardown is expected (hub disposed / process killed).
					const isAbort =
						error instanceof Error && (error.name === "AbortError" || error.message.includes("aborted"))
					if (isAbort && this.isDisposed) {
						mcpSysLog.debug(`Transport closed for "${name}" (expected on dispose):`, error.message)
						return
					}
					mcpSysLog.error(`Transport error for "${name}":`, error)
					const connection = this.findConnection(name, source)
					if (connection) {
						connection.server.status = "disconnected"
						this.appendErrorMessage(connection, error instanceof Error ? error.message : `${error}`)
					}
					await this.notifyWebviewOfServerChanges()
				}

				transport.onclose = async () => {
					const connection = this.findConnection(name, source)
					if (connection) {
						connection.server.status = "disconnected"
					}
					await this.notifyWebviewOfServerChanges()
				}

				// transport.stderr is only available after the process has been started. However we can't start it separately from the .connect() call because it also starts the transport. And we can't place this after the connect call since we need to capture the stderr stream before the connection is established, in order to capture errors during the connection process.
				// As a workaround, we start the transport ourselves, and then monkey-patch the start method to no-op so that .connect() doesn't try to start it again.
				await transport.start()
				const stderrStream = transport.stderr
				if (stderrStream) {
					stderrStream.on("data", async (data: Buffer) => {
						const output = data.toString()
						// Check if output contains INFO level log
						const isInfoLog = /INFO/i.test(output)

						if (isInfoLog) {
							// Log normal informational messages
							mcpSysLog.info(`Server "${name}" info:`, output)
						} else {
							// Treat as error log
							mcpSysLog.error(`Server "${name}" stderr:`, output)
							const connection = this.findConnection(name, source)
							if (connection) {
								this.appendErrorMessage(connection, output)
								if (connection.server.status === "disconnected") {
									await this.notifyWebviewOfServerChanges()
								}
							}
						}
					})
				} else {
					mcpSysLog.error(`No stderr stream for ${name}`)
				}
			} else if (configInjected.type === "streamable-http") {
				// Streamable HTTP connection
				transport = new StreamableHTTPClientTransport(new URL(configInjected.url), {
					requestInit: {
						headers: configInjected.headers,
					},
					// The connection's headers are the ones above, fixed here for its whole
					// life. `fetchWithMcpCallHeaders` adds the PER-CALL ones a plugin
					// resolved for the tool call this request belongs to (call-headers.ts);
					// with no plugin answering it is the global `fetch`.
					fetch: fetchWithMcpCallHeaders,
				})

				// Set up Streamable HTTP specific error handling
				transport.onerror = async (error) => {
					// AbortError during teardown is expected (hub disposed / SSE stream cancelled).
					const isAbort =
						error instanceof Error && (error.name === "AbortError" || error.message.includes("aborted"))
					if (isAbort && this.isDisposed) {
						mcpSysLog.debug(
							`Transport closed for "${name}" (streamable-http, expected on dispose):`,
							error.message,
						)
						return
					}
					mcpSysLog.error(`Transport error for "${name}" (streamable-http):`, error)
					const connection = this.findConnection(name, source)
					if (connection) {
						connection.server.status = "disconnected"
						this.appendErrorMessage(connection, error instanceof Error ? error.message : `${error}`)
					}
					await this.notifyWebviewOfServerChanges()
				}

				transport.onclose = async () => {
					const connection = this.findConnection(name, source)
					if (connection) {
						connection.server.status = "disconnected"
					}
					await this.notifyWebviewOfServerChanges()
				}
			} else if (configInjected.type === "sse") {
				// SSE connection
				const sseOptions = {
					requestInit: {
						headers: configInjected.headers,
					},
				}
				// Configure ReconnectingEventSource options
				const reconnectingEventSourceOptions = {
					max_retry_time: 5000, // Maximum retry time in milliseconds
					withCredentials: configInjected.headers?.["Authorization"] ? true : false, // Enable credentials if Authorization header exists
					fetch: (url: string | URL, init: RequestInit) => {
						const headers = new Headers({ ...(init?.headers || {}), ...(configInjected.headers || {}) })
						return fetch(url, {
							...init,
							headers,
						})
					},
				}
				// ReconnectingEventSource is a runtime-compatible polyfill; its static
				// shape differs from the DOM `EventSource` type under core's stricter lib.
				global.EventSource = ReconnectingEventSource as unknown as typeof EventSource
				transport = new SSEClientTransport(new URL(configInjected.url), {
					...sseOptions,
					// Same per-call seam as streamable-http. It reaches only the POST leg
					// (the SSE stream is opened through `eventSourceInit.fetch` above and
					// belongs to the connection, not to any one call) — which is exactly
					// the leg a `tools/call` request rides.
					fetch: fetchWithMcpCallHeaders,
					eventSourceInit: reconnectingEventSourceOptions,
				})

				// Set up SSE specific error handling
				transport.onerror = async (error) => {
					// AbortError during teardown is expected (hub disposed / SSE stream cancelled).
					const isAbort =
						error instanceof Error && (error.name === "AbortError" || error.message.includes("aborted"))
					if (isAbort && this.isDisposed) {
						mcpSysLog.debug(`Transport closed for "${name}" (expected on dispose):`, error.message)
						return
					}
					mcpSysLog.error(`Transport error for "${name}":`, error)
					const connection = this.findConnection(name, source)
					if (connection) {
						connection.server.status = "disconnected"
						this.appendErrorMessage(connection, error instanceof Error ? error.message : `${error}`)
					}
					await this.notifyWebviewOfServerChanges()
				}

				transport.onclose = async () => {
					const connection = this.findConnection(name, source)
					if (connection) {
						connection.server.status = "disconnected"
					}
					await this.notifyWebviewOfServerChanges()
				}
			} else {
				// Should not happen if validateServerConfig is correct
				throw new Error(`Unsupported MCP server type: ${(configInjected as any).type}`)
			}

			// Only override transport.start for stdio transports that have already been started
			if (configInjected.type === "stdio") {
				transport.start = async () => {}
			}

			// Create a connected connection.
			// Store the *raw* (pre-injection) config so `server.config` mirrors
			// the on-disk file: this keeps `${env:…}`/`${workspaceFolder}`
			// placeholders intact for the settings editor (no secret leakage),
			// avoids double-injection on restart (connectToServer re-injects),
			// and prevents spurious change-detection diffs against the file.
			const connection: ConnectedMcpConnection = {
				type: "connected",
				server: {
					name,
					config: JSON.stringify(config),
					status: "connecting",
					disabled: configInjected.disabled,
					source,
					projectPath: source === "project" ? getHost().workspace.workspaceRoots()[0] : undefined,
					errorHistory: [],
				},
				client,
				transport,
			}
			this.connections.push(connection)

			// Connect (this will automatically start the transport).
			// The MCP SDK does not impose a connect-time timeout on HTTP/SSE transports,
			// so an unreachable or unresponsive server (TCP accept but no MCP handshake)
			// would block the connect call indefinitely. That in turn blocks
			// initializationPromise → waitUntilReady() → Task.startTask() (via the
			// MCP-tool-count warning), preventing any new task from running.
			//
			// Apply a hard connect deadline for non-stdio transports (stdio already
			// surfaces failures via its child-process error path).
			if (configInjected.type === "stdio") {
				await client.connect(transport)
			} else {
				const CONNECT_TIMEOUT_MS = 10_000
				let timeoutId: NodeJS.Timeout | undefined
				const timeoutPromise = new Promise<never>((_, reject) => {
					timeoutId = setTimeout(
						() =>
							reject(
								new Error(
									`MCP connect timed out after ${CONNECT_TIMEOUT_MS}ms (${configInjected.type} → ${configInjected.url})`,
								),
							),
						CONNECT_TIMEOUT_MS,
					)
				})
				try {
					await Promise.race([client.connect(transport), timeoutPromise])
				} finally {
					if (timeoutId) clearTimeout(timeoutId)
				}
			}
			connection.server.status = "connected"
			connection.server.error = ""
			connection.server.instructions = client.getInstructions()

			// Initial fetch of tools and resources
			connection.server.tools = await this.fetchToolsList(name, source)
			connection.server.resources = await this.fetchResourcesList(name, source)
			connection.server.resourceTemplates = await this.fetchResourceTemplatesList(name, source)
		} catch (error) {
			// Update status with error
			const connection = this.findConnection(name, source)
			if (connection) {
				connection.server.status = "disconnected"
				this.appendErrorMessage(connection, error instanceof Error ? error.message : `${error}`)
			}
			throw error
		}
	}

	private appendErrorMessage(connection: McpConnection, error: string, level: "error" | "warn" | "info" = "error") {
		const MAX_ERROR_LENGTH = 1000
		const truncatedError =
			error.length > MAX_ERROR_LENGTH
				? `${error.substring(0, MAX_ERROR_LENGTH)}...(error message truncated)`
				: error

		// Add to error history
		if (!connection.server.errorHistory) {
			connection.server.errorHistory = []
		}

		connection.server.errorHistory.push({
			message: truncatedError,
			timestamp: Date.now(),
			level,
		})

		// Keep only the last 100 errors
		if (connection.server.errorHistory.length > 100) {
			connection.server.errorHistory = connection.server.errorHistory.slice(-100)
		}

		// Update current error display
		connection.server.error = truncatedError
	}

	/**
	 * Helper method to find a connection by server name and source
	 * @param serverName The name of the server to find
	 * @param source Optional source to filter by (global or project)
	 * @returns The matching connection or undefined if not found
	 */
	private findConnection(serverName: string, source?: "global" | "project"): McpConnection | undefined {
		// If source is specified, only find servers with that source
		if (source !== undefined) {
			return this.connections.find((conn) => conn.server.name === serverName && conn.server.source === source)
		}

		// If no source is specified, first look for project servers, then global servers
		// This ensures that when servers have the same name, project servers are prioritized
		const projectConn = this.connections.find(
			(conn) => conn.server.name === serverName && conn.server.source === "project",
		)
		if (projectConn) return projectConn

		// If no project server is found, look for global servers
		return this.connections.find(
			(conn) => conn.server.name === serverName && (conn.server.source === "global" || !conn.server.source),
		)
	}

	/**
	 * Find a connection by sanitized server name.
	 * This is used when parsing MCP tool responses where the server name has been
	 * sanitized (e.g., hyphens replaced with underscores) for API compliance.
	 * Uses fuzzy matching to handle cases where models convert hyphens to underscores.
	 * @param sanitizedServerName The sanitized server name from the API tool call
	 * @returns The original server name if found, or null if no match
	 */
	public findServerNameBySanitizedName(sanitizedServerName: string): string | null {
		// First, check for an exact match
		const exactMatch = this.connections.find((conn) => conn.server.name === sanitizedServerName)
		if (exactMatch) {
			return exactMatch.server.name
		}

		// Check the registry for sanitized name mapping
		const registryMatch = this.sanitizedNameRegistry.get(sanitizedServerName)
		if (registryMatch) {
			return registryMatch
		}

		// Use fuzzy matching: treat hyphens and underscores as equivalent
		const fuzzyMatch = this.connections.find((conn) => toolNamesMatch(conn.server.name, sanitizedServerName))
		if (fuzzyMatch) {
			return fuzzyMatch.server.name
		}

		return null
	}

	private async fetchToolsList(serverName: string, source?: "global" | "project"): Promise<McpTool[]> {
		try {
			// Use the helper method to find the connection
			const connection = this.findConnection(serverName, source)

			if (!connection || connection.type !== "connected") {
				return []
			}

			const response = await connection.client.request({ method: "tools/list" }, ListToolsResultSchema)

			// Determine the actual source of the server
			const actualSource = connection.server.source || "global"

			// The server's own EFFECTIVE definition — whichever scope it actually came
			// from. Reading the writable file alone was wrong for every server that is
			// not IN it: a worker's servers arrive in the org-global scope
			// (`$SHOFER_GLOBAL_DIR/mcp.json`) or from a plugin's
			// `contributes.mcpServers`, both merged into the connection but neither
			// present in `~/.shofer/mcp.json` — so their declared `toolGroups` were
			// dropped and every one of their tools resolved `uncategorized`. On a
			// headless worker that turns each call into an approval ask nobody is there
			// to answer, which reads as the run hanging.
			let declared: Record<string, any> = {}
			try {
				declared = JSON.parse(connection.server.config) as Record<string, any>
			} catch {
				// A connection always carries a config it was built from; an unparseable
				// one leaves the declared layer empty rather than failing the listing.
			}

			// The user's own override layer, which must still WIN: the toggle/assign
			// paths write it there (`updateServerToolList`, `setToolGroup`) and then
			// re-list, so this read is what makes those take effect. Absent for a
			// server the user has never touched.
			let override: Record<string, any> = {}
			try {
				const configPath =
					actualSource === "project" ? await this.getProjectMcpPath() : await this.getMcpSettingsFilePath()
				if (configPath) {
					const parsed = JSON.parse(await fs.readFile(configPath, "utf-8"))
					override = parsed?.mcpServers?.[serverName] ?? {}
				}
			} catch (error) {
				mcpSysLog.error(`Failed to read tool configuration for ${serverName}:`, error)
				// Continue with the declared layer alone.
			}

			const disabledToolsList: string[] = override.disabledTools ?? declared.disabledTools ?? []
			const toolGroupsConfig: Record<string, string> = {
				...(declared.toolGroups ?? {}),
				...(override.toolGroups ?? {}),
			}

			// Resolve per-tool group assignments. Priority order:
			//   1. User-supplied override in the writable mcp.json (`toolGroups[toolName]`)
			//   2. The server's own declaration, in whatever scope defined it
			//   3. Server-declared `_meta["shofer.dev/toolGroup"]`
			//   4. Default `uncategorized`
			// Auto-approval is gated by group, not by a per-tool flag.
			// A declared group is validated as a SLUG, not against the builtin enum:
			// a server naming `salesforce` mints that category here, at DISCOVERY, so
			// its auto-approve toggle exists before the tool is ever called. Only a
			// malformed name is dropped (to `uncategorized` by the caller's fallback).
			const resolveGroup = (raw: unknown): McpTool["group"] => {
				const parsed = toolGroupNameSchema.safeParse(raw)
				if (!parsed.success) {
					return undefined
				}
				registerToolGroup(parsed.data)
				return parsed.data
			}
			// A verb-multiplexing tool's per-operation map (see MCP_META_OP_GROUPS),
			// sanitized entry by entry: a value that is not a valid category name is
			// dropped rather than failing the listing or being forwarded — the call
			// then falls back to the tool-level group, which is the maximum over the
			// operations. A declaration that is not a plain object, or one nothing
			// survives, yields `undefined`.
			const resolveOpGroups = (raw: unknown): McpTool["opGroups"] => {
				if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
					return undefined
				}
				const map: Record<string, ToolGroup> = {}
				for (const [operation, declared] of Object.entries(raw as Record<string, unknown>)) {
					const group = resolveGroup(declared)
					if (operation.length > 0 && group) {
						map[operation] = group
					}
				}
				return Object.keys(map).length > 0 ? map : undefined
			}
			const tools: McpTool[] = (response?.tools || []).map((tool) => {
				// Tier 3 is read from `_meta` and NOT from a top-level `group`: the
				// SDK parses this response through `ToolSchema`, whose plain
				// `z.object` strips every key it does not declare, so a top-level
				// one never arrives (see MCP_META_TOOL_GROUP). `_meta` is in that
				// schema, so it does.
				const userGroup = resolveGroup(toolGroupsConfig[tool.name])
				const group: McpTool["group"] =
					userGroup ?? resolveGroup(tool._meta?.[MCP_META_TOOL_GROUP]) ?? "uncategorized"

				// Both halves of the per-call resolution are carried, never
				// pre-collapsed: `opGroups` is what the SERVER said about each verb,
				// and `groupIsUserOverride` is what lets a user's whole-tool
				// assignment beat it at decision time (`getMcpToolGroup`).
				return {
					...tool,
					enabledForPrompt: !disabledToolsList.includes(tool.name),
					group,
					opGroups: resolveOpGroups(tool._meta?.[MCP_META_OP_GROUPS]),
					groupIsUserOverride: userGroup !== undefined ? true : undefined,
				}
			})

			return tools
		} catch (error) {
			mcpSysLog.error(`Failed to fetch tools for ${serverName}:`, error)
			return []
		}
	}

	private async fetchResourcesList(serverName: string, source?: "global" | "project"): Promise<McpResource[]> {
		try {
			const connection = this.findConnection(serverName, source)
			if (!connection || connection.type !== "connected") {
				return []
			}
			const response = await connection.client.request({ method: "resources/list" }, ListResourcesResultSchema)
			return response?.resources || []
		} catch {
			// mcpSysLog.error(`Failed to fetch resources for ${serverName}:`, error)
			return []
		}
	}

	private async fetchResourceTemplatesList(
		serverName: string,
		source?: "global" | "project",
	): Promise<McpResourceTemplate[]> {
		try {
			const connection = this.findConnection(serverName, source)
			if (!connection || connection.type !== "connected") {
				return []
			}
			const response = await connection.client.request(
				{ method: "resources/templates/list" },
				ListResourceTemplatesResultSchema,
			)
			return response?.resourceTemplates || []
		} catch {
			// mcpSysLog.error(`Failed to fetch resource templates for ${serverName}:`, error)
			return []
		}
	}

	async deleteConnection(name: string, source?: "global" | "project"): Promise<void> {
		// Clean up file watchers for this server
		this.removeFileWatchersForServer(name)

		// If source is provided, only delete connections from that source
		const connections = source
			? this.connections.filter((conn) => conn.server.name === name && conn.server.source === source)
			: this.connections.filter((conn) => conn.server.name === name)

		for (const connection of connections) {
			try {
				if (connection.type === "connected") {
					await connection.transport.close()
					await connection.client.close()
				}
			} catch (error) {
				mcpSysLog.error(`Failed to close transport for ${name}:`, error)
			}
		}

		// Remove the connections from the array
		this.connections = this.connections.filter((conn) => {
			if (conn.server.name !== name) return true
			if (source && conn.server.source !== source) return true
			return false
		})

		// Remove from sanitized name registry if no more connections with this name exist
		const remainingConnections = this.connections.filter((conn) => conn.server.name === name)
		if (remainingConnections.length === 0) {
			const sanitizedName = sanitizeMcpName(name)
			this.sanitizedNameRegistry.delete(sanitizedName)
		}
	}

	async updateServerConnections(
		newServers: Record<string, any>,
		source: "global" | "project" = "global",
		manageConnectingState: boolean = true,
	): Promise<void> {
		if (manageConnectingState) {
			this.isConnecting = true
		}
		this.removeAllFileWatchers()
		// Filter connections by source
		const currentConnections = this.connections.filter(
			(conn) => conn.server.source === source || (!conn.server.source && source === "global"),
		)
		const currentNames = new Set(currentConnections.map((conn) => conn.server.name))
		const newNames = new Set(Object.keys(newServers))

		// Delete removed servers
		for (const name of currentNames) {
			if (!newNames.has(name)) {
				await this.deleteConnection(name, source)
			}
		}

		// Update or add servers
		for (const [name, config] of Object.entries(newServers)) {
			// Only consider connections that match the current source
			const currentConnection = this.findConnection(name, source)

			// Validate and transform the config
			let validatedConfig: z.infer<typeof ServerConfigSchema>
			try {
				validatedConfig = this.validateServerConfig(config, name)
			} catch (error) {
				this.showErrorMessage(`Invalid configuration for MCP server "${name}"`, error)
				continue
			}

			if (!currentConnection) {
				// New server
				try {
					// Only setup file watcher for enabled servers
					if (!validatedConfig.disabled) {
						this.setupFileWatcher(name, validatedConfig, source)
					}
					await this.connectToServer(name, validatedConfig, source)
				} catch (error) {
					this.showErrorMessage(`Failed to connect to new MCP server ${name}`, error)
				}
			} else if (!deepEqual(JSON.parse(currentConnection.server.config), config)) {
				// Existing server with changed config
				try {
					// Only setup file watcher for enabled servers
					if (!validatedConfig.disabled) {
						this.setupFileWatcher(name, validatedConfig, source)
					}
					await this.deleteConnection(name, source)
					await this.connectToServer(name, validatedConfig, source)
				} catch (error) {
					this.showErrorMessage(`Failed to reconnect MCP server ${name}`, error)
				}
			}
			// If server exists with same config, do nothing
		}
		await this.notifyWebviewOfServerChanges()
		if (manageConnectingState) {
			this.isConnecting = false
		}
	}

	private setupFileWatcher(
		name: string,
		config: z.infer<typeof ServerConfigSchema>,
		source: "global" | "project" = "global",
	) {
		// Initialize an empty array for this server if it doesn't exist
		if (!this.fileWatchers.has(name)) {
			this.fileWatchers.set(name, [])
		}

		const watchers = this.fileWatchers.get(name) || []

		// Only stdio type has args
		if (config.type === "stdio") {
			// Setup watchers for custom watchPaths if defined
			if (config.watchPaths && config.watchPaths.length > 0) {
				const watchPathsWatcher = chokidar.watch(config.watchPaths, {
					// persistent: true,
					// ignoreInitial: true,
					// awaitWriteFinish: true,
				})

				watchPathsWatcher.on("change", async (changedPath) => {
					try {
						// Pass the source from the config to restartConnection
						await this.restartConnection(name, source)
					} catch (error) {
						mcpSysLog.error(`Failed to restart server ${name} after change in ${changedPath}:`, error)
					}
				})

				watchers.push(watchPathsWatcher)
			}

			// Also setup the fallback build/index.js watcher if applicable
			const filePath = config.args?.find((arg: string) => arg.includes("build/index.js"))
			if (filePath) {
				// we use chokidar instead of onDidSaveTextDocument because it doesn't require the file to be open in the editor
				const indexJsWatcher = chokidar.watch(filePath, {
					// persistent: true,
					// ignoreInitial: true,
					// awaitWriteFinish: true, // This helps with atomic writes
				})

				indexJsWatcher.on("change", async () => {
					try {
						// Pass the source from the config to restartConnection
						await this.restartConnection(name, source)
					} catch (error) {
						mcpSysLog.error(`Failed to restart server ${name} after change in ${filePath}:`, error)
					}
				})

				watchers.push(indexJsWatcher)
			}

			// Update the fileWatchers map with all watchers for this server
			if (watchers.length > 0) {
				this.fileWatchers.set(name, watchers)
			}
		}
	}

	private removeAllFileWatchers() {
		this.fileWatchers.forEach((watchers) => watchers.forEach((watcher) => watcher.close()))
		this.fileWatchers.clear()
	}

	private removeFileWatchersForServer(serverName: string) {
		const watchers = this.fileWatchers.get(serverName)
		if (watchers) {
			watchers.forEach((watcher) => watcher.close())
			this.fileWatchers.delete(serverName)
		}
	}

	async restartConnection(serverName: string, source?: "global" | "project"): Promise<void> {
		this.isConnecting = true

		// Check if MCP is globally enabled
		const mcpEnabled = await this.isMcpEnabled()
		if (!mcpEnabled) {
			this.isConnecting = false
			return
		}

		// Get existing connection and update its status
		const connection = this.findConnection(serverName, source)
		const config = connection?.server.config
		if (config) {
			getHost().notifier.info(t("mcp:info.server_restarting", { serverName }))
			connection.server.status = "connecting"
			connection.server.error = ""
			await this.notifyWebviewOfServerChanges()
			await delay(500) // artificial delay to show user that server is restarting
			try {
				await this.deleteConnection(serverName, connection.server.source)
				// Parse the config to validate it
				const parsedConfig = JSON.parse(config)
				try {
					// Validate the config
					const validatedConfig = this.validateServerConfig(parsedConfig, serverName)

					// Try to connect again using validated config
					await this.connectToServer(serverName, validatedConfig, connection.server.source || "global")
					getHost().notifier.info(t("mcp:info.server_connected", { serverName }))
				} catch (validationError) {
					this.showErrorMessage(`Invalid configuration for MCP server "${serverName}"`, validationError)
				}
			} catch (error) {
				this.showErrorMessage(`Failed to restart ${serverName} MCP server connection`, error)
			}
		}

		await this.notifyWebviewOfServerChanges()
		this.isConnecting = false
	}

	public async refreshAllConnections(): Promise<void> {
		if (this.isConnecting) {
			return
		}

		// Check if MCP is globally enabled
		const mcpEnabled = await this.isMcpEnabled()
		if (!mcpEnabled) {
			// Clear all existing connections
			const existingConnections = [...this.connections]
			for (const conn of existingConnections) {
				await this.deleteConnection(conn.server.name, conn.server.source)
			}

			// Still initialize servers to track them, but they won't connect
			await this.initializeMcpServers("global")
			await this.initializeMcpServers("project")

			await this.notifyWebviewOfServerChanges()
			return
		}

		this.isConnecting = true

		try {
			// Probe the config files so any read error is surfaced/logged before we
			// tear down and re-initialize (the authoritative parse happens in
			// initializeMcpServers below).
			const globalPath = await this.getMcpSettingsFilePath()
			try {
				await fs.readFile(globalPath, "utf-8")
			} catch (error) {
				mcpSysLog.info("Error reading global MCP config:", error)
			}

			const projectPath = await this.getProjectMcpPath()
			if (projectPath) {
				try {
					await fs.readFile(projectPath, "utf-8")
				} catch (error) {
					mcpSysLog.info("Error reading project MCP config:", error)
				}
			}

			// Clear all existing connections first
			const existingConnections = [...this.connections]
			for (const conn of existingConnections) {
				await this.deleteConnection(conn.server.name, conn.server.source)
			}

			// Re-initialize all servers from scratch
			// This ensures proper initialization including fetching tools, resources, etc.
			await this.initializeMcpServers("global")
			await this.initializeMcpServers("project")

			await delay(100)

			await this.notifyWebviewOfServerChanges()
		} catch (error) {
			this.showErrorMessage("Failed to refresh MCP servers", error)
		} finally {
			this.isConnecting = false
		}
	}

	private async notifyWebviewOfServerChanges(): Promise<void> {
		// Get global server order from settings file
		const settingsPath = await this.getMcpSettingsFilePath()
		const content = await fs.readFile(settingsPath, "utf-8")
		const config = JSON.parse(content)
		const globalServerOrder = Object.keys(config.mcpServers || {})

		// Get project server order if available
		const projectMcpPath = await this.getProjectMcpPath()
		let projectServerOrder: string[] = []
		if (projectMcpPath) {
			try {
				const projectContent = await fs.readFile(projectMcpPath, "utf-8")
				const projectConfig = JSON.parse(projectContent)
				projectServerOrder = Object.keys(projectConfig.mcpServers || {})
			} catch {
				// Silently continue with empty project server order
			}
		}

		// Sort connections: first project servers in their defined order, then global servers in their defined order
		// This ensures that when servers have the same name, project servers are prioritized
		const sortedConnections = [...this.connections].sort((a, b) => {
			const aIsGlobal = a.server.source === "global" || !a.server.source
			const bIsGlobal = b.server.source === "global" || !b.server.source

			// If both are global or both are project, sort by their respective order
			if (aIsGlobal && bIsGlobal) {
				const indexA = globalServerOrder.indexOf(a.server.name)
				const indexB = globalServerOrder.indexOf(b.server.name)
				return indexA - indexB
			} else if (!aIsGlobal && !bIsGlobal) {
				const indexA = projectServerOrder.indexOf(a.server.name)
				const indexB = projectServerOrder.indexOf(b.server.name)
				return indexA - indexB
			}

			// Project servers come before global servers (reversed from original)
			return aIsGlobal ? 1 : -1
		})

		const serversToSend = sortedConnections.map((connection) => connection.server)
		const message = {
			type: "mcpServers" as const,
			mcpServers: serversToSend,
		}

		// Prefer broadcasting to all registered providers so every open webview gets
		// the updated list (notifyAllProvidersFn is injected by McpServerManager).
		if (this.notifyAllProvidersFn) {
			this.notifyAllProvidersFn(message)
		} else {
			// Fallback: notify only the provider that created this hub.
			const targetProvider: TaskProviderLike | undefined = this.providerRef.deref()
			if (targetProvider) {
				try {
					await targetProvider.postMessageToWebview(message)
				} catch (error) {
					mcpSysLog.error("[McpHub] Error calling targetProvider.postMessageToWebview:", error)
				}
			} else {
				mcpSysLog.error("[McpHub] No target provider available - cannot send mcpServers message to webview")
			}
		}
	}

	public async toggleServerDisabled(
		serverName: string,
		disabled: boolean,
		source?: "global" | "project",
	): Promise<void> {
		try {
			// Find the connection to determine if it's a global or project server
			const connection = this.findConnection(serverName, source)
			if (!connection) {
				throw new Error(`Server ${serverName}${source ? ` with source ${source}` : ""} not found`)
			}

			const serverSource = connection.server.source || "global"
			this.assertServerNotLocked(serverName, serverSource)
			// Update the server config in the appropriate file
			await this.updateServerConfig(serverName, { disabled }, serverSource)

			// Update the connection object
			if (connection) {
				try {
					connection.server.disabled = disabled

					// If disabling a connected server, disconnect it
					if (disabled && connection.server.status === "connected") {
						// Clean up file watchers when disabling
						this.removeFileWatchersForServer(serverName)
						await this.deleteConnection(serverName, serverSource)
						// Re-add as a disabled connection
						// Re-read config from file to get updated disabled state
						const updatedConfig = await this.readServerConfigFromFile(serverName, serverSource)
						await this.connectToServer(serverName, updatedConfig, serverSource)
					} else if (!disabled && connection.server.status === "disconnected") {
						// If enabling a disabled server, connect it
						// Re-read config from file to get updated disabled state
						const updatedConfig = await this.readServerConfigFromFile(serverName, serverSource)
						await this.deleteConnection(serverName, serverSource)
						// When re-enabling, file watchers will be set up in connectToServer
						await this.connectToServer(serverName, updatedConfig, serverSource)
					} else if (connection.server.status === "connected") {
						// Only refresh capabilities if connected
						connection.server.tools = await this.fetchToolsList(serverName, serverSource)
						connection.server.resources = await this.fetchResourcesList(serverName, serverSource)
						connection.server.resourceTemplates = await this.fetchResourceTemplatesList(
							serverName,
							serverSource,
						)
					}
				} catch (error) {
					mcpSysLog.error(`Failed to refresh capabilities for ${serverName}:`, error)
				}
			}

			await this.notifyWebviewOfServerChanges()
		} catch (error) {
			this.showErrorMessage(`Failed to update server ${serverName} state`, error)
			throw error
		}
	}

	/**
	 * Helper method to read a server's configuration from the appropriate settings file
	 * @param serverName The name of the server to read
	 * @param source Whether to read from the global or project config
	 * @returns The validated server configuration
	 */
	private async readServerConfigFromFile(
		serverName: string,
		source: "global" | "project" = "global",
	): Promise<z.infer<typeof ServerConfigSchema>> {
		// Determine which config file to read
		let configPath: string
		if (source === "project") {
			const projectMcpPath = await this.getProjectMcpPath()
			if (!projectMcpPath) {
				throw new Error("Project MCP configuration file not found")
			}
			configPath = projectMcpPath
		} else {
			configPath = await this.getMcpSettingsFilePath()
		}

		// Ensure the settings file exists and is accessible
		try {
			await fs.access(configPath)
		} catch (error) {
			mcpSysLog.error("Settings file not accessible:", error)
			throw new Error("Settings file not accessible")
		}

		// Read and parse the config file
		const content = await fs.readFile(configPath, "utf-8")
		const config = JSON.parse(content)

		// Validate the config structure
		if (!config || typeof config !== "object") {
			throw new Error("Invalid config structure")
		}

		if (!config.mcpServers || typeof config.mcpServers !== "object") {
			throw new Error("No mcpServers section in config")
		}

		if (!config.mcpServers[serverName]) {
			throw new Error(`Server ${serverName} not found in config`)
		}

		// Validate and return the server config
		return this.validateServerConfig(config.mcpServers[serverName], serverName)
	}

	/**
	 * Helper method to update a server's configuration in the appropriate settings file
	 * @param serverName The name of the server to update
	 * @param configUpdate The configuration updates to apply
	 * @param source Whether to update the global or project config
	 */
	private async updateServerConfig(
		serverName: string,
		configUpdate: Record<string, any>,
		source: "global" | "project" = "global",
	): Promise<void> {
		// Determine which config file to update
		let configPath: string
		if (source === "project") {
			const projectMcpPath = await this.getProjectMcpPath()
			if (!projectMcpPath) {
				throw new Error("Project MCP configuration file not found")
			}
			configPath = projectMcpPath
		} else {
			configPath = await this.getMcpSettingsFilePath()
		}

		// Ensure the settings file exists and is accessible
		try {
			await fs.access(configPath)
		} catch (error) {
			mcpSysLog.error("Settings file not accessible:", error)
			throw new Error("Settings file not accessible")
		}

		// Read and parse the config file
		const content = await fs.readFile(configPath, "utf-8")
		const config = JSON.parse(content)

		// Validate the config structure
		if (!config || typeof config !== "object") {
			throw new Error("Invalid config structure")
		}

		if (!config.mcpServers || typeof config.mcpServers !== "object") {
			config.mcpServers = {}
		}

		if (!config.mcpServers[serverName]) {
			config.mcpServers[serverName] = {}
		}

		// Create a new server config object to ensure clean structure
		const serverConfig = {
			...config.mcpServers[serverName],
			...configUpdate,
		}

		config.mcpServers[serverName] = serverConfig

		// Write the entire config back
		const updatedConfig = {
			mcpServers: config.mcpServers,
		}

		// Set flag to prevent file watcher from triggering server restart
		if (this.flagResetTimer) {
			clearTimeout(this.flagResetTimer)
		}
		this.isProgrammaticUpdate = true
		try {
			await safeWriteJson(configPath, updatedConfig, { prettyPrint: true })
		} finally {
			// Reset flag after watcher debounce period (non-blocking)
			this.flagResetTimer = setTimeout(() => {
				this.isProgrammaticUpdate = false
				this.flagResetTimer = undefined
			}, 600)
		}
	}

	public async updateServerTimeout(
		serverName: string,
		timeout: number,
		source?: "global" | "project",
	): Promise<void> {
		try {
			// Find the connection to determine if it's a global or project server
			const connection = this.findConnection(serverName, source)
			if (!connection) {
				throw new Error(`Server ${serverName}${source ? ` with source ${source}` : ""} not found`)
			}

			this.assertServerNotLocked(serverName, connection.server.source || "global")
			// Update the server config in the appropriate file
			await this.updateServerConfig(serverName, { timeout }, connection.server.source || "global")

			await this.notifyWebviewOfServerChanges()
		} catch (error) {
			this.showErrorMessage(`Failed to update server ${serverName} timeout settings`, error)
			throw error
		}
	}

	/**
	 * Applies a partial configuration update from the settings UI to a server's
	 * entry in the appropriate config file, then reconnects so that
	 * transport-affecting changes (command, args, cwd, env, url, headers,
	 * watchPaths, …) take effect immediately.
	 *
	 * Fields set to `undefined` in `configUpdate` are removed from the stored
	 * config (JSON serialization drops `undefined`). This lets the UI clear
	 * optional fields and switch transport types cleanly — e.g. switching from
	 * `stdio` to `sse` sends `url` while clearing `command`/`args`/`env`.
	 *
	 * The merged result is validated before it is persisted so user mistakes are
	 * surfaced without leaving a broken config on disk.
	 */
	public async updateServerConfigFromUI(
		serverName: string,
		configUpdate: Record<string, any>,
		source?: "global" | "project",
	): Promise<void> {
		try {
			const connection = this.findConnection(serverName, source)
			if (!connection) {
				throw new Error(`Server ${serverName}${source ? ` with source ${source}` : ""} not found`)
			}

			const serverSource = connection.server.source || "global"

			// Validate the merged result before writing anything to disk.
			const current = JSON.parse(connection.server.config)
			const merged: Record<string, any> = { ...current, ...configUpdate }
			for (const key of Object.keys(merged)) {
				if (merged[key] === undefined) {
					delete merged[key]
				}
			}
			this.validateServerConfig(merged, serverName)

			// Persist the update. updateServerConfig merges into the file and the
			// JSON write drops any keys whose value is `undefined`.
			await this.updateServerConfig(serverName, configUpdate, serverSource)

			// Reconnect using the freshly written config so the changes apply.
			const updatedConfig = await this.readServerConfigFromFile(serverName, serverSource)
			await this.deleteConnection(serverName, serverSource)
			await this.connectToServer(serverName, updatedConfig, serverSource)

			await this.notifyWebviewOfServerChanges()
		} catch (error) {
			this.showErrorMessage(`Failed to update configuration for server ${serverName}`, error)
			throw error
		}
	}

	public async deleteServer(serverName: string, source?: "global" | "project"): Promise<void> {
		try {
			// Find the connection to determine if it's a global or project server
			const connection = this.findConnection(serverName, source)
			if (!connection) {
				throw new Error(`Server ${serverName}${source ? ` with source ${source}` : ""} not found`)
			}

			const serverSource = connection.server.source || "global"
			this.assertServerNotLocked(serverName, serverSource)
			// Determine config file based on server source
			const isProjectServer = serverSource === "project"
			let configPath: string

			if (isProjectServer) {
				// Get project MCP config path
				const projectMcpPath = await this.getProjectMcpPath()
				if (!projectMcpPath) {
					throw new Error("Project MCP configuration file not found")
				}
				configPath = projectMcpPath
			} else {
				// Get global MCP settings path
				configPath = await this.getMcpSettingsFilePath()
			}

			// Ensure the settings file exists and is accessible
			try {
				await fs.access(configPath)
			} catch {
				throw new Error("Settings file not accessible")
			}

			const content = await fs.readFile(configPath, "utf-8")
			const config = JSON.parse(content)

			// Validate the config structure
			if (!config || typeof config !== "object") {
				throw new Error("Invalid config structure")
			}

			if (!config.mcpServers || typeof config.mcpServers !== "object") {
				config.mcpServers = {}
			}

			// Remove the server from the settings
			if (config.mcpServers[serverName]) {
				delete config.mcpServers[serverName]

				// Write the entire config back
				const updatedConfig = {
					mcpServers: config.mcpServers,
				}

				await safeWriteJson(configPath, updatedConfig, { prettyPrint: true })

				// Update server connections with the correct source
				await this.updateServerConnections(config.mcpServers, serverSource)

				getHost().notifier.info(t("mcp:info.server_deleted", { serverName }))
			} else {
				getHost().notifier.warn(t("mcp:info.server_not_found", { serverName }))
			}
		} catch (error) {
			this.showErrorMessage(`Failed to delete MCP server ${serverName}`, error)
			throw error
		}
	}

	async readResource(
		serverName: string,
		uri: string,
		source?: "global" | "project",
		signal?: AbortSignal,
	): Promise<McpResourceResponse> {
		const connection = this.findConnection(serverName, source)
		if (!connection || connection.type !== "connected") {
			throw new Error(`No connection found for server: ${serverName}${source ? ` with source ${source}` : ""}`)
		}
		if (connection.server.disabled) {
			throw new Error(`Server "${serverName}" is disabled`)
		}
		return await connection.client.request(
			{
				method: "resources/read",
				params: {
					uri,
				},
			},
			ReadResourceResultSchema,
			signal ? { signal } : undefined,
		)
	}

	/**
	 * Invokes a tool on a connected MCP server.
	 *
	 * `taskId` and `toolCallId` are the two identifiers the server side needs to
	 * place the call: which run it belongs to, and which of the model's tool
	 * calls it IS. Both travel in the MCP request's `_meta` (see
	 * {@link MCP_META_TASK_ID} / {@link MCP_META_TOOL_CALL_ID}).
	 *
	 * `taskId` also drives the per-call HEADER seam: before the request goes out,
	 * plugins are asked what headers THIS call should carry (`call-headers.ts`),
	 * which is how a value belonging to the run rather than to the host reaches a
	 * connection whose own headers were fixed when it connected. Nobody answering
	 * leaves the request exactly as it was.
	 */
	async callTool(
		serverName: string,
		toolName: string,
		toolArguments?: Record<string, unknown>,
		source?: "global" | "project",
		taskId?: string,
		toolCallId?: string,
		signal?: AbortSignal,
	): Promise<McpToolCallResponse> {
		const connection = this.findConnection(serverName, source)
		if (!connection || connection.type !== "connected") {
			throw new Error(
				`No connection found for server: ${serverName}${source ? ` with source ${source}` : ""}. Please make sure to use MCP servers available under 'Connected MCP Servers'.`,
			)
		}
		if (connection.server.disabled) {
			throw new Error(`Server "${serverName}" is disabled and cannot be used`)
		}

		let timeout: number
		// Unparseable config falls back to `stdio`, which the header seam skips: a
		// resolver must not be asked to hand a credential to a server we could not
		// even read the URL of. The parse failure is already logged below.
		let serverType: "stdio" | "sse" | "streamable-http" = "stdio"
		let serverUrl: string | undefined
		try {
			const parsedConfig = ServerConfigSchema.parse(JSON.parse(connection.server.config))
			timeout = (parsedConfig.timeout ?? 60) * 1000
			serverType = parsedConfig.type
			serverUrl = parsedConfig.type === "stdio" ? undefined : parsedConfig.url
		} catch (error) {
			mcpSysLog.error("Failed to parse server config for timeout:", error)
			// Default to 60 seconds if parsing fails
			timeout = 60 * 1000
		}

		const params: Record<string, unknown> = {
			name: toolName,
			arguments: toolArguments,
		}

		// Identify the call in _meta: the task it belongs to (which servers require
		// for tracing) and, when the call came from a provider tool call, which
		// call it is. A key with no value is omitted rather than sent empty.
		const meta: Record<string, string> = {}
		if (taskId) {
			meta[MCP_META_TASK_ID] = taskId
		}
		if (toolCallId) {
			// The RAW provider id, deliberately NOT run through `sanitizeToolUseId`.
			// That sanitizer exists for the tool_result leg, where the API validates
			// the id against `^[a-zA-Z0-9_-]+$`; a broker recording the call has no
			// such constraint, and the two records are only joinable while both hold
			// the string the model emitted. Sanitizing here would silently produce a
			// key that matches nothing.
			meta[MCP_META_TOOL_CALL_ID] = toolCallId
		}
		if (Object.keys(meta).length > 0) {
			params._meta = meta
		}

		// The per-call transport headers, if any plugin supplies them for this
		// server (call-headers.ts). Resolved from the SAME task id `_meta` carries,
		// because that is what makes them the RUN's headers rather than the host's.
		// Never throws and never fails the call: no answer means the request goes
		// out with exactly the connection's own headers.
		const callHeaders = await resolveMcpCallHeaders({
			serverName: connection.server.name,
			source: connection.server.source ?? "global",
			type: serverType,
			url: serverUrl,
			toolName,
			taskId,
		})

		const mcpT0 = performance.now()
		// One [MCP] line per call (start + finish) so the per-task "Logs" tab shows
		// MCP activity; this path runs inside the task's tool dispatch and is
		// attributed to the owning task via the ambient log context.
		mcpSysLog.info(`▶ ${serverName}/${toolName}`)
		try {
			const result = await withMcpCallHeaders(callHeaders, () =>
				connection.client.request(
					{
						method: "tools/call",
						params,
					},
					CallToolResultSchema,
					{
						timeout,
						...(signal ? { signal } : {}),
					},
				),
			)
			const dur = performance.now() - mcpT0
			recordMcpDuration(serverName, toolName, dur)
			incMcpCalls(serverName, toolName, "success")
			mcpSysLog.info(`✔ ${serverName}/${toolName} done in ${Math.round(dur)}ms`)
			return result
		} catch (error) {
			const dur = performance.now() - mcpT0
			const errorType = classifyMcpError(error)
			recordMcpDuration(serverName, toolName, dur)
			// Map the closed-enum errorType to the call-status label via the
			// shared helper so the mapping lives in one place.
			incMcpCalls(serverName, toolName, mcpErrorTypeToStatus(errorType))
			incMcpErrors(serverName, toolName, errorType)
			mcpSysLog.warn(
				`✖ ${serverName}/${toolName} failed after ${Math.round(dur)}ms (${errorType}): ${error instanceof Error ? error.message : String(error)}`,
			)
			throw error
		}
	}

	/**
	 * Helper method to update the per-server `disabledTools` list in the
	 * appropriate settings file.
	 * @param serverName The name of the server to update
	 * @param source Whether to update the global or project config
	 * @param toolName The name of the tool to add or remove
	 * @param addTool Whether to add (true) or remove (false) the tool from the list
	 */
	private async updateServerToolList(
		serverName: string,
		source: "global" | "project",
		toolName: string,
		addTool: boolean,
	): Promise<void> {
		const listName = "disabledTools"
		// Find the connection with matching name and source
		const connection = this.findConnection(serverName, source)

		if (!connection) {
			throw new Error(`Server ${serverName} with source ${source} not found`)
		}

		// Determine the correct config path based on the source
		let configPath: string
		if (source === "project") {
			// Get project MCP config path
			const projectMcpPath = await this.getProjectMcpPath()
			if (!projectMcpPath) {
				throw new Error("Project MCP configuration file not found")
			}
			configPath = projectMcpPath
		} else {
			// Get global MCP settings path
			configPath = await this.getMcpSettingsFilePath()
		}

		// Normalize path for cross-platform compatibility
		// Use a consistent path format for both reading and writing
		const normalizedPath = process.platform === "win32" ? configPath.replace(/\\/g, "/") : configPath

		// Read the appropriate config file
		const content = await fs.readFile(normalizedPath, "utf-8")
		const config = JSON.parse(content)

		if (!config.mcpServers) {
			config.mcpServers = {}
		}

		if (!config.mcpServers[serverName]) {
			config.mcpServers[serverName] = {
				type: "stdio",
				command: "node",
				args: [], // Default to an empty array; can be set later if needed
			}
		}

		if (!config.mcpServers[serverName][listName]) {
			config.mcpServers[serverName][listName] = []
		}

		const targetList = config.mcpServers[serverName][listName]
		const toolIndex = targetList.indexOf(toolName)

		if (addTool && toolIndex === -1) {
			targetList.push(toolName)
		} else if (!addTool && toolIndex !== -1) {
			targetList.splice(toolIndex, 1)
		}

		// Set flag to prevent file watcher from triggering server restart
		if (this.flagResetTimer) {
			clearTimeout(this.flagResetTimer)
		}
		this.isProgrammaticUpdate = true
		try {
			await safeWriteJson(normalizedPath, config, { prettyPrint: true })
		} finally {
			// Reset flag after watcher debounce period (non-blocking)
			this.flagResetTimer = setTimeout(() => {
				this.isProgrammaticUpdate = false
				this.flagResetTimer = undefined
			}, 600)
		}

		if (connection) {
			connection.server.tools = await this.fetchToolsList(serverName, source)
			await this.notifyWebviewOfServerChanges()
		}
	}

	async toggleToolEnabledForPrompt(
		serverName: string,
		source: "global" | "project",
		toolName: string,
		isEnabled: boolean,
	): Promise<void> {
		try {
			// When isEnabled is true, we want to remove the tool from the disabledTools list.
			// When isEnabled is false, we want to add the tool to the disabledTools list.
			const addToolToDisabledList = !isEnabled
			await this.updateServerToolList(serverName, source, toolName, addToolToDisabledList)
		} catch (error) {
			this.showErrorMessage(`Failed to update settings for tool ${toolName}`, error)
			throw error // Re-throw to ensure the error is properly handled
		}
	}

	/**
	 * Assigns an MCP tool to a tool group (category) by writing the override into
	 * `toolGroups[toolName]` in the server's config file. This override has the
	 * highest priority when resolving the tool's group for auto-approval (see
	 * `fetchToolsList`). Passing `group` as `null`/`undefined` removes the
	 * override so the tool falls back to its server-declared group (or
	 * `"uncategorized"`).
	 */
	async setToolGroup(
		serverName: string,
		source: "global" | "project",
		toolName: string,
		group: string | null | undefined,
	): Promise<void> {
		try {
			const connection = this.findConnection(serverName, source)
			if (!connection) {
				throw new Error(`Server ${serverName} with source ${source} not found`)
			}

			// Validate the group up front (when one was provided). Any slug is
			// accepted: this is the path by which a name typed into the MCP group
			// dropdown CREATES a category, so it is registered here rather than only
			// on the re-list that follows the write.
			if (group != null) {
				toolGroupNameSchema.parse(group)
				registerToolGroup(group)
			}

			// Resolve the correct config file for this server's source.
			let configPath: string
			if (source === "project") {
				const projectMcpPath = await this.getProjectMcpPath()
				if (!projectMcpPath) {
					throw new Error("Project MCP configuration file not found")
				}
				configPath = projectMcpPath
			} else {
				configPath = await this.getMcpSettingsFilePath()
			}

			const normalizedPath = process.platform === "win32" ? configPath.replace(/\\/g, "/") : configPath
			const content = await fs.readFile(normalizedPath, "utf-8")
			const config = JSON.parse(content)

			if (!config.mcpServers || !config.mcpServers[serverName]) {
				throw new Error(`Server ${serverName} not found in config`)
			}

			const serverEntry = config.mcpServers[serverName]
			const existingGroups: Record<string, string> =
				serverEntry.toolGroups && typeof serverEntry.toolGroups === "object" ? serverEntry.toolGroups : {}

			if (group == null) {
				delete existingGroups[toolName]
			} else {
				existingGroups[toolName] = group
			}

			// Keep the file tidy: drop the key entirely when no overrides remain.
			if (Object.keys(existingGroups).length > 0) {
				serverEntry.toolGroups = existingGroups
			} else {
				delete serverEntry.toolGroups
			}

			// Suppress the file watcher's restart while we write programmatically.
			if (this.flagResetTimer) {
				clearTimeout(this.flagResetTimer)
			}
			this.isProgrammaticUpdate = true
			try {
				await safeWriteJson(normalizedPath, config, { prettyPrint: true })
			} finally {
				this.flagResetTimer = setTimeout(() => {
					this.isProgrammaticUpdate = false
					this.flagResetTimer = undefined
				}, 600)
			}

			// Re-fetch the tool list so the resolved `group` updates in the UI
			// without a full server reconnect.
			connection.server.tools = await this.fetchToolsList(serverName, source)
			await this.notifyWebviewOfServerChanges()
		} catch (error) {
			this.showErrorMessage(`Failed to update group for tool ${toolName}`, error)
			throw error
		}
	}

	/**
	 * Handles enabling/disabling MCP globally
	 * @param enabled Whether MCP should be enabled or disabled
	 * @returns Promise<void>
	 */
	async handleMcpEnabledChange(enabled: boolean): Promise<void> {
		if (!enabled) {
			// If MCP is being disabled, disconnect all servers with error handling
			const existingConnections = [...this.connections]
			const disconnectionErrors: Array<{ serverName: string; error: string }> = []

			for (const conn of existingConnections) {
				try {
					await this.deleteConnection(conn.server.name, conn.server.source)
				} catch (error) {
					const errorMessage = error instanceof Error ? error.message : String(error)
					disconnectionErrors.push({
						serverName: conn.server.name,
						error: errorMessage,
					})
					mcpSysLog.error(`Failed to disconnect MCP server ${conn.server.name}: ${errorMessage}`)
				}
			}

			// If there were errors, notify the user
			if (disconnectionErrors.length > 0) {
				const errorSummary = disconnectionErrors.map((e) => `${e.serverName}: ${e.error}`).join("\n")
				getHost().notifier.warn(
					t("mcp:errors.disconnect_servers_partial", {
						count: disconnectionErrors.length,
						errors: errorSummary,
					}),
				)
			}

			// Re-initialize servers to track them in disconnected state
			try {
				await this.refreshAllConnections()
			} catch (error) {
				mcpSysLog.error(`Failed to refresh MCP connections after disabling: ${error}`)
				getHost().notifier.error(t("mcp:errors.refresh_after_disable"))
			}
		} else {
			// If MCP is being enabled, reconnect all servers
			try {
				await this.refreshAllConnections()
			} catch (error) {
				mcpSysLog.error(`Failed to refresh MCP connections after enabling: ${error}`)
				getHost().notifier.error(t("mcp:errors.refresh_after_enable"))
			}
		}
	}

	async dispose(): Promise<void> {
		// Prevent multiple disposals
		if (this.isDisposed) {
			return
		}

		this.isDisposed = true

		// Clear all debounce timers
		for (const timer of this.configChangeDebounceTimers.values()) {
			clearTimeout(timer)
		}

		this.configChangeDebounceTimers.clear()

		// Clear flag reset timer and reset programmatic update flag
		if (this.flagResetTimer) {
			clearTimeout(this.flagResetTimer)
			this.flagResetTimer = undefined
		}

		this.isProgrammaticUpdate = false
		this.removeAllFileWatchers()

		for (const connection of this.connections) {
			try {
				await this.deleteConnection(connection.server.name, connection.server.source)
			} catch (error) {
				mcpSysLog.error(`Failed to close connection for ${connection.server.name}:`, error)
			}
		}

		this.connections = []

		for (const watcher of this.settingsWatchers) {
			watcher.dispose()
		}
		this.settingsWatchers = []

		if (this.projectMcpWatcher) {
			this.projectMcpWatcher.dispose()
			this.projectMcpWatcher = undefined
		}

		this.disposables.forEach((d) => d.dispose())
	}
}
