/**
 * agent-mesh — makes a Shofer node a participant in the NATS agent mesh (saas.md §5.5).
 *
 * Pure JS (no native deps). Owns ALL NATS I/O for the node:
 *  - **inbound**: subscribes to configured/subscribed subjects and injects each message into
 *    the running agent via `ctx.agent.notify` (the mesh's async-notification delivery);
 *  - **outbound telemetry**: optionally publishes this node's task events (`onEvent`) to NATS;
 *  - **agent-facing tools**: `mesh_publish` / `mesh_subscribe` / `mesh_unsubscribe` so the agent
 *    can emit and subscribe to events itself, in addition to the static config subscriptions.
 *
 * It is transport-siblings with the (native) temporal-runner plugin but shares nothing with it —
 * they coordinate through Shofer (the runner spawns tasks; this plugin observes + publishes their
 * events). See docs/temporal_plugin.md.
 */

import { defineCustomTool, parametersSchema as z } from "@shofer/types"
import type { PluginContext, ShoferPlugin, PluginEvent } from "@shofer/types"

interface MeshConfig {
	natsUrl: string
	subscriptions: string[]
	deliverMode: "queue" | "interrupt" | "spawn"
	telemetry: boolean
	telemetrySubjectPrefix: string
}

// A minimal structural view of the pieces of the `nats` client we use (avoids a hard type dep).
interface NatsSub {
	unsubscribe(): void
}
interface NatsConn {
	publish(subject: string, data: Uint8Array): void
	subscribe(
		subject: string,
		opts: { callback: (err: unknown, msg: { subject: string; data: Uint8Array }) => void },
	): NatsSub
	drain(): Promise<void>
}

/** Module-singleton mesh state, shared between the background service and the tools. */
const M: {
	ctx?: PluginContext
	cfg?: MeshConfig
	nc?: NatsConn
	subs: Map<string, NatsSub>
	enc: TextEncoder
	dec: TextDecoder
} = { subs: new Map(), enc: new TextEncoder(), dec: new TextDecoder() }

function readConfig(ctx: PluginContext): MeshConfig {
	const c = (ctx.config ?? {}) as Partial<MeshConfig>
	return {
		natsUrl: c.natsUrl || "nats://nats:4222",
		subscriptions: Array.isArray(c.subscriptions) ? c.subscriptions : [],
		deliverMode: c.deliverMode || "queue",
		telemetry: !!c.telemetry,
		telemetrySubjectPrefix: c.telemetrySubjectPrefix || "agents.telemetry",
	}
}

/** Deliver an inbound mesh message into the running agent. */
function inject(subject: string, body: string): void {
	const ctx = M.ctx
	if (!ctx?.agent) return
	void ctx.agent.notify(`[mesh:${subject}] ${body}`, { mode: M.cfg?.deliverMode ?? "queue" })
}

function subscribe(subject: string): void {
	if (!M.nc || M.subs.has(subject)) return
	const sub = M.nc.subscribe(subject, {
		callback: (err, msg) => {
			if (err) return
			inject(msg.subject, M.dec.decode(msg.data))
		},
	})
	M.subs.set(subject, sub)
}

const plugin: ShoferPlugin = {
	name: "agent-mesh",

	async initialize(ctx: PluginContext): Promise<void> {
		M.ctx = ctx
		M.cfg = readConfig(ctx)
		const log = ctx.host?.log
		const notifier = ctx.host?.notifier

		if (!ctx.registerService) {
			const m = "agent-mesh: ctx.registerService unavailable in this host; mesh not started."
			log?.warn(m)
			notifier?.warn(m)
			return
		}

		ctx.registerService({
			name: "agent-mesh-nats",
			start: () => {
				void (async () => {
					try {
						const { connect } = await import("nats")
						M.nc = (await connect({ servers: M.cfg!.natsUrl })) as unknown as NatsConn
						for (const s of M.cfg!.subscriptions) subscribe(s)
						log?.info(
							`agent-mesh: connected to ${M.cfg!.natsUrl}; static subscriptions: [${M.cfg!.subscriptions.join(", ")}]`,
						)
					} catch (e) {
						const err = e instanceof Error ? e : new Error(String(e))
						const code = (err as NodeJS.ErrnoException).code
						const missing =
							code === "ERR_MODULE_NOT_FOUND" ||
							code === "MODULE_NOT_FOUND" ||
							/cannot find (module|package)/i.test(err.message)
						const m = missing
							? `agent-mesh: the 'nats' dependency is not installed (${err.message}). Run \`npm install\` in the plugin folder. Mesh not started.`
							: `agent-mesh: failed to connect to NATS: ${err.message}`
						log?.error(m)
						notifier?.error(m)
					}
				})()
			},
			stop: () => {
				void (async () => {
					for (const s of M.subs.values()) {
						try {
							s.unsubscribe()
						} catch {
							/* best-effort */
						}
					}
					M.subs.clear()
					try {
						await M.nc?.drain()
					} catch {
						/* best-effort */
					}
					M.nc = undefined
				})()
			},
		})
	},

	// Outbound telemetry: publish this node's task events to NATS (opt-in via config.telemetry).
	onEvent(event: PluginEvent): void {
		if (!M.cfg?.telemetry || !M.nc || !event.taskId) return
		try {
			M.nc.publish(`${M.cfg.telemetrySubjectPrefix}.${event.taskId}`, M.enc.encode(JSON.stringify(event)))
		} catch {
			/* best-effort telemetry */
		}
	},

	// Agent-facing tools: emit + subscribe to events on the mesh (async notifications).
	registerTools() {
		return [
			defineCustomTool({
				name: "mesh_publish",
				description:
					"Emit an event/notification onto the NATS agent mesh. Any node/agent subscribed to the subject (statically or via mesh_subscribe) receives it. Fire-and-forget (async).",
				parameters: z.object({
					subject: z
						.string()
						.describe("NATS subject to publish to, e.g. 'project.p1.notice' or 'agents.broadcast'."),
					message: z.string().describe("The payload to send (plain text or JSON string)."),
				}),
				async execute({ subject, message }): Promise<string> {
					if (!M.nc)
						return "mesh_publish error: not connected to NATS yet (the mesh service is still starting or unconfigured)."
					try {
						M.nc.publish(subject, M.enc.encode(message))
						return `Published to '${subject}'.`
					} catch (e) {
						return `mesh_publish error: ${e instanceof Error ? e.message : String(e)}`
					}
				},
			}),
			defineCustomTool({
				name: "mesh_subscribe",
				description:
					"Subscribe to a NATS subject (supports '*'/'>' wildcards). From now on, messages on that subject are delivered to you as notifications on your next turn. Use to watch for async events (e.g. 'ops.alert.*').",
				parameters: z.object({
					subject: z.string().describe("NATS subject/pattern to subscribe to."),
				}),
				async execute({ subject }): Promise<string> {
					if (!M.nc) return "mesh_subscribe error: not connected to NATS yet."
					if (M.subs.has(subject)) return `Already subscribed to '${subject}'.`
					subscribe(subject)
					return `Subscribed to '${subject}'. Matching messages will arrive as notifications.`
				},
			}),
			defineCustomTool({
				name: "mesh_unsubscribe",
				description: "Stop receiving notifications from a previously subscribed NATS subject.",
				parameters: z.object({
					subject: z.string().describe("The subject/pattern to unsubscribe from."),
				}),
				async execute({ subject }): Promise<string> {
					const sub = M.subs.get(subject)
					if (!sub) return `Not subscribed to '${subject}'.`
					try {
						sub.unsubscribe()
					} catch {
						/* best-effort */
					}
					M.subs.delete(subject)
					return `Unsubscribed from '${subject}'.`
				},
			}),
		]
	},
}

export default plugin
