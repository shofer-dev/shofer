import type { EventEmitter } from "events"
import type { Socket } from "net"

import type { ShoferEvents } from "./events.js"
import type { ShoferSettings } from "./global-settings.js"
import type { HistoryItem } from "./history.js"
import type { ProviderSettingsEntry, ProviderSettings } from "./provider-settings.js"
import type { IpcMessage, IpcServerEvents } from "./ipc.js"

export type ShoferAPIEvents = ShoferEvents

export interface ShoferAPI extends EventEmitter<ShoferAPIEvents> {
	/**
	 * Starts a new task with an optional initial message and images.
	 * @param task Optional initial task message.
	 * @param images Optional array of image data URIs (e.g., "data:image/webp;base64,...").
	 * @returns The ID of the new task.
	 */
	startNewTask({
		configuration,
		text,
		images,
		newTab,
	}: {
		configuration?: ShoferSettings
		text?: string
		images?: string[]
		newTab?: boolean
	}): Promise<string>
	/**
	 * Resumes a task with the given ID.
	 * @param taskId The ID of the task to resume.
	 * @throws Error if the task is not found in the task history.
	 */
	resumeTask(taskId: string): Promise<void>
	/**
	 * Checks if a task with the given ID is in the task history.
	 * @param taskId The ID of the task to check.
	 * @returns True if the task is in the task history, false otherwise.
	 */
	isTaskInHistory(taskId: string): Promise<boolean>
	/**
	 * Returns the current task stack.
	 * @returns An array of task IDs.
	 */
	getCurrentTaskStack(): string[]
	/**
	 * Clears the current task.
	 */
	clearCurrentTask(lastMessage?: string): Promise<void>
	/**
	 * Cancels the current task.
	 */
	cancelCurrentTask(): Promise<void>
	/**
	 * Sends a message to the current task.
	 * @param message Optional message to send.
	 * @param images Optional array of image data URIs (e.g., "data:image/webp;base64,...").
	 */
	sendMessage(message?: string, images?: string[]): Promise<void>
	/**
	 * Removes a queued message by ID from the current task's message queue.
	 * @param messageId The ID of the queued message to remove.
	 */
	deleteQueuedMessage(messageId: string): void
	/**
	 * Simulates pressing the primary button in the chat interface.
	 */
	pressPrimaryButton(): Promise<void>
	/**
	 * Simulates pressing the secondary button in the chat interface.
	 */
	pressSecondaryButton(): Promise<void>
	/**
	 * Returns true if the API is ready to use.
	 */
	isReady(): boolean
	/**
	 * Returns the current configuration.
	 * @returns The current configuration.
	 */
	getConfiguration(): ShoferSettings
	/**
	 * Sets the configuration for the current task.
	 * @param values An object containing key-value pairs to set.
	 */
	setConfiguration(values: ShoferSettings): Promise<void>
	/**
	 * Returns a list of all configured profile names
	 * @returns Array of profile names
	 */
	getProfiles(): string[]
	/**
	 * Returns the profile entry for a given name
	 * @param name The name of the profile
	 * @returns The profile entry, or undefined if the profile does not exist
	 */
	getProfileEntry(name: string): ProviderSettingsEntry | undefined
	/**
	 * Creates a new API configuration profile
	 * @param name The name of the profile
	 * @param profile The profile to create; defaults to an empty object
	 * @param activate Whether to activate the profile after creation; defaults to true
	 * @returns The ID of the created profile
	 * @throws Error if the profile already exists
	 */
	createProfile(name: string, profile?: ProviderSettings, activate?: boolean): Promise<string>
	/**
	 * Updates an existing API configuration profile
	 * @param name The name of the profile
	 * @param profile The profile to update
	 * @param activate Whether to activate the profile after update; defaults to true
	 * @returns The ID of the updated profile
	 * @throws Error if the profile does not exist
	 */
	updateProfile(name: string, profile: ProviderSettings, activate?: boolean): Promise<string | undefined>
	/**
	 * Creates a new API configuration profile or updates an existing one
	 * @param name The name of the profile
	 * @param profile The profile to create or update; defaults to an empty object
	 * @param activate Whether to activate the profile after upsert; defaults to true
	 * @returns The ID of the upserted profile
	 */
	upsertProfile(name: string, profile: ProviderSettings, activate?: boolean): Promise<string | undefined>
	/**
	 * Deletes a profile by name
	 * @param name The name of the profile to delete
	 * @throws Error if the profile does not exist
	 */
	deleteProfile(name: string): Promise<void>
	/**
	 * Returns the name of the currently active profile
	 * @returns The profile name, or undefined if no profile is active
	 */
	getActiveProfile(): string | undefined
	/**
	 * Changes the active API configuration profile
	 * @param name The name of the profile to activate
	 * @throws Error if the profile does not exist
	 */
	setActiveProfile(name: string): Promise<string | undefined>

	// ─── Task History & Management (TaskSelector parity) ───────────

	/**
	 * Returns all task history items as a flat array.
	 * This is the data backing the TaskSelector UI panel.
	 * @returns Array of history items (sorted by ts descending).
	 */
	getTaskHistoryItems(): HistoryItem[]

	/**
	 * Switches the active task to the one with the given ID.
	 * In VSCode this loads the task into the chat view; in headless
	 * mode it creates the task on the internal stack.
	 * @param taskId The ID of the task to focus/switch to.
	 * @param options.keepCurrentTask When true, does not dismiss the current task.
	 * @throws Error if the task is not found.
	 */
	showTaskWithId(taskId: string, options?: { keepCurrentTask?: boolean }): Promise<void>

	/**
	 * Renames a task by ID. The name appears in TaskSelector and HistoryView.
	 * @param taskId The ID of the task to rename.
	 * @param name The new display name for the task.
	 * @throws Error if the task is not found.
	 */
	renameTask(taskId: string, name: string): Promise<void>

	/**
	 * Archives a task (soft-removes from the main task listing).
	 * Archived tasks are moved to the "Archived" collapsible section.
	 * @param taskId The ID of the task to archive.
	 */
	archiveTask(taskId: string): Promise<void>

	/**
	 * Unarchives a previously archived task.
	 * @param taskId The ID of the task to unarchive.
	 */
	unarchiveTask(taskId: string): Promise<void>

	/**
	 * Pins a task (shows it at the top of the task list).
	 * @param taskId The ID of the task to pin.
	 */
	pinTask(taskId: string): Promise<void>

	/**
	 * Unpins a previously pinned task.
	 * @param taskId The ID of the task to unpin.
	 */
	unpinTask(taskId: string): Promise<void>

	/**
	 * Deletes a task and (optionally) all its subtasks from history.
	 * Also cleans up persisted task directories and in-memory instances.
	 * @param taskId The ID of the task to delete.
	 * @param cascadeSubtasks When true (default), also deletes all descendant subtasks.
	 */
	deleteTask(taskId: string, cascadeSubtasks?: boolean): Promise<void>

	// ─── Task Export (data-returning variants) ──────────────────────

	/**
	 * Returns the markdown export content for a task as a string.
	 * This is the same content that `exportTaskWithId` would save to a file,
	 * returned inline for programmatic consumption.
	 * @param taskId The ID of the task to export.
	 * @returns The markdown-formatted task conversation.
	 */
	getTaskMarkdownExport(taskId: string): Promise<string>

	/**
	 * Returns the JSON export trace for a task as a structured object.
	 * This is the same data that `exportTaskWithIdJson` would save to a file,
	 * returned inline for programmatic consumption.
	 * @param taskId The ID of the task to export.
	 * @returns The structured JSON trace (calls, cost, token usage, etc.).
	 */
	getTaskJsonExport(taskId: string): Promise<Record<string, unknown>>

	// ─── Logging ────────────────────────────────────────────────────

	/**
	 * Returns the most recent lines from the extension's output channel buffer.
	 * Useful for headless/CLI consumers that have no VSCode Output panel.
	 * @param maxLines Maximum number of recent lines to return (default: 2000).
	 * @returns Newline-joined log lines.
	 */
	getOutputLogs(maxLines?: number): string

	// ─── Configuration Import/Export ─────────────────────────────────

	/**
	 * Exports the full Shofer configuration (except secrets) as a JSON string.
	 * The resulting string can be saved to a file or transferred to another
	 * instance, then imported via `importConfiguration`.
	 * @returns JSON string of the current ShoferSettings.
	 */
	exportConfiguration(): string

	/**
	 * Imports a Shofer configuration from a JSON string (previously obtained
	 * via `exportConfiguration`). Applies and persists all settings.
	 * @param json JSON string of ShoferSettings to import.
	 * @throws Error if the JSON is invalid or the schema is violated.
	 */
	importConfiguration(json: string): Promise<void>

	// ─── Workflows ─────────────────────────────────────────────────

	/**
	 * Creates and starts a Slang workflow from a .slang source string.
	 *
	 * The workflow is parsed, validated, and launched as a WorkflowTask that
	 * manages its own multi-agent slang-driven loop. The current task (if any)
	 * is moved to the background.
	 *
	 * @param slangSource The .slang source content as a string.
	 * @param flowParams Optional initial parameter values for the flow.
	 * @returns The task ID of the created WorkflowTask.
	 * @throws Error if the slang source has parse errors or contains no flows.
	 */
	createWorkflow(slangSource: string, flowParams?: Record<string, unknown>): Promise<string>

	/**
	 * Discovers available Slang workflows from the project's
	 * `.shofer/workflows/` directory and the user's global
	 * `~/.shofer/workflows/` directory.
	 *
	 * @returns A map of flow name → slang source content.
	 */
	discoverWorkflows(): Promise<Map<string, string>>
}

export interface ShoferIpcServer extends EventEmitter<IpcServerEvents> {
	listen(): void
	broadcast(message: IpcMessage): void
	send(client: string | Socket, message: IpcMessage): void
	get socketPath(): string
	get isListening(): boolean
}
