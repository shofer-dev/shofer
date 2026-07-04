/**
 * plugin-services — the supervisor behind `ctx.registerService` (design §6.11 G7;
 * Phase 6, P6.G7).
 *
 * A plugin registers a long-lived background service (`{ name, start, stop }`) that is
 * tied to its lifecycle: `start()` runs when the plugin is enabled+active, `stop()` on
 * disable/uninstall/deactivate. The {@link PluginServiceSupervisor} owns the registry and
 * **isolates** every service: a `start`/`stop` that throws or hangs is bounded by
 * {@link PLUGIN_SERVICE_TIMEOUT_MS} and turned into a shown+logged warning — it can never
 * crash or stall the host. This is the one capability no prior phase covered.
 *
 * Host-agnostic: no `vscode`, no `node:*`. The {@link PluginManager} drives it
 * (start after load, stop on unload); the plugin only sees the {@link HostDisposable}
 * that `registerService` returns.
 */

import type { HostDisposable, PluginService } from "@shofer/types"

import { warnPlugin } from "./plugin-warnings.js"

/**
 * Per-service wall-clock budget for `start`/`stop` (design §6.11 G7). A service that
 * exceeds it is abandoned (left running in the background) with a warning, so one hanging
 * service can never block plugin activation/teardown.
 */
export const PLUGIN_SERVICE_TIMEOUT_MS = 5000

/** A registered service plus its owner + started state. */
interface ServiceRecord {
	pluginName: string
	service: PluginService
	started: boolean
}

/**
 * Race `promise` against a {@link PLUGIN_SERVICE_TIMEOUT_MS} timer. Resolves `true` if the
 * promise settled in time, `false` on timeout. Rejections propagate (the caller isolates
 * them). The timer is always cleared so it never keeps the event loop alive.
 */
async function withServiceTimeout(promise: Promise<void>, timeoutMs = PLUGIN_SERVICE_TIMEOUT_MS): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined
	const timeout = new Promise<false>((resolve) => {
		timer = setTimeout(() => resolve(false), timeoutMs)
	})
	try {
		const result = await Promise.race([promise.then(() => true as const), timeout])
		return result
	} finally {
		if (timer) clearTimeout(timer)
	}
}

export class PluginServiceSupervisor {
	private readonly records: ServiceRecord[] = []
	private readonly warn: (message: string) => void

	constructor(warn: (message: string) => void = warnPlugin) {
		this.warn = warn
	}

	/**
	 * Register a service for `pluginName` (design §6.11 G7). The service is **not** started
	 * here — {@link startForPlugin} starts it once the plugin is active (so a plugin that
	 * registers during `initialize` starts cleanly). Returns a {@link HostDisposable} that
	 * stops (best-effort) and removes just this service.
	 */
	register(pluginName: string, service: PluginService): HostDisposable {
		const record: ServiceRecord = { pluginName, service, started: false }
		this.records.push(record)
		return {
			dispose: () => {
				const idx = this.records.indexOf(record)
				if (idx !== -1) this.records.splice(idx, 1)
				// Fire-and-forget the stop; a synchronous dispose must not block on it.
				void this.stopOne(record)
			},
		}
	}

	/** Number of registered (not-yet-removed) services for `pluginName` — for diagnostics/tests. */
	countFor(pluginName: string): number {
		return this.records.filter((r) => r.pluginName === pluginName).length
	}

	/** Start every not-yet-started service for `pluginName`, each supervised + isolated. */
	async startForPlugin(pluginName: string): Promise<void> {
		for (const record of this.records.filter((r) => r.pluginName === pluginName && !r.started)) {
			record.started = true
			await this.runSupervised(record, "start", () => Promise.resolve(record.service.start()))
		}
	}

	/** Stop **and remove** every service for `pluginName`, each supervised + isolated. */
	async stopForPlugin(pluginName: string): Promise<void> {
		const owned = this.records.filter((r) => r.pluginName === pluginName)
		for (const record of owned) {
			const idx = this.records.indexOf(record)
			if (idx !== -1) this.records.splice(idx, 1)
			await this.stopOne(record)
		}
	}

	/** Stop a single service (if started + it declares `stop`), supervised + isolated. */
	private async stopOne(record: ServiceRecord): Promise<void> {
		if (!record.started || !record.service.stop) return
		record.started = false
		await this.runSupervised(record, "stop", () => Promise.resolve(record.service.stop!()))
	}

	/** Run `op` under the timeout with per-service error isolation (never rethrows). */
	private async runSupervised(
		record: ServiceRecord,
		phase: "start" | "stop",
		op: () => Promise<void>,
	): Promise<void> {
		try {
			const finished = await withServiceTimeout(op())
			if (!finished) {
				this.warn(
					`[plugin:${record.pluginName}] service "${record.service.name}" ${phase} exceeded ` +
						`${PLUGIN_SERVICE_TIMEOUT_MS}ms — left running in the background.`,
				)
			}
		} catch (error) {
			this.warn(
				`[plugin:${record.pluginName}] service "${record.service.name}" ${phase} failed: ${String(error)} — isolated.`,
			)
		}
	}
}
