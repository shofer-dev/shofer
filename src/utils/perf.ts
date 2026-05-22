/**
 * Wall-time instrumentation helper.
 *
 * Wraps any async (or sync) operation, measures wall time, and:
 *   1. Always reports the duration to the registered histogram callback
 *      (the Prometheus pipeline registers itself at module init time).
 *   2. When `process.env.DEBUG` is set, periodically writes p50/p95
 *      summaries to the output channel.
 *
 * Replaces the prior `@perf` decorator, which was unusable because
 * `src/tsconfig.json` sets `experimentalDecorators: true` (legacy / Stage 1
 * signature) while the Stage 3 decorator API needs the opposite, and
 * because `@perf` annotations are trivial to misplace inside JSDoc blocks
 * (where they silently become comments).
 */

import { outputLog } from "./outputChannelLogger"

// ---------------------------------------------------------------------------
// Histogram callback wiring
// ---------------------------------------------------------------------------

let _histogramFn: ((key: string, ms: number) => void) | undefined

/** Install the metrics-registry sink.  Called once from `registry.ts`. */
export function setHistogramCallback(fn: (key: string, ms: number) => void): void {
	_histogramFn = fn
}

// ---------------------------------------------------------------------------
// DEBUG-mode ring buffer (p50/p95 summaries)
// ---------------------------------------------------------------------------

const WINDOW = 50
const _ringBuffers = new Map<string, { durations: number[]; count: number }>()

function writeDebugSummary(key: string, dur: number): void {
	let buf = _ringBuffers.get(key)
	if (!buf) {
		buf = { durations: [], count: 0 }
		_ringBuffers.set(key, buf)
	}
	if (buf.durations.length >= WINDOW) buf.durations.shift()
	buf.durations.push(dur)
	buf.count++

	let summary = ""
	if (buf.count % WINDOW === 0 && buf.durations.length > 0) {
		const sorted = [...buf.durations].sort((a, b) => a - b)
		const p50 = sorted[Math.floor(sorted.length * 0.5)]
		const p95 = sorted[Math.floor(sorted.length * 0.95)]
		summary = ` p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms n=${buf.count}`
	}
	outputLog(`[perf] ${key} dur=${dur.toFixed(1)}ms${summary}`)
}

function record(key: string, dur: number): void {
	if (_histogramFn) _histogramFn(key, dur)
	if (process.env["DEBUG"]) writeDebugSummary(key, dur)
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Time an async operation.  The returned promise resolves with the same
 * value the inner function returned; errors propagate unchanged after the
 * duration has been recorded.
 *
 * ```ts
 * return time("saveShoferMessages", () => this.doSave())
 * ```
 */
export async function time<T>(key: string, fn: () => Promise<T>): Promise<T> {
	const t0 = performance.now()
	try {
		return await fn()
	} finally {
		record(key, performance.now() - t0)
	}
}

/** Synchronous variant — same semantics as {@link time}. */
export function timeSync<T>(key: string, fn: () => T): T {
	const t0 = performance.now()
	try {
		return fn()
	} finally {
		record(key, performance.now() - t0)
	}
}
