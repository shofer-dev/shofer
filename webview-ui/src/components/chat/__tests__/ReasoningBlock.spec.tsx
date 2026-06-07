import { render, screen } from "@/utils/test-utils"
import { ReasoningBlock } from "../ReasoningBlock"

// Mock i18n
vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, opts?: any) => {
			if (key === "chat:reasoning.thinking") return "Thinking"
			if (key === "chat:reasoning.seconds") return `${opts?.count ?? 0}s`
			return key
		},
	}),
	initReactI18next: {
		type: "3rdParty",
		init: () => {},
	},
}))

// Mock ExtensionState context
vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({
		reasoningBlockCollapsed: false,
	}),
}))

describe("ReasoningBlock", () => {
	it("renders nothing when not streaming and content is empty", () => {
		const { container } = render(<ReasoningBlock content="" isStreaming={false} isLast={false} ts={0} />)
		expect(container.querySelector(".group")).toBeNull()
	})

	it("renders nothing when not streaming and content is the trivial preamble '• response'", () => {
		const { container } = render(<ReasoningBlock content="• response" isStreaming={false} isLast={false} ts={0} />)
		expect(container.querySelector(".group")).toBeNull()
	})

	it("renders the thinking header when streaming with trivial content '• response'", () => {
		render(<ReasoningBlock content="• response" isStreaming={true} isLast={true} ts={0} />)
		expect(screen.getByText("Thinking")).toBeInTheDocument()
	})

	it("renders the thinking header when streaming even with empty content", () => {
		render(<ReasoningBlock content="" isStreaming={true} isLast={true} ts={0} />)
		expect(screen.getByText("Thinking")).toBeInTheDocument()
	})

	it("renders content when not streaming and has content", () => {
		render(<ReasoningBlock content="Let me think about this..." isStreaming={false} isLast={false} ts={0} />)
		expect(screen.getByText("Thinking")).toBeInTheDocument()
		expect(screen.getByText("Let me think about this...")).toBeInTheDocument()
	})

	it("renders content when streaming and has content", () => {
		render(<ReasoningBlock content="Processing..." isStreaming={true} isLast={true} ts={0} />)
		expect(screen.getByText("Thinking")).toBeInTheDocument()
		expect(screen.getByText("Processing...")).toBeInTheDocument()
	})
})
