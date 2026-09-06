import { MultiPointStrategy } from "../multi-point-strategy.js"
import type { CacheStrategyConfig, CachePointPlacement, ModelInfo } from "../types.js"

/**
 * What happens to Bedrock cache points when a conversation OUTGROWS the number
 * of them the model allows.
 *
 * A cache point is a prefix marker: everything before it can be served from the
 * provider's cache on the next request. The budget is fixed (`maxCachePoints`),
 * so once a conversation has used them all, every further turn poses the same
 * question — keep the existing markers, or spend one on the new messages?
 *
 * Moving a marker is not free: it INVALIDATES the cached prefix behind it, so
 * the next request re-pays for everything from there on. That is why the
 * reallocation is gated on a 20% margin rather than on "the new messages are
 * bigger": a marginal win pays the invalidation cost for nothing, repeatedly,
 * on every turn. The two placements combined are the pair with the SMALLEST
 * token gap, so the prefix that is thrown away is the cheapest one to rebuild.
 *
 * The other rule is CONTINUITY: placements survive from one request to the next
 * unchanged wherever possible, because a marker that moves is a marker whose
 * cache never gets used.
 */

const MODEL: ModelInfo = {
	maxTokens: 8192,
	contextWindow: 200_000,
	supportsPromptCache: true,
	maxCachePoints: 3,
	minTokensPerCachePoint: 50,
	cachableFields: ["system", "messages"],
}

/**
 * A message of roughly `words` WORDS. The estimator is word-based rather than
 * character-based, so a long run of one token-less blob counts as one word — a
 * detail worth encoding, because a fixture built from `"x".repeat(n)` measures
 * ~1 token however long it is and silently never reaches any threshold.
 */
const message = (role: "user" | "assistant", words: number) => ({ role, content: "tok ".repeat(words).trim() })

const config = (overrides: Partial<CacheStrategyConfig> = {}): CacheStrategyConfig => ({
	modelInfo: { ...MODEL, ...(overrides.modelInfo ?? {}) },
	systemPrompt: "You are a helpful assistant",
	messages: [],
	usePromptCache: true,
	...overrides,
})

const placementsFor = (overrides: Partial<CacheStrategyConfig>): CachePointPlacement[] =>
	new MultiPointStrategy(config(overrides)).determineOptimalCachePoints().messageCachePointPlacements ?? []

/** A cache point is its own block; a message carries one inside its content. */
const hasCachePoint = (block: unknown): boolean => {
	const candidate = block as { cachePoint?: { type?: string }; content?: unknown[] }
	if (candidate?.cachePoint?.type === "default") return true
	return Array.isArray(candidate?.content) && candidate.content.some((inner) => hasCachePoint(inner))
}

/** A conversation of `count` turns, each `tokens` tokens. */
const conversation = (count: number, words = 100) =>
	Array.from({ length: count }, (_, i) => message(i % 2 === 0 ? "user" : "assistant", words))

describe("a fresh conversation", () => {
	it("places nothing when there is nothing to cache", () => {
		expect(placementsFor({ messages: [message("user", 100)] })).toEqual([])
	})

	it("places nothing when caching is turned off", () => {
		expect(placementsFor({ messages: conversation(6), usePromptCache: false })).toEqual([])
	})

	it("spends its budget from the start of the conversation", () => {
		const placements = placementsFor({ messages: conversation(8) })

		expect(placements.length).toBeGreaterThan(0)
		expect(placements.length).toBeLessThanOrEqual(MODEL.maxCachePoints)
		// Strictly increasing: a marker only ever moves forward.
		expect(placements.map((p) => p.index)).toEqual([...placements.map((p) => p.index)].sort((a, b) => a - b))
	})

	it("places nothing when no range is worth a marker", () => {
		// Below the model's minimum, a cache point costs more than it saves.
		expect(placementsFor({ messages: conversation(4, 1) })).toEqual([])
	})

	it("anchors every marker on a USER message, which is where a prefix ends", () => {
		const placements = placementsFor({ messages: conversation(8) })
		const messages = conversation(8)

		expect(placements.every((p) => messages[p.index]!.role === "user")).toBe(true)
	})
})

describe("a conversation that has grown", () => {
	const previous: CachePointPlacement[] = [
		{ index: 1, type: "message", tokensCovered: 200 },
		{ index: 3, type: "message", tokensCovered: 200 },
	]

	it("KEEPS every previous marker and adds one while the budget allows", () => {
		// Continuity: a marker that moves is a marker whose cache never gets used.
		const placements = placementsFor({
			messages: conversation(8),
			previousCachePointPlacements: previous,
			modelInfo: { ...MODEL, maxCachePoints: 5 },
		})

		expect(placements.slice(0, 2).map((p) => p.index)).toEqual([1, 3])
		expect(placements.length).toBeGreaterThan(2)
	})

	it("keeps the previous markers UNCHANGED when the new messages are too small to matter", () => {
		const placements = placementsFor({
			messages: [...conversation(4), message("user", 1)],
			previousCachePointPlacements: previous,
		})

		expect(placements.map((p) => p.index)).toEqual([1, 3])
	})

	it("drops a previous marker that now points past the end of the conversation", () => {
		// A rewind or a condense can shorten the history under the placements.
		const placements = placementsFor({
			messages: conversation(3),
			previousCachePointPlacements: [
				{ index: 1, type: "message", tokensCovered: 200 },
				{ index: 99, type: "message", tokensCovered: 200 },
			],
			modelInfo: { ...MODEL, maxCachePoints: 5 },
		})

		expect(placements.every((p) => p.index < 3)).toBe(true)
	})
})

describe("reallocating when the budget is full", () => {
	/** Three markers already placed — the whole budget for this model. */
	const full: CachePointPlacement[] = [
		{ index: 1, type: "message", tokensCovered: 100 },
		{ index: 3, type: "message", tokensCovered: 100 },
		{ index: 5, type: "message", tokensCovered: 100 },
	]

	it("COMBINES two markers when the new messages are decisively larger", () => {
		// The combined pair is the cheapest prefix to rebuild, and the 20% margin
		// is what makes rebuilding it worth the invalidation.
		const messages = [...conversation(6, 20), message("user", 5_000), message("assistant", 5_000)]

		const placements = placementsFor({ messages, previousCachePointPlacements: full })

		expect(placements.length).toBeLessThanOrEqual(MODEL.maxCachePoints)
		// A marker now covers the new tail, which had none before.
		expect(placements.some((p) => p.index >= 6)).toBe(true)
	})

	it("REFUSES to reallocate for a marginal gain", () => {
		// Just above the minimum but far below the 20% margin: reallocating here
		// would pay the invalidation cost every single turn.
		const messages = [...conversation(6, 200), message("user", 60)]

		const placements = placementsFor({ messages, previousCachePointPlacements: full })

		expect(placements.map((p) => p.index)).toEqual([1, 3, 5])
	})

	it("never exceeds the model's budget", () => {
		const messages = [...conversation(6, 20), message("user", 9_000)]

		expect(placementsFor({ messages, previousCachePointPlacements: full }).length).toBeLessThanOrEqual(
			MODEL.maxCachePoints,
		)
	})
})

describe("what the caller gets back", () => {
	it("carries the placements so the NEXT request can keep them", () => {
		// The continuity rule only works because the caller round-trips these.
		const result = new MultiPointStrategy(config({ messages: conversation(8) })).determineOptimalCachePoints()

		expect(Array.isArray(result.messageCachePointPlacements)).toBe(true)
	})

	it("caches the system prompt when the model allows it and it is big enough", () => {
		const result = new MultiPointStrategy(
			config({ systemPrompt: "word ".repeat(400), messages: conversation(4) }),
		).determineOptimalCachePoints()

		expect(result.system.some(hasCachePoint)).toBe(true)
	})

	it("leaves the system prompt uncached when it is below the threshold", () => {
		const result = new MultiPointStrategy(
			config({ systemPrompt: "short", messages: conversation(4) }),
		).determineOptimalCachePoints()

		expect(result.system.some(hasCachePoint)).toBe(false)
	})

	it("caches ONLY the system prompt for a model that cannot cache messages", () => {
		const result = new MultiPointStrategy(
			config({
				systemPrompt: "word ".repeat(400),
				messages: conversation(8),
				modelInfo: { ...MODEL, cachableFields: ["system"] },
			}),
		).determineOptimalCachePoints()

		expect(result.system.some(hasCachePoint)).toBe(true)
		expect(result.messages.some(hasCachePoint)).toBe(false)
	})

	it("returns an uncached result when caching is off", () => {
		const result = new MultiPointStrategy(
			config({ messages: conversation(8), usePromptCache: false }),
		).determineOptimalCachePoints()

		expect(result.system.some(hasCachePoint)).toBe(false)
		expect(result.messages.some(hasCachePoint)).toBe(false)
	})
})
