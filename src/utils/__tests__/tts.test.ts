// npx vitest src/utils/__tests__/tts.test.ts

/**
 * The TTS queue is a one-at-a-time speaker with a global enable flag. The
 * behaviours worth pinning are the ones a user notices: nothing is spoken while
 * the toggle is off, utterances do not overlap, `stopTts` drops the whole
 * backlog rather than just the current utterance, and a failing `say` does not
 * wedge the queue for every later message.
 */

type SpeakCallback = (err?: string) => void

const hoisted = vi.hoisted(() => ({
	spoken: [] as Array<{ text: string; speed?: number }>,
	stops: 0,
	pending: [] as SpeakCallback[],
	/** When true, `speak` parks its callback in `pending` instead of settling. */
	defer: false,
	failWith: undefined as string | undefined,
	throwOnRequire: false,
}))

// `tts.ts` reaches for the speaker with a lazy CommonJS `require("say")`, which
// vitest's ESM `vi.mock` registry does not intercept — the real module loads and
// tries to spawn `festival`. Seeding Node's own CJS cache under the resolved id
// is what actually substitutes it.
import { createRequire } from "module"

const nodeRequire = createRequire(import.meta.url)
const sayId = nodeRequire.resolve("say")

nodeRequire.cache[sayId] = {
	id: sayId,
	filename: sayId,
	loaded: true,
	exports: {
		speak: (text: string, _voice: string | undefined, speed: number | undefined, cb?: SpeakCallback) => {
			hoisted.spoken.push({ text, speed })
			if (!cb) return
			if (hoisted.defer) {
				hoisted.pending.push(cb)
				return
			}
			cb(hoisted.failWith)
		},
		stop: () => {
			hoisted.stops++
		},
	},
} as unknown as NodeJS.Module

import { playTts, setTtsEnabled, setTtsSpeed, stopTts } from "../tts"

beforeEach(() => {
	hoisted.spoken = []
	hoisted.pending = []
	hoisted.stops = 0
	hoisted.defer = false
	hoisted.failWith = undefined
	hoisted.throwOnRequire = false
	setTtsEnabled(false)
	setTtsSpeed(1.0)
	stopTts()
})

describe("playTts", () => {
	it("says nothing while TTS is disabled — the default", async () => {
		await playTts("hello")
		expect(hoisted.spoken).toEqual([])
	})

	it("speaks once enabled, at the configured speed", async () => {
		setTtsEnabled(true)
		setTtsSpeed(1.5)

		await playTts("hello")

		expect(hoisted.spoken).toEqual([{ text: "hello", speed: 1.5 }])
	})

	it("fires onStart then onStop around the utterance", async () => {
		setTtsEnabled(true)
		const order: string[] = []

		await playTts("hello", { onStart: () => order.push("start"), onStop: () => order.push("stop") })

		expect(order).toEqual(["start", "stop"])
	})

	it("drains queued utterances IN ORDER rather than overlapping them", async () => {
		setTtsEnabled(true)
		hoisted.defer = true

		const first = playTts("one")
		// A second call while the first is still speaking must not reach `say`.
		const second = playTts("two")
		expect(hoisted.spoken.map((s) => s.text)).toEqual(["one"])

		await second
		hoisted.pending.shift()!(undefined)
		await vi.waitFor(() => expect(hoisted.pending).toHaveLength(1))
		hoisted.pending.shift()!(undefined)
		await first

		expect(hoisted.spoken.map((s) => s.text)).toEqual(["one", "two"])
	})

	it("keeps going after a failed utterance instead of wedging the queue", async () => {
		setTtsEnabled(true)
		hoisted.failWith = "audio device busy"

		await playTts("one")
		hoisted.failWith = undefined
		await playTts("two")

		expect(hoisted.spoken.map((s) => s.text)).toEqual(["one", "two"])
	})
})

describe("stopTts", () => {
	it("stops the speaker AND discards the backlog — a later play does not resurrect it", async () => {
		setTtsEnabled(true)
		hoisted.defer = true

		void playTts("one")
		void playTts("two")
		void playTts("three")

		stopTts()
		expect(hoisted.stops).toBe(1)

		hoisted.defer = false
		await playTts("fresh")

		expect(hoisted.spoken.map((s) => s.text)).toEqual(["one", "fresh"])
	})

	it("is safe to call when nothing is speaking", () => {
		expect(() => stopTts()).not.toThrow()
		expect(hoisted.stops).toBe(0)
	})
})
