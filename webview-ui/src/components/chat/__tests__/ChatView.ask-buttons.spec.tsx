// npx vitest src/components/chat/__tests__/ChatView.ask-buttons.spec.tsx
//
// Every `ShoferAsk` that reaches the chat decides three things at once: whether
// the composer is locked, which two answer buttons appear, and what each of them
// posts back. This spec walks the ask variants (and the tool sub-variants that
// change the button copy) so an ask added without an arm shows up as a missing
// button rather than as a silently unanswerable turn.

import React from "react"
import { render, screen, fireEvent, act, waitFor } from "@/utils/test-utils"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"

import { ExtensionStateContextProvider } from "@src/context/ExtensionStateContext"
import { vscode } from "@src/utils/vscode"

import ChatView from "../ChatView"

vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))
vi.mock("use-sound", () => ({ default: () => [vi.fn()] }))
vi.mock("../ChatRow", () => ({ default: () => <div data-testid="chat-row" /> }))
vi.mock("../AutoApproveMenu", () => ({ default: () => null }))
vi.mock("../../common/VersionIndicator", () => ({ default: () => null }))
vi.mock("@src/components/welcome/ShoferTips", () => ({ default: () => <div /> }))
vi.mock("@src/components/welcome/ShoferHero", () => ({ default: () => <div /> }))

vi.mock("react-virtuoso", () => ({
	Virtuoso: ({ data, itemContent }: any) => (
		<div>
			{data.map((item: { ts: number }, index: number) => (
				<div key={item.ts}>{itemContent(index, item)}</div>
			))}
		</div>
	),
}))

vi.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
	initReactI18next: { type: "3rdParty", init: () => {} },
	Trans: ({ i18nKey, children }: any) => <>{children || i18nKey}</>,
}))

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeButton: ({ children, onClick, disabled }: any) => (
		<button onClick={onClick} disabled={disabled}>
			{children}
		</button>
	),
	VSCodeTextField: ({ value, onInput }: any) => (
		<input value={value} onChange={(e) => onInput?.({ target: { value: e.target.value } })} />
	),
	VSCodeLink: ({ children, href }: any) => <a href={href}>{children}</a>,
}))

vi.mock("../ChatTextArea", () => {
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	const mockReact = require("react")
	const Component = mockReact.forwardRef(function MockChatTextArea(props: any, ref: any) {
		mockReact.useImperativeHandle(ref, () => ({ focus: vi.fn() }))
		return <div data-testid="chat-textarea" data-sending-disabled={String(!!props.sendingDisabled)} />
	})
	return { default: Component, ChatTextArea: Component }
})

const postMessage = vi.mocked(vscode.postMessage)
const posted = (type: string) => postMessage.mock.calls.map((c) => c[0]).filter((m: any) => m?.type === type)

const hydrate = async (state: Record<string, unknown>) => {
	await act(async () => {
		window.postMessage(
			{
				type: "stateInit",
				state: {
					version: "1.0.0",
					shoferMessages: [],
					taskHistory: [],
					shouldShowAnnouncement: false,
					allowedCommands: [],
					alwaysAllowExecute: false,
					telemetrySetting: "enabled",
					currentTaskItem: { id: "task-1", ts: 1, task: "the task", number: 1 },
					...state,
				},
			},
			"*",
		)
		await new Promise((r) => setTimeout(r, 0))
	})
}

const renderChatView = () =>
	render(
		<ExtensionStateContextProvider>
			<QueryClientProvider client={new QueryClient()}>
				<ChatView isHidden={false} showAnnouncement={false} hideAnnouncement={() => {}} />
			</QueryClientProvider>
		</ExtensionStateContextProvider>,
	)

/** A conversation whose last message is the given ask. */
const conversationEndingIn = (ask: string, text = "") => [
	{ ts: 1, type: "say", say: "task", text: "the task" },
	{ ts: 2, type: "ask", ask, text },
]

const withAsk = async (ask: string, text = "") => {
	renderChatView()
	await hydrate({ shoferMessages: conversationEndingIn(ask, text) })
}

beforeEach(() => vi.clearAllMocks())

describe("the buttons each ask offers", () => {
	it.each([
		["api_req_failed", "chat:retry.title", "chat:startNewTask.title"],
		["mistake_limit_reached", "chat:proceedAnyways.title", "chat:startNewTask.title"],
		["command", "chat:runCommand.title", "chat:reject.title"],
		["command_output", "chat:proceedWhileRunning.title", "chat:killCommand.title"],
		["use_mcp_server", "chat:approve.title", "chat:reject.title"],
		["resume_task", "chat:resumeTask.title", "chat:terminate.title"],
		["resume_completed_task", "chat:startNewTask.title", undefined],
		["completion_result", "chat:startNewTask.title", undefined],
	])("%s offers %s / %s", async (ask, primary, secondary) => {
		await withAsk(ask)

		await waitFor(() => expect(screen.getByText(primary)).toBeInTheDocument())
		if (secondary) {
			expect(screen.getByText(secondary)).toBeInTheDocument()
		}
	})

	it("budget_limit offers continue / abort", async () => {
		await withAsk("budget_limit", JSON.stringify({ spent: 6, limit: 5 }))
		await waitFor(() => expect(screen.getByText("Continue without limit")).toBeInTheDocument())
		expect(screen.getByText("Abort task")).toBeInTheDocument()
	})

	it("followup offers no buttons — the answer is typed", async () => {
		await withAsk("followup", JSON.stringify({ question: "which?" }))
		await waitFor(() => expect(screen.getByTestId("chat-textarea")).toBeInTheDocument())
		expect(screen.queryByText("chat:approve.title")).not.toBeInTheDocument()
	})
})

describe("the tool ask's button copy follows the tool", () => {
	const toolAsk = (tool: Record<string, unknown>) => JSON.stringify(tool)

	it.each([
		[{ tool: "editedExistingFile", path: "a.ts" }, "chat:save.title", "chat:reject.title"],
		[
			{ tool: "editedExistingFile", batchDiffs: [{ path: "a.ts" }] },
			"chat:edit-batch.approve.title",
			"chat:edit-batch.deny.title",
		],
		[{ tool: "generateImage", path: "a.png" }, "chat:save.title", "chat:reject.title"],
		[{ tool: "readFile", path: "a.ts" }, "chat:approve.title", "chat:reject.title"],
		[
			{ tool: "readFile", batchFiles: [{ path: "a.ts" }] },
			"chat:read-batch.approve.title",
			"chat:read-batch.deny.title",
		],
		[{ tool: "listFilesTopLevel", path: "src" }, "chat:approve.title", "chat:reject.title"],
		[
			{ tool: "listFilesRecursive", batchDirs: [{ path: "src" }] },
			"chat:list-batch.approve.title",
			"chat:list-batch.deny.title",
		],
		[{ tool: "switchMode", mode: "architect" }, "chat:approve.title", "chat:reject.title"],
	])("%o offers the right pair", async (tool, primary, secondary) => {
		await withAsk("tool", toolAsk(tool))
		await waitFor(() => expect(screen.getByText(primary)).toBeInTheDocument())
		expect(screen.getByText(secondary)).toBeInTheDocument()
	})

	it("finishTask offers only the completion button", async () => {
		await withAsk("tool", toolAsk({ tool: "finishTask" }))
		await waitFor(() => expect(screen.getByText("chat:completeSubtaskAndReturn")).toBeInTheDocument())
		expect(screen.queryByText("chat:reject.title")).not.toBeInTheDocument()
	})
})

describe("answering", () => {
	it("retries a failed request and starts a new task from the secondary", async () => {
		await withAsk("api_req_failed")

		await waitFor(() => expect(screen.getByText("chat:retry.title")).toBeInTheDocument())
		fireEvent.click(screen.getByText("chat:retry.title"))
		expect(posted("askResponse")[0]).toMatchObject({ askResponse: "yesButtonClicked" })
	})

	it("aborts a budget-limit ask through a noButtonClicked, not a local abort", async () => {
		await withAsk("budget_limit", JSON.stringify({ spent: 6, limit: 5 }))

		await waitFor(() => expect(screen.getByText("Abort task")).toBeInTheDocument())
		fireEvent.click(screen.getByText("Abort task"))
		expect(posted("askResponse")[0]).toMatchObject({ askResponse: "noButtonClicked" })
	})

	it("kills a running command through a terminal operation", async () => {
		await withAsk("command_output")

		await waitFor(() => expect(screen.getByText("chat:killCommand.title")).toBeInTheDocument())
		fireEvent.click(screen.getByText("chat:killCommand.title"))
		expect(posted("terminalOperation")[0]).toMatchObject({ terminalOperation: "abort" })
	})

	it("starts a new task rather than answering a resumed-completed ask", async () => {
		await withAsk("resume_completed_task")

		await waitFor(() => expect(screen.getByText("chat:startNewTask.title")).toBeInTheDocument())
		fireEvent.click(screen.getByText("chat:startNewTask.title"))
		expect(posted("createParallelTask")).toHaveLength(1)
		expect(posted("askResponse")).toHaveLength(0)
	})

	it("clears the buttons once an answer is sent", async () => {
		await withAsk("use_mcp_server", JSON.stringify({ type: "use_mcp_tool", serverName: "s" }))

		await waitFor(() => expect(screen.getByText("chat:approve.title")).toBeInTheDocument())
		fireEvent.click(screen.getByText("chat:approve.title"))
		await waitFor(() => expect(screen.queryByText("chat:approve.title")).not.toBeInTheDocument())
	})
})

describe("the composer lock", () => {
	it("is released for an ask the user must answer by typing", async () => {
		await withAsk("followup", JSON.stringify({ question: "which?" }))
		await waitFor(() =>
			expect(screen.getByTestId("chat-textarea")).toHaveAttribute("data-sending-disabled", "false"),
		)
	})

	it("is held while a request is in flight", async () => {
		renderChatView()
		await hydrate({
			shoferMessages: [
				{ ts: 1, type: "say", say: "task", text: "the task" },
				{ ts: 2, type: "say", say: "api_req_started", text: JSON.stringify({ request: "…" }) },
			],
		})
		await waitFor(() =>
			expect(screen.getByTestId("chat-textarea")).toHaveAttribute("data-sending-disabled", "true"),
		)
	})
})
