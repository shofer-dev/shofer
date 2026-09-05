// pnpm --filter @shofer/cli test src/ui/hooks/__tests__/useFocusManagement.test.tsx

import type { PendingAsk } from "../../types.js"
import { useUIStateStore } from "../../stores/uiStateStore.js"
import { useFocusManagement } from "../useFocusManagement.js"
import { renderHook } from "./helpers/render-hook.js"

/**
 * Focus arbitration between the scrollback and the prompt. The derived values
 * are a two-level fallback: an explicit `manualFocus` wins, and with none set the
 * answer follows whether an approval prompt is up — because an approval must own
 * the keyboard. `canToggleFocus` gates the toggle AND clears a stale override
 * whenever the view stops allowing one.
 */
describe("useFocusManagement", () => {
	const followup: PendingAsk = { id: "a", type: "followup", content: "?" }
	const approval: PendingAsk = { id: "b", type: "tool", content: "run?" }

	beforeEach(() => {
		useUIStateStore.getState().resetUIState()
	})

	it("with nothing pending: the input is active and focus may be toggled", () => {
		const hook = renderHook(() => useFocusManagement({ showApprovalPrompt: false, pendingAsk: null }))

		expect(hook.current.canToggleFocus).toBe(true)
		expect(hook.current.isInputAreaActive).toBe(true)
		expect(hook.current.isScrollAreaActive).toBe(false)
		expect(hook.current.manualFocus).toBeNull()

		hook.unmount()
	})

	it("an approval prompt takes the keyboard and forbids toggling", () => {
		const hook = renderHook(() => useFocusManagement({ showApprovalPrompt: true, pendingAsk: approval }))

		expect(hook.current.canToggleFocus).toBe(false)
		expect(hook.current.isScrollAreaActive).toBe(true)
		expect(hook.current.isInputAreaActive).toBe(false)

		hook.act(() => hook.current.toggleFocus())
		expect(hook.current.manualFocus).toBeNull()

		hook.unmount()
	})

	it("a followup question still allows toggling", () => {
		const hook = renderHook(() => useFocusManagement({ showApprovalPrompt: false, pendingAsk: followup }))
		expect(hook.current.canToggleFocus).toBe(true)
		hook.unmount()
	})

	it("a non-followup ask allows toggling only once the custom input is open", () => {
		const hook = renderHook(() => useFocusManagement({ showApprovalPrompt: false, pendingAsk: approval }))
		expect(hook.current.canToggleFocus).toBe(false)

		hook.act(() => {
			useUIStateStore.getState().setShowCustomInput(true)
		})
		expect(hook.current.canToggleFocus).toBe(true)

		hook.unmount()
	})

	it("toggles from the derived default, then alternates", () => {
		const hook = renderHook(() => useFocusManagement({ showApprovalPrompt: false, pendingAsk: null }))

		// Derived default is input-active, so the first toggle hands focus to scroll.
		hook.act(() => hook.current.toggleFocus())
		expect(hook.current.manualFocus).toBe("scroll")
		expect(hook.current.isScrollAreaActive).toBe(true)
		expect(hook.current.isInputAreaActive).toBe(false)

		hook.act(() => hook.current.toggleFocus())
		expect(hook.current.manualFocus).toBe("input")
		expect(hook.current.isScrollAreaActive).toBe(false)
		expect(hook.current.isInputAreaActive).toBe(true)

		hook.act(() => hook.current.toggleFocus())
		expect(hook.current.manualFocus).toBe("scroll")

		hook.unmount()
	})

	it("toggles the other way round when the scroll area already holds focus", () => {
		// showApprovalPrompt makes the scroll area the derived default; with the
		// custom input open the toggle is still permitted.
		useUIStateStore.getState().setShowCustomInput(true)
		const hook = renderHook(() => useFocusManagement({ showApprovalPrompt: true, pendingAsk: approval }))

		expect(hook.current.canToggleFocus).toBe(false)
		hook.unmount()
	})

	it("drops a manual override as soon as the view stops allowing one", () => {
		const hook = renderHook(
			({ showApprovalPrompt }: { showApprovalPrompt: boolean }) =>
				useFocusManagement({ showApprovalPrompt, pendingAsk: null }),
			{ showApprovalPrompt: false },
		)

		hook.act(() => hook.current.setManualFocus("scroll"))
		expect(hook.current.manualFocus).toBe("scroll")

		hook.rerender({ showApprovalPrompt: true })
		expect(hook.current.canToggleFocus).toBe(false)
		expect(hook.current.manualFocus).toBeNull()

		hook.unmount()
	})
})
