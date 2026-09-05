// npx vitest src/components/chat/__tests__/ChatView.send-path.spec.tsx
//
// The two ChatView rules `webview-ui/AGENTS.md` states outright:
//
//  1. Webview Send-Path Rule — `handleSendMessage` MUST NOT post a bare
//     `askResponse: "messageResponse"` without a confirmed pending ask. With no
//     ask outstanding the text goes through `queueMessage`, so the next
//     `Task.ask()` drains it and the host's `prependMessage` backstop is never
//     load-bearing.
//  2. ChatView Draft-Snapshot Rule — on a task switch the OUTGOING task's input
//     is snapshotted before the incoming task's draft is restored.
//
// Plus the primary/secondary answer buttons, which are the other way an ask is
// answered.

import React from "react"
import { render, screen, fireEvent, act, waitFor } from "@/utils/test-utils"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"

import { ExtensionStateContextProvider } from "@src/context/ExtensionStateContext"
import { vscode } from "@src/utils/vscode"

import ChatView from "../ChatView"

vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))

vi.mock("use-sound", () => ({ default: () => [vi.fn()] }))

vi.mock("../ChatRow", () => ({
	default: ({ message }: { message: { ts: number } }) => <div data-testid="chat-row">{message.ts}</div>,
}))

vi.mock("../AutoApproveMenu", () => ({ default: () => null }))
vi.mock("../../common/VersionIndicator", () => ({ default: () => null }))
vi.mock("@src/components/welcome/ShoferTips", () => ({ default: () => <div /> }))
vi.mock("@src/components/welcome/ShoferHero", () => ({ default: () => <div /> }))

vi.mock("react-virtuoso", () => ({
	Virtuoso: ({ data, itemContent }: any) => (
		<div data-testid="virtuoso-item-list">
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

// A minimal composer: it reports what ChatView handed it and can fire `onSend`
// with whatever the test wants to "type".
vi.mock("../ChatTextArea", () => {
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	const mockReact = require("react")
	const Component = mockReact.forwardRef(function MockChatTextArea(props: any, ref: any) {
		mockReact.useImperativeHandle(ref, () => ({ focus: vi.fn() }))
		return (
			<div data-testid="chat-textarea">
				<input
					data-testid="composer"
					value={props.inputValue ?? ""}
					data-sending-disabled={String(!!props.sendingDisabled)}
					onChange={(e: React.ChangeEvent<HTMLInputElement>) => props.setInputValue?.(e.target.value)}
				/>
				<button data-testid="do-send" onClick={() => props.onSend(props.inputValue ?? "")}>
					send
				</button>
			</div>
		)
	})
	return { default: Component, ChatTextArea: Component }
})

const postMessage = vi.mocked(vscode.postMessage)

const message = (over: Record<string, unknown>) => ({ ts: Date.now(), type: "say", say: "text", ...over })

// `window.postMessage` is delivered on a later task, so hydration is awaited —
// typing before it lands would be undone by the task-switch effect.
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

// The composer is controlled by ChatView, so a change event only becomes the
// value `onSend` reads once React has re-rendered — every test awaits that.
const type = async (text: string) => {
	fireEvent.change(screen.getByTestId("composer"), { target: { value: text } })
	await waitFor(() => expect(screen.getByTestId("composer")).toHaveValue(text))
}
const send = () => fireEvent.click(screen.getByTestId("do-send"))

const posted = (type: string) => postMessage.mock.calls.map((c) => c[0]).filter((m: any) => m?.type === type)

beforeEach(() => vi.clearAllMocks())

describe("the send path", () => {
	it("starts a new task when there is no conversation yet", async () => {
		renderChatView()
		await hydrate({ shoferMessages: [] })

		await type("build me a thing")
		send()

		await waitFor(() => expect(posted("newTask")).toHaveLength(1))
		expect(posted("newTask")[0]).toMatchObject({ text: "build me a thing", images: [] })
	})

	it("queues, rather than answering, when no ask is outstanding", async () => {
		renderChatView()
		await hydrate({
			shoferMessages: [
				message({ ts: 1, say: "task", text: "the task" }),
				message({ ts: 2, say: "text", text: "working" }),
			],
		})

		await type("one more thing")
		send()

		await waitFor(() => expect(posted("queueMessage")).toHaveLength(1))
		expect(posted("queueMessage")[0]).toMatchObject({ text: "one more thing" })
		// The rule: never a bare messageResponse without a confirmed ask.
		expect(posted("askResponse")).toHaveLength(0)
	})

	it("answers the ask directly when one is outstanding", async () => {
		renderChatView()
		await hydrate({
			shoferMessages: [
				message({ ts: 1, say: "task", text: "the task" }),
				{ ts: 2, type: "ask", ask: "followup", text: JSON.stringify({ question: "which?" }) },
			],
		})

		await type("the second one")
		send()

		await waitFor(() => expect(posted("askResponse")).toHaveLength(1))
		expect(posted("askResponse")[0]).toMatchObject({
			askResponse: "messageResponse",
			text: "the second one",
		})
		expect(posted("queueMessage")).toHaveLength(0)
	})

	it("queues while a command is running, because command_output is not a user ask", async () => {
		renderChatView()
		await hydrate({
			shoferMessages: [
				message({ ts: 1, say: "task", text: "the task" }),
				{ ts: 2, type: "ask", ask: "command_output", text: "" },
			],
		})

		await type("stop after this")
		send()

		await waitFor(() => expect(posted("queueMessage")).toHaveLength(1))
		expect(posted("askResponse")).toHaveLength(0)
	})

	it("sends nothing for an empty message", async () => {
		renderChatView()
		await hydrate({ shoferMessages: [] })

		send()
		await new Promise((r) => setTimeout(r, 0))
		expect(posted("newTask")).toHaveLength(0)
		expect(posted("queueMessage")).toHaveLength(0)
	})

	it("refuses to send at all while the active provider is retired", async () => {
		renderChatView()
		await hydrate({ shoferMessages: [], apiConfiguration: { apiProvider: "groq" } })

		await type("hello")
		send()

		await new Promise((r) => setTimeout(r, 0))
		expect(posted("newTask")).toHaveLength(0)
		expect(posted("queueMessage")).toHaveLength(0)
	})
})

describe("per-task input drafts", () => {
	it("snapshots the outgoing task's draft before restoring the incoming one", async () => {
		renderChatView()
		await hydrate({
			shoferMessages: [message({ ts: 1, say: "task", text: "task one" })],
			currentTaskItem: { id: "task-1", ts: 1, task: "one", number: 1 },
		})

		await type("draft for task one")
		await waitFor(() => expect(screen.getByTestId("composer")).toHaveValue("draft for task one"))

		// Switch to a second task: its composer starts empty.
		await hydrate({
			shoferMessages: [message({ ts: 2, say: "task", text: "task two" })],
			currentTaskItem: { id: "task-2", ts: 2, task: "two", number: 2 },
		})
		await waitFor(() => expect(screen.getByTestId("composer")).toHaveValue(""))

		await type("draft for task two")

		// Switching back restores the first task's draft, not the second's.
		await hydrate({
			shoferMessages: [message({ ts: 1, say: "task", text: "task one" })],
			currentTaskItem: { id: "task-1", ts: 1, task: "one", number: 1 },
		})
		await waitFor(() => expect(screen.getByTestId("composer")).toHaveValue("draft for task one"))

		await hydrate({
			shoferMessages: [message({ ts: 2, say: "task", text: "task two" })],
			currentTaskItem: { id: "task-2", ts: 2, task: "two", number: 2 },
		})
		await waitFor(() => expect(screen.getByTestId("composer")).toHaveValue("draft for task two"))
	})

	it("clears the composer for a task that has no draft", async () => {
		renderChatView()
		await hydrate({
			shoferMessages: [message({ ts: 1, say: "task", text: "one" })],
			currentTaskItem: { id: "task-1", ts: 1, task: "one", number: 1 },
		})
		await type("something")

		await hydrate({
			shoferMessages: [message({ ts: 3, say: "task", text: "three" })],
			currentTaskItem: { id: "task-3", ts: 3, task: "three", number: 3 },
		})
		await waitFor(() => expect(screen.getByTestId("composer")).toHaveValue(""))
	})
})

describe("answer buttons", () => {
	const askState = (ask: string, extra: Record<string, unknown> = {}) => ({
		shoferMessages: [
			message({ ts: 1, say: "task", text: "the task" }),
			{ ts: 2, type: "ask", ask, text: extra.text ?? "" },
		],
		currentTaskItem: { id: "task-1", ts: 1, task: "one", number: 1 },
		...extra,
	})

	it("approves a tool ask with the primary button", async () => {
		renderChatView()
		await hydrate(askState("tool", { text: JSON.stringify({ tool: "readFile", path: "a.ts" }) }))

		const approve = await screen.findByText("chat:approve.title")
		fireEvent.click(approve)

		await waitFor(() => expect(posted("askResponse")).toHaveLength(1))
		expect(posted("askResponse")[0]).toMatchObject({ askResponse: "yesButtonClicked" })
	})

	it("rejects a tool ask with the secondary button", async () => {
		renderChatView()
		await hydrate(askState("tool", { text: JSON.stringify({ tool: "readFile", path: "a.ts" }) }))

		const reject = await screen.findByText("chat:reject.title")
		fireEvent.click(reject)

		await waitFor(() => expect(posted("askResponse")).toHaveLength(1))
		expect(posted("askResponse")[0]).toMatchObject({ askResponse: "noButtonClicked" })
	})

	it("continues and aborts a running command through the terminal operations", async () => {
		renderChatView()
		await hydrate(askState("command_output"))

		const proceed = await screen.findByText("chat:proceedWhileRunning.title")
		fireEvent.click(proceed)
		await waitFor(() => expect(posted("terminalOperation")[0]).toMatchObject({ terminalOperation: "continue" }))
	})

	it("starts a new task from a completed result", async () => {
		renderChatView()
		await hydrate(askState("completion_result"))

		const startNew = await screen.findByText("chat:startNewTask.title")
		fireEvent.click(startNew)
		await waitFor(() => expect(posted("createParallelTask")).toHaveLength(1))
	})
})
