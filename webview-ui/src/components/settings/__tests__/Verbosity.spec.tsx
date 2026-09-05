// npx vitest src/components/settings/__tests__/Verbosity.spec.tsx
//
// The verbosity picker: it is model-gated, defaults to "medium" when the
// profile carries nothing, and — like every Settings control — stages through
// `setApiConfigurationField` rather than posting to the host.

import { render, screen, fireEvent } from "@/utils/test-utils"

import { verbosityLevels } from "@shofer/types"

import { Verbosity } from "../Verbosity"

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))

const postMessage = vi.fn()
vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: (m: unknown) => postMessage(m) } }))

const setApiConfigurationField = vi.fn()

const modelInfo = { contextWindow: 1000, supportsPromptCache: false } as never

const renderIt = (props: Record<string, unknown> = {}) =>
	render(
		<Verbosity
			apiConfiguration={{}}
			setApiConfigurationField={setApiConfigurationField}
			modelInfo={modelInfo}
			{...(props as object)}
		/>,
	)

beforeEach(() => vi.clearAllMocks())

describe("Verbosity", () => {
	it("renders nothing without a model to describe", () => {
		const { container } = renderIt({ modelInfo: undefined })
		expect(container).toBeEmptyDOMElement()
	})

	it("shows the medium default when the profile names none", () => {
		renderIt()
		expect(screen.getByTestId("verbosity")).toHaveTextContent("settings:providers.verbosity.medium")
	})

	it("shows the level the profile carries", () => {
		renderIt({ apiConfiguration: { verbosity: "high" } })
		expect(screen.getByTestId("verbosity")).toHaveTextContent("settings:providers.verbosity.high")
	})

	it("offers every declared level", () => {
		renderIt()
		fireEvent.click(screen.getByRole("combobox"))

		for (const level of verbosityLevels) {
			expect(screen.getAllByText(`settings:providers.verbosity.${level}`).length).toBeGreaterThan(0)
		}
	})

	it("stages a choice instead of applying it", () => {
		renderIt()
		fireEvent.click(screen.getByRole("combobox"))
		fireEvent.click(screen.getAllByText("settings:providers.verbosity.low")[0])

		expect(setApiConfigurationField).toHaveBeenCalledWith("verbosity", "low")
		expect(postMessage).not.toHaveBeenCalled()
	})
})
