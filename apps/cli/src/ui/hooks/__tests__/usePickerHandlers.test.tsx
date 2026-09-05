// pnpm --filter @shofer/cli test src/ui/hooks/__tests__/usePickerHandlers.test.tsx

import type { WebviewMessage } from "@shofer/types"

import type {
	AutocompleteInputHandle,
	AutocompleteItem,
	AutocompletePickerState,
} from "../../components/autocomplete/index.js"
import { useCLIStore } from "../../store.js"
import { useUIStateStore } from "../../stores/uiStateStore.js"
import { usePickerHandlers } from "../usePickerHandlers.js"
import { renderHook } from "./helpers/render-hook.js"

/**
 * The autocomplete picker's selection handler. Two triggers are special because
 * selecting from them is a COMMAND rather than a text completion: `mode` posts a
 * mode switch, and `history` switches the whole task — which is why it refuses
 * while a task is running, short-circuits on re-selecting the current task, and
 * resets the per-task message-dedup refs before it hands over.
 */
describe("usePickerHandlers", () => {
	let sent: WebviewMessage[]
	let autocomplete: AutocompleteInputHandle<AutocompleteItem> & { calls: string[] }
	let followup: AutocompleteInputHandle<AutocompleteItem> & { calls: string[] }
	let showInfo: ReturnType<typeof vi.fn>
	let seenMessageIds: { current: Set<string> }
	let firstTextMessageSkipped: { current: boolean }

	const makeHandle = (): AutocompleteInputHandle<AutocompleteItem> & { calls: string[] } => {
		const calls: string[] = []
		return {
			calls,
			pickerState: {
				activeTrigger: null,
				results: [],
				selectedIndex: 0,
				isOpen: false,
				isLoading: false,
				triggerInfo: null,
			},
			closePicker: () => {
				calls.push("close")
			},
			handleItemSelect: (item: AutocompleteItem) => {
				calls.push(`select:${JSON.stringify(item)}`)
			},
			handleIndexChange: (index: number) => {
				calls.push(`index:${index}`)
			},
			refreshSearch: () => {
				calls.push("refresh")
			},
		}
	}

	beforeEach(() => {
		useCLIStore.getState().reset()
		useUIStateStore.getState().resetUIState()
		sent = []
		autocomplete = makeHandle()
		followup = makeHandle()
		showInfo = vi.fn()
		seenMessageIds = { current: new Set(["stale"]) }
		firstTextMessageSkipped = { current: true }
	})

	const setTrigger = (id: string | null) => {
		useUIStateStore.getState().setPickerState({
			...useUIStateStore.getState().pickerState,
			activeTrigger: id ? ({ id } as AutocompletePickerState<AutocompleteItem>["activeTrigger"]) : null,
		})
	}

	const mount = (sendToExtension: ((msg: WebviewMessage) => void) | null = (msg) => sent.push(msg)) =>
		renderHook(() =>
			usePickerHandlers({
				autocompleteRef: { current: autocomplete } as React.RefObject<
					AutocompleteInputHandle<AutocompleteItem>
				>,
				followupAutocompleteRef: { current: followup } as React.RefObject<
					AutocompleteInputHandle<AutocompleteItem>
				>,
				sendToExtension,
				showInfo,
				seenMessageIds: seenMessageIds as React.MutableRefObject<Set<string>>,
				firstTextMessageSkipped: firstTextMessageSkipped as React.MutableRefObject<boolean>,
			}),
		)

	it("publishes picker state into the UI store", () => {
		const hook = mount()
		const state = {
			activeTrigger: null,
			results: [{ key: "a" }],
			selectedIndex: 1,
			isOpen: true,
			isLoading: false,
			triggerInfo: null,
		} as AutocompletePickerState<{ key: string }>

		hook.act(() => hook.current.handlePickerStateChange(state))
		expect(useUIStateStore.getState().pickerState).toEqual(state)

		hook.unmount()
	})

	it("selecting a mode posts a mode switch and closes both pickers", () => {
		setTrigger("mode")
		const hook = mount()

		hook.act(() => hook.current.handlePickerSelect({ key: "code", slug: "code", name: "Code" }))

		expect(sent).toEqual([{ type: "mode", text: "code" }])
		expect(autocomplete.calls).toEqual(["close"])
		expect(followup.calls).toEqual(["close"])

		hook.unmount()
	})

	it("selecting a mode with no transport still closes the pickers", () => {
		setTrigger("mode")
		const hook = mount(null)

		hook.act(() => hook.current.handlePickerSelect({ key: "code", slug: "code", name: "Code" }))

		expect(sent).toEqual([])
		expect(autocomplete.calls).toEqual(["close"])

		hook.unmount()
	})

	it("refuses a task switch while a task is running, and says why", () => {
		setTrigger("history")
		useCLIStore.getState().setLoading(true)
		const hook = mount()

		hook.act(() => hook.current.handlePickerSelect({ id: "task-2", key: "task-2" }))

		expect(showInfo).toHaveBeenCalledWith("Cannot switch tasks while task is in progress", 2000)
		expect(sent).toEqual([])
		expect(autocomplete.calls).toEqual(["close"])

		hook.unmount()
	})

	it("re-selecting the task already open just closes the picker", () => {
		setTrigger("history")
		useCLIStore.getState().setCurrentTaskId("task-1")
		const hook = mount()

		hook.act(() => hook.current.handlePickerSelect({ id: "task-1", key: "task-1" }))

		expect(sent).toEqual([])
		expect(autocomplete.calls).toEqual(["close"])
		expect(followup.calls).toEqual(["close"])

		hook.unmount()
	})

	it("switching task resets the per-task state, flags the resume, and asks for the task", () => {
		setTrigger("history")
		useCLIStore.getState().setCurrentTaskId("task-1")
		useCLIStore.getState().addMessage({ id: "m1", role: "user", content: "old" })
		useCLIStore.getState().setTaskHistory([{ id: "task-1", task: "x", ts: 1 }])
		const hook = mount()

		hook.act(() => hook.current.handlePickerSelect({ id: "task-2", key: "task-2" }))

		const state = useCLIStore.getState()
		expect(state.messages).toEqual([])
		// Global state survives a task switch.
		expect(state.taskHistory).toHaveLength(1)
		expect(state.isResumingTask).toBe(true)
		expect(state.currentTaskId).toBe("task-2")
		expect(seenMessageIds.current.size).toBe(0)
		expect(firstTextMessageSkipped.current).toBe(false)
		expect(sent).toEqual([{ type: "showTaskWithId", text: "task-2" }])

		hook.unmount()
	})

	it("with no transport a task switch resets nothing and only closes the picker", () => {
		setTrigger("history")
		useCLIStore.getState().addMessage({ id: "m1", role: "user", content: "old" })
		const hook = mount(null)

		hook.act(() => hook.current.handlePickerSelect({ id: "task-2", key: "task-2" }))

		expect(useCLIStore.getState().messages).toHaveLength(1)
		expect(autocomplete.calls).toEqual(["close"])

		hook.unmount()
	})

	it("any other selection is an ordinary completion, handed to both inputs", () => {
		setTrigger("file")
		const hook = mount()

		hook.act(() => hook.current.handlePickerSelect({ key: "a.ts", path: "a.ts" }))

		expect(autocomplete.calls[0]).toContain("select:")
		expect(followup.calls[0]).toContain("select:")
		expect(sent).toEqual([])

		hook.unmount()
	})

	it("a mode-trigger item without a slug, and a history item without an id, fall through to completion", () => {
		setTrigger("mode")
		const hook = mount()
		hook.act(() => hook.current.handlePickerSelect({ key: "no-slug" }))
		expect(autocomplete.calls[0]).toContain("select:")
		hook.unmount()

		setTrigger("history")
		const second = mount()
		second.act(() => second.current.handlePickerSelect({ key: "no-id" }))
		expect(autocomplete.calls.at(-1)).toContain("select:")
		second.unmount()
	})

	it("a null selection falls through to completion rather than crashing", () => {
		setTrigger("mode")
		const hook = mount()

		hook.act(() => hook.current.handlePickerSelect(null))
		expect(autocomplete.calls).toEqual(["select:null"])

		hook.unmount()
	})

	it("close and index-change reach both inputs", () => {
		const hook = mount()

		hook.act(() => hook.current.handlePickerClose())
		hook.act(() => hook.current.handlePickerIndexChange(3))

		expect(autocomplete.calls).toEqual(["close", "index:3"])
		expect(followup.calls).toEqual(["close", "index:3"])

		hook.unmount()
	})

	it("tolerates refs that hold nothing yet", () => {
		const hook = renderHook(() =>
			usePickerHandlers({
				autocompleteRef: { current: null } as unknown as React.RefObject<
					AutocompleteInputHandle<AutocompleteItem>
				>,
				followupAutocompleteRef: {
					current: null,
				} as unknown as React.RefObject<AutocompleteInputHandle<AutocompleteItem>>,
				sendToExtension: null,
				showInfo,
				seenMessageIds: seenMessageIds as React.MutableRefObject<Set<string>>,
				firstTextMessageSkipped: firstTextMessageSkipped as React.MutableRefObject<boolean>,
			}),
		)

		expect(() => {
			hook.act(() => hook.current.handlePickerClose())
			hook.act(() => hook.current.handlePickerIndexChange(0))
			hook.act(() => hook.current.handlePickerSelect({ key: "x" }))
		}).not.toThrow()

		hook.unmount()
	})
})
