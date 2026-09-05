// pnpm --filter @shofer/cli test src/ui/hooks/__tests__/useInputHistory.test.tsx

import { useInputHistory } from "../useInputHistory.js"
import { renderHook } from "./helpers/render-hook.js"

const loadHistory = vi.hoisted(() => vi.fn())
const addToHistory = vi.hoisted(() => vi.fn())

vi.mock("../../../lib/storage/history.js", () => ({ loadHistory, addToHistory }))

/**
 * Shell-style input history. The invariants worth pinning are the browsing
 * cursor's edges — Up from the newest entry saves the DRAFT first, Up at the
 * oldest entry stays there, Down past the newest returns the draft — and that a
 * storage failure is never fatal, because history is a convenience and losing it
 * must not take the prompt with it.
 */
describe("useInputHistory", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		loadHistory.mockResolvedValue(["first", "second", "third"])
		addToHistory.mockImplementation(async (entry: string) => ["first", "second", "third", entry])
	})

	const mount = (options?: Parameters<typeof useInputHistory>[0]) => {
		const hook = renderHook(() => useInputHistory(options))
		// The mount effect loads history asynchronously.
		hook.act(() => {})
		return hook
	}

	const flush = async (hook: ReturnType<typeof mount>) => {
		await hook.actAsync()
	}

	it("loads the persisted history once, on mount", async () => {
		const hook = mount()
		await flush(hook)

		expect(loadHistory).toHaveBeenCalledTimes(1)
		expect(hook.current.history).toEqual(["first", "second", "third"])
		expect(hook.current.isBrowsing).toBe(false)
		expect(hook.current.historyValue).toBeNull()

		hook.unmount()
	})

	it("survives a history file that cannot be read", async () => {
		loadHistory.mockRejectedValue(new Error("EACCES"))
		const hook = mount()
		await flush(hook)

		expect(hook.current.history).toEqual([])
		hook.unmount()
	})

	it("walks backwards from the newest entry, saving the draft on the first step", async () => {
		const hook = mount({ getCurrentInput: () => "typed so far" })
		await flush(hook)

		hook.act(() => hook.current.navigateUp())
		expect(hook.current.historyValue).toBe("third")
		expect(hook.current.isBrowsing).toBe(true)
		expect(hook.current.draft).toBe("typed so far")

		hook.act(() => hook.current.navigateUp())
		expect(hook.current.historyValue).toBe("second")

		hook.act(() => hook.current.navigateUp())
		expect(hook.current.historyValue).toBe("first")

		// At the oldest entry it stays put rather than falling off the end.
		hook.act(() => hook.current.navigateUp())
		expect(hook.current.historyValue).toBe("first")

		hook.unmount()
	})

	it("walks forwards and returns to the draft past the newest entry", async () => {
		const hook = mount()
		await flush(hook)

		hook.act(() => hook.current.navigateUp())
		hook.act(() => hook.current.navigateUp())
		expect(hook.current.historyValue).toBe("second")

		hook.act(() => hook.current.navigateDown())
		expect(hook.current.historyValue).toBe("third")

		hook.act(() => hook.current.navigateDown())
		expect(hook.current.historyValue).toBeNull()
		expect(hook.current.isBrowsing).toBe(false)

		// Down while not browsing is a no-op.
		hook.act(() => hook.current.navigateDown())
		expect(hook.current.isBrowsing).toBe(false)

		hook.unmount()
	})

	it("does nothing while inactive", async () => {
		const hook = mount({ isActive: false })
		await flush(hook)

		hook.act(() => hook.current.navigateUp())
		expect(hook.current.isBrowsing).toBe(false)

		hook.act(() => hook.current.navigateDown())
		expect(hook.current.isBrowsing).toBe(false)

		hook.unmount()
	})

	it("does nothing when the history is empty", async () => {
		loadHistory.mockResolvedValue([])
		const hook = mount()
		await flush(hook)

		hook.act(() => hook.current.navigateUp())
		expect(hook.current.isBrowsing).toBe(false)

		hook.unmount()
	})

	it("browsing without a getCurrentInput leaves the draft empty", async () => {
		const hook = mount()
		await flush(hook)

		hook.act(() => hook.current.navigateUp())
		expect(hook.current.draft).toBe("")

		hook.unmount()
	})

	it("appends an entry, re-reads the stored list and leaves browsing", async () => {
		const hook = mount()
		await flush(hook)

		hook.act(() => hook.current.navigateUp())
		expect(hook.current.isBrowsing).toBe(true)

		await hook.actAsync(() => hook.current.addEntry("  fourth  "))

		expect(addToHistory).toHaveBeenCalledWith("fourth")
		expect(hook.current.history).toEqual(["first", "second", "third", "fourth"])
		expect(hook.current.isBrowsing).toBe(false)
		expect(hook.current.draft).toBe("")

		hook.unmount()
	})

	it("refuses to store a blank entry", async () => {
		const hook = mount()
		await flush(hook)

		await hook.actAsync(() => hook.current.addEntry("   "))
		expect(addToHistory).not.toHaveBeenCalled()

		hook.unmount()
	})

	it("survives a history file that cannot be written", async () => {
		addToHistory.mockRejectedValue(new Error("ENOSPC"))
		const hook = mount()
		await flush(hook)

		await hook.actAsync(() => hook.current.addEntry("fourth"))

		expect(hook.current.history).toEqual(["first", "second", "third"])
		expect(hook.current.isBrowsing).toBe(false)

		hook.unmount()
	})

	it("resetBrowsing clears the cursor, and adopts the passed input as the draft", async () => {
		const hook = mount()
		await flush(hook)

		hook.act(() => hook.current.navigateUp())
		hook.act(() => hook.current.resetBrowsing("kept"))
		expect(hook.current.isBrowsing).toBe(false)
		expect(hook.current.draft).toBe("kept")

		hook.act(() => hook.current.navigateUp())
		hook.act(() => hook.current.resetBrowsing())
		expect(hook.current.isBrowsing).toBe(false)
		expect(hook.current.draft).toBe("kept")

		hook.unmount()
	})

	it("exposes setDraft for the input component to keep in sync", async () => {
		const hook = mount()
		await flush(hook)

		hook.act(() => hook.current.setDraft("typed"))
		expect(hook.current.draft).toBe("typed")

		hook.unmount()
	})
})
