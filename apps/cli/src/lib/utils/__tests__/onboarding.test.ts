/**
 * Unit tests for `runOnboarding` (`src/lib/utils/onboarding.ts`).
 *
 * The onboarding screen is an ink component behind a dynamic import, so both
 * `ink` and the component module are faked and the `onSelect` callback is
 * pulled straight off the rendered element — no TTY, no rendering, and no real
 * sign-in (the `login` command is faked too).
 */

import { OnboardingProviderChoice } from "@/types/index.js"
import { login } from "@/commands/index.js"
import { saveSettings } from "@/lib/storage/index.js"

import { runOnboarding } from "../onboarding.js"

const unmount = vi.hoisted(() => vi.fn())
const render = vi.hoisted(() => vi.fn(() => ({ unmount })))

vi.mock("ink", () => ({ render }))
vi.mock("../../../ui/components/onboarding/index.js", () => ({ OnboardingScreen: () => null }))
vi.mock("@/commands/index.js", () => ({ login: vi.fn() }))
vi.mock("@/lib/storage/index.js", () => ({ saveSettings: vi.fn() }))

type SelectHandler = (choice: OnboardingProviderChoice) => Promise<void>

/** The `onSelect` prop of the element handed to ink's `render`. */
function selectHandler(): SelectHandler {
	const [element] = render.mock.calls.at(-1) as unknown as [{ props: { onSelect: SelectHandler } }]
	return element.props.onSelect
}

describe("runOnboarding", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		vi.spyOn(console, "log").mockImplementation(() => {})
		vi.mocked(login).mockResolvedValue({ success: true, token: "jwt-abc" })
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	/**
	 * Let `runOnboarding`'s two dynamic imports resolve. Polled rather than
	 * awaited once — how many turns a dynamic import takes is not fixed, and a
	 * single tick is flaky under load.
	 */
	async function untilRendered(): Promise<void> {
		for (let i = 0; i < 200 && render.mock.calls.length === 0; i++) {
			await new Promise((resolve) => setTimeout(resolve, 5))
		}
	}

	it("renders the onboarding screen and waits for a choice", async () => {
		const pending = runOnboarding()
		await untilRendered()

		expect(render).toHaveBeenCalledTimes(1)
		expect(typeof selectHandler()).toBe("function")

		void selectHandler()(OnboardingProviderChoice.Byok)
		await pending
	})

	it("signs in and returns the token for the shofer choice", async () => {
		const pending = runOnboarding()
		await untilRendered()

		void selectHandler()(OnboardingProviderChoice.Shofer)

		await expect(pending).resolves.toEqual({
			choice: OnboardingProviderChoice.Shofer,
			token: "jwt-abc",
			skipped: false,
		})
		expect(login).toHaveBeenCalledTimes(1)
		expect(unmount).toHaveBeenCalledTimes(1)
		expect(saveSettings).toHaveBeenCalledWith({ onboardingProviderChoice: OnboardingProviderChoice.Shofer })
	})

	it("returns no token when the sign-in fails", async () => {
		vi.mocked(login).mockResolvedValue({ success: false, error: "denied" })

		const pending = runOnboarding()
		await untilRendered()
		void selectHandler()(OnboardingProviderChoice.Shofer)

		await expect(pending).resolves.toEqual({
			choice: OnboardingProviderChoice.Shofer,
			token: undefined,
			skipped: false,
		})
	})

	it("skips sign-in entirely for the bring-your-own-key choice", async () => {
		const pending = runOnboarding()
		await untilRendered()
		void selectHandler()(OnboardingProviderChoice.Byok)

		await expect(pending).resolves.toEqual({ choice: OnboardingProviderChoice.Byok, skipped: false })
		expect(login).not.toHaveBeenCalled()
		expect(saveSettings).toHaveBeenCalledWith({ onboardingProviderChoice: OnboardingProviderChoice.Byok })
	})

	it("persists the choice before doing anything else", async () => {
		const pending = runOnboarding()
		await untilRendered()
		void selectHandler()(OnboardingProviderChoice.Byok)
		await pending

		expect(vi.mocked(saveSettings).mock.invocationCallOrder[0]).toBeLessThan(unmount.mock.invocationCallOrder[0]!)
	})
})
