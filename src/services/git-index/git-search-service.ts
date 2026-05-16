import type { GitSearchResult, IGitSearchService } from "./interfaces/git"
import type { IEmbedder } from "../code-index/interfaces/embedder"
import type { IVectorStore } from "../code-index/interfaces/vector-store"
import { TelemetryService } from "@shofer/telemetry"
import { TelemetryEventName } from "@shofer/types"

/**
 * Service that embeds a query and searches the git Qdrant collection.
 *
 * Reuses the same IEmbedder and QdrantVectorStore instances as the code index,
 * but targets the git-specific Qdrant collection.
 */
export class GitSearchService implements IGitSearchService {
	constructor(
		private readonly embedder: IEmbedder,
		private readonly vectorStore: IVectorStore,
	) {}

	async search(query: string, minScore: number, maxResults: number): Promise<GitSearchResult[]> {
		try {
			// Generate embedding for the query using the same embedder
			const embeddingResponse = await this.embedder.createEmbeddings([query])
			const vector = embeddingResponse?.embeddings[0]
			if (!vector) {
				throw new Error("Failed to generate embedding for git search query.")
			}

			// Search the git Qdrant collection (not the code collection).
			// The vectorStore already targets the git-specific collection because
			// it was created with the git collection name.
			// IVectorStore.search signature: (queryVector, directoryPrefix?, minScore?, maxResults?)
			const results = await this.vectorStore.search(vector, undefined, minScore, maxResults)

			// Map to GitSearchResult
			return results.map((r) => ({
				id: r.id,
				score: r.score,
				payload: {
					commit_hash: r.payload?.commit_hash ?? "",
					short_hash: r.payload?.short_hash ?? "",
					author: r.payload?.author ?? "",
					author_date: r.payload?.author_date ?? "",
					subject: r.payload?.subject ?? "",
					body: r.payload?.body ?? "",
				},
			}))
		} catch (error) {
			try {
				TelemetryService.instance.captureEvent(TelemetryEventName.CODE_INDEX_ERROR, {
					error: error instanceof Error ? error.message : String(error),
					stack: error instanceof Error ? error.stack : undefined,
					location: "GitSearchService.search",
				})
			} catch {
				// Telemetry may not be initialized yet.
			}
			throw error
		}
	}
}
