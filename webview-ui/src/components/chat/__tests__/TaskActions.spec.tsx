import type { HistoryItem } from "@shofer/types"

import { render, screen, fireEvent } from "@/utils/test-utils"
import { vscode } from "@/utils/vscode"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { useCopyToClipboard } from "@/utils/clipboard"

import { TaskActions } from "../TaskActions"

// Mock scrollIntoView for JSDOM
Object.defineProperty(Element.prototype, "scrollIntoView", {
	value: vi.fn(),
	writable: true,
})

// Mock the vscode utility
vi.mock("@/utils/vscode", () => ({
	vscode: {
		postMessage: vi.fn(),
	},
}))

// Mock the useExtensionState hook
vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: vi.fn(),
}))

// Mock the useCopyToClipboard hook
vi.mock("@/utils/clipboard", () => ({
	useCopyToClipboard: vi.fn(),
}))

const mockPostMessage = vi.mocked(vscode.postMessage)
const mockUseExtensionState = vi.mocked(useExtensionState)
const mockUseCopyToClipboard = vi.mocked(useCopyToClipboard)

// Mock react-i18next
vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string) => {
			const translations: Record<string, string> = {
				"chat:task.export": "Export task history",
				"chat:task.delete": "Delete Task (Shift + Click to skip confirmation)",
				"chat:task.openApiHistory": "Open API History",
				"chat:task.openUiHistory": "Open UI History",
				"history:copyPrompt": "Copy",
			}
			return translations[key] || key
		},
	}),
	initReactI18next: {
		type: "3rdParty",
		init: vi.fn(),
	},
}))

// Mock pretty-bytes
vi.mock("pretty-bytes", () => ({
	default: (bytes: number) => `${bytes} B`,
}))

describe("TaskActions", () => {
	const mockItem: HistoryItem = {
		id: "test-task-id",
		number: 1,
		ts: Date.now(),
		task: "Test task",
		tokensIn: 100,
		tokensOut: 200,
		totalCost: 0.01,
		size: 1024,
	}

	beforeEach(() => {
		vi.clearAllMocks()
		mockUseExtensionState.mockReturnValue({
			debug: false,
		} as any)
		mockUseCopyToClipboard.mockReturnValue({
			copyWithFeedback: vi.fn(),
			showCopyFeedback: false,
		})
	})

	describe("Other Actions", () => {
		it("renders export button", () => {
			render(<TaskActions item={mockItem} buttonsDisabled={false} />)

			const exportButton = screen.getByLabelText("Export task history")
			expect(exportButton).toBeInTheDocument()
		})

		it("sends exportCurrentTask message when export button is clicked", () => {
			render(<TaskActions item={mockItem} buttonsDisabled={false} />)

			const exportButton = screen.getByLabelText("Export task history")
			fireEvent.click(exportButton)

			expect(mockPostMessage).toHaveBeenCalledWith({
				type: "exportCurrentTask",
			})
		})

		it("renders delete button when item has size", () => {
			render(<TaskActions item={mockItem} buttonsDisabled={false} />)

			const deleteButton = screen.getByLabelText("Delete Task (Shift + Click to skip confirmation)")
			expect(deleteButton).toBeInTheDocument()
		})

		it("does not render delete button when item has no size", () => {
			const itemWithoutSize = { ...mockItem, size: 0 }
			render(<TaskActions item={itemWithoutSize} buttonsDisabled={false} />)

			const deleteButton = screen.queryByLabelText("Delete Task (Shift + Click to skip confirmation)")
			expect(deleteButton).not.toBeInTheDocument()
		})

		it("shows check icon when showCopyFeedback is true", () => {
			// First render with showCopyFeedback: false (default)
			const { rerender } = render(<TaskActions item={mockItem} buttonsDisabled={false} />)

			// Verify copy icon is shown initially
			const copyButton = screen.getByLabelText("Copy")
			expect(copyButton).toBeInTheDocument()
			expect(copyButton.querySelector("svg.lucide-copy")).toBeInTheDocument()
			expect(copyButton.querySelector("svg.lucide-check")).not.toBeInTheDocument()

			// Mock showCopyFeedback: true to simulate successful copy
			mockUseCopyToClipboard.mockReturnValue({
				copyWithFeedback: vi.fn(),
				showCopyFeedback: true,
			})

			rerender(<TaskActions item={mockItem} buttonsDisabled={false} />)

			// Verify check icon is shown after successful copy
			expect(copyButton.querySelector("svg.lucide-check")).toBeInTheDocument()
			expect(copyButton.querySelector("svg.lucide-copy")).not.toBeInTheDocument()
		})
	})

	describe("Button States", () => {
		it("export and copy buttons are always enabled while delete button respects buttonsDisabled state", () => {
			// Test with buttonsDisabled = false
			const { rerender } = render(<TaskActions item={mockItem} buttonsDisabled={false} />)

			let exportButton = screen.getByLabelText("Export task history")
			let copyButton = screen.getByLabelText("Copy")
			let deleteButton = screen.getByLabelText("Delete Task (Shift + Click to skip confirmation)")

			expect(exportButton).not.toBeDisabled()
			expect(copyButton).not.toBeDisabled()
			expect(deleteButton).not.toBeDisabled()

			// Test with buttonsDisabled = true
			rerender(<TaskActions item={mockItem} buttonsDisabled={true} />)

			exportButton = screen.getByLabelText("Export task history")
			copyButton = screen.getByLabelText("Copy")
			deleteButton = screen.getByLabelText("Delete Task (Shift + Click to skip confirmation)")

			// Export and copy remain enabled
			expect(exportButton).not.toBeDisabled()
			expect(copyButton).not.toBeDisabled()
			// Delete button is disabled
			expect(deleteButton).toBeDisabled()
		})
	})

	describe("Debug Buttons", () => {
		it("does not render debug buttons when debug is false", () => {
			mockUseExtensionState.mockReturnValue({
				debug: false,
			} as any)

			render(<TaskActions item={mockItem} buttonsDisabled={false} />)

			const apiHistoryButton = screen.queryByLabelText("Open API History")
			const uiHistoryButton = screen.queryByLabelText("Open UI History")

			expect(apiHistoryButton).not.toBeInTheDocument()
			expect(uiHistoryButton).not.toBeInTheDocument()
		})

		it("does not render debug buttons when debug is undefined", () => {
			mockUseExtensionState.mockReturnValue({} as any)

			render(<TaskActions item={mockItem} buttonsDisabled={false} />)

			const apiHistoryButton = screen.queryByLabelText("Open API History")
			const uiHistoryButton = screen.queryByLabelText("Open UI History")

			expect(apiHistoryButton).not.toBeInTheDocument()
			expect(uiHistoryButton).not.toBeInTheDocument()
		})

		it("renders debug buttons when debug is true and item has id", () => {
			mockUseExtensionState.mockReturnValue({
				debug: true,
			} as any)

			render(<TaskActions item={mockItem} buttonsDisabled={false} />)

			const apiHistoryButton = screen.getByLabelText("Open API History")
			const uiHistoryButton = screen.getByLabelText("Open UI History")

			expect(apiHistoryButton).toBeInTheDocument()
			expect(uiHistoryButton).toBeInTheDocument()
		})

		it("does not render debug buttons when debug is true but item has no id", () => {
			mockUseExtensionState.mockReturnValue({
				debug: true,
			} as any)

			render(<TaskActions item={undefined} buttonsDisabled={false} />)

			const apiHistoryButton = screen.queryByLabelText("Open API History")
			const uiHistoryButton = screen.queryByLabelText("Open UI History")

			expect(apiHistoryButton).not.toBeInTheDocument()
			expect(uiHistoryButton).not.toBeInTheDocument()
		})

		it("sends openDebugApiHistory message when Open API History button is clicked", () => {
			mockUseExtensionState.mockReturnValue({
				debug: true,
			} as any)

			render(<TaskActions item={mockItem} buttonsDisabled={false} />)

			const apiHistoryButton = screen.getByLabelText("Open API History")
			fireEvent.click(apiHistoryButton)

			expect(mockPostMessage).toHaveBeenCalledWith({
				type: "openDebugApiHistory",
			})
		})

		it("sends openDebugUiHistory message when Open UI History button is clicked", () => {
			mockUseExtensionState.mockReturnValue({
				debug: true,
			} as any)

			render(<TaskActions item={mockItem} buttonsDisabled={false} />)

			const uiHistoryButton = screen.getByLabelText("Open UI History")
			fireEvent.click(uiHistoryButton)

			expect(mockPostMessage).toHaveBeenCalledWith({
				type: "openDebugUiHistory",
			})
		})
	})
})
