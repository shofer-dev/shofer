// The digest is a stripped-down version of the COMPLETE conversation: append-only,
// never evicted, never compacted, byte-stable as a prefix. These pin the completeness
// property the detectors rely on — the first observation is still there after ten
// thousand more.

import { ConversationDigest } from "../src/digest.js"

const T0 = 1_700_000_000_000

describe("ConversationDigest", () => {
	it("keeps everything: the first entry survives arbitrarily many appends", () => {
		const digest = new ConversationDigest()
		digest.appendObservation({ at: T0, kind: "user", text: "the original goal: port the plugin" })
		for (let i = 0; i < 10_000; i++) {
			digest.appendObservation({ at: T0 + i, kind: "tool", text: `tool call number ${i}` })
		}
		const rendered = digest.render()
		expect(rendered.startsWith("[")).toBe(true)
		expect(rendered).toContain("the original goal: port the plugin")
		expect(rendered).toContain("tool call number 9999")
	})

	it("is a byte-stable prefix: appending never rewrites what was rendered before", () => {
		const digest = new ConversationDigest()
		digest.appendObservation({ at: T0, kind: "narration", text: "first" })
		digest.appendFeedback(1, T0 + 1000, [{ detector: "default", verdict: "silent" }])
		const before = digest.render()
		digest.appendObservation({ at: T0 + 2000, kind: "tool", text: "second" })
		const after = digest.render()
		expect(after.startsWith(before)).toBe(true)
	})

	it("counts chars monotonically (the trigger/cap input)", () => {
		const digest = new ConversationDigest()
		const c0 = digest.chars
		digest.appendObservation({ at: T0, kind: "tool", text: "x".repeat(100) })
		expect(digest.chars).toBeGreaterThan(c0 + 100)
	})
})
