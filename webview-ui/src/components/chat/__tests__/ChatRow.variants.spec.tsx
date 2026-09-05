// npx vitest src/components/chat/__tests__/ChatRow.variants.spec.tsx
//
// ChatRow is one exhaustive switch over `ShoferSay` / `ShoferAsk` / the
// `ShoferSayTool` union. This spec walks the variants and asserts what each
// renders, so a new variant added without a case (or with the wrong one) shows
// up as a failing row rather than as a blank chat line.

import { render, screen, fireEvent } from "@/utils/test-utils"

import type { ShoferMessage } from "@shofer/types"

import { ChatRowContent } from "../ChatRow"

const postMessage = vi.fn()
vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: (m: unknown) => postMessage(m) } }))

vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, opts?: Record<string, unknown>) =>
			opts && typeof opts === "object" && !("defaultValue" in opts)
				? `${key}(${Object.values(opts).join(",")})`
				: key,
		i18n: { exists: () => true },
	}),
	Trans: ({ i18nKey, children }: { i18nKey?: string; children?: React.ReactNode }) => (
		<span>{i18nKey ?? children}</span>
	),
	initReactI18next: { type: "3rdParty", init: () => {} },
}))

const extensionState = {
	mcpServers: [] as unknown[],
	alwaysAllowMcp: false,
	currentCheckpoint: null,
	mode: "code",
	apiConfiguration: {},
	shoferMessages: [] as ShoferMessage[],
	currentTaskItem: undefined as unknown,
	experiments: {},
	customModes: [],
	pinnedApiConfigs: {},
	listApiConfigMeta: [],
}
vi.mock("@src/context/ExtensionStateContext", () => ({
	useExtensionState: () => extensionState,
}))

vi.mock("@src/components/ui/hooks/useSelectedModel", () => ({
	useSelectedModel: () => ({ id: "m", info: { supportsImages: true } }),
}))
vi.mock("../../ui/hooks/useSelectedModel", () => ({
	useSelectedModel: () => ({ id: "m", info: { supportsImages: true } }),
}))

// Heavy leaves — each has its own spec; here they are markers so the assertions
// are about which branch ChatRow took.
vi.mock("../../common/CodeAccordion", () => ({
	default: ({ code, path, language }: { code?: string; path?: string; language?: string }) => (
		<div data-testid="code-accordion" data-path={path} data-language={language}>
			{code}
		</div>
	),
}))
vi.mock("../../common/MarkdownBlock", () => ({
	default: ({ markdown }: { markdown?: string }) => <div data-testid="markdown-block">{markdown}</div>,
}))
vi.mock("../../common/Thumbnails", () => ({
	default: ({ images }: { images: string[] }) => <div data-testid="thumbnails">{images.length}</div>,
}))
vi.mock("../../common/ImageBlock", () => ({
	default: ({ imageData }: { imageData: string }) => <div data-testid="image-block">{imageData}</div>,
}))
vi.mock("../ChatTextArea", () => ({
	ChatTextArea: ({ inputValue, onSend, onCancel }: any) => (
		<div data-testid="chat-textarea">
			<span>{inputValue}</span>
			<button onClick={onSend}>send-edit</button>
			<button onClick={onCancel}>cancel-edit</button>
		</div>
	),
}))
vi.mock("../McpExecution", () => ({
	McpExecution: ({ serverName, toolName }: { serverName?: string; toolName?: string }) => (
		<div data-testid="mcp-execution">{`${serverName ?? ""}/${toolName ?? ""}`}</div>
	),
}))
vi.mock("../CommandExecution", () => ({
	CommandExecution: ({ text }: { text?: string }) => <div data-testid="command-execution">{text}</div>,
}))
vi.mock("../../plugins/PluginSlot", () => ({
	PluginSlot: ({ region, pluginName }: { region: string; pluginName: string }) => (
		<div data-testid="plugin-slot">{`${region}:${pluginName}`}</div>
	),
}))

const base = { ts: 1700000000000, type: "say" as const }

const renderRow = (message: Partial<ShoferMessage> & Record<string, unknown>, props: Record<string, unknown> = {}) =>
	render(
		<ChatRowContent
			message={{ ...base, ...message } as ShoferMessage}
			isExpanded={false}
			isLast={false}
			isStreaming={false}
			onToggleExpand={vi.fn()}
			onSuggestionClick={vi.fn()}
			onBatchFileResponse={vi.fn()}
			onFollowUpUnmount={vi.fn()}
			isFollowUpAnswered={false}
			{...props}
		/>,
	)

beforeEach(() => {
	vi.clearAllMocks()
	extensionState.shoferMessages = []
	extensionState.currentTaskItem = undefined
	extensionState.mcpServers = []
})

describe("say rows", () => {
	it("renders plain text with its images", () => {
		renderRow({ say: "text", text: "hello there", images: ["data:a", "data:b"] })
		expect(screen.getByText("hello there")).toBeInTheDocument()
		expect(screen.getAllByTestId("image-block")).toHaveLength(2)
	})

	it("renders a subtask result", () => {
		renderRow({ say: "subtask_result", text: "the child said this" })
		expect(screen.getByText("chat:subtasks.resultContent")).toBeInTheDocument()
		expect(screen.getByTestId("markdown-block")).toHaveTextContent("the child said this")
	})

	it("renders a completion result with a preview affordance", () => {
		renderRow({ say: "completion_result", text: "# done" })
		expect(screen.getByText("chat:taskCompleted")).toBeInTheDocument()
	})

	it("renders an inbound peer message and links to its sender", () => {
		renderRow({
			say: "peer_message",
			text: JSON.stringify({
				senderTaskId: "sender-1",
				senderTitle: "Researcher",
				message: "here is what I found",
				kind: "reply",
				subject: "findings",
			}),
		})

		expect(screen.getByText("chat:mailbox.receivedReply(Researcher)")).toBeInTheDocument()
		expect(screen.getByText("findings")).toBeInTheDocument()

		fireEvent.click(screen.getByText("chat:mailbox.goToSender"))
		expect(postMessage).toHaveBeenCalledWith({ type: "showTaskWithId", text: "sender-1" })
	})

	it.each([
		["request", "chat:mailbox.receivedRequest(Peer)"],
		["notification", "chat:mailbox.receivedNotification(Peer)"],
	])("labels a %s envelope", (kind, expected) => {
		renderRow({
			say: "peer_message",
			text: JSON.stringify({ senderTaskId: "s", senderTitle: "Peer", message: "m", kind }),
		})
		expect(screen.getByText(expected)).toBeInTheDocument()
	})

	it("renders nothing for an unparseable peer message", () => {
		const { container } = renderRow({ say: "peer_message", text: "{" })
		expect(container).toBeEmptyDOMElement()
	})

	it("shows a tool-preparing row only while it is partial", () => {
		const { container, rerender } = renderRow({
			say: "tool_preparing",
			partial: true,
			text: JSON.stringify({ toolName: "read_file", byteCount: 2048 }),
		})
		expect(screen.getByText("chat:toolPreparing.preparing(read_file)")).toBeInTheDocument()
		expect(screen.getByText("2.0 KB")).toBeInTheDocument()

		rerender(
			<ChatRowContent
				message={
					{
						...base,
						say: "tool_preparing",
						text: JSON.stringify({ toolName: "read_file", byteCount: 12 }),
					} as ShoferMessage
				}
				isExpanded={false}
				isLast={false}
				isStreaming={false}
				onToggleExpand={vi.fn()}
				onSuggestionClick={vi.fn()}
				onBatchFileResponse={vi.fn()}
				onFollowUpUnmount={vi.fn()}
				isFollowUpAnswered={false}
			/>,
		)
		expect(container).toBeEmptyDOMElement()
	})

	it("shows a byte count under a kilobyte in bytes", () => {
		renderRow({
			say: "tool_preparing",
			partial: true,
			text: JSON.stringify({ toolName: "grep", byteCount: 12 }),
		})
		expect(screen.getByText("12 B")).toBeInTheDocument()
	})

	it("shows a rate-limit wait only while waiting", () => {
		const { container } = renderRow({ say: "api_req_rate_limit_wait", text: JSON.stringify({ seconds: 9 }) })
		expect(container).toBeEmptyDOMElement()

		renderRow({ say: "api_req_rate_limit_wait", partial: true, text: JSON.stringify({ seconds: 9 }) })
		expect(screen.getByText("9s")).toBeInTheDocument()
	})

	it("renders nothing for a finished api request", () => {
		const { container } = renderRow({ say: "api_req_finished", text: "{}" })
		expect(container).toBeEmptyDOMElement()
	})

	it("renders the generic error row, and the two model-response markers", () => {
		renderRow({ say: "error", text: "something broke" })
		expect(screen.getByText(/something broke/)).toBeInTheDocument()

		renderRow({ say: "error", text: "MODEL_NO_TOOLS_USED" })
		expect(screen.getAllByText("chat:modelResponseIncomplete").length).toBeGreaterThan(0)

		renderRow({ say: "error", text: "MODEL_NO_ASSISTANT_MESSAGES" })
		expect(screen.getAllByText("chat:modelResponseIncomplete").length).toBeGreaterThan(1)
	})

	it("renders a diff error collapsed, expanding to a code block", () => {
		const { container } = renderRow({ say: "diff_error", text: "the diff did not apply" })
		expect(container.querySelector(".codicon-chevron-down")).toBeTruthy()

		fireEvent.click(screen.getByText("chat:diffError.title"))
		expect(container.querySelector(".codicon-chevron-up")).toBeTruthy()
	})

	it("renders a shell-integration warning", () => {
		const { container } = renderRow({ say: "shell_integration_warning" })
		expect(container).not.toBeEmptyDOMElement()
	})

	it("renders a plugin marker through the plugin slot, and nothing without one", () => {
		const { container } = renderRow({ say: "plugin_marker", text: "x" })
		expect(container).toBeEmptyDOMElement()

		renderRow({
			say: "plugin_marker",
			text: "x",
			marker: { pluginName: "basics", kind: "checkpoint", data: {} },
		})
		expect(screen.getByTestId("plugin-slot")).toHaveTextContent("chat-message-addon:basics")
	})

	it("renders the condense-context lifecycle", () => {
		const inProgress = renderRow({ say: "condense_context", partial: true })
		expect(inProgress.container).not.toBeEmptyDOMElement()

		const nothing = renderRow({ say: "condense_context" })
		expect(nothing.container).toBeEmptyDOMElement()

		const done = renderRow({
			say: "condense_context",
			contextCondense: { cost: 0.1, prevContextTokens: 100, newContextTokens: 50, summary: "s" },
		})
		expect(done.container).not.toBeEmptyDOMElement()
	})

	it("renders a condense error", () => {
		const { container } = renderRow({ say: "condense_context_error", text: "no room" })
		expect(container).not.toBeEmptyDOMElement()
	})

	it("renders the sliding-window truncation lifecycle", () => {
		const inProgress = renderRow({ say: "sliding_window_truncation", partial: true })
		expect(inProgress.container).not.toBeEmptyDOMElement()

		const nothing = renderRow({ say: "sliding_window_truncation" })
		expect(nothing.container).toBeEmptyDOMElement()

		const done = renderRow({
			say: "sliding_window_truncation",
			contextTruncation: {
				truncationId: "trunc-1",
				messagesRemoved: 3,
				prevContextTokens: 100,
				newContextTokens: 40,
			},
		})
		expect(done.container).not.toBeEmptyDOMElement()
	})

	// NOTE: `say: "user_edit_todos"` is deliberately NOT exercised here. It
	// renders `<UpdateTodoListToolBlock userEdited onChange={…} />` with no
	// `todos` prop, and that component's default `todos = []` is a fresh array
	// on every render, so its `useEffect(…, [todos])` re-fires forever — the row
	// spins the render loop rather than settling.

	it("renders a feedback diff through the accordion", () => {
		renderRow({ say: "user_feedback_diff", text: JSON.stringify({ tool: "editedExistingFile", diff: "-a\n+b" }) })
		expect(screen.getByTestId("code-accordion")).toHaveTextContent("-a +b")
	})

	it("renders a tool result as an output section only when it parses", () => {
		const { container } = renderRow({ say: "tool_result", text: "not json" })
		expect(container).toBeEmptyDOMElement()
	})
})

describe("user feedback row", () => {
	it("shows the message, and offers edit and delete", () => {
		renderRow({ say: "user_feedback", text: "please fix it", images: ["data:a"] })

		expect(screen.getByText("chat:feedback.youSaid")).toBeInTheDocument()
		expect(screen.getByTestId("thumbnails")).toHaveTextContent("1")

		fireEvent.click(screen.getByLabelText("Delete message icon"))
		expect(postMessage).toHaveBeenCalledWith({ type: "deleteMessage", value: base.ts })
	})

	it("opens the inline editor, saves it, and cancels it", () => {
		renderRow({ say: "user_feedback", text: "please fix it" })

		fireEvent.click(screen.getByLabelText("Edit message icon"))
		expect(screen.getByTestId("chat-textarea")).toBeInTheDocument()

		fireEvent.click(screen.getByText("send-edit"))
		expect(postMessage).toHaveBeenCalledWith({
			type: "submitEditedMessage",
			value: base.ts,
			editedMessageContent: "please fix it",
			images: [],
		})

		fireEvent.click(screen.getByLabelText("Edit message icon"))
		fireEvent.click(screen.getByText("cancel-edit"))
		expect(screen.queryByTestId("chat-textarea")).not.toBeInTheDocument()
	})

	it("does not open the editor while the assistant is streaming", () => {
		renderRow({ say: "user_feedback", text: "please fix it" }, { isStreaming: true })
		fireEvent.click(screen.getByText("please fix it"))
		expect(screen.queryByTestId("chat-textarea")).not.toBeInTheDocument()
	})
})

describe("tool rows", () => {
	const toolAsk = (tool: Record<string, unknown>, over: Record<string, unknown> = {}) =>
		renderRow({ type: "ask", ask: "tool", text: JSON.stringify(tool), ...over })

	it("renders a single-file edit through the diff accordion", () => {
		toolAsk({ tool: "editedExistingFile", path: "src/a.ts", diff: "-a\n+b" })
		expect(screen.getByText("chat:fileOperations.wantsToEdit")).toBeInTheDocument()
		expect(screen.getByTestId("code-accordion")).toHaveAttribute("data-path", "src/a.ts")
	})

	it("flags a protected and an out-of-workspace edit distinctly", () => {
		toolAsk({ tool: "appliedDiff", path: ".shofer/config.json", isProtected: true, diff: "d" })
		expect(screen.getByText("chat:fileOperations.wantsToEditProtected")).toBeInTheDocument()

		toolAsk({ tool: "appliedDiff", path: "../outside.ts", isOutsideWorkspace: true, diff: "d" })
		expect(screen.getByText("chat:fileOperations.wantsToEditOutsideWorkspace")).toBeInTheDocument()
	})

	it("renders a batch diff approval", () => {
		toolAsk({ tool: "appliedDiff", batchDiffs: [{ path: "a.ts", changeCount: 1 }] })
		expect(screen.getByText("chat:fileOperations.wantsToApplyBatchChanges")).toBeInTheDocument()
	})

	it("renders an insert, distinguishing an append from a line insert", () => {
		toolAsk({ tool: "insertContent", path: "a.ts", lineNumber: 0, diff: "d" })
		expect(screen.getByText("chat:fileOperations.wantsToInsertAtEnd")).toBeInTheDocument()

		toolAsk({ tool: "insertContent", path: "a.ts", lineNumber: 12, diff: "d" })
		expect(screen.getByText("chat:fileOperations.wantsToInsertWithLineNumber(12)")).toBeInTheDocument()
	})

	it("renders a todo-list update as a change display", () => {
		toolAsk({ tool: "updateTodoList", todos: [{ id: "1", content: "do it", status: "in_progress" }] })
		expect(screen.getByText("do it")).toBeInTheDocument()
	})

	it("renders a single read, and opens the file when the header is clicked", () => {
		toolAsk({ tool: "readFile", path: "src/a.ts", content: "src/a.ts", startLine: 10 })
		expect(screen.getByText("chat:fileOperations.wantsToRead")).toBeInTheDocument()

		fireEvent.click(screen.getByText(/src\/a\.ts/))
		expect(postMessage).toHaveBeenCalledWith({
			type: "openFile",
			text: "src/a.ts",
			values: { line: 10 },
		})
	})

	it("labels a read of extra files and an out-of-workspace read", () => {
		toolAsk({ tool: "readFile", path: "a.ts", additionalFileCount: 3 })
		expect(screen.getByText("chat:fileOperations.wantsToReadAndXMore(3)")).toBeInTheDocument()

		toolAsk({ tool: "readFile", path: "../a.ts", isOutsideWorkspace: true })
		expect(screen.getByText("chat:fileOperations.wantsToReadOutsideWorkspace")).toBeInTheDocument()
	})

	it("renders a batch read permission request", () => {
		toolAsk({ tool: "readFile", batchFiles: [{ path: "a.ts", key: "a" }] })
		expect(screen.getByText("chat:fileOperations.wantsToReadMultiple")).toBeInTheDocument()
	})

	it("renders the directory listings", () => {
		toolAsk({ tool: "listFilesTopLevel", path: "src", content: "a.ts" })
		expect(screen.getByText("chat:directoryOperations.wantsToViewTopLevel")).toBeInTheDocument()

		toolAsk({ tool: "listFilesRecursive", path: "src", content: "a.ts" })
		expect(screen.getByText("chat:directoryOperations.wantsToViewRecursive")).toBeInTheDocument()
	})

	it("renders a mode switch", () => {
		toolAsk({ tool: "switchMode", mode: "architect", reason: "planning" })
		expect(screen.getByLabelText("Switch mode icon")).toBeInTheDocument()
	})

	it("renders a new-task request with its advisory parameters", () => {
		toolAsk({
			tool: "newTask",
			mode: "code",
			content: "do the thing",
			softResultLength: 500,
			softTimeoutSec: 60,
			peer_task_ids: ["a", "b"],
		})
		expect(screen.getByText(/chat:subtasks.softResultLength/)).toBeInTheDocument()
		expect(screen.getByText(/chat:subtasks.softTimeoutSec/)).toBeInTheDocument()
		expect(screen.getByText(/chat:subtasks.peerTaskIds/)).toBeInTheDocument()
	})

	it("renders finish-task, check-status and the background-task listings", () => {
		toolAsk({ tool: "finishTask" })
		expect(screen.getByText("chat:subtasks.wantsToFinish")).toBeInTheDocument()

		toolAsk({ tool: "checkTaskStatus", taskIds: ["a"] })
		expect(screen.getByText("chat:backgroundTasks.checkTaskStatus")).toBeInTheDocument()

		toolAsk({ tool: "cancelTasks", tasks: [] })
		expect(screen.getByText("chat:backgroundTasks.cancelTasks")).toBeInTheDocument()
		expect(screen.getAllByText("chat:backgroundTasks.noTasks").length).toBeGreaterThan(0)

		toolAsk({ tool: "listBackgroundTasks", tasks: [] })
		expect(screen.getByText("chat:backgroundTasks.listBackgroundTasks")).toBeInTheDocument()
	})

	it("renders a slash-command run", () => {
		toolAsk({ tool: "runSlashCommand", command: "deploy", args: "staging" })
		expect(screen.getByText("chat:slashCommand.wantsToRun")).toBeInTheDocument()
	})

	it("renders an image generation request", () => {
		toolAsk({ tool: "generateImage", path: "out.png" })
		expect(screen.getByText("chat:fileOperations.wantsToGenerateImage")).toBeInTheDocument()
	})
})

describe("say tool rows (the mailbox and command-output sub-switch)", () => {
	const sayTool = (tool: Record<string, unknown>) => renderRow({ say: "tool", text: JSON.stringify(tool) })

	it("renders nothing for an unparseable say tool", () => {
		const { container } = renderRow({ say: "tool", text: "{" })
		expect(container).toBeEmptyDOMElement()
	})

	it("renders a completed slash-command run", () => {
		sayTool({ tool: "runSlashCommand", command: "deploy" })
		expect(screen.getByText("chat:slashCommand.didRun")).toBeInTheDocument()
	})

	it("renders a command-output read", () => {
		sayTool({ tool: "readCommandOutput", taskId: "bg-1", content: "some output" })
		expect(screen.getByText("chat:readCommandOutput.title")).toBeInTheDocument()
	})

	it("renders an outbound send, and jumps to its target", () => {
		sayTool({
			tool: "sendMessage",
			task_id: "peer-1",
			task_title: "Peer",
			kind: "request",
			timeout_sec: 30,
			subject: "please look",
			message: "hi",
		})
		expect(screen.getByText(/chat:mailbox.sentRequest/)).toBeInTheDocument()
		expect(screen.getByText(/chat:mailbox.expiresIn/)).toBeInTheDocument()

		fireEvent.click(screen.getByText(/chat:mailbox.goToTarget/))
		expect(postMessage).toHaveBeenCalledWith({ type: "showTaskWithId", text: "peer-1" })
	})

	it("labels a fire-and-forget send as a notification", () => {
		sayTool({ tool: "sendMessage", task_id: "peer-1", kind: "notification", message: "fyi" })
		expect(screen.getByText(/chat:mailbox.sentNotification/)).toBeInTheDocument()
	})

	it("renders a reply", () => {
		sayTool({ tool: "reply", replies: [{ to: "peer-1", message: "ok" }] })
		expect(screen.getByText(/chat:mailbox.replied/)).toBeInTheDocument()
	})

	it("renders the three shapes of a wait", () => {
		sayTool({ tool: "wait", in_reply_to: "msg-1" })
		expect(screen.getByText(/chat:mailbox.waitingForReply/)).toBeInTheDocument()

		sayTool({ tool: "wait", from_ids: ["a", "b"] })
		expect(screen.getByText(/chat:mailbox.waitingForSenders/)).toBeInTheDocument()

		sayTool({ tool: "wait", timeout_sec: 45 })
		expect(screen.getByText(/chat:mailbox.waitWithTimeout/)).toBeInTheDocument()
	})
})

describe("ask rows", () => {
	it("renders a command ask through the execution component", () => {
		renderRow({ type: "ask", ask: "command", text: "npm test" })
		expect(screen.getByTestId("command-execution")).toBeInTheDocument()
	})

	it("renders an mcp tool ask", () => {
		renderRow({
			type: "ask",
			ask: "use_mcp_server",
			text: JSON.stringify({ type: "use_mcp_tool", serverName: "files", toolName: "read" }),
		})
		expect(screen.getByTestId("mcp-execution")).toBeInTheDocument()
		expect(screen.getByText("chat:mcp.wantsToUseTool(files)")).toBeInTheDocument()
	})

	it("labels an external LM tool distinctly", () => {
		renderRow({
			type: "ask",
			ask: "use_mcp_server",
			text: JSON.stringify({
				type: "use_mcp_tool",
				serverName: "files",
				toolName: "read",
				external_lm_tool: true,
			}),
		})
		expect(screen.getByText("chat:mcp.wantsToUseExternalTool(read,files)")).toBeInTheDocument()
	})

	it("labels a resource access", () => {
		renderRow({
			type: "ask",
			ask: "use_mcp_server",
			text: JSON.stringify({ type: "access_mcp_resource", serverName: "files", uri: "file:///a" }),
		})
		expect(screen.getByText("chat:mcp.wantsToAccessResource(files)")).toBeInTheDocument()
	})

	it("renders a completion-result ask", () => {
		renderRow({ type: "ask", ask: "completion_result", text: "all done" })
		expect(screen.getByText("chat:taskCompleted")).toBeInTheDocument()
	})

	it("renders a follow-up question with its suggestions", () => {
		renderRow({
			type: "ask",
			ask: "followup",
			text: JSON.stringify({ question: "which one?", suggest: [{ answer: "the first" }] }),
		})
		expect(screen.getByText("chat:questions.hasQuestion")).toBeInTheDocument()
		expect(screen.getByText("which one?")).toBeInTheDocument()
	})

	it("renders the auto-approval limit warning", () => {
		const { container } = renderRow({
			type: "ask",
			ask: "auto_approval_max_req_reached",
			text: JSON.stringify({ count: 20 }),
		})
		expect(container).not.toBeEmptyDOMElement()
	})

	it("renders a mistake-limit row", () => {
		const { container } = renderRow({ type: "ask", ask: "mistake_limit_reached", text: "too many mistakes" })
		expect(container).not.toBeEmptyDOMElement()
	})
})
