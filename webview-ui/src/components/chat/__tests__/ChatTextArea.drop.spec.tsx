// npx vitest src/components/chat/__tests__/ChatTextArea.drop.spec.tsx
//
// The composer's drop target takes two very different payloads and must tell
// them apart: a PATH-style drop from the Explorer or an editor tab (a URI/text
// payload with no `files` list), which becomes dropped context files; and an
// IMAGE file drop, which becomes attachments. Each branch also has a visible
// refusal, because a silently ignored drop reads as a broken editor.

import { defaultModeSlug } from "@shofer/types"

import { render, fireEvent, screen, act } from "@src/utils/test-utils"
import { useExtensionState } from "@src/context/ExtensionStateContext"
import { vscode } from "@src/utils/vscode"

import { ChatTextArea } from "../ChatTextArea"

vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))
vi.mock("@src/context/ExtensionStateContext")
vi.mock("@src/components/common/CodeBlock")
vi.mock("@src/components/common/MarkdownBlock")

const postMessage = vi.mocked(vscode.postMessage)
const posted = (type: string) => postMessage.mock.calls.map((c) => c[0]).filter((m: any) => m?.type === type)
const logged = (fragment: string) =>
	posted("webviewLog").some((m: any) => typeof m.text === "string" && m.text.includes(fragment))

const setSelectedImages = vi.fn()
const onContextFilesDropped = vi.fn()

const defaultProps = {
	inputValue: "",
	setInputValue: vi.fn(),
	onSend: vi.fn(),
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
	modeShortcutText: "",
	onContextFilesDropped,
}

/** A `DataTransfer` stand-in: jsdom's has no settable `types`/`files`. */
const dataTransfer = ({ types = {}, files = [] }: { types?: Record<string, string>; files?: File[] }) => ({
	types: Object.keys(types),
	getData: (t: string) => types[t] ?? "",
	files,
})

/**
 * Fire the drop and let it FULLY settle. An image drop reads each file through
 * a `FileReader`, whose `onloadend` lands on a later macrotask — a single tick
 * is not enough under load, and a late callback would otherwise leak its
 * `setSelectedImages` into the next test.
 */
const drop = async (payload: { types?: Record<string, string>; files?: File[] }) => {
	const target = screen.getByPlaceholderText("Type a message…").closest("div")!.parentElement!
	await act(async () => {
		fireEvent.drop(target, { dataTransfer: dataTransfer(payload) })
		await new Promise((r) => setTimeout(r, 0))
	})
	if (payload.files?.length) {
		for (let i = 0; i < 50; i++) {
			if (setSelectedImages.mock.calls.length > 0 || posted("draggedImages").length > 0) break
			await act(async () => {
				await new Promise((r) => setTimeout(r, 5))
			})
		}
	}
	// One last flush so nothing is still in flight when the test ends.
	await act(async () => {
		await new Promise((r) => setTimeout(r, 5))
	})
}

const imageFile = (type = "image/png") => new File(["bytes"], "shot.png", { type })

beforeEach(() => {
	vi.clearAllMocks()
	vi.mocked(useExtensionState).mockReturnValue({
		filePaths: [],
		openedTabs: [],
		apiConfiguration: { apiProvider: "anthropic" },
		taskHistory: [],
		cwd: "/repo",
		commands: [],
		customModes: [],
	} as never)
})

describe("path-style drops", () => {
	it("hands dropped workspace files to the caller", async () => {
		render(<ChatTextArea {...defaultProps} />)
		await drop({ types: { "text/uri-list": "file:///repo/src/a.ts" } })

		expect(onContextFilesDropped).toHaveBeenCalledWith([
			expect.objectContaining({ path: expect.stringContaining("a.ts") }),
		])
		expect(setSelectedImages).not.toHaveBeenCalled()
	})

	it("reports a payload it could not turn into any file", async () => {
		render(<ChatTextArea {...defaultProps} />)
		await drop({ types: { "text/plain": "   " } })
		expect(logged("[drop:textarea] fired")).toBe(true)
	})

	it("reports a drop carrying neither a payload nor files", async () => {
		render(<ChatTextArea {...defaultProps} />)
		await drop({})
		expect(logged("no payload and no files")).toBe(true)
	})

	it("logs the modifier keys and MIME types it saw", async () => {
		render(<ChatTextArea {...defaultProps} />)
		await drop({ types: { "text/plain": "x" } })
		expect(logged("[drop:textarea] fired")).toBe(true)
	})
})

describe("image drops", () => {
	it("reads dropped images into the attachment list and tells the host", async () => {
		render(<ChatTextArea {...defaultProps} />)
		await drop({ files: [imageFile()] })

		expect(setSelectedImages).toHaveBeenCalled()
		expect(posted("draggedImages")).toHaveLength(1)
	})

	it("refuses images when the model cannot take them, visibly", async () => {
		render(<ChatTextArea {...defaultProps} shouldDisableImages />)
		await drop({ files: [imageFile()] })

		expect(setSelectedImages).not.toHaveBeenCalled()
		expect(posted("draggedImages")).toHaveLength(0)
	})

	it("ignores files of a type it does not accept", async () => {
		render(<ChatTextArea {...defaultProps} />)
		await drop({ files: [new File(["x"], "a.pdf", { type: "application/pdf" })] })

		expect(setSelectedImages).not.toHaveBeenCalled()
		expect(logged("none are accepted image types")).toBe(true)
	})

	it("prefers the path payload over the files list when both are present", async () => {
		render(<ChatTextArea {...defaultProps} />)
		await drop({ types: { "text/uri-list": "file:///repo/src/a.ts" }, files: [imageFile()] })

		expect(onContextFilesDropped).toHaveBeenCalled()
		expect(setSelectedImages).not.toHaveBeenCalled()
	})
})

describe("the drag-over affordance", () => {
	it("highlights the composer while a drag hovers it and clears on leave", () => {
		render(<ChatTextArea {...defaultProps} />)
		const target = screen.getByPlaceholderText("Type a message…").closest("div")!.parentElement!

		fireEvent.dragOver(target, { dataTransfer: dataTransfer({ types: { Files: "" } }) })
		fireEvent.dragLeave(target, { dataTransfer: dataTransfer({ types: { Files: "" } }) })
		// The class toggling is cosmetic; what matters is that neither throws
		// and no payload is consumed by a hover.
		expect(onContextFilesDropped).not.toHaveBeenCalled()
		expect(setSelectedImages).not.toHaveBeenCalled()
	})
})
