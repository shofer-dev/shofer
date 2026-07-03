import { type ShoferAPI, ShoferEventName } from "@shofer/types"

import type { AgentApi, AskResponse, ServerEvent } from "@shofer/types"

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
] as const

export class ShoferApiAgent implements AgentApi {
	constructor(private readonly api: ShoferAPI) {}

	async createTask(input: { prompt: string; taskId?: string }): Promise<{ taskId: string }> {
		const taskId = await this.api.startNewTask({ text: input.prompt, taskId: input.taskId })
		return { taskId }
	}

	async sendMessage(taskId: string, message: string): Promise<void> {
		// Make the addressed task current, then send (ShoferAPI is current-task-centric).
		await this.api.resumeTask(taskId).catch(() => {})
		await this.api.sendMessage(message)
	}

	async cancelTask(taskId: string): Promise<void> {
		void taskId // ShoferAPI is current-task-centric; the id is implied.
		await this.api.cancelCurrentTask()
	}

	async respondToAsk(taskId: string, response: AskResponse): Promise<void> {
		await this.api.respondToAsk(taskId, response)
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
