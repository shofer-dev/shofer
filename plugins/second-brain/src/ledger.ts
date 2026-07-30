/**
 * ledger — per-task durable judgment, persisted in the plugin's private storage.
 *
 * The ledger holds what the observer has concluded about ONE task: its goal, delivered advisories with their adjudicated outcomes, the
 * gate's refusals, suppressed dedup keys and budget spend. It is task-scoped by design
 * (workspace scope would accumulate confidently stale claims this plugin has no
 * machinery to invalidate) and it is DERIVED state: deleting one is always safe — a
 * running task rebuilds from its next observations.
 */

import type { PluginStorage } from "@shofer/types"

import { LEDGER_MAX_DROPS, LEDGER_TTL_DAYS, type Advisory, type GateDrop, type TaskLedger } from "./types.js"

const LEDGER_DIR = "ledgers"

function ledgerPath(taskId: string): string {
	// Task ids are uuids; keep the filename honest anyway.
	return `${LEDGER_DIR}/${taskId.replace(/[^A-Za-z0-9_-]/g, "_")}.json`
}

export function emptyLedger(taskId: string, now: number): TaskLedger {
	return {
		version: 1,
		taskId,
		updatedAt: now,
		advisories: [],
		drops: [],
		suppressed: [],
		finishGateFirings: [],
		tokens: { prompt: 0, completion: 0 },
		costUsd: 0,
		passes: 0,
	}
}

export class LedgerStore {
	constructor(private readonly storage: PluginStorage) {}

	/** Load (or mint) a task's ledger. Corrupt/foreign versions start fresh — no migrations. */
	async load(taskId: string, now: number): Promise<TaskLedger> {
		try {
			const raw = await this.storage.readFile(ledgerPath(taskId))
			const parsed: unknown = JSON.parse(raw)
			if (
				typeof parsed === "object" &&
				parsed !== null &&
				(parsed as TaskLedger).version === 1 &&
				(parsed as TaskLedger).taskId === taskId
			) {
				return parsed as TaskLedger
			}
		} catch {
			// Missing or unreadable — start fresh.
		}
		return emptyLedger(taskId, now)
	}

	/** Write-through save with the caps applied (notes/drops are bounded, FIFO). */
	async save(ledger: TaskLedger, now: number): Promise<void> {
		ledger.updatedAt = now
		if (ledger.drops.length > LEDGER_MAX_DROPS) ledger.drops = ledger.drops.slice(-LEDGER_MAX_DROPS)
		try {
			await this.storage.writeFile(ledgerPath(ledger.taskId), JSON.stringify(ledger))
		} catch {
			// Best-effort: a failed persist costs durability, never the session.
		}
	}

	async delete(taskId: string): Promise<void> {
		try {
			await this.storage.delete(ledgerPath(taskId))
		} catch {
			// Already gone.
		}
	}

	/** List persisted ledger task ids (filenames), for sweep/forget-all. */
	async list(): Promise<string[]> {
		try {
			const files = await this.storage.list(LEDGER_DIR)
			return files.filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, ""))
		} catch {
			return []
		}
	}

	/** TTL sweep: delete ledgers untouched for LEDGER_TTL_DAYS. Never touches live tasks. */
	async sweep(now: number, liveTaskIds: ReadonlySet<string>): Promise<string[]> {
		const cutoff = now - LEDGER_TTL_DAYS * 24 * 3600 * 1000
		const removed: string[] = []
		for (const id of await this.list()) {
			if (liveTaskIds.has(id)) continue
			try {
				const raw = await this.storage.readFile(ledgerPath(id))
				const parsed = JSON.parse(raw) as TaskLedger
				if (typeof parsed.updatedAt === "number" && parsed.updatedAt < cutoff) {
					await this.storage.delete(ledgerPath(id))
					removed.push(id)
				}
			} catch {
				// Unreadable ledger: derived state, sweep it.
				await this.delete(id)
				removed.push(id)
			}
		}
		return removed
	}
}

/** Record a delivered advisory on the ledger. */
export function recordAdvisory(ledger: TaskLedger, advisory: Advisory): void {
	ledger.advisories.push(advisory)
}

/** Record a gate refusal — a silent drop is indistinguishable from a bug. */
export function recordDrop(ledger: TaskLedger, drop: GateDrop): void {
	ledger.drops.push(drop)
}
