/**
 * temporal-runner — a Shofer plugin that makes a Shofer node a **Temporal activity worker**.
 *
 * On enable it hosts (via `ctx.registerService`) a Temporal Worker that long-polls a
 * capability-tagged task queue and, on pickup, drives the co-located Shofer as a durable job
 * through the scoped `ctx.agent.spawn` API (plugin_system.md §14): await the structured
 * result, stream telemetry to NATS, heartbeat, and cancel on Temporal cancellation.
 *
 * Design: docs/temporal_plugin.md. Requires its own deps (see package.json) —
 * `@temporalio/worker`, `@temporalio/activity`, `nats` — installed alongside the plugin.
 */

import type { PluginContext, ShoferPlugin, PluginTaskResult } from "@shofer/types"

interface RunnerConfig {
	temporalAddress: string
	namespace: string
	taskQueue: string
	activityName: string
	concurrency: number
	natsUrl: string
	heartbeatMs: number
}

/** Input a pipeline workflow passes to the runShoferTask activity. */
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
		natsUrl: c.natsUrl || "",
		heartbeatMs: typeof c.heartbeatMs === "number" ? c.heartbeatMs : 10_000,
	}
}

const plugin: ShoferPlugin = {
	name: "temporal-runner",

	async initialize(ctx: PluginContext): Promise<void> {
		const cfg = readConfig(ctx)
		const log = ctx.host?.log
		const notifier = ctx.host?.notifier
		// Surface a problem both to the plugin log AND to the user (toast) — a runner that
		// can't start should never fail silently.
		const fail = (m: string) => {
			log?.error(m)
			notifier?.error(m)
		}

		if (!ctx.agent) {
			fail(
				"temporal-runner: ctx.agent is unavailable — the plugin needs permissions.agent and a host that wires the agent seam. Worker not started.",
			)
			return
		}
		if (!ctx.registerService) {
			fail("temporal-runner: ctx.registerService is unavailable in this host. Worker not started.")
			return
		}

		// Deferred, dynamic imports so a Shofer without these deps (or with the plugin
		// disabled) never pays for them, and the plugin degrades to a warning instead of a
		// load-time crash.
		let worker: { run(): Promise<void>; shutdown(): Promise<void> } | undefined
		let nats: { publish(subject: string, data: Uint8Array): void; drain(): Promise<void> } | undefined

		ctx.registerService({
			name: "temporal-worker",
			start: () => {
				void (async () => {
					try {
						const { Worker, NativeConnection } = await import("@temporalio/worker")
						const activityCtx = await import("@temporalio/activity")

						if (cfg.natsUrl) {
							try {
								const { connect } = await import("nats")
								nats = (await connect({ servers: cfg.natsUrl })) as unknown as typeof nats
							} catch (e) {
								log?.warn(`temporal-runner: NATS connect failed (${String(e)}); telemetry disabled`)
							}
						}
						const enc = new TextEncoder()

						const connection = await NativeConnection.connect({ address: cfg.temporalAddress })

						// The activity drives Shofer as a durable job (§14). Non-determinism is
						// isolated here — this is an Activity, never a Workflow.
						const runShoferTask = async (input: RunTaskInput): Promise<PluginTaskResult> => {
							const actx = activityCtx.Context.current()
							const handle = await ctx.agent!.spawn(input.prompt, { metadata: input.metadata })

							const unsub = handle.onEvent((e) => {
								if (nats)
									nats.publish(`agents.telemetry.${handle.taskId}`, enc.encode(JSON.stringify(e)))
								actx.heartbeat({ taskId: handle.taskId, event: e.name })
							})
							const hb = setInterval(() => actx.heartbeat({ taskId: handle.taskId }), cfg.heartbeatMs)
							// Temporal cancellation (human cancel / kill switch) → abort the Shofer task.
							actx.cancellationSignal.addEventListener("abort", () => void handle.cancel())

							try {
								return await handle.result()
							} finally {
								unsub()
								clearInterval(hb)
							}
						}

						worker = await Worker.create({
							connection,
							namespace: cfg.namespace,
							taskQueue: cfg.taskQueue,
							maxConcurrentActivityExecutions: Math.max(1, cfg.concurrency),
							activities: { [cfg.activityName]: runShoferTask },
						})

						log?.info(
							`temporal-runner: worker polling ${cfg.temporalAddress} ns=${cfg.namespace} queue=${cfg.taskQueue} (${cfg.activityName})`,
						)
						await worker.run()
					} catch (e) {
						const err = e instanceof Error ? e : new Error(String(e))
						const code = (err as NodeJS.ErrnoException).code
						const missingDep =
							code === "ERR_MODULE_NOT_FOUND" ||
							code === "MODULE_NOT_FOUND" ||
							/cannot find (module|package)/i.test(err.message)
						fail(
							missingDep
								? `temporal-runner: required dependencies are not installed (${err.message}). This plugin needs @temporalio/worker, @temporalio/activity and nats installed in its directory — run \`npm install\` in the plugin folder (the native @temporalio core is per-architecture). Worker not started.`
								: `temporal-runner: worker failed to start: ${err.message}`,
						)
					}
				})()
			},
			stop: () => {
				void (async () => {
					try {
						await worker?.shutdown()
					} catch {
						/* best-effort */
					}
					try {
						await nats?.drain()
					} catch {
						/* best-effort */
					}
				})()
			},
		})
	},
}

export default plugin
