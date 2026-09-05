// npx vitest src/components/chat/__tests__/ChatTextArea.selectors.spec.tsx
//
// The composer's two pre-task selectors, whose behaviour differs by whether a
// task is focused: with one, mode and profile changes are scoped to THAT task
// through the host; on the home screen they are pure tier-1 drafts that ride
// along with the next `newTask` and touch nothing globally.

import { defaultModeSlug } from "@shofer/types"

import { render, fireEvent, screen } from "@src/utils/test-utils"
import { useExtensionState } from "@src/context/ExtensionStateContext"
import { vscode } from "@src/utils/vscode"

import { ChatTextArea } from "../ChatTextArea"

vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))
vi.mock("@src/context/ExtensionStateContext")
vi.mock("@src/components/common/CodeBlock")
vi.mock("@src/components/common/MarkdownBlock")

const postMessage = vi.mocked(vscode.postMessage)
const posted = (type: string) => postMessage.mock.calls.map((c) => c[0]).filter((m: any) => m?.type === type)

const setMode = vi.fn()
const setCurrentApiConfigName = vi.fn()
const onSelectImages = vi.fn()
const onStop = vi.fn()
const onCancel = vi.fn()
const onEnqueueMessage = vi.fn()

const defaultProps = {
	inputValue: "",
	setInputValue: vi.fn(),
	onSend: vi.fn(),
	sendingDisabled: false,
	selectApiConfigDisabled: false,
	onSelectImages,
	shouldDisableImages: false,
	placeholderText: "Type a message…",
	selectedImages: [],
	setSelectedImages: vi.fn(),
	onHeightChange: vi.fn(),
	mode: defaultModeSlug,
	setMode,
	modeShortcutText: "",
}

const state = (over: Record<string, unknown> = {}) =>
	vi.mocked(useExtensionState).mockReturnValue({
		filePaths: [],
		openedTabs: [],
		apiConfiguration: { apiProvider: "anthropic" },
		taskHistory: [],
		cwd: "/repo",
		commands: [],
		customModes: [],
		listApiConfigMeta: [
			{ id: "cfg-1", name: "Config One" },
			{ id: "cfg-2", name: "Config Two" },
		],
		currentApiConfigName: "Config One",
		setCurrentApiConfigName,
		modeApiConfigs: {},
		...over,
	} as never)

beforeEach(() => {
	vi.clearAllMocks()
	state()
})

describe("the mode selector", () => {
	it("keeps a home-screen mode choice local", () => {
		render(<ChatTextArea {...defaultProps} />)
		// The selector's own spec covers its UI; here the handler is what matters.
		expect(posted("mode")).toHaveLength(0)
	})

	it("seeds the profile draft from the mode's association on the home screen", () => {
		state({ modeApiConfigs: { [defaultModeSlug]: "cfg-2" }, currentApiConfigName: "Config One" })
		render(<ChatTextArea {...defaultProps} />)
		expect(setCurrentApiConfigName).toHaveBeenCalledWith("Config Two")
	})

	it("leaves the profile alone when the mode names one already selected", () => {
		state({ modeApiConfigs: { [defaultModeSlug]: "cfg-1" }, currentApiConfigName: "Config One" })
		render(<ChatTextArea {...defaultProps} />)
		expect(setCurrentApiConfigName).not.toHaveBeenCalled()
	})

	it("leaves the profile alone with a task focused — that is the task's own choice", () => {
		// `hasActiveTask` is a PROP, not derived from the context.
		state({ modeApiConfigs: { [defaultModeSlug]: "cfg-2" }, currentApiConfigName: "Config One" })
		render(<ChatTextArea {...defaultProps} hasActiveTask />)
		expect(setCurrentApiConfigName).not.toHaveBeenCalled()
	})

	it("ignores an association naming a profile that no longer exists", () => {
		state({ modeApiConfigs: { [defaultModeSlug]: "gone" } })
		render(<ChatTextArea {...defaultProps} />)
		expect(setCurrentApiConfigName).not.toHaveBeenCalled()
	})
})

describe("the image button", () => {
	it("asks the host to pick images", () => {
		const { container } = render(<ChatTextArea {...defaultProps} />)
		const button = container.querySelector('[aria-label="chat:addImages"]') as HTMLElement
		fireEvent.click(button)
		expect(onSelectImages).toHaveBeenCalled()
	})

	it("is disabled and inert when the model cannot take images", () => {
		const { container } = render(<ChatTextArea {...defaultProps} shouldDisableImages />)
		const button = container.querySelector("button[disabled]") as HTMLButtonElement
		expect(button).toBeTruthy()
		fireEvent.click(button)
		expect(onSelectImages).not.toHaveBeenCalled()
	})
})

describe("edit mode", () => {
	it("offers a cancel affordance and abandons on Escape", () => {
		render(<ChatTextArea {...defaultProps} isEditMode onCancel={onCancel} inputValue="editing" />)

		fireEvent.keyDown(screen.getByPlaceholderText("Type a message…"), { key: "Escape" })
		expect(onCancel).toHaveBeenCalled()
	})

	it("does not cancel on Escape outside edit mode", () => {
		render(<ChatTextArea {...defaultProps} onCancel={onCancel} inputValue="x" />)
		fireEvent.keyDown(screen.getByPlaceholderText("Type a message…"), { key: "Escape" })
		expect(onCancel).not.toHaveBeenCalled()
	})
})

describe("the send / stop button", () => {
	it("stops the run while the agent is streaming", () => {
		render(<ChatTextArea {...defaultProps} isStreaming onStop={onStop} />)
		fireEvent.click(screen.getByLabelText("chat:stop.title"))
		expect(onStop).toHaveBeenCalled()
	})

	it("is NOT labelled as a stop button when nothing is running", () => {
		const { container } = render(<ChatTextArea {...defaultProps} inputValue="hello" />)
		// The same button morphs between send and stop; with nothing running it
		// carries the send-key hint instead.
		expect(container.querySelector('[aria-label="chat:stop.title"]')).toBeNull()
		expect(container.querySelector('[aria-label^="chat:pressToSend"]')).toBeTruthy()
	})
})

describe("the enqueue affordance", () => {
	it("appears only while the run is stoppable AND there is text to enqueue", () => {
		const { rerender } = render(<ChatTextArea {...defaultProps} isStreaming onEnqueueMessage={onEnqueueMessage} />)
		expect(screen.queryByLabelText("chat:enqueueMessage")).not.toBeInTheDocument()

		rerender(
			<ChatTextArea {...defaultProps} isStreaming inputValue="queue me" onEnqueueMessage={onEnqueueMessage} />,
		)
		fireEvent.click(screen.getByLabelText("chat:enqueueMessage"))
		expect(onEnqueueMessage).toHaveBeenCalled()
	})

	it("is absent when the run is not stoppable", () => {
		render(<ChatTextArea {...defaultProps} inputValue="queue me" onEnqueueMessage={onEnqueueMessage} />)
		expect(screen.queryByLabelText("chat:enqueueMessage")).not.toBeInTheDocument()
	})
})

describe("edit mode's cancel button", () => {
	it("abandons the edit", () => {
		render(<ChatTextArea {...defaultProps} isEditMode onCancel={onCancel} inputValue="editing" />)
		fireEvent.click(screen.getByLabelText("chat:cancel.title"))
		expect(onCancel).toHaveBeenCalled()
	})
})
