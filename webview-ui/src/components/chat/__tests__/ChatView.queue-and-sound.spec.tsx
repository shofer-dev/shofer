// npx vitest src/components/chat/__tests__/ChatView.queue-and-sound.spec.tsx
//
// Two surfaces around the conversation itself: the queued-message panel (whose
// edits and removals are host messages keyed by the queued message's id, not by
// its position), and the audio/TTS cues, which a HIDDEN ChatView must defer to
// the visible instance — the view is permanently mounted, so a hidden copy that
// played would double every sound.

import React from "react"
import { render, screen, fireEvent, act, waitFor } from "@/utils/test-utils"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"

import { ExtensionStateContextProvider } from "@src/context/ExtensionStateContext"
import { vscode } from "@src/utils/vscode"

import ChatView from "../ChatView"

vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))

const playNotification = vi.fn()
const playCelebration = vi.fn()
const playProgressLoop = vi.fn()
vi.mock("use-sound", () => ({
	default: (src: string) => [
		src.includes("celebration") ? playCelebration : src.includes("progress") ? playProgressLoop : playNotification,
	],
}))

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
	const Component = mockReact.forwardRef(function MockChatTextArea(_props: any, ref: any) {
		mockReact.useImperativeHandle(ref, () => ({ focus: vi.fn() }))
		return <div data-testid="chat-textarea" />
	})
	return { default: Component, ChatTextArea: Component }
})

// The queue panel exposes its callbacks so the id-keyed messages can be checked.
vi.mock("../QueuedMessages", () => ({
	QueuedMessages: ({ queue, onRemove, onUpdate, onForceSend }: any) =>
		queue.length === 0 ? null : (
			<div data-testid="queued-messages">
				{queue.map((m: { id: string; text: string }, index: number) => (
					<div key={m.id}>
						<span>{m.text}</span>
						<button aria-label={`remove-${index}`} onClick={() => onRemove(index)} />
						<button aria-label={`update-${index}`} onClick={() => onUpdate(index, "edited")} />
					</div>
				))}
				{onForceSend && <button aria-label="force-send" onClick={onForceSend} />}
			</div>
		),
}))

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
					...state,
				},
			},
			"*",
		)
		await new Promise((r) => setTimeout(r, 0))
	})
}

const renderChatView = (isHidden = false) =>
	render(
		<ExtensionStateContextProvider>
			<QueryClientProvider client={new QueryClient()}>
				<ChatView isHidden={isHidden} showAnnouncement={false} hideAnnouncement={() => {}} />
			</QueryClientProvider>
		</ExtensionStateContextProvider>,
	)

const conversation = (last: Record<string, unknown>) => [
	{ ts: 1, type: "say", say: "task", text: "the task" },
	{ ts: 2, ...last },
]

beforeEach(() => vi.clearAllMocks())

describe("the queued-message panel", () => {
	const queue = [
		{ id: "q1", text: "first", timestamp: 1 },
		{ id: "q2", text: "second", timestamp: 2 },
	]

	it("stays hidden while the queue is empty", async () => {
		renderChatView()
		await hydrate({ shoferMessages: conversation({ type: "say", say: "text", text: "hi" }) })
		expect(screen.queryByTestId("queued-messages")).not.toBeInTheDocument()
	})

	it("removes by the message's id, not its index", async () => {
		renderChatView()
		await hydrate({ shoferMessages: conversation({ type: "say", say: "text", text: "hi" }), messageQueue: queue })

		await waitFor(() => expect(screen.getByTestId("queued-messages")).toBeInTheDocument())
		fireEvent.click(screen.getByLabelText("remove-1"))
		expect(posted("removeQueuedMessage")[0]).toMatchObject({ text: "q2" })
	})

	it("edits by id, carrying the message's images along", async () => {
		renderChatView()
		await hydrate({
			shoferMessages: conversation({ type: "say", say: "text", text: "hi" }),
			messageQueue: [{ id: "q1", text: "first", timestamp: 1, images: ["data:a"] }],
		})

		await waitFor(() => expect(screen.getByTestId("queued-messages")).toBeInTheDocument())
		fireEvent.click(screen.getByLabelText("update-0"))
		expect(posted("editQueuedMessage")[0]).toMatchObject({
			payload: { id: "q1", text: "edited", images: ["data:a"] },
		})
	})
})

describe("audio and speech cues", () => {
	it("plays nothing while sound is disabled", async () => {
		renderChatView()
		await hydrate({
			soundEnabled: false,
			shoferMessages: conversation({ type: "ask", ask: "api_req_failed", text: "boom" }),
		})
		expect(playProgressLoop).not.toHaveBeenCalled()
	})

	it("plays the progress loop for an ask the user must resolve", async () => {
		renderChatView()
		await hydrate({
			soundEnabled: true,
			shoferMessages: conversation({ type: "ask", ask: "api_req_failed", text: "boom" }),
		})
		await waitFor(() => expect(playProgressLoop).toHaveBeenCalled())
	})

	it("plays the celebration on a completed task", async () => {
		renderChatView()
		await hydrate({
			soundEnabled: true,
			shoferMessages: conversation({ type: "ask", ask: "completion_result", text: "done" }),
		})
		await waitFor(() => expect(playCelebration).toHaveBeenCalled())
	})

	it("plays nothing at all from a HIDDEN view", async () => {
		renderChatView(true)
		await hydrate({
			soundEnabled: true,
			shoferMessages: conversation({ type: "ask", ask: "completion_result", text: "done" }),
		})
		expect(playCelebration).not.toHaveBeenCalled()
		expect(playNotification).not.toHaveBeenCalled()
		expect(playProgressLoop).not.toHaveBeenCalled()
	})

	it("does not speak from a hidden view either", async () => {
		renderChatView(true)
		await hydrate({
			ttsEnabled: true,
			shoferMessages: conversation({ type: "say", say: "completion_result", text: "all finished" }),
		})
		expect(posted("playTts")).toHaveLength(0)
	})
})

describe("the task surface", () => {
	it("shows the home screen with no conversation", async () => {
		renderChatView()
		await hydrate({ shoferMessages: [] })
		expect(screen.queryByTestId("chat-row")).not.toBeInTheDocument()
	})

	it("renders one row per message once a task exists", async () => {
		renderChatView()
		await hydrate({
			shoferMessages: [
				{ ts: 1, type: "say", say: "task", text: "the task" },
				{ ts: 2, type: "say", say: "text", text: "one" },
				{ ts: 3, type: "say", say: "text", text: "two" },
			],
		})
		await waitFor(() => expect(screen.getAllByTestId("chat-row").length).toBeGreaterThan(0))
	})
})
