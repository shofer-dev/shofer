/**
 * temporal-runner — makes a Shofer node a **Temporal activity worker** (the runner role).
 *
 * On enable it hosts (via `ctx.registerService`) a Temporal Worker that long-polls a
 * capability-tagged task queue and, on pickup, drives the co-located Shofer as a durable job
 * through the scoped `ctx.agent.spawn` API (plugin_system.md §14): await the structured result,
 * heartbeat, and cancel on Temporal cancellation. It also exposes read-only **introspection
 * tools** so the agent can inspect the pipeline/runner state.
 *
 * It owns Temporal only — it carries **no NATS**. Live telemetry/notifications are the
 * `agent-mesh` plugin's job (they coordinate through Shofer, not with each other). Design:
 * docs/temporal_plugin.md. Requires @temporalio/worker + @temporalio/activity + @temporalio/client
 * installed alongside it (the worker's core is native/per-architecture).
 */

import { defineCustomTool, parametersSchema as z } from "@shofer/types"
import type { PluginContext, ShoferPlugin, PluginTaskResult } from "@shofer/types"

interface RunnerConfig {
	temporalAddress: string
	namespace: string
	taskQueue: string
	activityName: string
	concurrency: number
	heartbeatMs: number
}

interface RunTaskInput {
	prompt: string
	metadata?: Record<string, unknown>
}

function readConfig(ctx: PluginContext): RunnerConfig {
	const c = (ctx.config ?? {}) as Partial<RunnerConfig>
	return {
		temporalAddress: c.temporalAddress || "temporal:7233",
		namespace: c.namespace || "default",
		taskQueue: c.taskQueue || "runner:coding",
		activityName: c.activityName || "runShoferTask",
		concurrency: typeof c.concurrency === "number" ? c.concurrency : 1,
		heartbeatMs: typeof c.heartbeatMs === "number" ? c.heartbeatMs : 10_000,
	}
}

/** Lazily-created pure-JS Temporal client (for the read-only introspection tools). */
let clientPromise:
	| Promise<{
			describeQueue: (q: string) => Promise<string>
			list: (q?: string, n?: number) => Promise<string>
			describe: (id: string) => Promise<string>
	  }>
	| undefined

function getClient(cfg: RunnerConfig) {
	if (!clientPromise) {
		clientPromise = (async () => {
			const { Client, Connection } = await import("@temporalio/client")
			const connection = await Connection.connect({ address: cfg.temporalAddress })
			const client = new Client({ connection, namespace: cfg.namespace })
			return {
				async describeQueue(q: string) {
					const res = await client.workflowService.describeTaskQueue({
						namespace: cfg.namespace,
						taskQueue: { name: q },
						taskQueueType: 2 /* ACTIVITY */,
					})
					const pollers = (res.pollers ?? []).map((p) => p.identity).filter(Boolean)
					return `Task queue '${q}': ${pollers.length} activity poller(s)${pollers.length ? " — " + pollers.join(", ") : " (no runners polling)"}.`
				},
				async list(q?: string, n = 10) {
					const out: string[] = []
					for await (const wf of client.workflow.list({ query: q })) {
						out.push(`- ${wf.workflowId} [${wf.type}] status=${wf.status.name}`)
						if (out.length >= n) break
					}
					return out.length ? out.join("\n") : "(no matching workflows)"
				},
				async describe(id: string) {
					const d = await client.workflow.getHandle(id).describe()
					return `Workflow ${id}: type=${d.type} status=${d.status.name} runId=${d.runId} started=${d.startTime?.toISOString?.() ?? "?"}`
				},
			}
		})()
	}
	return clientPromise
}

const plugin: ShoferPlugin = {
	name: "temporal-runner",

	async initialize(ctx: PluginContext): Promise<void> {
		const cfg = readConfig(ctx)
		const log = ctx.host?.log
		const notifier = ctx.host?.notifier
		const fail = (m: string) => {
			log?.error(m)
			notifier?.error(m)
		}

		if (!ctx.agent) {
			fail(
				"temporal-runner: ctx.agent is unavailable — needs permissions.agent and a host that wires the agent seam. Worker not started.",
			)
			return
		}
		if (!ctx.registerService) {
			fail("temporal-runner: ctx.registerService is unavailable in this host. Worker not started.")
			return
		}

		let worker: { run(): Promise<void>; shutdown(): void } | undefined

		ctx.registerService({
			name: "temporal-worker",
			start: () => {
				void (async () => {
					try {
						const { Worker, NativeConnection } = await import("@temporalio/worker")
						const activityCtx = await import("@temporalio/activity")

						// The activity drives Shofer as a durable job (§14). Non-determinism is
						// isolated here — this is an Activity, never a Workflow.
						const runShoferTask = async (input: RunTaskInput): Promise<PluginTaskResult> => {
							const actx = activityCtx.Context.current()
							const handle = await ctx.agent!.spawn(input.prompt, { metadata: input.metadata })
							const unsub = handle.onEvent(() => actx.heartbeat({ taskId: handle.taskId }))
							const hb = setInterval(() => actx.heartbeat({ taskId: handle.taskId }), cfg.heartbeatMs)
							actx.cancellationSignal.addEventListener("abort", () => void handle.cancel())
							try {
								return await handle.result()
							} finally {
								unsub()
								clearInterval(hb)
							}
						}

						const w = await Worker.create({
							connection: await NativeConnection.connect({ address: cfg.temporalAddress }),
							namespace: cfg.namespace,
							taskQueue: cfg.taskQueue,
							maxConcurrentActivityTaskExecutions: Math.max(1, cfg.concurrency),
							activities: { [cfg.activityName]: runShoferTask },
						})
						worker = w
						log?.info(
							`temporal-runner: worker polling ${cfg.temporalAddress} ns=${cfg.namespace} queue=${cfg.taskQueue} (${cfg.activityName})`,
						)
						await w.run()
					} catch (e) {
						const err = e instanceof Error ? e : new Error(String(e))
						const code = (err as NodeJS.ErrnoException).code
						const missingDep =
							code === "ERR_MODULE_NOT_FOUND" ||
							code === "MODULE_NOT_FOUND" ||
							/cannot find (module|package)/i.test(err.message)
						fail(
							missingDep
								? `temporal-runner: required dependencies are not installed (${err.message}). This plugin needs @temporalio/worker, @temporalio/activity and @temporalio/client installed in its directory — run \`npm install\` in the plugin folder (the native @temporalio core is per-architecture). Worker not started.`
								: `temporal-runner: worker failed to start: ${err.message}`,
						)
					}
				})()
			},
			stop: () => {
				try {
					worker?.shutdown()
				} catch {
					/* best-effort */
				}
			},
		})
	},

	// Read-only introspection tools so the agent can inspect the pipeline/runner state.
	registerTools(ctx: PluginContext) {
		const cfg = readConfig(ctx)
		const guard = async (fn: (c: Awaited<ReturnType<typeof getClient>>) => Promise<string>): Promise<string> => {
			try {
				return await fn(await getClient(cfg))
			} catch (e) {
				return `temporal error: ${e instanceof Error ? e.message : String(e)}`
			}
		}
		return [
			defineCustomTool({
				name: "temporal_task_queue_status",
				description:
					"Introspect a Temporal task queue: how many runner workers are polling it (pool health). Read-only.",
				parameters: z.object({
					taskQueue: z.string().describe("Task queue to inspect (e.g. 'runner:coding').").optional(),
				}),
				async execute({ taskQueue }): Promise<string> {
					return guard((c) => c.describeQueue(taskQueue || cfg.taskQueue))
				},
			}),
			defineCustomTool({
				name: "temporal_list_workflows",
				description:
					"List Temporal workflow executions (optionally filtered by a Temporal visibility query). Read-only.",
				parameters: z.object({
					query: z
						.string()
						.describe("Optional Temporal list filter, e.g. \"ExecutionStatus='Running'\".")
						.optional(),
					limit: z.number().describe("Max results (default 10).").optional(),
				}),
				async execute({ query, limit }): Promise<string> {
					return guard((c) => c.list(query, limit ?? 10))
				},
			}),
			defineCustomTool({
				name: "temporal_describe_workflow",
				description:
					"Describe a Temporal workflow execution by id (type, status, runId, start time). Read-only.",
				parameters: z.object({
					workflowId: z.string().describe("The workflow id to describe."),
				}),
				async execute({ workflowId }): Promise<string> {
					return guard((c) => c.describe(workflowId))
				},
			}),
		]
	},
}

export default plugin
