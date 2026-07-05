import { describe, it, expect } from "vitest"

import { estimateUsdCost, type PricingHandler } from "../pricing.js"

const handlerWith = (info: { inputPrice?: number; outputPrice?: number }): PricingHandler => ({
	getModel: () => ({ info }),
})

describe("estimateUsdCost (plugin port)", () => {
	it("uses the handler's model info pricing when available (USD per 1M tokens)", () => {
		const handler = handlerWith({ inputPrice: 3, outputPrice: 15 })
		// 1M prompt @ $3 + 1M completion @ $15 = $18
		expect(estimateUsdCost(handler, 1_000_000, 1_000_000)).toBeCloseTo(18, 6)
		// Fractional token counts scale linearly.
		expect(estimateUsdCost(handler, 500_000, 200_000)).toBeCloseTo(0.5 * 3 + 0.2 * 15, 6)
	})

	it("falls back to conservative defaults when the model reports no price", () => {
		const handler = handlerWith({})
		// Fallback: $0.5 input + $2.0 output per 1M tokens.
		expect(estimateUsdCost(handler, 1_000_000, 1_000_000)).toBeCloseTo(0.5 + 2.0, 6)
	})

	it("ignores zero / negative prices and keeps the fallback for that side", () => {
		const handler = handlerWith({ inputPrice: 0, outputPrice: 10 })
		// input 0 → fallback 0.5; output 10 kept.
		expect(estimateUsdCost(handler, 1_000_000, 1_000_000)).toBeCloseTo(0.5 + 10, 6)
	})

	it("falls back when getModel() throws", () => {
		const handler: PricingHandler = {
			getModel: () => {
				throw new Error("no model")
			},
		}
		expect(estimateUsdCost(handler, 1_000_000, 1_000_000)).toBeCloseTo(0.5 + 2.0, 6)
	})

	it("is zero for zero tokens", () => {
		expect(estimateUsdCost(handlerWith({ inputPrice: 3, outputPrice: 15 }), 0, 0)).toBe(0)
	})
})
