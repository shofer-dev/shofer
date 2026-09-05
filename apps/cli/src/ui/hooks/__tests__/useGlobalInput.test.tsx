// pnpm --filter @shofer/cli test src/ui/hooks/__tests__/useGlobalInput.test.tsx

import type { Key } from "ink"
import type { WebviewMessage } from "@shofer/types"

import { useCLIStore } from "../../store.js"
import { useUIStateStore } from "../../stores/uiStateStore.js"
import { useGlobalInput, type UseGlobalInputOptions } from "../useGlobalInput.js"
import { renderHook } from "./helpers/render-hook.js"

/**
 * The app-level keyboard shortcuts. Ink's `useInput` needs a real raw-mode TTY,
 * so it is replaced with a capture: the handler the hook registers is invoked
 * directly with the `(input, key)` pair Ink would have parsed. That is the same
 * contract — `useInput`'s whole job is to produce that pair.
 */

const captured: { handler?: (input: string, key: Key) => void } = vi.hoisted(() => ({}))

vi.mock("ink", async (importOriginal) => {
	const actual = await importOriginal<typeof import("ink")>()
	return {
		...actual,
		useInput: (handler: (input: string, key: Key) => void) => {
			captured.handler = handler
		},
	}
})

const key = (overrides: Partial<Key> = {}): Key =>
	({
		upArrow: false,
		downArrow: false,
		leftArrow: false,
		rightArrow: false,
		pageDown: false,
		pageUp: false,
		return: false,
		escape: false,
		ctrl: false,
		shift: false,
		tab: false,
		backspace: false,
		delete: false,
		meta: false,
		...overrides,
	}) as Key

describe("useGlobalInput", () => {
	let sent: WebviewMessage[]
	let showInfo: ReturnType<typeof vi.fn>
	let toggleFocus: ReturnType<typeof vi.fn>
	let closePicker: ReturnType<typeof vi.fn>
	let cancelTask: ReturnType<typeof vi.fn>
	let exit: ReturnType<typeof vi.fn>
	let cleanup: ReturnType<typeof vi.fn>

	const modes = [
		{ key: "code", slug: "code", name: "Code" },
		{ key: "architect", slug: "architect", name: "Architect" },
	]

	beforeEach(() => {
		vi.useFakeTimers()
		useCLIStore.getState().reset()
		useUIStateStore.getState().resetUIState()
		captured.handler = undefined
		sent = []
		showInfo = vi.fn()
		toggleFocus = vi.fn()
		closePicker = vi.fn()
		cancelTask = vi.fn().mockResolvedValue(undefined)
		exit = vi.fn()
		cleanup = vi.fn().mockResolvedValue(undefined)
	})

	afterEach(() => {
		vi.useRealTimers()
		vi.restoreAllMocks()
	})

	const mount = (overrides: Partial<UseGlobalInputOptions> = {}) =>
		renderHook(() =>
			useGlobalInput({
				canToggleFocus: true,
				isScrollAreaActive: false,
				pickerIsOpen: false,
				availableModes: modes,
				currentMode: "code",
				mode: "code",
				sendToExtension: (msg) => sent.push(msg),
				cancelTask,
				showInfo,
				exit,
				cleanup,
				toggleFocus,
				closePicker,
				...overrides,
			}),
		)

	const press = (hook: ReturnType<typeof mount>, input: string, k: Partial<Key> = {}) => {
		hook.act(() => captured.handler?.(input, key(k)))
	}

	describe("Tab", () => {
		it("toggles focus when the view allows it", () => {
			const hook = mount()
			press(hook, "", { tab: true })
			expect(toggleFocus).toHaveBeenCalledTimes(1)
			hook.unmount()
		})

		it("does not toggle focus while the picker is open, or when toggling is forbidden", () => {
			const withPicker = mount({ pickerIsOpen: true })
			press(withPicker, "", { tab: true })
			withPicker.unmount()

			const locked = mount({ canToggleFocus: false })
			press(locked, "", { tab: true })
			locked.unmount()

			expect(toggleFocus).not.toHaveBeenCalled()
		})
	})

	describe("Ctrl+M — cycle modes", () => {
		it("moves to the next mode and says so", () => {
			const hook = mount()
			press(hook, "m", { ctrl: true })

			expect(sent).toEqual([{ type: "mode", text: "architect" }])
			expect(showInfo).toHaveBeenCalledWith("Switched to Architect", 2000)
			hook.unmount()
		})

		it("wraps around from the last mode", () => {
			const hook = mount({ currentMode: "architect" })
			press(hook, "m", { ctrl: true })
			expect(sent).toEqual([{ type: "mode", text: "code" }])
			hook.unmount()
		})

		it("falls back to the launch mode when the store has none, and to the first mode when it is unknown", () => {
			const hook = mount({ currentMode: null, mode: "architect" })
			press(hook, "m", { ctrl: true })
			expect(sent).toEqual([{ type: "mode", text: "code" }])
			hook.unmount()

			sent.length = 0
			const unknown = mount({ currentMode: "nonexistent" })
			press(unknown, "m", { ctrl: true })
			expect(sent).toEqual([{ type: "mode", text: "code" }])
			unknown.unmount()
		})

		it("also recognises the kitty CSI-u encoding", () => {
			const hook = mount()
			press(hook, "\x1b[109;5u")
			expect(sent).toEqual([{ type: "mode", text: "architect" }])
			hook.unmount()
		})

		it("refuses while a task is running", () => {
			useCLIStore.getState().setLoading(true)
			const hook = mount()
			press(hook, "m", { ctrl: true })

			expect(showInfo).toHaveBeenCalledWith("Cannot switch modes while task is in progress", 2000)
			expect(sent).toEqual([])
			hook.unmount()
		})

		it("does nothing with fewer than two modes, or with no transport", () => {
			const single = mount({ availableModes: [modes[0]!] })
			press(single, "m", { ctrl: true })
			single.unmount()

			const detached = mount({ sendToExtension: null })
			press(detached, "m", { ctrl: true })
			detached.unmount()

			expect(sent).toEqual([])
		})
	})

	describe("Ctrl+T — the TODO viewer", () => {
		it("opens the viewer when there are todos", () => {
			useCLIStore.getState().setTodos([{ id: "1", content: "a", status: "pending" }])
			const hook = mount()
			press(hook, "t", { ctrl: true })

			expect(useUIStateStore.getState().showTodoViewer).toBe(true)
			hook.unmount()
		})

		it("refuses to open an empty viewer and says so", () => {
			const hook = mount()
			press(hook, "t", { ctrl: true })

			expect(showInfo).toHaveBeenCalledWith("No TODO list available", 2000)
			expect(useUIStateStore.getState().showTodoViewer).toBe(false)
			hook.unmount()
		})

		it("closes an open viewer", () => {
			useUIStateStore.getState().setShowTodoViewer(true)
			const hook = mount()
			press(hook, "t", { ctrl: true })

			expect(useUIStateStore.getState().showTodoViewer).toBe(false)
			hook.unmount()
		})

		it("closes the picker first when one is open", () => {
			useCLIStore.getState().setTodos([{ id: "1", content: "a", status: "pending" }])
			const hook = mount({ pickerIsOpen: true })
			press(hook, "\x1b[116;5u")

			expect(closePicker).toHaveBeenCalledTimes(1)
			expect(useUIStateStore.getState().showTodoViewer).toBe(true)
			hook.unmount()
		})
	})

	describe("Escape", () => {
		it("closes the TODO viewer before anything else", () => {
			useUIStateStore.getState().setShowTodoViewer(true)
			useCLIStore.getState().setLoading(true)
			const hook = mount()
			press(hook, "", { escape: true })

			expect(useUIStateStore.getState().showTodoViewer).toBe(false)
			expect(cancelTask).not.toHaveBeenCalled()
			hook.unmount()
		})

		it("cancels a running task through the host, not by killing the stream", () => {
			useCLIStore.getState().setLoading(true)
			const hook = mount()
			press(hook, "", { escape: true })

			expect(cancelTask).toHaveBeenCalledTimes(1)
			hook.unmount()
		})

		it("leaves escape to the picker while one is open", () => {
			useCLIStore.getState().setLoading(true)
			const hook = mount({ pickerIsOpen: true })
			press(hook, "", { escape: true })

			expect(cancelTask).not.toHaveBeenCalled()
			hook.unmount()
		})

		it("does nothing when nothing is running", () => {
			const hook = mount()
			press(hook, "", { escape: true })
			expect(cancelTask).not.toHaveBeenCalled()
			hook.unmount()
		})

		it("does nothing when there is no cancel to call", () => {
			useCLIStore.getState().setLoading(true)
			const hook = mount({ cancelTask: null })
			expect(() => press(hook, "", { escape: true })).not.toThrow()
			hook.unmount()
		})
	})

	describe("Ctrl+C — exit", () => {
		it("closes the picker on the first press instead of arming the exit", () => {
			const hook = mount({ pickerIsOpen: true })
			press(hook, "c", { ctrl: true })

			expect(closePicker).toHaveBeenCalledTimes(1)
			expect(useUIStateStore.getState().pendingExit).toBe(false)
			hook.unmount()
		})

		it("arms a hint on the first press and disarms it after two seconds", () => {
			const hook = mount()
			press(hook, "c", { ctrl: true })

			expect(useUIStateStore.getState().pendingExit).toBe(true)
			expect(useUIStateStore.getState().showExitHint).toBe(true)

			hook.act(() => {
				vi.advanceTimersByTime(2000)
			})
			expect(useUIStateStore.getState().pendingExit).toBe(false)
			expect(useUIStateStore.getState().showExitHint).toBe(false)

			hook.unmount()
		})

		it("exits on the second press, after cleanup has run", async () => {
			const processExit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never)
			const hook = mount()

			press(hook, "c", { ctrl: true })
			press(hook, "c", { ctrl: true })

			await hook.actAsync()

			expect(cleanup).toHaveBeenCalledTimes(1)
			expect(exit).toHaveBeenCalledTimes(1)
			expect(processExit).toHaveBeenCalledWith(0)

			hook.unmount()
		})
	})

	it("ignores an ordinary keystroke", () => {
		const hook = mount()
		press(hook, "a")

		expect(sent).toEqual([])
		expect(toggleFocus).not.toHaveBeenCalled()
		expect(showInfo).not.toHaveBeenCalled()
		hook.unmount()
	})

	it("clears its pending exit-hint timer on unmount", () => {
		const hook = mount()
		press(hook, "c", { ctrl: true })
		hook.unmount()

		// The store keeps the armed flag: the timer that would have cleared it was
		// disposed with the component rather than firing against a dead tree.
		vi.advanceTimersByTime(5000)
		expect(useUIStateStore.getState().pendingExit).toBe(true)
	})
})
