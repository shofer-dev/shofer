import type { LimitFunction } from "p-limit"

import type { EmbedderInfo, EmbeddingResponse, IEmbedder } from "../interfaces/embedder"

/**
 * Decorator that funnels every `createEmbeddings` call through a shared
 * `p-limit` lane, preventing the code-index and git-history indexers from
 * saturating the embedding backend in parallel.
 *
 * - `createEmbeddings` is gated by the lane.
 * - `validateConfiguration` is intentionally NOT gated: it is a one-shot
 *   probe used during setup/diagnostics and must not be blocked by a
 *   long-running batch that is currently occupying the lane (otherwise the
 *   Settings page validation spinner can hang for minutes).
 * - `embedderInfo` is a pure getter and passes through unchanged.
 *
 * See `embedder-lane.ts` for the per-provider concurrency table and the
 * rationale for sharing lanes across embedder instances.
 */
export class SerializedEmbedder implements IEmbedder {
	constructor(
		private readonly inner: IEmbedder,
		private readonly lane: LimitFunction,
	) {}

	async createEmbeddings(texts: string[], model?: string, signal?: AbortSignal): Promise<EmbeddingResponse> {
		return this.lane(() => this.inner.createEmbeddings(texts, model, signal))
	}

	async validateConfiguration(): Promise<{ valid: boolean; error?: string }> {
		return this.inner.validateConfiguration()
	}

	get embedderInfo(): EmbedderInfo {
		return this.inner.embedderInfo
	}
}
