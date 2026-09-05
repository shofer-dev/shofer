// pnpm --filter @shofer/cli test src/ui/hooks/__tests__/useTaskSubmit.test.tsx

import type { WebviewMessage } from "@shofer/types"

import { useCLIStore } from "../../store.js"
import { useUIStateStore } from "../../stores/uiStateStore.js"
import { useTaskSubmit } from "../useTaskSubmit.js"
import { renderHook } from "./helpers/render-hook.js"

/**
 * The submit path: three mutually exclusive destinations for a line the user
 * typed — answer the outstanding ask, START the first task, or continue an
 * existing one — plus the Y/N approval keys.
 *
 * `handleApprove` / `handleReject` post `yesButtonClicked` / `noButtonClicked`;
 * they are the human deciding, which is why they are separate from the message
 * path and never inferred from typed text.
 */
describe("useTaskSubmit", () => {
	let sent: WebviewMessage[]
	let sendToExtension: (msg: WebviewMessage) => void
	let runTask: ReturnType<typeof vi.fn>
	let seenMessageIds: { current: Set<string> }
	let firstTextMessageSkipped: { current: boolean }

	beforeEach(() => {
		useCLIStore.getState().reset()
		useUIStateStore.getState().resetUIState()
		sent = []
		sendToExtension = (msg) => sent.push(msg)
		runTask = vi.fn().mockResolvedValue(undefined)
		seenMessageIds = { current: new Set(["stale"]) }
		firstTextMessageSkipped = { current: true }
	})

	const mount = (overrides: Partial<Parameters<typeof useTaskSubmit>[0]> = {}) =>
		renderHook(() =>
			useTaskSubmit({
				sendToExtension,
				runTask,
				seenMessageIds: seenMessageIds as React.MutableRefObject<Set<string>>,
				firstTextMessageSkipped: firstTextMessageSkipped as React.MutableRefObject<boolean>,
				...overrides,
			}),
		)

	it("ignores an empty submission and one with no transport", async () => {
		const hook = mount()
		await hook.actAsync(() => hook.current.handleSubmit("   "))
		expect(sent).toEqual([])
		hook.unmount()

		const detached = mount({ sendToExtension: null })
		await detached.actAsync(() => detached.current.handleSubmit("hello"))
		expect(sent).toEqual([])
		detached.unmount()
	})

	it("ignores the __CUSTOM__ sentinel the followup menu uses to open the text box", async () => {
		const hook = mount()
		await hook.actAsync(() => hook.current.handleSubmit("__CUSTOM__"))

		expect(sent).toEqual([])
		expect(useCLIStore.getState().messages).toEqual([])
		hook.unmount()
	})

	it("starts the first task through runTask rather than the ask channel", async () => {
		const hook = mount()
		await hook.actAsync(() => hook.current.handleSubmit("  do the thing  "))

		expect(runTask).toHaveBeenCalledWith("do the thing")
		expect(sent).toEqual([])
		expect(useCLIStore.getState().hasStartedTask).toBe(true)
		expect(useCLIStore.getState().isLoading).toBe(true)
		expect(useCLIStore.getState().messages[0]).toMatchObject({ role: "user", content: "do the thing" })

		hook.unmount()
	})

	it("surfaces a failure to start the task and stops the spinner", async () => {
		runTask.mockRejectedValue(new Error("no provider"))
		const hook = mount()
		await hook.actAsync(() => hook.current.handleSubmit("go"))

		expect(useCLIStore.getState().error).toBe("no provider")
		expect(useCLIStore.getState().isLoading).toBe(false)
		hook.unmount()
	})

	it("stringifies a non-Error rejection", async () => {
		runTask.mockRejectedValue("plain string")
		const hook = mount()
		await hook.actAsync(() => hook.current.handleSubmit("go"))

		expect(useCLIStore.getState().error).toBe("plain string")
		hook.unmount()
	})

	it("starts the task with no runTask wired without throwing", async () => {
		const hook = mount({ runTask: null })
		await hook.actAsync(() => hook.current.handleSubmit("go"))

		expect(useCLIStore.getState().hasStartedTask).toBe(true)
		hook.unmount()
	})

	it("answers an outstanding ask as a messageResponse and clears the custom-input state", async () => {
		useCLIStore.getState().setPendingAsk({ id: "a1", type: "followup", content: "?" })
		useUIStateStore.getState().setShowCustomInput(true)
		useUIStateStore.getState().setIsTransitioningToCustomInput(true)

		const hook = mount()
		await hook.actAsync(() => hook.current.handleSubmit("the answer"))

		expect(sent).toEqual([{ type: "askResponse", askResponse: "messageResponse", text: "the answer" }])
		expect(useCLIStore.getState().pendingAsk).toBeNull()
		expect(useUIStateStore.getState().showCustomInput).toBe(false)
		expect(useUIStateStore.getState().isTransitioningToCustomInput).toBe(false)
		expect(useCLIStore.getState().isLoading).toBe(true)
		expect(runTask).not.toHaveBeenCalled()

		hook.unmount()
	})

	it("continues a started task over the ask channel, clearing a completed state first", async () => {
		useCLIStore.getState().setHasStartedTask(true)
		useCLIStore.getState().setComplete(true)

		const hook = mount()
		await hook.actAsync(() => hook.current.handleSubmit("and now this"))

		expect(useCLIStore.getState().isComplete).toBe(false)
		expect(useCLIStore.getState().isLoading).toBe(true)
		expect(sent).toEqual([{ type: "askResponse", askResponse: "messageResponse", text: "and now this" }])
		expect(runTask).not.toHaveBeenCalled()

		hook.unmount()
	})

	it("intercepts the /new global command: resets the CLI and re-requests the catalogs", async () => {
		useCLIStore.getState().setHasStartedTask(true)
		useCLIStore.getState().addMessage({ id: "m1", role: "user", content: "old" })

		const hook = mount()
		await hook.actAsync(() => hook.current.handleSubmit("/new"))

		expect(useCLIStore.getState().messages).toEqual([])
		expect(seenMessageIds.current.size).toBe(0)
		expect(firstTextMessageSkipped.current).toBe(false)
		expect(sent).toEqual([{ type: "clearTask" }, { type: "requestCommands" }, { type: "requestModes" }])

		hook.unmount()
	})

	it("passes a slash command that is not a CLI global straight through to the agent", async () => {
		useCLIStore.getState().setHasStartedTask(true)
		const hook = mount()
		await hook.actAsync(() => hook.current.handleSubmit("/not-a-cli-command"))

		expect(sent).toEqual([{ type: "askResponse", askResponse: "messageResponse", text: "/not-a-cli-command" }])
		hook.unmount()
	})

	it("passes a bare slash through, matching no command name at all", async () => {
		useCLIStore.getState().setHasStartedTask(true)
		const hook = mount()
		await hook.actAsync(() => hook.current.handleSubmit("/"))

		expect(sent).toEqual([{ type: "askResponse", askResponse: "messageResponse", text: "/" }])
		hook.unmount()
	})

	it("approves and rejects through the ask channel", () => {
		useCLIStore.getState().setPendingAsk({ id: "a1", type: "tool", content: "run?" })
		const hook = mount()

		hook.act(() => hook.current.handleApprove())
		expect(sent).toEqual([{ type: "askResponse", askResponse: "yesButtonClicked" }])
		expect(useCLIStore.getState().pendingAsk).toBeNull()
		expect(useCLIStore.getState().isLoading).toBe(true)

		hook.act(() => hook.current.handleReject())
		expect(sent[1]).toEqual({ type: "askResponse", askResponse: "noButtonClicked" })

		hook.unmount()
	})

	it("decides nothing when there is no transport to decide over", () => {
		const hook = mount({ sendToExtension: null })

		hook.act(() => hook.current.handleApprove())
		hook.act(() => hook.current.handleReject())

		expect(sent).toEqual([])
		hook.unmount()
	})
})
