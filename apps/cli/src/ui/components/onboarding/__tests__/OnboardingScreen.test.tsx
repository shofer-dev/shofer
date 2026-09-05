import { render } from "ink-testing-library"

import { OnboardingProviderChoice } from "@/types/index.js"

import { OnboardingScreen } from "../OnboardingScreen.js"
import * as barrel from "../index.js"

const tick = () => new Promise((resolve) => setTimeout(resolve, 20))

/**
 * Ink attaches its stdin listener from an effect, so a key written before that
 * effect lands is dropped on the floor. Every key this screen takes is
 * idempotent (arrows saturate at the ends of a two-item list, and confirming
 * the same option twice fires `onChange` once), so re-pressing until the
 * expectation holds is deterministic rather than a sleep-and-hope.
 */
async function pressUntil(stdin: { write: (data: string) => void }, sequence: string, done: () => boolean) {
	for (let attempt = 0; attempt < 25; attempt++) {
		if (done()) return
		stdin.write(sequence)
		await tick()
	}
	if (!done()) throw new Error(`key ${JSON.stringify(sequence)} never took effect`)
}

describe("OnboardingScreen", () => {
	it("renders the prompt", () => {
		const { lastFrame } = render(<OnboardingScreen onSelect={() => {}} />)
		expect(lastFrame()).toContain("How would you like to connect to an LLM provider?")
	})

	it("offers both provider choices", () => {
		const { lastFrame } = render(<OnboardingScreen onSelect={() => {}} />)
		const output = lastFrame()

		expect(output).toContain("Connect to Shofer Cloud")
		expect(output).toContain("Bring your own API key")
	})

	it("reports the highlighted choice when the selection is confirmed", async () => {
		const onSelect = vi.fn()
		const { stdin } = render(<OnboardingScreen onSelect={onSelect} />)

		await pressUntil(stdin, "\r", () => onSelect.mock.calls.length > 0)

		expect(onSelect).toHaveBeenCalledWith(OnboardingProviderChoice.Shofer)
	})

	it("reports the second choice after moving the selection down", async () => {
		const onSelect = vi.fn()
		const { stdin, lastFrame } = render(<OnboardingScreen onSelect={onSelect} />)

		await pressUntil(stdin, "\u001B[B", () => (lastFrame() ?? "").includes("❯ Bring your own API key"))
		await pressUntil(stdin, "\r", () => onSelect.mock.calls.length > 0)

		expect(onSelect).toHaveBeenCalledWith(OnboardingProviderChoice.Byok)
	})

	it("is re-exported from the barrel", () => {
		expect(barrel.OnboardingScreen).toBe(OnboardingScreen)
	})
})
