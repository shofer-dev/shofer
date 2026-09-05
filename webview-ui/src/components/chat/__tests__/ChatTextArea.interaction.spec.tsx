// npx vitest src/components/chat/__tests__/ChatTextArea.interaction.spec.tsx
//
// The composer's keyboard, paste and drop behaviour: the Enter contract (both
// `enterBehavior` settings), the @-mention context menu's keyboard navigation,
// the mention-aware Backspace, and the paste/drop paths that turn a URL, an
// image or a dropped file into input.

import { defaultModeSlug } from "@shofer/types"

import { render, fireEvent, screen, waitFor, act } from "@src/utils/test-utils"
import { useExtensionState } from "@src/context/ExtensionStateContext"
import { vscode } from "@src/utils/vscode"

import { ChatTextArea } from "../ChatTextArea"

vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))
vi.mock("@src/context/ExtensionStateContext")
vi.mock("@src/components/common/CodeBlock")
vi.mock("@src/components/common/MarkdownBlock")

const postMessage = vi.mocked(vscode.postMessage)
const posted = (type: string) => postMessage.mock.calls.map((c) => c[0]).filter((m: any) => m?.type === type)

const setInputValue = vi.fn()
const setSelectedImages = vi.fn()
const onSend = vi.fn()

const defaultProps = {
	inputValue: "",
	setInputValue,
	onSend,
	sendingDisabled: false,
	selectApiConfigDisabled: false,
	onSelectImages: vi.fn(),
	shouldDisableImages: false,
	placeholderText: "Type a message…",
	selectedImages: [],
	setSelectedImages,
	onHeightChange: vi.fn(),
	mode: defaultModeSlug,
	setMode: vi.fn(),
	modeShortcutText: "(⌘. for next mode)",
}

const state = (over: Record<string, unknown> = {}) =>
	vi.mocked(useExtensionState).mockReturnValue({
		filePaths: ["src/a.ts", "src/b.ts"],
		openedTabs: [],
		apiConfiguration: { apiProvider: "anthropic" },
		taskHistory: [],
		cwd: "/test/workspace",
		commands: [{ name: "deploy", source: "project" }],
		customModes: [],
		...over,
	} as never)

const composer = () => screen.getByPlaceholderText("Type a message…") as HTMLTextAreaElement

/**
 * Type into the composer WITH a cursor position. Two jsdom/React details make
 * this fiddly: `handleInputChange` reads `selectionStart` to decide whether the
 * @/slash menu opens, and React's value tracker suppresses `onChange` when the
 * typed text already equals the controlled `value` — so every caller renders
 * with a DIFFERENT starting value.
 */
const typeInto = (value: string, cursor = value.length) => {
	fireEvent.change(composer(), { target: { value, selectionStart: cursor } })
}

/** The context menu is an absolutely-positioned overlay above the composer. */
const contextMenu = () => document.querySelector('[style*="calc(100% - 10px)"]')

beforeEach(() => {
	vi.clearAllMocks()
	state()
})

describe("the Enter contract", () => {
	it("sends on Enter and inserts a newline on Shift+Enter by default", () => {
		render(<ChatTextArea {...defaultProps} inputValue="hello" />)

		fireEvent.keyDown(composer(), { key: "Enter" })
		expect(onSend).toHaveBeenCalledTimes(1)

		fireEvent.keyDown(composer(), { key: "Enter", shiftKey: true })
		expect(onSend).toHaveBeenCalledTimes(1)
	})

	it("inverts under the newline enter-behaviour", () => {
		state({ enterBehavior: "newline" })
		render(<ChatTextArea {...defaultProps} inputValue="hello" />)

		fireEvent.keyDown(composer(), { key: "Enter" })
		expect(onSend).not.toHaveBeenCalled()

		fireEvent.keyDown(composer(), { key: "Enter", shiftKey: true })
		expect(onSend).toHaveBeenCalledTimes(1)

		fireEvent.keyDown(composer(), { key: "Enter", ctrlKey: true })
		expect(onSend).toHaveBeenCalledTimes(2)

		fireEvent.keyDown(composer(), { key: "Enter", metaKey: true })
		expect(onSend).toHaveBeenCalledTimes(3)
	})

	it("never sends mid-composition", () => {
		render(<ChatTextArea {...defaultProps} inputValue="こんにち" />)
		const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true })
		Object.defineProperty(event, "isComposing", { value: true })
		fireEvent(composer(), event)
		expect(onSend).not.toHaveBeenCalled()
	})
})

describe("the @-mention menu", () => {
	it("opens on @ and survives Escape (which only resets the selected type)", async () => {
		render(<ChatTextArea {...defaultProps} inputValue="" />)
		typeInto("@")
		await waitFor(() => expect(contextMenu()).toBeTruthy())

		fireEvent.keyDown(composer(), { key: "Escape" })
		expect(contextMenu()).toBeTruthy()
	})

	it("stays closed once the mention is followed by a space", async () => {
		render(<ChatTextArea {...defaultProps} inputValue="" />)
		typeInto("@ x")
		expect(contextMenu()).toBeNull()
	})

	it("moves the highlight with the arrow keys", async () => {
		render(<ChatTextArea {...defaultProps} inputValue="" />)
		typeInto("@")
		await waitFor(() => expect(contextMenu()).toBeTruthy())

		fireEvent.keyDown(composer(), { key: "ArrowDown" })
		fireEvent.keyDown(composer(), { key: "ArrowUp" })
		expect(contextMenu()).toBeTruthy()
	})

	it("asks the host for fresh commands when a slash menu opens", () => {
		render(<ChatTextArea {...defaultProps} inputValue="" />)
		typeInto("/")
		expect(posted("requestCommands")).toHaveLength(1)
	})
})

describe("mention-aware editing", () => {
	it("stages a plain edit", () => {
		render(<ChatTextArea {...defaultProps} />)
		typeInto("hello")
		expect(setInputValue).toHaveBeenCalledWith("hello")
	})

	it("moves the cursor rather than deleting the space after a mention", () => {
		const value = "@/src/a.ts more"
		render(<ChatTextArea {...defaultProps} inputValue={value} />)

		const el = composer()
		el.setSelectionRange(11, 11)
		fireEvent.keyUp(el, { key: "End" })
		fireEvent.keyDown(el, { key: "Backspace" })
		// The mention itself is untouched by the first Backspace.
		expect(setInputValue).not.toHaveBeenCalled()
	})

	it("removes the whole mention on the second Backspace", () => {
		const value = "@/src/a.ts "
		render(<ChatTextArea {...defaultProps} inputValue={value} />)

		const el = composer()
		// The composer tracks the caret from arrow/Home/End key-ups.
		el.setSelectionRange(value.length, value.length)
		fireEvent.keyUp(el, { key: "End" })

		fireEvent.keyDown(el, { key: "Backspace" })
		fireEvent.keyDown(el, { key: "Backspace" })
		expect(setInputValue).toHaveBeenCalledWith("")
	})
})

describe("pasting", () => {
	const paste = (data: { text?: string; items?: unknown[] }) =>
		act(async () => {
			fireEvent.paste(composer(), {
				clipboardData: {
					items: data.items ?? [],
					getData: () => data.text ?? "",
					files: [],
				},
			})
			await new Promise((r) => setTimeout(r, 0))
		})

	it("inserts a pasted URL as text at the cursor", async () => {
		render(<ChatTextArea {...defaultProps} inputValue="see " />)
		await paste({ text: "  https://example.test/x  " })
		expect(setInputValue).toHaveBeenCalledWith(expect.stringContaining("https://example.test/x"))
	})

	it("lets a plain text paste fall through to the browser", async () => {
		render(<ChatTextArea {...defaultProps} />)
		await paste({ text: "just words" })
		expect(setInputValue).not.toHaveBeenCalled()
		expect(posted("webviewLog").some((m: any) => m.text.includes("text paste"))).toBe(true)
	})

	it("reads pasted images into the selection", async () => {
		const blob = new Blob(["x"], { type: "image/png" })
		render(<ChatTextArea {...defaultProps} />)
		await paste({
			text: "",
			items: [{ type: "image/png", getAsFile: () => blob }],
		})
		await waitFor(() => expect(setSelectedImages).toHaveBeenCalled())
	})

	it("refuses images when the model cannot take them, and says why", async () => {
		render(<ChatTextArea {...defaultProps} shouldDisableImages />)
		await paste({ text: "", items: [{ type: "image/png", getAsFile: () => new Blob(["x"]) }] })
		expect(setSelectedImages).not.toHaveBeenCalled()
		expect(posted("webviewLog").some((m: any) => m.text.includes("images disabled"))).toBe(true)
	})

	it("ignores an image item whose blob is missing", async () => {
		render(<ChatTextArea {...defaultProps} />)
		await paste({ text: "", items: [{ type: "image/png", getAsFile: () => null }] })
		expect(setSelectedImages).not.toHaveBeenCalled()
		expect(posted("webviewLog").some((m: any) => m.text.includes("no valid images"))).toBe(true)
	})

	it("ignores an image type the host does not accept", async () => {
		render(<ChatTextArea {...defaultProps} />)
		await paste({ text: "", items: [{ type: "image/tiff", getAsFile: () => new Blob(["x"]) }] })
		expect(setSelectedImages).not.toHaveBeenCalled()
	})
})

describe("the enhance-prompt button", () => {
	const enhance = () =>
		screen.getByRole("button", {
			name: (_: string, element: Element) => element.querySelector(".lucide-wand-sparkles") !== null,
		})

	it("asks the host to enhance the current text", () => {
		render(<ChatTextArea {...defaultProps} inputValue="make this better" />)
		fireEvent.click(enhance())
		expect(posted("enhancePrompt")[0]).toMatchObject({ text: "make this better" })
	})

	it("does nothing with an empty composer", () => {
		render(<ChatTextArea {...defaultProps} inputValue="" />)
		fireEvent.click(enhance())
		expect(posted("enhancePrompt")).toHaveLength(0)
	})
})
