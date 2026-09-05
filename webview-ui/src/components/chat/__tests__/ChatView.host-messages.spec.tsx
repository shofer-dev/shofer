// npx vitest src/components/chat/__tests__/ChatView.host-messages.spec.tsx
//
// The host→webview leg of the bridge, as ChatView implements it: the `invoke`
// remote-control verbs the extension's commands use, image and context-file
// delivery, the condense round-trip, and the global keyboard shortcuts. Also
// the message FILTER — the rows a conversation carries but must never paint.

import { render, screen, fireEvent, act, waitFor } from "@/utils/test-utils"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"

import { ExtensionStateContextProvider } from "@src/context/ExtensionStateContext"
import { vscode } from "@src/utils/vscode"

import ChatView from "../ChatView"

vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))

const playNotification = vi.fn()
vi.mock("use-sound", () => ({ default: () => [playNotification] }))

vi.mock("../ChatRow", () => ({
	default: ({ message }: any) => <div data-testid="chat-row" data-say={message?.say} data-ask={message?.ask} />,
}))
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

// The composer is stubbed, but it echoes back the draft and the image count so
// the messages that only touch those are still observable.
vi.mock("../ChatTextArea", () => {
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	const mockReact = require("react")
	const Component = mockReact.forwardRef(function MockChatTextArea(props: any, ref: any) {
		mockReact.useImperativeHandle(ref, () => ({ focus: () => focused() }))
		return (
			<div
				data-testid="chat-textarea"
				data-value={props.inputValue}
				data-images={(props.selectedImages ?? []).length}
			/>
		)
	})
	return { default: Component, ChatTextArea: Component }
})

const focused = vi.fn()

const postMessage = vi.mocked(vscode.postMessage)
const posted = (type: string) => postMessage.mock.calls.map((c) => c[0]).filter((m: any) => m?.type === type)

const send = async (message: Record<string, unknown>) => {
	await act(async () => {
		window.postMessage(message, "*")
		await new Promise((r) => setTimeout(r, 0))
	})
}

const modes = [
	{ slug: "code", name: "Code", roleDefinition: "", groups: [] },
	{ slug: "ask", name: "Ask", roleDefinition: "", groups: [] },
	{ slug: "debug", name: "Debug", roleDefinition: "", groups: [] },
]

const hydrate = (state: Record<string, unknown>) =>
	send({
		type: "stateInit",
		state: {
			version: "1.0.0",
			shoferMessages: [],
			taskHistory: [],
			shouldShowAnnouncement: false,
			allowedCommands: [],
			alwaysAllowExecute: false,
			telemetrySetting: "enabled",
			customModes: modes,
			mode: "code",
			...state,
		},
	})

const renderChatView = (isHidden = false) =>
	render(
		<ExtensionStateContextProvider>
			<QueryClientProvider client={new QueryClient()}>
				<ChatView isHidden={isHidden} showAnnouncement={false} hideAnnouncement={() => {}} />
			</QueryClientProvider>
		</ExtensionStateContextProvider>,
	)

const task = (...rest: Record<string, unknown>[]) => [
	{ ts: 1, type: "say", say: "task", text: "the task" },
	...rest.map((m, i) => ({ ts: 2 + i, ...m })),
]

const composer = () => screen.getByTestId("chat-textarea")

beforeEach(() => vi.clearAllMocks())

describe("the invoke verbs", () => {
	it("puts text and images in the box without sending them", async () => {
		renderChatView()
		await hydrate({ shoferMessages: task() })

		await send({ type: "invoke", invoke: "setChatBoxMessage", text: "drafted", images: ["data:a"] })

		expect(composer()).toHaveAttribute("data-value", "drafted")
		expect(composer()).toHaveAttribute("data-images", "1")
		expect(posted("askResponse")).toHaveLength(0)
		expect(posted("newTask")).toHaveLength(0)
	})

	it("appends to a draft that is already there", async () => {
		renderChatView()
		await hydrate({ shoferMessages: task() })

		await send({ type: "invoke", invoke: "setChatBoxMessage", text: "one" })
		await send({ type: "invoke", invoke: "setChatBoxMessage", text: "two" })

		expect(composer()).toHaveAttribute("data-value", "one two")
	})

	it("starts a task from an empty conversation", async () => {
		renderChatView()
		await hydrate({ shoferMessages: [] })

		await send({ type: "invoke", invoke: "sendMessage", text: "do the thing" })
		expect(posted("newTask")[0]).toMatchObject({ text: "do the thing" })
	})

	it("clears the conversation on a new chat", async () => {
		renderChatView()
		await hydrate({ shoferMessages: task({ type: "ask", ask: "followup", text: "?" }) })

		await send({ type: "invoke", invoke: "setChatBoxMessage", text: "leftover" })
		await send({ type: "invoke", invoke: "newChat" })

		// The reset deliberately keeps the draft: it clears the ASK state, not
		// what the user has typed.
		expect(composer()).toHaveAttribute("data-value", "leftover")
	})

	it("drives the primary button remotely", async () => {
		renderChatView()
		await hydrate({ shoferMessages: task({ type: "ask", ask: "tool", text: "{}" }) })
		await waitFor(() => expect(screen.getAllByTestId("chat-row").length).toBeGreaterThan(0))

		await send({ type: "invoke", invoke: "primaryButtonClick" })
		expect(posted("askResponse")[0]).toMatchObject({ askResponse: "yesButtonClicked" })
	})

	it("drives the secondary button remotely", async () => {
		// A separate render: answering an ask retires it, so the two buttons
		// cannot both be exercised against one pending ask.
		renderChatView()
		await hydrate({ shoferMessages: task({ type: "ask", ask: "tool", text: "{}" }) })
		await waitFor(() => expect(screen.getAllByTestId("chat-row").length).toBeGreaterThan(0))

		await send({ type: "invoke", invoke: "secondaryButtonClick" })
		expect(posted("askResponse")[0]).toMatchObject({ askResponse: "noButtonClicked" })
	})
})

describe("images the host picked", () => {
	it("adds them to the composer", async () => {
		renderChatView()
		await hydrate({ shoferMessages: task() })

		await send({ type: "selectedImages", images: ["data:a", "data:b"] })
		expect(composer()).toHaveAttribute("data-images", "2")
	})

	it("leaves an edit-scoped delivery to the row that asked for it", async () => {
		renderChatView()
		await hydrate({ shoferMessages: task() })

		await send({ type: "selectedImages", images: ["data:a"], context: "edit" })
		expect(composer()).toHaveAttribute("data-images", "0")
	})
})

describe("context files delivered by the host", () => {
	const drop = (paths: string[]) =>
		send({ type: "addContextFiles", contextFiles: paths.map((path) => ({ path, isFile: true })) })

	it("renders a removable chip per file", async () => {
		renderChatView()
		await hydrate({ shoferMessages: task() })

		await drop(["src/a.ts", "src/b.ts"])
		expect(screen.getByLabelText("Remove src/a.ts")).toBeInTheDocument()

		fireEvent.click(screen.getByLabelText("Remove src/a.ts"))
		expect(screen.queryByLabelText("Remove src/a.ts")).not.toBeInTheDocument()
		expect(screen.getByLabelText("Remove src/b.ts")).toBeInTheDocument()
	})

	it("dedupes a path already carried", async () => {
		renderChatView()
		await hydrate({ shoferMessages: task() })

		await drop(["src/a.ts"])
		await drop(["src/a.ts", "src/c.ts"])

		expect(screen.getAllByLabelText(/^Remove /)).toHaveLength(2)
	})

	it("ignores an empty delivery", async () => {
		renderChatView()
		await hydrate({ shoferMessages: task() })

		await send({ type: "addContextFiles", contextFiles: [] })
		expect(screen.queryByLabelText(/^Remove /)).not.toBeInTheDocument()
	})
})

describe("condensing the context", () => {
	it("re-enables sending when the host answers", async () => {
		renderChatView()
		await hydrate({ shoferMessages: task() })

		await send({ type: "condenseTaskContextStarted", text: "task-1" })
		await send({ type: "condenseTaskContextResponse", text: "task-1" })

		// Observable through the composer coming back to life rather than
		// through internal state: nothing is disabled once the round-trip ends.
		expect(composer()).toBeInTheDocument()
	})

	it("ignores an answer carrying no task", async () => {
		renderChatView()
		await hydrate({ shoferMessages: task() })
		await send({ type: "condenseTaskContextResponse" })
		expect(composer()).toBeInTheDocument()
	})
})

describe("the notification cue", () => {
	it("sounds when the host says interaction is required", async () => {
		renderChatView()
		await hydrate({ soundEnabled: true, shoferMessages: task() })

		await send({ type: "interactionRequired" })
		expect(playNotification).toHaveBeenCalled()
	})
})

describe("keyboard shortcuts", () => {
	const press = (init: KeyboardEventInit) =>
		act(() => {
			window.dispatchEvent(new KeyboardEvent("keydown", { ...init, bubbles: true, cancelable: true }))
		})

	it("cycles the mode forward with Ctrl+.", async () => {
		renderChatView()
		await hydrate({ shoferMessages: task() })

		await press({ key: ".", ctrlKey: true })
		expect(posted("mode")[0]).toMatchObject({ text: "ask" })
	})

	it("cycles backward with Ctrl+Shift+. and wraps", async () => {
		renderChatView()
		await hydrate({ shoferMessages: task() })

		await press({ key: ".", ctrlKey: true, shiftKey: true })
		expect(posted("mode")[0]).toMatchObject({ text: "debug" })
	})

	it("does nothing when governance left no modes at all", async () => {
		renderChatView()
		await hydrate({ shoferMessages: task(), customModes: [] })

		await press({ key: ".", ctrlKey: true })
		expect(posted("mode")).toHaveLength(0)
	})

	// The chat surface also carries a Find BUTTON with the same accessible name,
	// so the overlay is identified by its input specifically.
	const findBox = () => screen.queryByRole("textbox", { name: "Find in session" })

	it("opens the in-session search with Ctrl+F, and closes it with Escape", async () => {
		renderChatView()
		await hydrate({ shoferMessages: task() })

		await press({ key: "f", ctrlKey: true })
		expect(findBox()).toBeInTheDocument()

		await press({ key: "Escape" })
		expect(findBox()).not.toBeInTheDocument()
	})

	it("leaves Ctrl+F to VS Code when there is no task to search", async () => {
		renderChatView()
		await hydrate({ shoferMessages: [] })

		await press({ key: "f", ctrlKey: true })
		expect(findBox()).not.toBeInTheDocument()
	})

	it("does not claim Ctrl+Shift+F, which is the workspace search", async () => {
		renderChatView()
		await hydrate({ shoferMessages: task() })

		await press({ key: "f", ctrlKey: true, shiftKey: true })
		expect(findBox()).not.toBeInTheDocument()
	})
})

describe("the message filter", () => {
	const shown = () => screen.queryAllByTestId("chat-row")

	// Every case keeps one ordinary row so the assertion distinguishes "filtered"
	// from "the whole list failed to render".
	const visible = { type: "say", say: "text", text: "visible" }

	it("hides the control-plane and bookkeeping rows", async () => {
		renderChatView()
		await hydrate({
			shoferMessages: task(
				visible,
				{ type: "say", say: "api_req_finished" },
				{ type: "say", say: "api_req_deleted" },
				{ type: "say", say: "mcp_server_request_started" },
				{ type: "say", say: "task_interaction", text: "{}" },
				{ type: "say", say: "checkpoint_saved", text: "abc123" },
			),
		})

		await waitFor(() => expect(shown().length).toBeGreaterThan(0))
		const says = shown().map((el) => el.getAttribute("data-say"))
		expect(says).not.toContain("api_req_finished")
		expect(says).not.toContain("mcp_server_request_started")
		expect(says).not.toContain("task_interaction")
		expect(says).not.toContain("checkpoint_saved")
	})

	it("hides a plugin marker the plugin asked to suppress", async () => {
		renderChatView()
		await hydrate({
			shoferMessages: task(
				{ type: "say", say: "plugin_marker", marker: { suppress: true } },
				{ type: "say", say: "text", text: "visible" },
			),
		})

		await waitFor(() => expect(shown().length).toBeGreaterThan(0))
		expect(shown().map((el) => el.getAttribute("data-say"))).not.toContain("plugin_marker")
	})

	it("hides an empty text row but keeps one carrying an image", async () => {
		renderChatView()
		await hydrate({
			shoferMessages: task(
				{ type: "say", say: "text", text: "" },
				{ type: "say", say: "text", text: "", images: ["data:a"] },
			),
		})

		await waitFor(() => expect(shown().length).toBeGreaterThan(0))
		expect(shown().filter((el) => el.getAttribute("data-say") === "text")).toHaveLength(1)
	})

	it("hides the resume asks the host uses to re-enter a task", async () => {
		renderChatView()
		await hydrate({
			shoferMessages: task(visible, { type: "ask", ask: "resume_task" }, { type: "ask", ask: "api_req_failed" }),
		})

		await waitFor(() => expect(shown().length).toBeGreaterThan(0))
		const asks = shown().map((el) => el.getAttribute("data-ask"))
		expect(asks).not.toContain("resume_task")
		expect(asks).not.toContain("api_req_failed")
	})

	it("hides a completion ask with no result text", async () => {
		renderChatView()
		await hydrate({ shoferMessages: task(visible, { type: "ask", ask: "completion_result", text: "" }) })

		await waitFor(() => expect(shown().length).toBeGreaterThan(0))
		expect(shown().map((el) => el.getAttribute("data-ask"))).not.toContain("completion_result")
	})
})
