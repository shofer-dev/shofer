// pnpm --filter @shofer/cli test src/agent/__tests__/approval-posture-unreadable.test.ts

import { resolveApprovalPosture, defaultApprovalSeed } from "../approval-posture.js"

type ScopeRoots = Parameters<typeof resolveApprovalPosture>[0]["roots"]

/**
 * The fail-closed half of posture resolution: a `.shofer/` overlay that cannot be
 * read must leave the SEED in place, so the node asks for everything rather than
 * guessing at a posture it never saw.
 */

describe("resolveApprovalPosture with an unreadable overlay", () => {
	it("keeps the seed and configures nothing", async () => {
		const posture = await resolveApprovalPosture({
			roots: undefined as unknown as ScopeRoots,
			seed: defaultApprovalSeed(),
		})

		expect(posture.configuredKeys).toEqual([])
		expect(posture.effective.autoApprovalEnabled).toBe(false)
		expect(posture.seed).toEqual(defaultApprovalSeed())
	})

	it("falls back to the default seed when none is supplied", async () => {
		const posture = await resolveApprovalPosture({ roots: undefined as unknown as ScopeRoots })
		expect(posture.effective).toEqual(defaultApprovalSeed())
		expect(posture.summary).toBeTruthy()
	})
})
