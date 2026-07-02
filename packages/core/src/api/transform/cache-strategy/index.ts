export { CacheStrategy } from "./base-strategy.js"
export { MultiPointStrategy } from "./multi-point-strategy.js"
// `ModelInfo` here is the cache-strategy-specific shape; expose it as `CacheModelInfo`
// from the core barrel to avoid colliding with `@shofer/types`' generic `ModelInfo`.
export type {
	ModelInfo as CacheModelInfo,
	CachePoint,
	CacheResult,
	CachePointPlacement,
	CacheStrategyConfig,
} from "./types.js"
