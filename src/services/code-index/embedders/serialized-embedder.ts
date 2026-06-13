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
		const response = await this.lane(() => this.inner.createEmbeddings(texts, model, signal))
		// Guard against silent text↔vector misalignment. The scanner and file
		// watcher pair blocks to vectors POSITIONALLY (embeddings[i] ↔ block[i]),
		// so a provider that drops an over-long item, sub-batches lossily, or
		// returns a short/reordered batch would store every subsequent block
		// under the WRONG embedding — a corruption that silently persists in
		// Qdrant and poisons search. Fail the batch loudly instead; the
		// scanner/watcher retry+error paths surface it rather than upserting
		// misaligned vectors.
		if (response.embeddings.length !== texts.length) {
			throw new Error(
				`Embedding count mismatch: requested ${texts.length} texts but received ` +
					`${response.embeddings.length} embeddings. Refusing to upsert misaligned vectors.`,
			)
		}
		return response
	}

	async validateConfiguration(): Promise<{ valid: boolean; error?: string }> {
		return this.inner.validateConfiguration()
	}

	get embedderInfo(): EmbedderInfo {
		return this.inner.embedderInfo
	}
}
