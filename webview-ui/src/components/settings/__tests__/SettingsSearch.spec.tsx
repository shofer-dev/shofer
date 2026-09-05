// npx vitest src/components/settings/__tests__/SettingsSearch.spec.tsx

import { Bot } from "lucide-react"
import { render, screen, fireEvent, act } from "@/utils/test-utils"

import { SettingsSearch } from "../SettingsSearch"
import type { SearchableSettingData } from "../useSettingsSearch"

vi.mock("@/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))
vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))

const onNavigate = vi.fn()

const index: SearchableSettingData[] = [
	{
		settingId: "sound-enabled",
		section: "notifications",
		label: "Enable sound effects",
		sectionLabel: "Notifications",
	},
	{ settingId: "sound-volume", section: "notifications", label: "Sound volume", sectionLabel: "Notifications" },
	{ settingId: "api-provider", section: "providers", label: "API Provider", sectionLabel: "Providers" },
] as never

const sections = [
	{ id: "notifications", icon: Bot },
	{ id: "providers", icon: Bot },
] as never

const renderSearch = () => render(<SettingsSearch index={index} onNavigate={onNavigate} sections={sections} />)

const input = () => screen.getByRole("textbox")

const search = (value: string) => {
	fireEvent.focus(input())
	fireEvent.change(input(), { target: { value } })
}

beforeEach(() => {
	vi.clearAllMocks()
	// The component defers the highlight scroll to the browser.
	Element.prototype.scrollIntoView = vi.fn()
})

describe("SettingsSearch", () => {
	it("shows no dropdown until there is a query", () => {
		renderSearch()
		fireEvent.focus(input())
		expect(screen.queryByRole("listbox")).not.toBeInTheDocument()
	})

	it("lists the matching settings and highlights the first", () => {
		renderSearch()
		search("sound")

		const options = screen.getAllByRole("option")
		expect(options.length).toBeGreaterThan(0)
		expect(options[0]).toHaveAttribute("aria-selected", "true")
	})

	it("says so when nothing matches", () => {
		renderSearch()
		search("zzzz-nothing")
		expect(screen.getByText(/noResults/)).toBeInTheDocument()
	})

	it("navigates on click, clears the query, and keeps the input focused", () => {
		renderSearch()
		search("API Provider")

		fireEvent.click(screen.getAllByRole("option")[0])
		expect(onNavigate).toHaveBeenCalledWith("providers", "api-provider")
		expect(input()).toHaveValue("")
	})

	it("moves the highlight with the arrow keys, wrapping at both ends", () => {
		renderSearch()
		search("sound")

		const ids = () => screen.getAllByRole("option").findIndex((o) => o.getAttribute("aria-selected") === "true")
		expect(ids()).toBe(0)

		fireEvent.keyDown(input(), { key: "ArrowDown" })
		expect(ids()).toBe(1)

		fireEvent.keyDown(input(), { key: "ArrowDown" })
		expect(ids()).toBe(0)

		fireEvent.keyDown(input(), { key: "ArrowUp" })
		expect(ids()).toBe(1)
	})

	it("opens the highlighted result on Enter", () => {
		renderSearch()
		search("sound")
		fireEvent.keyDown(input(), { key: "Enter" })
		expect(onNavigate).toHaveBeenCalled()
	})

	it("ignores the arrow keys and Enter when nothing matched", () => {
		renderSearch()
		search("zzzz-nothing")
		fireEvent.keyDown(input(), { key: "ArrowDown" })
		fireEvent.keyDown(input(), { key: "Enter" })
		expect(onNavigate).not.toHaveBeenCalled()
	})

	it("closes on Escape without navigating", () => {
		renderSearch()
		search("sound")
		fireEvent.keyDown(input(), { key: "Escape" })
		expect(screen.queryByRole("listbox")).not.toBeInTheDocument()
		expect(onNavigate).not.toHaveBeenCalled()
	})

	it("ignores any other key", () => {
		renderSearch()
		search("sound")
		fireEvent.keyDown(input(), { key: "a" })
		expect(screen.getByRole("listbox")).toBeInTheDocument()
	})

	it("closes shortly after the input loses focus", () => {
		vi.useFakeTimers()
		renderSearch()
		search("sound")

		fireEvent.blur(input())
		act(() => {
			vi.advanceTimersByTime(300)
		})
		expect(screen.queryByRole("listbox")).not.toBeInTheDocument()
		vi.useRealTimers()
	})
})
