import { type ShoferAPI, ShoferEventName } from "@shofer/types"

import type {
	AgentApi,
	AskResponse,
	ChangedFilesPayload,
	CheckpointDiffEntry,
	CheckpointDiffOptions,
	CheckpointRestoreOptions,
	CreateTaskInput,
	ServerEvent,
	SyncedSecrets,
	SyncedSettings,
} from "@shofer/types"

/** Construction options for {@link ShoferApiAgent}. */
export interface ShoferApiAgentOptions {
	/**
	 * Whether to honor the per-task `apiConfiguration` a controller ships with
	 * {@link AgentApi.createTask}. `true` on a `shofer serve` node started WITHOUT
	 * explicit CLI provider/model/api-key/base-url overrides, so the front-end's
	 * API Configuration drives each task (and can differ per task). `false` when
	 * the node has a manual CLI override — the node's own config always wins and
	 * the incoming config is ignored. Defaults to `false` (the in-process/local
	 * adapter, which never receives a remote config anyway).
	 */
	allowClientConfig?: boolean
}

/**
 * Live {@link AgentApi} backed by the in-process {@link ShoferAPI} (§11).
 *
 * This is the adapter that connects the HTTP/SSE transport to the real agent: the
 * HTTP server (`createHttpServer`) becomes drivable by instantiating it with
 * `new ShoferApiAgent(api)`. The remaining wiring is an entrypoint that calls
 * `server.listen(...)` (a `shofer serve` command / extension command); running it
 * fully headless is gated on §9.
 *
 * Note: `ShoferAPI` is current-task-centric (`sendMessage`/`cancelCurrentTask`
 * have no task id), so `sendMessage(taskId, …)` resumes that task first. A future
 * multi-session API would let the transport address tasks directly.
 */
const FORWARDED_EVENTS = [
	ShoferEventName.TaskCreated,
	ShoferEventName.TaskStarted,
	ShoferEventName.TaskCompleted,
	ShoferEventName.TaskAborted,
	ShoferEventName.TaskError,
	ShoferEventName.Message,
	ShoferEventName.TaskModeSwitched,
	// Full-fidelity remote rendering (Shofer Nodes L2): the controller's token/context
	// meter + TaskHeader summary need authoritative token usage from the executor.
	ShoferEventName.TaskTokenUsageUpdated,
] as const

export class ShoferApiAgent implements AgentApi {
	private appliedConfigVersion?: string

	constructor(
		private readonly api: ShoferAPI,
		private readonly options: ShoferApiAgentOptions = {},
	) {}

	/** The last controller config-sync version this node applied (config_sync §6). */
	get configVersion(): string | undefined {
		return this.appliedConfigVersion
	}

	/**
	 * Whether this node accepts controller config pushes (config_sync §Part A). A
	 * self-administered node (`allowClientConfig === false`) ignores `applyConfig`, so
	 * it never echoes the controller's `desiredVersion`; it advertises `managed: false`
	 * on `/health` & `/whoami` so the controller EXEMPTS it from version-gating.
	 */
	get acceptsClientConfig(): boolean {
		return !!this.options.allowClientConfig
	}

	async applyConfig(config: SyncedSettings, version: string, secrets: SyncedSecrets): Promise<void> {
		// Node CLI override wins — ignore controller pushes, same rule as apiConfiguration.
		if (!this.options.allowClientConfig) return
		await this.api.applySyncedSettings(config)
		// Credentials land after the settings they belong to, so a node never briefly
		// holds a store/embedder config it has no key for.
		await this.api.applySyncedSecrets(secrets)
		this.appliedConfigVersion = version // opaque; echoed on /health & /whoami so the controller sees convergence
	}

	async createTask(input: CreateTaskInput): Promise<{ taskId: string }> {
		// Apply the controller's per-task API Configuration only when this node has
		// no local CLI override (`allowClientConfig`). `configuration` is a partial
		// ShoferSettings; ProviderSettings is a subset of it, so it seeds the task's
		// provider/model/base-url/key for this task.
		const configuration =
			this.options.allowClientConfig && input.apiConfiguration ? input.apiConfiguration : undefined
		// `mode` is required and always applied per-task (independent of the config
		// gate above): it selects behaviour, not credentials. Passed as `initialMode`
		// so concurrent tasks can run different modes without a global mode switch.
		const taskId = await this.api.startNewTask({
			text: input.prompt,
			taskId: input.taskId,
			initialMode: input.mode,
			configuration,
		})
		return { taskId }
	}

	async sendMessage(taskId: string, message: string): Promise<void> {
		// Ensure the addressed task has a live instance (rehydrates from the task
		// store after an executor restart; no-op when it is already live), then
		// deliver task-addressed — never current-task-centric, which both raced
		// concurrent tasks and, in headless hosts, routed into a webview invoke
		// that nothing consumes.
		await this.api.resumeTask(taskId).catch(() => {})
		await this.api.sendMessage(message, undefined, taskId)
	}

	async cancelTask(taskId: string): Promise<void> {
		void taskId // ShoferAPI is current-task-centric; the id is implied.
		await this.api.cancelCurrentTask()
	}

	async respondToAsk(taskId: string, response: AskResponse): Promise<void> {
		await this.api.respondToAsk(taskId, response)
	}

	// ── Reverse data channel (Shofer Nodes L3) — delegate to the in-process API ──

	getCheckpointDiff(taskId: string, opts: CheckpointDiffOptions): Promise<CheckpointDiffEntry[]> {
		return this.api.getCheckpointDiff(taskId, opts)
	}

	getTaskChangedFiles(taskId: string): Promise<ChangedFilesPayload> {
		return this.api.getTaskChangedFiles(taskId)
	}

	getChangedFileDiff(taskId: string, relPath: string): Promise<{ original: string | null; final: string | null }> {
		return this.api.getChangedFileDiff(taskId, relPath)
	}

	async restoreCheckpoint(taskId: string, opts: CheckpointRestoreOptions): Promise<void> {
		await this.api.restoreCheckpoint(taskId, opts)
	}

	async revertChangedFile(taskId: string, relPath: string): Promise<void> {
		await this.api.revertChangedFile(taskId, relPath)
	}

	async revertAllChangedFiles(taskId: string): Promise<void> {
		await this.api.revertAllChangedFiles(taskId)
	}

	async acceptChangedFile(taskId: string, relPath: string): Promise<void> {
		await this.api.acceptChangedFile(taskId, relPath)
	}

	async acceptAllChangedFiles(taskId: string): Promise<void> {
		await this.api.acceptAllChangedFiles(taskId)
	}

	subscribe(listener: (event: ServerEvent) => void): () => void {
		const handlers = FORWARDED_EVENTS.map((name) => {
			const handler = (...args: unknown[]) => listener({ type: name, args })
			this.api.on(name as never, handler as never)
			return { name, handler }
		})
		return () => {
			for (const { name, handler } of handlers) {
				this.api.off(name as never, handler as never)
			}
		}
	}
}
