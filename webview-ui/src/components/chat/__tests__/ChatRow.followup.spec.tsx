// npx vitest src/components/chat/__tests__/ChatRow.followup.spec.tsx
//
// The follow-up ask has two shapes — free-text suggestions, and a TYPED
// parameter form when a workflow declared one — plus a partial state where the
// question is still streaming. The remaining tool rows with real markup (grep,
// skills, subtask links, todo replay) ride along.

import { render, screen, fireEvent } from "@/utils/test-utils"

import type { HistoryItem, ShoferMessage } from "@shofer/types"

import { ChatRowContent } from "../ChatRow"

const postMessage = vi.fn()
vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: (m: unknown) => postMessage(m) } }))

vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, opts?: Record<string, unknown>) =>
			opts && !("defaultValue" in opts) ? `${key}(${Object.values(opts).join(",")})` : key,
		i18n: { exists: () => true },
	}),
	Trans: ({ i18nKey, values }: any) => <span>{values ? `${i18nKey}(${Object.values(values)})` : i18nKey}</span>,
	initReactI18next: { type: "3rdParty", init: () => {} },
}))

const extensionState = {
	mcpServers: [] as unknown[],
	shoferMessages: [] as ShoferMessage[],
	currentTaskItem: undefined as HistoryItem | undefined,
	mode: "code",
	apiConfiguration: {},
	experiments: {},
}
vi.mock("@src/context/ExtensionStateContext", () => ({ useExtensionState: () => extensionState }))

vi.mock("@src/components/ui/hooks/useSelectedModel", () => ({
	useSelectedModel: () => ({ id: "m", info: { supportsImages: true } }),
}))

vi.mock("../../common/CodeAccordion", () => ({
	default: ({ code, path }: { code?: string; path?: string }) => (
		<div data-testid="code-accordion" data-path={path}>
			{code}
		</div>
	),
}))
vi.mock("../../common/MarkdownBlock", () => ({
	default: ({ markdown }: { markdown?: string }) => <div data-testid="markdown-block">{markdown}</div>,
}))
vi.mock("../Markdown", () => ({
	Markdown: ({ markdown }: { markdown?: string }) => <div data-testid="markdown">{markdown}</div>,
}))
vi.mock("../FollowUpSuggest", () => ({
	FollowUpSuggest: ({ suggestions, isAnswered }: any) => (
		<div data-testid="follow-up-suggest" data-answered={String(!!isAnswered)}>
			{(suggestions ?? []).map((s: { answer: string }) => (
				<span key={s.answer}>{s.answer}</span>
			))}
		</div>
	),
}))
vi.mock("../WorkflowParamForm", () => ({
	WorkflowParamForm: ({ params, isAnswered }: any) => (
		<div data-testid="param-form" data-answered={String(!!isAnswered)}>
			{params.length}
		</div>
	),
}))

const onSuggestionClick = vi.fn()
const onFollowUpUnmount = vi.fn()

const renderRow = (message: Record<string, unknown>, props: Record<string, unknown> = {}) =>
	render(
		<ChatRowContent
			message={{ ts: 1700000000000, ...message } as ShoferMessage}
			isExpanded={false}
			isLast={false}
			isStreaming={false}
			onToggleExpand={vi.fn()}
			onSuggestionClick={onSuggestionClick}
			onBatchFileResponse={vi.fn()}
			onFollowUpUnmount={onFollowUpUnmount}
			isFollowUpAnswered={false}
			{...props}
		/>,
	)

const followup = (
	data: Record<string, unknown>,
	props: Record<string, unknown> = {},
	messageOver: Record<string, unknown> = {},
) => renderRow({ type: "ask", ask: "followup", text: JSON.stringify(data), ...messageOver }, props)

beforeEach(() => {
	vi.clearAllMocks()
	extensionState.shoferMessages = []
	extensionState.currentTaskItem = undefined
})

describe("the follow-up ask", () => {
	it("renders the question with its suggestions", () => {
		followup({ question: "which environment?", suggest: [{ answer: "staging" }, { answer: "production" }] })

		expect(screen.getByTestId("markdown")).toHaveTextContent("which environment?")
		expect(screen.getByTestId("follow-up-suggest")).toHaveTextContent("staging")
	})

	it("shows the raw streaming text while the question is still partial", () => {
		renderRow({ type: "ask", ask: "followup", partial: true, text: "which enviro" })
		expect(screen.getByTestId("markdown")).toHaveTextContent("which enviro")
	})

	it("renders a typed parameter form instead of suggestions when one is declared", () => {
		followup({
			question: "configure the run",
			paramForm: [
				{ name: "env", type: "string" },
				{ name: "dryRun", type: "boolean" },
			],
		})

		expect(screen.getByTestId("param-form")).toHaveTextContent("2")
		expect(screen.queryByTestId("follow-up-suggest")).not.toBeInTheDocument()
	})

	it("falls back to suggestions for an empty parameter form", () => {
		followup({ question: "q", paramForm: [] })
		expect(screen.getByTestId("follow-up-suggest")).toBeInTheDocument()
	})

	it("reports the ask unanswered by default and answered once resolved", () => {
		const { unmount } = followup({ question: "q", suggest: [{ answer: "a" }] })
		expect(screen.getByTestId("follow-up-suggest")).toHaveAttribute("data-answered", "false")
		unmount()

		followup({ question: "q", suggest: [{ answer: "a" }] }, { isFollowUpAnswered: true })
		expect(screen.getByTestId("follow-up-suggest")).toHaveAttribute("data-answered", "true")
	})

	it("marks a parameter form answered too", () => {
		followup({ question: "q", paramForm: [{ name: "a", type: "string" }] }, { isFollowUpAnswered: true })
		expect(screen.getByTestId("param-form")).toHaveAttribute("data-answered", "true")
	})
})

describe("the remaining tool rows", () => {
	const toolAsk = (tool: Record<string, unknown>, over: Record<string, unknown> = {}) =>
		renderRow({ type: "ask", ask: "tool", text: JSON.stringify(tool), ...over })

	it("renders a grep search with its regex and file pattern", () => {
		toolAsk({ tool: "grepSearch", path: "src", regex: "TODO", filePattern: "*.ts", content: "3 matches" })

		expect(screen.getByText(/wantsToSearch/)).toBeInTheDocument()
		expect(screen.getByTestId("code-accordion")).toHaveAttribute("data-path", "src/(*.ts)")
	})

	it("flags a grep outside the workspace", () => {
		toolAsk({ tool: "grepSearch", path: "../elsewhere", regex: "x", isOutsideWorkspace: true })
		expect(screen.getByText(/wantsToSearchOutsideWorkspace/)).toBeInTheDocument()
	})

	it("renders a skills load", () => {
		toolAsk({ tool: "skills", name: "eauction-search", path: "/skills/a/SKILL.md" })
		expect(screen.getByText("chat:skills.wantsToLoad")).toBeInTheDocument()
	})

	it("offers a link to a subtask the parent created", () => {
		// The link is keyed positionally: the Nth `newTask` row in the
		// conversation maps to the Nth entry in the parent's `childIds`.
		const text = JSON.stringify({ tool: "newTask", mode: "code", content: "do it" })
		extensionState.currentTaskItem = { id: "parent", childIds: ["child-1"] } as never
		extensionState.shoferMessages = [{ ts: 1700000000000, type: "ask", ask: "tool", text } as ShoferMessage]

		toolAsk({ tool: "newTask", mode: "code", content: "do it" })

		expect(screen.getByText("chat:subtasks.goToSubtask")).toBeInTheDocument()
		fireEvent.click(screen.getByText("chat:subtasks.goToSubtask"))
		expect(postMessage).toHaveBeenCalledWith({ type: "showTaskWithId", text: "child-1" })
	})

	it("offers no subtask link when the task has no children", () => {
		const text = JSON.stringify({ tool: "newTask", mode: "code", content: "do it" })
		extensionState.currentTaskItem = { id: "parent" } as never
		extensionState.shoferMessages = [{ ts: 1700000000000, type: "ask", ask: "tool", text } as ShoferMessage]

		toolAsk({ tool: "newTask", mode: "code", content: "do it" })
		expect(screen.queryByText("chat:subtasks.goToSubtask")).not.toBeInTheDocument()
	})

	it("diffs a todo update against the previous list in the conversation", () => {
		extensionState.shoferMessages = [
			{
				ts: 1,
				type: "ask",
				ask: "tool",
				text: JSON.stringify({ tool: "updateTodoList", todos: [{ id: "1", content: "a", status: "pending" }] }),
			} as ShoferMessage,
			{ ts: 1700000000000, type: "ask", ask: "tool" } as ShoferMessage,
		]

		toolAsk({ tool: "updateTodoList", todos: [{ id: "1", content: "a", status: "completed" }] })
		expect(screen.getByText("a")).toBeInTheDocument()
	})
})
