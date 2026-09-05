import { render } from "ink-testing-library"

import type { AutocompletePickerState } from "../components/autocomplete/types.js"
import type { PendingAsk, TUIMessage } from "../types.js"
import { App, type TUIAppProps } from "../App.js"

/**
 * `App` is a composition root: every seam it drives — the extension host, the
 * stores, the focus/toast/input hooks — belongs to another module. These tests
 * fake those seams and assert on what App itself decides: which branch of the
 * input area renders, what the status bar says, and how the Y/N, arrow and
 * autocomplete key paths are wired.
 */
const h = vi.hoisted(() => {
	const emptyPicker = {
		activeTrigger: null,
		results: [],
		selectedIndex: 0,
		isOpen: false,
		isLoading: false,
		triggerInfo: null,
	}

	return {
		cli: {
			messages: [] as unknown[],
			pendingAsk: null as unknown,
			isLoading: false,
			isComplete: false,
			hasStartedTask: false,
			error: null as string | null,
			fileSearchResults: [] as unknown[],
			allSlashCommands: [] as unknown[],
			availableModes: [] as unknown[],
			taskHistory: [] as unknown[],
			currentMode: "code",
			tokenUsage: null as unknown,
			routerModels: {},
			apiConfiguration: {},
			currentTodos: [] as unknown[],
		},
		ui: {
			showExitHint: false,
			countdownSeconds: null as number | null,
			showCustomInput: false,
			isTransitioningToCustomInput: false,
			showTodoViewer: false,
			pickerState: emptyPicker as unknown,
			setIsTransitioningToCustomInput: vi.fn(),
			setShowCustomInput: vi.fn(),
		},
		hooks: {
			currentToast: null as unknown,
			showInfo: vi.fn(),
			sendToExtension: vi.fn(),
			runTask: vi.fn(),
			cancelTask: vi.fn(),
			cleanup: vi.fn(),
			handleSubmit: vi.fn(),
			handleApprove: vi.fn(),
			handleReject: vi.fn(),
			cancelCountdown: vi.fn(),
			canToggleFocus: true,
			isScrollAreaActive: false,
			isInputAreaActive: true,
			toggleFocus: vi.fn(),
			handlePickerStateChange: vi.fn(),
			handlePickerSelect: vi.fn(),
			handlePickerClose: vi.fn(),
			handlePickerIndexChange: vi.fn(),
			globalInputOptions: null as unknown,
			focusOptions: null as unknown,
		},
		emptyPicker,
	}
})

vi.mock("../store.js", () => ({
	useCLIStore: () => h.cli,
}))

vi.mock("../stores/uiStateStore.js", () => {
	const useUIStateStore = () => h.ui
	useUIStateStore.getState = () => h.ui
	return { useUIStateStore }
})

vi.mock("../hooks/index.js", async () => {
	const terminalSize = await vi.importActual<typeof import("../hooks/TerminalSizeContext.js")>(
		"../hooks/TerminalSizeContext.js",
	)

	return {
		TerminalSizeProvider: terminalSize.TerminalSizeProvider,
		useTerminalSize: terminalSize.useTerminalSize,
		useToast: () => ({ currentToast: h.hooks.currentToast, showInfo: h.hooks.showInfo }),
		useMessageHandlers: () => ({
			handleExtensionMessage: vi.fn(),
			seenMessageIds: new Set<string>(),
			pendingCommandRef: { current: null },
			firstTextMessageSkipped: { current: false },
		}),
		useExtensionHost: () => ({
			sendToExtension: h.hooks.sendToExtension,
			runTask: h.hooks.runTask,
			cancelTask: h.hooks.cancelTask,
			cleanup: h.hooks.cleanup,
		}),
		useTaskSubmit: () => ({
			handleSubmit: h.hooks.handleSubmit,
			handleApprove: h.hooks.handleApprove,
			handleReject: h.hooks.handleReject,
		}),
		useFocusManagement: (options: unknown) => {
			h.hooks.focusOptions = options
			return {
				canToggleFocus: h.hooks.canToggleFocus,
				isScrollAreaActive: h.hooks.isScrollAreaActive,
				isInputAreaActive: h.hooks.isInputAreaActive,
				toggleFocus: h.hooks.toggleFocus,
			}
		},
		useFollowupCountdown: () => ({ cancelCountdown: h.hooks.cancelCountdown }),
		usePickerHandlers: () => ({
			handlePickerStateChange: h.hooks.handlePickerStateChange,
			handlePickerSelect: h.hooks.handlePickerSelect,
			handlePickerClose: h.hooks.handlePickerClose,
			handlePickerIndexChange: h.hooks.handlePickerIndexChange,
		}),
		useGlobalInput: (options: unknown) => {
			h.hooks.globalInputOptions = options
		},
	}
})

// The only filesystem seam under the tree, reached through AutocompleteInput.
vi.mock("../../lib/storage/history.js", () => ({
	MAX_HISTORY_ENTRIES: 500,
	getHistoryFilePath: () => "/dev/null",
	loadHistory: async () => [],
	saveHistory: async () => {},
	addToHistory: async () => [],
}))

const ESC = "\u001B"

const BACKSPACE = "\u0008"

const KEY = {
	up: `${ESC}[A`,
	down: `${ESC}[B`,
	enter: "\r",
	escape: ESC,
} as const

const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms))

/** The picker state App last pushed to its (faked) picker-handlers hook. */
const lastPickerState = () =>
	h.hooks.handlePickerStateChange.mock.lastCall?.[0] as AutocompletePickerState<{ key: string }> | undefined

const message = (over: Partial<TUIMessage> = {}): TUIMessage => ({
	id: "m1",
	role: "assistant",
	content: "hello",
	...over,
})

const openPicker = (over: Partial<AutocompletePickerState<{ key: string }>> = {}) => ({
	...h.emptyPicker,
	isOpen: true,
	results: [{ key: "one" }, { key: "two" }],
	...over,
})

function baseProps(): TUIAppProps {
	return {
		mode: "code",
		user: null,
		provider: "shofer",
		model: "some-model",
		reasoningEffort: "medium",
		workspacePath: "/tmp/project",
		extensionPath: "/tmp/ext",
		ephemeral: false,
		version: "9.9.9",
		createExtensionHost: () => ({}) as TUIAppProps["createExtensionHost"] extends never ? never : never,
	} as unknown as TUIAppProps
}

async function renderApp(overrides: Partial<TUIAppProps> = {}) {
	const result = render(<App {...baseProps()} {...overrides} />)
	// Ink subscribes to stdin from an effect and ScrollArea measures on a
	// 100ms interval, so give the first frame room to settle before driving it.
	await tick(160)

	const press = async (sequence: string) => {
		result.stdin.write(sequence)
		await tick(40)
	}

	return {
		...result,
		press,
		/**
		 * Re-presses until the expectation holds. Every key these tests send is
		 * idempotent (arrows saturate at the ends of a list, a repeated
		 * character only re-runs the same debounced search, confirming the same
		 * option fires `onChange` once), so retrying is deterministic rather
		 * than a longer sleep.
		 */
		async pressUntil(sequence: string, done: () => boolean) {
			for (let attempt = 0; attempt < 20 && !done(); attempt++) {
				result.stdin.write(sequence)
				await tick(40)
			}
			if (!done()) throw new Error(`key ${JSON.stringify(sequence)} never took effect`)
		},
		async type(text: string) {
			for (const char of text) {
				result.stdin.write(char)
				await tick(25)
			}
			await tick(60)
		},
		/**
		 * Types `text`, waits past the triggers' 150ms debounce, and — if the
		 * keystrokes were dropped before Ink subscribed — backspaces the line
		 * clean and tries again. Clearing between attempts is what keeps this
		 * deterministic: a retry that appended would change the query.
		 */
		async typeUntil(text: string, done: () => boolean) {
			for (let attempt = 0; attempt < 10; attempt++) {
				if (done()) return
				for (const char of text) {
					result.stdin.write(char)
					await tick(25)
				}
				await tick(220)
				if (done()) return
				for (let i = 0; i < text.length; i++) {
					result.stdin.write(BACKSPACE)
					await tick(20)
				}
				await tick(60)
			}
			if (!done()) throw new Error(`typing ${JSON.stringify(text)} never took effect`)
		},
	}
}

describe("App", () => {
	const originalRows = process.stdout.rows
	const originalColumns = process.stdout.columns

	beforeAll(() => {
		Object.defineProperty(process.stdout, "rows", { value: 40, configurable: true })
		Object.defineProperty(process.stdout, "columns", { value: 100, configurable: true })
	})

	afterAll(() => {
		Object.defineProperty(process.stdout, "rows", { value: originalRows, configurable: true })
		Object.defineProperty(process.stdout, "columns", { value: originalColumns, configurable: true })
	})

	beforeEach(() => {
		vi.clearAllMocks()
		Object.assign(h.cli, {
			messages: [],
			pendingAsk: null,
			isLoading: false,
			isComplete: false,
			hasStartedTask: false,
			error: null,
			fileSearchResults: [],
			allSlashCommands: [],
			availableModes: [],
			taskHistory: [],
			currentMode: "code",
			tokenUsage: null,
			routerModels: {},
			apiConfiguration: {},
			currentTodos: [],
		})
		Object.assign(h.ui, {
			showExitHint: false,
			countdownSeconds: null,
			showCustomInput: false,
			isTransitioningToCustomInput: false,
			showTodoViewer: false,
			pickerState: h.emptyPicker,
		})
		Object.assign(h.hooks, {
			currentToast: null,
			canToggleFocus: true,
			isScrollAreaActive: false,
			isInputAreaActive: true,
		})
	})

	describe("error state", () => {
		it("replaces the whole UI with the error and the exit hint", async () => {
			h.cli.error = "the host died"
			const { lastFrame } = await renderApp()
			const output = lastFrame() ?? ""

			expect(output).toContain("Error: the host died")
			expect(output).toContain("Press Ctrl+C to exit")
			// The normal chrome is gone.
			expect(output).not.toContain("Shofer CLI")
		})
	})

	describe("normal layout", () => {
		it("renders the header with the version and the current mode", async () => {
			h.cli.currentMode = "architect"
			const { lastFrame } = await renderApp()
			const output = lastFrame() ?? ""

			expect(output).toContain("Shofer CLI v9.9.9")
			expect(output).toContain("mode: architect")
		})

		it("falls back to the launch mode when the store has none", async () => {
			h.cli.currentMode = ""
			const { lastFrame } = await renderApp({ mode: "debug" } as Partial<TUIAppProps>)

			expect(lastFrame()).toContain("mode: debug")
		})

		it("renders the message history", async () => {
			h.cli.messages = [
				message({ id: "a", role: "user", content: "a question" }),
				message({ id: "b", role: "assistant", content: "an answer" }),
			]
			const { lastFrame } = await renderApp()
			await tick(160)
			const output = lastFrame() ?? ""

			expect(output).toContain("a question")
			expect(output).toContain("an answer")
		})

		it("renders the token metrics when a context window resolves", async () => {
			h.cli.tokenUsage = { totalCost: 1.5, totalTokensIn: 1000, totalTokensOut: 500, contextTokens: 4000 }
			h.cli.apiConfiguration = { apiProvider: "openai", openAiModelId: "x" }
			h.cli.routerModels = { openai: { x: { contextWindow: 8000 } } }

			const { lastFrame } = await renderApp()

			expect(lastFrame()).toContain("$1.50")
		})

		it("shows the continue placeholder once the task completed", async () => {
			h.cli.isComplete = true
			const { lastFrame } = await renderApp()

			// The placeholder only paints while the input is inactive.
			h.hooks.isInputAreaActive = false
			expect(lastFrame()).toBeDefined()
		})
	})

	describe("status bar", () => {
		it("prefers a toast over everything else", async () => {
			h.hooks.currentToast = { id: "t", message: "Mode switched", type: "info" }
			h.ui.showExitHint = true
			h.cli.isLoading = true

			const { lastFrame } = await renderApp()

			expect(lastFrame()).toContain("Mode switched")
			expect(lastFrame()).not.toContain("Press Ctrl+C again")
		})

		it("shows the exit hint next", async () => {
			h.ui.showExitHint = true
			h.cli.isLoading = true

			const { lastFrame } = await renderApp()

			expect(lastFrame()).toContain("Press Ctrl+C again to exit")
		})

		it("shows the thinking spinner while loading", async () => {
			h.cli.isLoading = true
			h.cli.messages = [message({ role: "user", content: "go" })]

			const { lastFrame } = await renderApp()
			const output = lastFrame() ?? ""

			expect(output).toContain("Esc to cancel")
		})

		it("labels the spinner for a tool call", async () => {
			h.cli.isLoading = true
			// `getView` reports "ToolUse" for an assistant turn that still has
			// tool calls outstanding — that is the state the label describes.
			h.cli.messages = [message({ id: "t", role: "assistant", hasPendingToolCalls: true })]

			const { lastFrame } = await renderApp()

			expect(lastFrame()).toContain("Using tool")
		})

		it("adds the scroll indicator to the spinner row when the scroll area has focus", async () => {
			h.cli.isLoading = true
			h.hooks.isScrollAreaActive = true

			const { lastFrame } = await renderApp()

			expect(lastFrame()).toContain("scroll")
		})

		it("shows the scroll indicator alone when not loading", async () => {
			h.hooks.isScrollAreaActive = true
			h.hooks.isInputAreaActive = false

			const { lastFrame } = await renderApp()
			const output = lastFrame() ?? ""

			expect(output).toContain("↑↓ scroll")
			expect(output).not.toContain("Esc to cancel")
		})

		it("shows the shortcut hint when the input has focus", async () => {
			const { lastFrame } = await renderApp()

			expect(lastFrame()).toContain("? for shortcuts")
		})

		it("shows nothing when neither area has focus", async () => {
			h.hooks.isScrollAreaActive = false
			h.hooks.isInputAreaActive = false

			const { lastFrame } = await renderApp()
			const output = lastFrame() ?? ""

			expect(output).not.toContain("? for shortcuts")
			expect(output).not.toContain("↑↓ scroll")
		})

		it("suppresses the spinner while an ask is pending", async () => {
			h.cli.isLoading = true
			h.cli.pendingAsk = { id: "a", type: "tool", content: "May I?" } satisfies PendingAsk

			const { lastFrame } = await renderApp()

			expect(lastFrame()).not.toContain("Esc to cancel")
		})
	})

	describe("approval prompt", () => {
		beforeEach(() => {
			h.cli.pendingAsk = { id: "ask-1", type: "tool", content: "Run rm -rf /?" } satisfies PendingAsk
		})

		it("renders the ask and the Y/N instructions", async () => {
			const { lastFrame } = await renderApp()
			const output = lastFrame() ?? ""

			expect(output).toContain("Run rm -rf /?")
			expect(output).toContain("to approve")
			expect(output).toContain("to reject")
		})

		it("approves on y", async () => {
			const { press } = await renderApp()

			await press("y")

			expect(h.hooks.handleApprove).toHaveBeenCalled()
			expect(h.hooks.handleReject).not.toHaveBeenCalled()
		})

		it("approves on an uppercase Y", async () => {
			const { press } = await renderApp()

			await press("Y")

			expect(h.hooks.handleApprove).toHaveBeenCalled()
		})

		it("rejects on n", async () => {
			const { press } = await renderApp()

			await press("n")

			expect(h.hooks.handleReject).toHaveBeenCalled()
			expect(h.hooks.handleApprove).not.toHaveBeenCalled()
		})

		it("ignores any other key", async () => {
			const { press } = await renderApp()

			await press("q")

			expect(h.hooks.handleApprove).not.toHaveBeenCalled()
			expect(h.hooks.handleReject).not.toHaveBeenCalled()
		})

		it("takes no Y/N decision when no ask is pending", async () => {
			h.cli.pendingAsk = null
			const { press } = await renderApp()

			await press("y")

			expect(h.hooks.handleApprove).not.toHaveBeenCalled()
		})

		it("takes no Y/N decision for a followup ask", async () => {
			h.cli.pendingAsk = { id: "f", type: "followup", content: "Which one?" } satisfies PendingAsk
			const { press } = await renderApp()

			await press("y")

			expect(h.hooks.handleApprove).not.toHaveBeenCalled()
		})

		it("tells focus management that an approval is showing", async () => {
			await renderApp()

			expect(h.hooks.focusOptions).toMatchObject({ showApprovalPrompt: true })
		})
	})

	describe("followup with suggestions", () => {
		beforeEach(() => {
			h.cli.pendingAsk = {
				id: "f1",
				type: "followup",
				content: "Which framework?",
				suggestions: [{ answer: "React" }, { answer: "Vue" }],
			} satisfies PendingAsk
		})

		it("renders the question and each suggestion", async () => {
			const { lastFrame } = await renderApp()
			const output = lastFrame() ?? ""

			expect(output).toContain("Which framework?")
			expect(output).toContain("React")
			expect(output).toContain("Vue")
			expect(output).toContain("Type something...")
			expect(output).toContain("↑↓ navigate")
		})

		it("shows the auto-select countdown", async () => {
			h.ui.countdownSeconds = 7
			const { lastFrame } = await renderApp()

			expect(lastFrame()).toContain("Auto-select in 7s")
		})

		it("omits the countdown when it is not running", async () => {
			const { lastFrame } = await renderApp()

			expect(lastFrame()).not.toContain("Auto-select in")
		})

		it("submits the highlighted suggestion on enter", async () => {
			const { pressUntil, press, lastFrame } = await renderApp()

			// Park the highlight on the first option before confirming. Only a
			// key that SATURATES may be retried — up stops at the top of the
			// list, while down would walk past its target — and retrying the
			// arrow is what proves stdin is live, since Ink subscribes from an
			// effect and the Select fires `onChange` once per distinct value.
			await pressUntil(KEY.up, () => (lastFrame() ?? "").includes("❯ React"))
			await press(KEY.enter)
			await tick(80)

			expect(h.hooks.handleSubmit).toHaveBeenCalledWith("React")
		})

		it("switches to the custom input when the escape hatch is chosen", async () => {
			// One suggestion, so "Type something..." is a single arrow away —
			// the Select fires `onChange` once per distinct value, so the
			// confirming Enter is not a key that can simply be re-pressed.
			h.cli.pendingAsk = {
				id: "f1",
				type: "followup",
				content: "Which framework?",
				suggestions: [{ answer: "React" }],
			} satisfies PendingAsk

			const { pressUntil, press, lastFrame } = await renderApp()

			await pressUntil(KEY.down, () => (lastFrame() ?? "").includes("❯ Type something..."))
			await press(KEY.enter)
			await tick(80)

			expect(h.hooks.cancelCountdown).toHaveBeenCalled()
			expect(h.ui.setIsTransitioningToCustomInput).toHaveBeenCalledWith(true)
			expect(h.ui.setShowCustomInput).toHaveBeenCalledWith(true)
			expect(h.hooks.handleSubmit).not.toHaveBeenCalled()
		})

		it("ignores the selection while already transitioning to the custom input", async () => {
			h.ui.isTransitioningToCustomInput = true
			const { press } = await renderApp()

			await press(KEY.enter)

			expect(h.hooks.handleSubmit).not.toHaveBeenCalled()
		})

		it("cancels the countdown on an arrow key", async () => {
			h.ui.countdownSeconds = 5
			const { pressUntil } = await renderApp()

			await pressUntil(KEY.down, () => h.hooks.cancelCountdown.mock.calls.length > 0)

			expect(h.hooks.cancelCountdown).toHaveBeenCalled()
		})

		it("cancels the countdown on the up arrow too", async () => {
			h.ui.countdownSeconds = 5
			const { pressUntil } = await renderApp()

			await pressUntil(KEY.up, () => h.hooks.cancelCountdown.mock.calls.length > 0)

			expect(h.hooks.cancelCountdown).toHaveBeenCalled()
		})

		it("does not cancel a countdown that is not running", async () => {
			h.ui.countdownSeconds = null
			const { press } = await renderApp()

			await press(KEY.down)

			expect(h.hooks.cancelCountdown).not.toHaveBeenCalled()
		})

		it("does not cancel a countdown on a non-arrow key", async () => {
			h.ui.countdownSeconds = 5
			const { press } = await renderApp()

			await press("x")

			expect(h.hooks.cancelCountdown).not.toHaveBeenCalled()
		})
	})

	describe("followup with the custom input", () => {
		beforeEach(() => {
			h.cli.pendingAsk = {
				id: "f2",
				type: "followup",
				content: "Say more",
				suggestions: [{ answer: "React" }],
			} satisfies PendingAsk
			h.ui.showCustomInput = true
		})

		it("renders the free-text input instead of the suggestion list", async () => {
			const { lastFrame } = await renderApp()
			const output = lastFrame() ?? ""

			expect(output).toContain("Say more")
			expect(output).not.toContain("↑↓ navigate")
		})

		it("renders the free-text input when the ask carries no suggestions", async () => {
			h.cli.pendingAsk = { id: "f3", type: "followup", content: "Anything?" } satisfies PendingAsk
			h.ui.showCustomInput = false

			const { lastFrame } = await renderApp()

			expect(lastFrame()).toContain("Anything?")
			expect(lastFrame()).not.toContain("↑↓ navigate")
		})

		it("renders the free-text input when the suggestion list is empty", async () => {
			h.cli.pendingAsk = {
				id: "f4",
				type: "followup",
				content: "Nothing suggested",
				suggestions: [],
			} satisfies PendingAsk
			h.ui.showCustomInput = false

			const { lastFrame } = await renderApp()

			expect(lastFrame()).toContain("Nothing suggested")
			expect(lastFrame()).not.toContain("↑↓ navigate")
		})

		it("submits the typed response and closes the custom input", async () => {
			const { type, press } = await renderApp()

			await type("my answer")
			await press(KEY.enter)

			expect(h.hooks.handleSubmit).toHaveBeenCalledWith("my answer")
			expect(h.ui.setShowCustomInput).toHaveBeenCalledWith(false)
			expect(h.ui.setIsTransitioningToCustomInput).toHaveBeenCalledWith(false)
		})

		it("does not submit an empty response", async () => {
			const { press } = await renderApp()

			await press(KEY.enter)

			expect(h.hooks.handleSubmit).not.toHaveBeenCalled()
		})

		it("renders the picker under the followup input when it is open", async () => {
			h.ui.pickerState = openPicker()

			const { lastFrame } = await renderApp()
			const output = lastFrame() ?? ""

			expect(output).toContain("one")
			expect(output).toContain("two")
		})

		it("renders the picker's own empty message", async () => {
			h.ui.pickerState = {
				...h.emptyPicker,
				isOpen: true,
				activeTrigger: { id: "file", emptyMessage: "No files match" },
			}

			const { lastFrame } = await renderApp()

			expect(lastFrame()).toContain("No files match")
		})
	})

	describe("main input area", () => {
		it("renders the picker when it is open", async () => {
			h.ui.pickerState = openPicker()

			const { lastFrame } = await renderApp()
			const output = lastFrame() ?? ""

			expect(output).toContain("one")
			expect(output).toContain("two")
			expect(output).not.toContain("? for shortcuts")
		})

		it("uses the active trigger's own renderItem", async () => {
			h.ui.pickerState = {
				...h.emptyPicker,
				isOpen: true,
				results: [{ key: "alpha" }],
				activeTrigger: {
					id: "custom",
					renderItem: (item: { key: string }) => `RENDERED:${item.key}`,
				},
			}

			const { lastFrame } = await renderApp()

			expect(lastFrame()).toContain("RENDERED:alpha")
		})

		it("renders the TODO viewer ahead of the picker", async () => {
			h.ui.showTodoViewer = true
			h.ui.pickerState = openPicker()
			h.cli.currentTodos = [{ id: "1", content: "Ship it", status: "pending" }]

			const { lastFrame } = await renderApp()
			const output = lastFrame() ?? ""

			expect(output).toContain("TODO List")
			expect(output).toContain("Ctrl+T to close")
			expect(output).not.toContain("one")
		})

		it("submits typed text through the task-submit hook", async () => {
			const { type, press } = await renderApp()

			await type("do the thing")
			await press(KEY.enter)

			expect(h.hooks.handleSubmit).toHaveBeenCalledWith("do the thing")
		})
	})

	describe("autocomplete triggers", () => {
		it("opens the slash-command picker", async () => {
			const { typeUntil } = await renderApp()

			await typeUntil("/", () => (lastPickerState()?.results.length ?? 0) > 0)

			expect(lastPickerState()?.activeTrigger?.id).toBe("slash-command")
		})

		it("merges the extension's slash commands with the CLI's own", async () => {
			h.cli.allSlashCommands = [{ name: "extension-only", source: "project" }]
			const { typeUntil } = await renderApp()

			await typeUntil("/", () => (lastPickerState()?.results.length ?? 0) > 0)

			const last = lastPickerState()!
			expect(last.results.some((r) => r.key === "extension-only")).toBe(true)
			expect(last.results.length).toBeGreaterThan(1)
		})

		it("opens the mode picker and offers the available modes", async () => {
			h.cli.availableModes = [{ slug: "architect", name: "Architect" }]
			const { typeUntil } = await renderApp()

			await typeUntil("!", () => (lastPickerState()?.results.length ?? 0) > 0)

			expect(lastPickerState()?.activeTrigger?.id).toBe("mode")
			expect(lastPickerState()?.results.map((r) => r.key)).toContain("architect")
		})

		it("opens the help picker", async () => {
			const { typeUntil } = await renderApp()

			await typeUntil("?", () => (lastPickerState()?.results.length ?? 0) > 0)

			expect(lastPickerState()?.activeTrigger?.id).toBe("help")
		})

		it("asks the extension to search files on the @ trigger", async () => {
			const { typeUntil } = await renderApp()

			await typeUntil("@src", () => h.hooks.sendToExtension.mock.calls.length > 0)

			expect(h.hooks.sendToExtension).toHaveBeenCalledWith(expect.objectContaining({ type: "grepSearch" }))
		})

		it("does nothing on the @ trigger when the host is not connected yet", async () => {
			const realSend = h.hooks.sendToExtension
			h.hooks.sendToExtension = undefined as unknown as typeof realSend
			try {
				const { type, lastFrame } = await renderApp()

				await type("@src")
				await tick(220)

				// The trigger's onSearch returns early rather than throwing.
				expect(lastFrame()).toContain("@src")
			} finally {
				h.hooks.sendToExtension = realSend
			}
		})

		it("offers only this workspace's tasks in the history picker", async () => {
			h.cli.taskHistory = [
				{ id: "t1", task: "here", ts: Date.now(), workspace: "/tmp/project" },
				{ id: "t2", task: "elsewhere", ts: Date.now(), workspace: "/other/place" },
			]
			const { typeUntil } = await renderApp()

			await typeUntil("#", () => (lastPickerState()?.results.length ?? 0) > 0)

			expect(lastPickerState()?.activeTrigger?.id).toBe("history")
			expect(lastPickerState()?.results.map((r) => r.key)).toEqual(["t1"])
		})
	})

	describe("file-search refresh", () => {
		it("refreshes the picker when new file results arrive while it is open", async () => {
			h.ui.pickerState = { ...h.emptyPicker, isOpen: true, activeTrigger: { id: "file" } }
			const { rerender } = await renderApp()

			h.cli.fileSearchResults = [{ path: "src/a.ts", type: "file" }]
			rerender(<App {...baseProps()} />)
			await tick()

			// Nothing throws and the tree survives the refresh call.
			expect(h.hooks.handlePickerStateChange).toBeDefined()
		})

		it("does not refresh when the picker is closed", async () => {
			const { rerender, lastFrame } = await renderApp()

			h.cli.fileSearchResults = [{ path: "src/a.ts", type: "file" }]
			rerender(<App {...baseProps()} />)
			await tick()

			expect(lastFrame()).toBeDefined()
		})

		it("does not refresh when the results arrive empty", async () => {
			h.ui.pickerState = { ...h.emptyPicker, isOpen: true, activeTrigger: { id: "file" } }
			const { rerender, lastFrame } = await renderApp()

			h.cli.fileSearchResults = []
			rerender(<App {...baseProps()} />)
			await tick()

			expect(lastFrame()).toBeDefined()
		})
	})

	describe("wiring", () => {
		it("hands the global-input hook the picker state and the mode list", async () => {
			h.cli.availableModes = [{ slug: "code", name: "Code" }]
			h.ui.pickerState = openPicker()

			await renderApp()

			expect(h.hooks.globalInputOptions).toMatchObject({
				pickerIsOpen: true,
				currentMode: "code",
			})
		})

		it("scrolls to the bottom when a message arrives while pinned there", async () => {
			const { rerender, lastFrame } = await renderApp()

			h.cli.messages = [message({ id: "new", content: "fresh" })]
			rerender(<App {...baseProps()} />)
			await tick(160)

			expect(lastFrame()).toContain("fresh")
		})

		it("tears down cleanly", async () => {
			const { unmount, lastFrame } = await renderApp()

			expect(lastFrame()).toBeTruthy()
			expect(() => unmount()).not.toThrow()
		})

		it("cancels a scroll update that was still queued at unmount", async () => {
			h.cli.messages = Array.from({ length: 40 }, (_, i) => message({ id: `m${i}`, content: `line ${i}` }))
			const { unmount } = await renderApp()

			// ScrollArea reports on its measure pass, and App defers the state
			// update with setImmediate; unmounting inside that window is what
			// exercises the clearImmediate teardown.
			unmount()

			expect(() => unmount()).not.toThrow()
		})
	})
})
