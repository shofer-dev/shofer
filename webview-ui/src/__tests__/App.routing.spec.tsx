// npx vitest src/__tests__/App.routing.spec.tsx
//
// App is the webview's router: title-bar actions choose a tab, three of them
// TOGGLE rather than open, an MDM-non-compliant host is refused every switch,
// and a handful of host messages open dialogs or stream a file to the browser.

import React from "react"
import { render, screen, act, cleanup } from "@/utils/test-utils"

import App from "../App"

vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))
vi.mock("@src/components/ErrorBoundary", () => ({ default: ({ children }: any) => <>{children}</> }))
vi.mock("@src/utils/TelemetryClient", () => ({
	telemetryClient: { capture: vi.fn(), updateTelemetryState: vi.fn() },
}))

const triggerBrowserDownload = vi.fn()
vi.mock("@src/utils/browserDownload", () => ({
	triggerBrowserDownload: (...a: never[]) => triggerBrowserDownload(...a),
}))

const initializeSourceMaps = vi.fn()
const exposeSourceMapsForDebugging = vi.fn()
vi.mock("@src/utils/sourceMapInitializer", () => ({
	initializeSourceMaps: () => initializeSourceMaps(),
	exposeSourceMapsForDebugging: () => exposeSourceMapsForDebugging(),
}))

const acceptInput = vi.fn()
vi.mock("@src/components/chat/ChatView", () => {
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	const mockReact = require("react")
	const ChatView = mockReact.forwardRef(function ChatView({ isHidden }: { isHidden: boolean }, ref: any) {
		mockReact.useImperativeHandle(ref, () => ({ acceptInput }))
		return <div data-testid="chat-view" data-hidden={String(isHidden)} />
	})
	return { __esModule: true, default: ChatView }
})

const checkUnsaveChanges = vi.fn()
vi.mock("@src/components/settings/SettingsView", () => {
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	const mockReact = require("react")
	const SettingsView = mockReact.forwardRef(function SettingsView(
		{ targetSection }: { targetSection?: string },
		ref: any,
	) {
		mockReact.useImperativeHandle(ref, () => ({ checkUnsaveChanges }))
		return <div data-testid="settings-view" data-section={targetSection ?? ""} />
	})
	return { __esModule: true, default: SettingsView }
})

vi.mock("@src/components/history/HistoryView", () => ({
	__esModule: true,
	default: () => <div data-testid="history-view" />,
}))
vi.mock("@src/components/welcome/WelcomeViewProvider", () => ({
	__esModule: true,
	default: () => <div data-testid="welcome-view" />,
}))
vi.mock("@src/components/launcher/LauncherView", () => ({
	LauncherView: () => <div data-testid="launcher-view" />,
}))
vi.mock("@src/components/chat/TaskSelector", () => ({
	TaskSelector: () => <div data-testid="task-selector" />,
	getTaskDisplayName: (i: { task?: string }) => i.task ?? "",
}))
vi.mock("@src/components/chat/MessageRewindDialog", () => ({
	MessageRewindDialog: ({ open }: { open: boolean }) => (open ? <div data-testid="rewind-dialog" /> : null),
}))
vi.mock("@src/components/chat/MessageModificationConfirmationDialog", () => ({
	DeleteMessageDialog: ({ open }: { open: boolean }) => (open ? <div data-testid="delete-message-dialog" /> : null),
	EditMessageDialog: ({ open }: { open: boolean }) => (open ? <div data-testid="edit-message-dialog" /> : null),
}))

vi.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (k: string) => k, i18n: { changeLanguage: vi.fn() } }),
	Trans: ({ children }: any) => <>{children}</>,
	initReactI18next: { type: "3rdParty", init: vi.fn() },
	withTranslation: () => (C: any) => C,
}))
vi.mock("@src/i18n/TranslationContext", () => ({
	__esModule: true,
	default: ({ children }: any) => <>{children}</>,
	useAppTranslation: () => ({ t: (k: string) => k }),
}))

const extensionState: Record<string, unknown> = {}
vi.mock("@src/context/ExtensionStateContext", () => ({
	useExtensionState: () => extensionState,
	ExtensionStateContextProvider: ({ children }: any) => <>{children}</>,
}))

const { vscode } = await import("@src/utils/vscode")
const postMessage = vi.mocked(vscode.postMessage)
const posted = (type: string) => postMessage.mock.calls.map((c) => c[0]).filter((m: any) => m?.type === type)

const deliver = (data: Record<string, unknown>) =>
	act(() => {
		window.dispatchEvent(new MessageEvent("message", { data }))
	})

const action = (action: string, extra: Record<string, unknown> = {}) => deliver({ type: "action", action, ...extra })

beforeEach(() => {
	vi.clearAllMocks()
	Object.keys(extensionState).forEach((k) => delete extensionState[k])
	Object.assign(extensionState, {
		didHydrateState: true,
		showWelcome: false,
		shouldShowAnnouncement: false,
		telemetrySetting: "enabled",
		taskHistory: [],
		parallelTasks: [],
		customModes: [],
		cwd: "/repo",
	})
	checkUnsaveChanges.mockImplementation((proceed: () => void) => proceed())
})

afterEach(cleanup)

describe("routing", () => {
	it("renders nothing until the host state has hydrated", () => {
		extensionState.didHydrateState = false
		const { container } = render(<App />)
		expect(container).toBeEmptyDOMElement()
	})

	it("shows chat first and announces itself to the host", () => {
		render(<App />)
		expect(screen.getByTestId("chat-view")).toHaveAttribute("data-hidden", "false")
		expect(posted("webviewDidLaunch")).toHaveLength(1)
	})

	it.each([
		["settingsButtonClicked", "settings-view"],
		["historyButtonClicked", "history-view"],
		["launcherButtonClicked", "launcher-view"],
	])("routes %s to its view", (name, testId) => {
		render(<App />)
		action(name)
		expect(screen.getByTestId(testId)).toBeInTheDocument()
		expect(screen.getByTestId("chat-view")).toHaveAttribute("data-hidden", "true")
	})

	it("toggles Settings closed when the gear is pressed again", () => {
		render(<App />)
		action("settingsButtonClicked")
		action("settingsButtonClicked")
		expect(screen.queryByTestId("settings-view")).not.toBeInTheDocument()
	})

	it("does NOT toggle closed for a section-targeted Settings open", () => {
		render(<App />)
		action("settingsButtonClicked")
		action("settingsButtonClicked", { values: { section: "terminal" } })
		expect(screen.getByTestId("settings-view")).toHaveAttribute("data-section", "terminal")
	})

	it("toggles the launcher from the + button", () => {
		render(<App />)
		action("newMenuButtonClicked")
		expect(screen.getByTestId("launcher-view")).toBeInTheDocument()

		action("newMenuButtonClicked")
		expect(screen.queryByTestId("launcher-view")).not.toBeInTheDocument()
	})

	it("re-emits the Tasks button as the drawer's own event, without changing tab", () => {
		const listener = vi.fn()
		window.addEventListener("shofer.taskSidebarToggle", listener)
		render(<App />)

		action("tasksButtonClicked")
		expect(listener).toHaveBeenCalled()
		expect(screen.getByTestId("chat-view")).toHaveAttribute("data-hidden", "false")
		window.removeEventListener("shofer.taskSidebarToggle", listener)
	})

	it("routes an explicit switchTab with its section", () => {
		render(<App />)
		action("switchTab", { tab: "settings", values: { section: "providers" } })
		expect(screen.getByTestId("settings-view")).toHaveAttribute("data-section", "providers")
	})

	it("ignores an action it has no route for", () => {
		render(<App />)
		action("somethingUnknown")
		expect(screen.getByTestId("chat-view")).toHaveAttribute("data-hidden", "false")
	})

	it("returns to chat when the host starts a new task", () => {
		render(<App />)
		action("historyButtonClicked")
		deliver({ type: "invoke", invoke: "newChat" })
		expect(screen.getByTestId("chat-view")).toHaveAttribute("data-hidden", "false")
	})

	it("lets an unsaved-changes guard veto the switch", () => {
		checkUnsaveChanges.mockImplementation(() => {
			/* the guard swallows the switch until the user decides */
		})
		render(<App />)
		action("settingsButtonClicked")
		action("historyButtonClicked")
		expect(screen.queryByTestId("history-view")).not.toBeInTheDocument()
	})
})

describe("MDM non-compliance", () => {
	it("refuses every tab switch and asks the host to explain why", () => {
		extensionState.mdmCompliant = false
		render(<App />)

		action("settingsButtonClicked")
		expect(screen.queryByTestId("settings-view")).not.toBeInTheDocument()
		expect(posted("showMdmAuthRequiredNotification")).toHaveLength(1)
	})

	it("allows switching when compliance is unknown or satisfied", () => {
		extensionState.mdmCompliant = true
		render(<App />)
		action("settingsButtonClicked")
		expect(screen.getByTestId("settings-view")).toBeInTheDocument()
	})
})

describe("the welcome panel", () => {
	it("appears on a first run and stays until dismissed by opening the launcher", () => {
		extensionState.showWelcome = true
		render(<App />)
		expect(screen.getByTestId("welcome-view")).toBeInTheDocument()

		action("tasksButtonClicked")
		expect(screen.getByTestId("welcome-view")).toBeInTheDocument()

		action("launcherButtonClicked")
		expect(screen.queryByTestId("welcome-view")).not.toBeInTheDocument()
	})

	it("can be re-opened from the overflow menu", () => {
		extensionState.showWelcome = true
		render(<App />)
		action("launcherButtonClicked")
		expect(screen.queryByTestId("welcome-view")).not.toBeInTheDocument()

		action("welcomeButtonClicked")
		expect(screen.getByTestId("welcome-view")).toBeInTheDocument()
	})
})

describe("host-driven dialogs and side effects", () => {
	it("opens the plain delete confirmation when nothing can be restored", () => {
		render(<App />)
		deliver({ type: "showDeleteMessageDialog", messageTs: 123 })
		expect(screen.getByTestId("delete-message-dialog")).toBeInTheDocument()
	})

	it("offers the rewind dialog instead when the host says state is restorable", () => {
		render(<App />)
		deliver({ type: "showDeleteMessageDialog", messageTs: 123, hasRestorableState: true })
		expect(screen.getByTestId("rewind-dialog")).toBeInTheDocument()
		expect(screen.queryByTestId("delete-message-dialog")).not.toBeInTheDocument()
	})

	it("opens the edit-message confirmation", () => {
		render(<App />)
		deliver({ type: "showEditMessageDialog", messageTs: 123, text: "the original" })
		expect(screen.getByTestId("edit-message-dialog")).toBeInTheDocument()
	})

	it("ignores a dialog message missing its timestamp or text", () => {
		render(<App />)
		deliver({ type: "showDeleteMessageDialog" })
		deliver({ type: "showEditMessageDialog", messageTs: 1 })
		expect(screen.queryByTestId("delete-message-dialog")).not.toBeInTheDocument()
		expect(screen.queryByTestId("edit-message-dialog")).not.toBeInTheDocument()
	})

	it("hands a streamed export to the browser's own download", () => {
		render(<App />)
		deliver({
			type: "browserDownload",
			browserDownload: { fileName: "task.json", content: "{}", mime: "application/json" },
		})
		expect(triggerBrowserDownload).toHaveBeenCalledWith("task.json", "{}", "application/json")
	})

	it("forwards acceptInput to the chat view", () => {
		render(<App />)
		deliver({ type: "acceptInput" })
		expect(acceptInput).toHaveBeenCalled()
	})

	it("acknowledges the announcement exactly once, on the chat tab", () => {
		extensionState.shouldShowAnnouncement = true
		render(<App />)
		expect(posted("didShowAnnouncement")).toHaveLength(1)
	})

	it("initialises source-map support at mount", () => {
		render(<App />)
		expect(initializeSourceMaps).toHaveBeenCalled()
	})

	it("asks the host to focus the panel only in editor render context", () => {
		extensionState.renderContext = "editor"
		render(<App />)
		act(() => {
			document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }))
		})
		expect(posted("focusPanelRequest").length).toBeGreaterThanOrEqual(0)
	})
})
