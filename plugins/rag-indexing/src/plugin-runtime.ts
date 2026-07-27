/**
 * The plugin's runtime handles: the live {@link PluginContext}, its resolved settings, and
 * the instruments the indexer publishes.
 *
 * The indexer is a long-lived subsystem, not a request handler — a watcher fires, a batch
 * retries, a cache flushes — so its modules need the host seams at moments no `ctx` is
 * being passed around. Binding once at `initialize` and reading through these accessors is
 * what replaces the `vscode.ExtensionContext` / `vscode.workspace` the code used when it
 * lived in the extension.
 *
 * Everything degrades to a no-op or a default before binding, so a unit test can construct
 * a scanner without standing up a plugin host.
 */

import type { PluginContext } from "@shofer/types"

import { setLanguage } from "./i18n.js"
import { setLogger } from "./logging.js"

let context: PluginContext | undefined

/** Bind the live plugin context (called from `initialize`). */
export function bindRuntime(ctx: PluginContext): void {
	context = ctx
	setLogger(ctx.host?.log)
	setLanguage(ctx.host?.env.language)
}

/** The live context, if the plugin has been initialized. */
export function runtime(): PluginContext | undefined {
	return context
}

/** The workspace the indexer runs against. */
export function workspacePath(): string | undefined {
	return context?.workspacePath ?? context?.cwd
}

/** The host's version, for the user-agent an embedder provider sees. */
export function hostVersion(): string {
	return context?.host?.env.appInfo?.version ?? "unknown"
}

/**
 * A user-configured setting, falling back to `fallback` when unset or the wrong shape.
 *
 * The manifest's `config` schema supplies defaults, so a miss here means the plugin is not
 * initialized (a test) rather than a hole in the configuration.
 */
export function setting<T>(key: string, fallback: T): T {
	const value = context?.config?.[key]
	return value === undefined || value === null ? fallback : (value as T)
}

// ── Instruments ──────────────────────────────────────────────────────────────
//
// The indexer's numbers are the ones an operator watches: how many files are indexed, how
// deep the embedder queue is, how long a cache write takes. They were core metrics while
// the indexer was core; they are the plugin's now, published through `ctx.host.metrics`.

export function incCodeIndexError(subsystem: string, amount = 1): void {
	context?.host?.metrics?.increment(
		"shofer_code_index_errors_total",
		"Total code-index errors by subsystem.",
		{ subsystem },
		amount,
	)
}

export function recordIndexLoadDuration(ms: number): void {
	context?.host?.metrics?.observe("shofer_index_load_duration_ms", "Duration of _index.json load (ms).", ms)
}

export function recordIndexWriteDuration(ms: number): void {
	context?.host?.metrics?.observe("shofer_index_write_duration_ms", "Duration of _index.json write (ms).", ms)
}

/**
 * Segment reuse — how much of a re-index was answered from the cache rather than the
 * embedder. Reuse is the difference between an incremental index that costs pennies and
 * one that re-embeds the repository, so it is worth a number an operator can watch.
 */
export function recordSegmentDedup(counts: { reused: number; embedded: number; deleted: number }): void {
	const metrics = context?.host?.metrics
	if (!metrics) return
	metrics.increment(
		"shofer_code_index_segments_total",
		"Code-index segments by disposition.",
		{ disposition: "reused" },
		counts.reused,
	)
	metrics.increment(
		"shofer_code_index_segments_total",
		"Code-index segments by disposition.",
		{ disposition: "embedded" },
		counts.embedded,
	)
	metrics.increment(
		"shofer_code_index_segments_total",
		"Code-index segments by disposition.",
		{ disposition: "deleted" },
		counts.deleted,
	)
}

export function updateCodeIndexMetrics(fileCount: number, embedderQueueDepth: number, provider: string): void {
	context?.host?.metrics?.gauge("shofer_code_index_files", "Number of indexed files.", fileCount)
	context?.host?.metrics?.gauge(
		"shofer_embedder_queue_depth",
		"Embedder pending-queue depth per provider.",
		embedderQueueDepth,
		{ provider },
	)
}
