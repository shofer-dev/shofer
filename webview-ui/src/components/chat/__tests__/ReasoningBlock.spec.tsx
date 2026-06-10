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

	it("renders header but no body when not streaming and content is pure preamble '• response'", () => {
		render(<ReasoningBlock content="• response" isStreaming={false} isLast={false} ts={0} />)
		// Header is shown (content after trimming is non-empty), but the preamble
		// is stripped for display so the markdown body renders nothing.
		expect(screen.getByText("Thinking")).toBeInTheDocument()
		expect(screen.queryByText("• response")).toBeNull()
	})

	it("renders header but no body when not streaming and content is pure preamble '•response' (no space)", () => {
		render(<ReasoningBlock content="•response" isStreaming={false} isLast={false} ts={0} />)
		expect(screen.getByText("Thinking")).toBeInTheDocument()
		expect(screen.queryByText("•response")).toBeNull()
	})

	it("renders header but no body when not streaming and content is just '•' (bullet only)", () => {
		render(<ReasoningBlock content="•" isStreaming={false} isLast={false} ts={0} />)
		expect(screen.getByText("Thinking")).toBeInTheDocument()
		expect(screen.queryByText("•")).toBeNull()
	})

	it("renders the thinking header when streaming with trivial content '• response'", () => {
		render(<ReasoningBlock content="• response" isStreaming={true} isLast={true} ts={0} />)
		expect(screen.getByText("Thinking")).toBeInTheDocument()
	})

	it("renders the thinking header when streaming with trivial content '•response' (no space)", () => {
		render(<ReasoningBlock content="•response" isStreaming={true} isLast={true} ts={0} />)
		expect(screen.getByText("Thinking")).toBeInTheDocument()
	})

	it("renders the thinking header when streaming with trivial content '•' (bullet only)", () => {
		render(<ReasoningBlock content="•" isStreaming={true} isLast={true} ts={0} />)
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

	it("strips bullet prefix for display without hiding block (glued preamble)", () => {
		// e.g. "•Okay, let's think" — old regex guard would hide the block;
		// new strip-for-display shows the cleaned content.
		render(<ReasoningBlock content="•Okay, let's think" isStreaming={false} isLast={false} ts={0} />)
		expect(screen.getByText("Thinking")).toBeInTheDocument()
		expect(screen.getByText("Okay, let's think")).toBeInTheDocument()
		expect(screen.queryByText("•Okay, let's think")).toBeNull()
	})

	it("strips bullet+response prefix for display without hiding block", () => {
		render(<ReasoningBlock content="• responseNow, considering…" isStreaming={false} isLast={false} ts={0} />)
		expect(screen.getByText("Thinking")).toBeInTheDocument()
		expect(screen.getByText("Now, considering…")).toBeInTheDocument()
	})
})
