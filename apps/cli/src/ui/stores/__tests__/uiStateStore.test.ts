// pnpm --filter @shofer/cli test src/ui/stores/__tests__/uiStateStore.test.ts

import { useUIStateStore } from "../uiStateStore.js"

/**
 * The transient UI store — everything that must NOT survive a task switch (exit
 * hinting, the followup countdown, focus, the autocomplete picker). Its whole
 * contract is that each setter writes exactly its own key and `resetUIState`
 * restores every one of them.
 */
describe("useUIStateStore", () => {
	beforeEach(() => {
		useUIStateStore.getState().resetUIState()
	})

	it("starts with nothing shown, no countdown, no focus override and a closed picker", () => {
		const state = useUIStateStore.getState()

		expect(state.showExitHint).toBe(false)
		expect(state.pendingExit).toBe(false)
		expect(state.countdownSeconds).toBeNull()
		expect(state.showCustomInput).toBe(false)
		expect(state.isTransitioningToCustomInput).toBe(false)
		expect(state.manualFocus).toBeNull()
		expect(state.showTodoViewer).toBe(false)
		expect(state.pickerState).toEqual({
			activeTrigger: null,
			results: [],
			selectedIndex: 0,
			isOpen: false,
			isLoading: false,
			triggerInfo: null,
		})
	})

	it("each setter writes its own key", () => {
		const store = useUIStateStore.getState()

		store.setShowExitHint(true)
		store.setPendingExit(true)
		store.setCountdownSeconds(5)
		store.setShowCustomInput(true)
		store.setIsTransitioningToCustomInput(true)
		store.setManualFocus("scroll")
		store.setShowTodoViewer(true)
		store.setPickerState({
			activeTrigger: null,
			results: [{ key: "a" }],
			selectedIndex: 2,
			isOpen: true,
			isLoading: true,
			triggerInfo: null,
		})

		const state = useUIStateStore.getState()
		expect(state.showExitHint).toBe(true)
		expect(state.pendingExit).toBe(true)
		expect(state.countdownSeconds).toBe(5)
		expect(state.showCustomInput).toBe(true)
		expect(state.isTransitioningToCustomInput).toBe(true)
		expect(state.manualFocus).toBe("scroll")
		expect(state.showTodoViewer).toBe(true)
		expect(state.pickerState.isOpen).toBe(true)
		expect(state.pickerState.selectedIndex).toBe(2)
	})

	it("focus can be handed to the input or released back to automatic", () => {
		useUIStateStore.getState().setManualFocus("input")
		expect(useUIStateStore.getState().manualFocus).toBe("input")

		useUIStateStore.getState().setManualFocus(null)
		expect(useUIStateStore.getState().manualFocus).toBeNull()
	})

	it("resetUIState restores every key at once", () => {
		const store = useUIStateStore.getState()
		store.setShowExitHint(true)
		store.setCountdownSeconds(3)
		store.setManualFocus("scroll")
		store.setShowTodoViewer(true)

		useUIStateStore.getState().resetUIState()

		const state = useUIStateStore.getState()
		expect(state.showExitHint).toBe(false)
		expect(state.countdownSeconds).toBeNull()
		expect(state.manualFocus).toBeNull()
		expect(state.showTodoViewer).toBe(false)
	})
})
