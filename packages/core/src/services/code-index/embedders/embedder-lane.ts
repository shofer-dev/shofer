import pLimit, { type LimitFunction } from "p-limit"

import type { EmbedderProvider } from "@shofer/types"

/**
 * Per-provider concurrency limits for the shared embedder lane.
 *
 * The two indexers (code + git-history) each construct their own `IEmbedder`
 * instance but talk to the same remote/local embedding service. Without
 * coordination, simultaneous batches contend for the same backend — most
 * visibly with Ollama, which serialises inference per loaded model and can
 * push the second caller past its request timeout (surfacing as the
 * `embeddings:validation.connectionFailed` AbortError).
 *
 * The lane sits at the `IEmbedder.createEmbeddings` boundary and gates
 * concurrent calls across every embedder constructed from the same provider.
 * Concurrency is keyed by provider so that local/serial backends (Ollama)
 * stay at 1 while cloud APIs that handle parallelism well keep their
 * throughput.
 */
const PROVIDER_CONCURRENCY: Record<EmbedderProvider, number> = {
	ollama: 1, // single-process serial inference; multiple inflight requests queue inside Ollama and time out
	openai: 4,
	"openai-compatible": 4,
	gemini: 4,
	mistral: 4,
	"vercel-ai-gateway": 4,
	bedrock: 4,
	openrouter: 4,
}

const DEFAULT_CONCURRENCY = 4

const lanes = new Map<EmbedderProvider, LimitFunction>()

/**
 * Return the (lazily created) p-limit lane for the given provider. Lanes are
 * module-level singletons — every `IEmbedder` instance for the same provider
 * shares one lane and therefore one concurrency budget across the whole
 * extension host.
 */
export function getEmbedderLane(provider: EmbedderProvider): LimitFunction {
	let lane = lanes.get(provider)
	if (!lane) {
		const concurrency = PROVIDER_CONCURRENCY[provider] ?? DEFAULT_CONCURRENCY
		lane = pLimit(concurrency)
		lanes.set(provider, lane)
	}
	return lane
}

/**
 * Current depth of a provider's embedder lane = running (`activeCount`) plus
 * queued (`pendingCount`) `createEmbeddings` calls. Used for the
 * `shofer_embedder_queue_depth` metric. Returns 0 when the lane hasn't been
 * created yet (no embeddings have run for this provider).
 */
export function getEmbedderLaneDepth(provider: string): number {
	const lane = lanes.get(provider as EmbedderProvider)
	if (!lane) return 0
	return lane.activeCount + lane.pendingCount
}
