// npx vitest src/utils/__tests__/focusPanel.test.ts

/**
 * Focusing the chat surface. Three cases, and the interesting one is the third:
 * a TAB panel is revealed through its own handle, a SIDEBAR view can only be
 * focused through a command id, and with NO panel at all the activity-bar
 * container has to be opened — which is what makes the keybinding work on a
 * cold window where Shofer has never been shown.
 */

const hoisted = vi.hoisted(() => ({ executeCommand: vi.fn(async () => undefined) }))

vi.mock("vscode", () => ({
	commands: { executeCommand: hoisted.executeCommand },
	ViewColumn: { Active: -1 },
}))

vi.mock("../../core/webview/ShoferProvider", () => ({
	ShoferProvider: { sideBarId: "shofer.SidebarProvider" },
}))

import { focusPanel } from "../focusPanel"

beforeEach(() => vi.clearAllMocks())

describe("focusPanel", () => {
	it("opens the activity-bar container when no panel exists yet", async () => {
		await focusPanel(undefined, undefined)

		expect(hoisted.executeCommand).toHaveBeenCalledWith("workbench.view.extension.shofer-ActivityBar")
	})

	it("REVEALS an inactive tab panel through its own handle", async () => {
		const tabPanel = { active: false, reveal: vi.fn() } as never

		await focusPanel(tabPanel, undefined)

		expect((tabPanel as unknown as { reveal: ReturnType<typeof vi.fn> }).reveal).toHaveBeenCalledWith(-1, false)
		expect(hoisted.executeCommand).not.toHaveBeenCalled()
	})

	it("leaves an ALREADY-ACTIVE tab panel alone", async () => {
		const tabPanel = { active: true, reveal: vi.fn() } as never

		await focusPanel(tabPanel, undefined)

		expect((tabPanel as unknown as { reveal: ReturnType<typeof vi.fn> }).reveal).not.toHaveBeenCalled()
		expect(hoisted.executeCommand).not.toHaveBeenCalled()
	})

	it("focuses a sidebar view through its command id — a view has no reveal()", async () => {
		await focusPanel(undefined, { visible: true } as never)

		expect(hoisted.executeCommand).toHaveBeenCalledWith("shofer.SidebarProvider.focus")
	})

	it("prefers the TAB panel when both exist", async () => {
		const tabPanel = { active: false, reveal: vi.fn() } as never

		await focusPanel(tabPanel, { visible: true } as never)

		expect((tabPanel as unknown as { reveal: ReturnType<typeof vi.fn> }).reveal).toHaveBeenCalled()
		expect(hoisted.executeCommand).not.toHaveBeenCalled()
	})
})
