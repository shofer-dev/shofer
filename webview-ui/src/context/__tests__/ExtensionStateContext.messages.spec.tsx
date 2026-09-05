// npx vitest src/context/__tests__/ExtensionStateContext.messages.spec.tsx
//
// The host→webview message pump. Each `ExtensionMessage` variant folds into the
// context's state, and several are DELTAS whose ordering and dedupe rules are
// the whole point (streaming appends, prepended history windows, per-item task
// history updates). A variant handled wrongly shows up as a stale or duplicated
// row rather than as an error, so each is asserted here.

import { render, screen, act } from "@/utils/test-utils"

import { ExtensionStateContextProvider, useExtensionState } from "../ExtensionStateContext"

vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))

const { vscode } = await import("@src/utils/vscode")
const postMessage = vi.mocked(vscode.postMessage)
const posted = (type: string) => postMessage.mock.calls.map((c) => c[0]).filter((m: any) => m?.type === type)

/** Renders whatever slice of the context a test names, as JSON. */
const Probe = ({ keys }: { keys: string[] }) => {
	const state = useExtensionState() as unknown as Record<string, unknown>
	return (
		<div>
			{keys.map((key) => (
				<div key={key} data-testid={key}>
					{JSON.stringify(state[key])}
				</div>
			))}
		</div>
	)
}

const renderProbe = (keys: string[]) =>
	render(
		<ExtensionStateContextProvider>
			<Probe keys={keys} />
		</ExtensionStateContextProvider>,
	)

const deliver = (data: Record<string, unknown>) =>
	act(() => {
		window.dispatchEvent(new MessageEvent("message", { data }))
	})

const read = (key: string) => JSON.parse(screen.getByTestId(key).textContent || "null")

const message = (ts: number, text: string) => ({ ts, type: "say", say: "text", text })

beforeEach(() => vi.clearAllMocks())

describe("state pushes", () => {
	it("hydrates from stateInit", () => {
		renderProbe(["version", "soundEnabled"])
		deliver({ type: "stateInit", state: { version: "9.9.9", soundEnabled: true } })
		expect(read("version")).toBe("9.9.9")
		expect(read("soundEnabled")).toBe(true)
	})

	it("applies a single-key configUpdate, and ignores one with no key", () => {
		renderProbe(["soundVolume"])
		deliver({ type: "configUpdate", key: "soundVolume", value: 0.7 })
		expect(read("soundVolume")).toBe(0.7)

		deliver({ type: "configUpdate", value: 0.1 })
		expect(read("soundVolume")).toBe(0.7)
	})

	it("merges a taskStateUpdate bag", () => {
		renderProbe(["currentTaskId"])
		deliver({ type: "taskStateUpdate", taskStateUpdates: { currentTaskId: "t-9" } })
		expect(read("currentTaskId")).toBe("t-9")
	})

	it("tolerates a taskStateUpdate with no payload", () => {
		renderProbe(["currentTaskId"])
		deliver({ type: "taskStateUpdate" })
		expect(read("currentTaskId")).toBeNull()
	})
})

describe("the auto-approve toggle action", () => {
	it("flips the flag and tells the host", () => {
		renderProbe(["autoApprovalEnabled"])

		deliver({ type: "action", action: "toggleAutoApprove" })
		expect(read("autoApprovalEnabled")).toBe(true)
		expect(posted("autoApprovalEnabled")).toEqual([{ type: "autoApprovalEnabled", bool: true }])

		deliver({ type: "action", action: "toggleAutoApprove" })
		expect(read("autoApprovalEnabled")).toBe(false)
	})

	it("ignores any other action", () => {
		renderProbe(["autoApprovalEnabled"])
		deliver({ type: "action", action: "chatButtonClicked" })
		expect(read("autoApprovalEnabled")).toBe(false)
	})
})

describe("streaming deltas", () => {
	it("replaces a message in place on messageUpdated", () => {
		renderProbe(["shoferMessages"])
		deliver({ type: "stateInit", state: { shoferMessages: [message(1, "first"), message(2, "second")] } })

		deliver({ type: "messageUpdated", shoferMessage: message(2, "second, revised") })
		expect(read("shoferMessages")[1].text).toBe("second, revised")
	})

	it("drops — and reports — an update for a message it does not have", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		renderProbe(["shoferMessages"])
		deliver({ type: "stateInit", state: { shoferMessages: [message(1, "first")] } })

		deliver({ type: "messageUpdated", shoferMessage: message(99, "from nowhere") })
		expect(read("shoferMessages")).toHaveLength(1)
		expect(warn).toHaveBeenCalled()
		warn.mockRestore()
	})

	it("appends a new message and de-duplicates a redelivered one", () => {
		renderProbe(["shoferMessages"])
		deliver({ type: "stateInit", state: { shoferMessages: [message(1, "first")] } })

		deliver({ type: "shoferMessageAppended", shoferMessage: message(2, "second") })
		expect(read("shoferMessages")).toHaveLength(2)

		// A reconnection can redeliver an append the state push already carried.
		deliver({ type: "shoferMessageAppended", shoferMessage: message(2, "second, revised") })
		expect(read("shoferMessages")).toHaveLength(2)
		expect(read("shoferMessages")[1].text).toBe("second, revised")
	})

	it("ignores an append with no message", () => {
		renderProbe(["shoferMessages"])
		deliver({ type: "shoferMessageAppended" })
		expect(read("shoferMessages")).toEqual([])
	})

	it("prepends an older window, oldest first, skipping the overlap", () => {
		renderProbe(["shoferMessages"])
		deliver({ type: "stateInit", state: { shoferMessages: [message(3, "third")] } })

		deliver({ type: "shoferMessagesPrepended", shoferMessages: [message(1, "first"), message(2, "second")] })
		expect(read("shoferMessages").map((m: { text: string }) => m.text)).toEqual(["first", "second", "third"])

		// The window overlaps the tail: nothing new to add.
		deliver({ type: "shoferMessagesPrepended", shoferMessages: [message(2, "second")] })
		expect(read("shoferMessages")).toHaveLength(3)
	})

	it("ignores an empty or absent prepend batch", () => {
		renderProbe(["shoferMessages"])
		deliver({ type: "shoferMessagesPrepended", shoferMessages: [] })
		deliver({ type: "shoferMessagesPrepended" })
		expect(read("shoferMessages")).toEqual([])
	})

	it("ignores a prepend for a task the user has navigated away from", () => {
		renderProbe(["shoferMessages"])
		deliver({ type: "stateInit", state: { shoferMessages: [message(3, "third")], currentTaskId: "here" } })

		deliver({ type: "shoferMessagesPrepended", taskId: "elsewhere", shoferMessages: [message(1, "first")] })
		expect(read("shoferMessages")).toHaveLength(1)
	})
})

describe("catalogue pushes", () => {
	it("replaces the simple lists, defaulting an absent payload to empty", () => {
		renderProbe(["mcpServers", "listApiConfigMeta", "vsCodeLmModels", "commands", "filePaths", "openedTabs"])

		deliver({ type: "mcpServers", mcpServers: [{ name: "files" }] })
		deliver({ type: "listApiConfig", listApiConfig: [{ id: "1", name: "one" }] })
		deliver({ type: "vsCodeLmModels", vsCodeLmModels: [{ vendor: "v", family: "f" }] })
		deliver({ type: "commands", commands: [{ name: "deploy" }] })
		deliver({ type: "workspaceUpdated", filePaths: ["a.ts"], openedTabs: [{ path: "a.ts" }] })

		expect(read("mcpServers")).toHaveLength(1)
		expect(read("listApiConfigMeta")).toHaveLength(1)
		expect(read("vsCodeLmModels")).toHaveLength(1)
		expect(read("commands")).toHaveLength(1)
		expect(read("filePaths")).toEqual(["a.ts"])

		deliver({ type: "mcpServers" })
		deliver({ type: "commands" })
		deliver({ type: "workspaceUpdated" })
		expect(read("mcpServers")).toEqual([])
		expect(read("commands")).toEqual([])
		expect(read("filePaths")).toEqual([])
	})

	it("stores the router and plugin catalogues", () => {
		renderProbe(["routerModels", "plugins", "pluginUiContributions"])
		deliver({ type: "routerModels", routerModels: { openrouter: {} } })
		deliver({ type: "plugins", plugins: [{ name: "basics" }] })
		deliver({ type: "pluginUiContributions", pluginUiContributions: [{ pluginName: "basics" }] })

		expect(read("routerModels")).toEqual({ openrouter: {} })
		expect(read("plugins")).toHaveLength(1)
		expect(read("pluginUiContributions")).toHaveLength(1)
	})

	it("stores skills and loaded skills independently", () => {
		renderProbe(["skills", "loadedSkills"])
		deliver({ type: "skills", skills: [{ name: "a" }] })
		expect(read("skills")).toHaveLength(1)

		deliver({ type: "skills", loadedSkills: ["a"] })
		expect(read("skills")).toHaveLength(1)
		expect(read("loadedSkills")).toEqual(["a"])
	})

	it("converts a pushed colour theme", () => {
		renderProbe(["theme"])
		deliver({ type: "theme", text: JSON.stringify({ rules: [{ token: "comment", foreground: "aabbcc" }] }) })
		expect(read("theme")[".hljs-comment"]).toBe("aabbcc")

		deliver({ type: "theme" })
		expect(read("theme")[".hljs-comment"]).toBe("aabbcc")
	})
})

describe("task history deltas", () => {
	const item = (id: string, createdAt: number) => ({ id, ts: createdAt, createdAt, task: id, number: 1 })

	it("replaces the whole list on taskHistoryUpdated", () => {
		renderProbe(["taskHistory"])
		deliver({ type: "taskHistoryUpdated", taskHistory: [item("a", 1)] })
		expect(read("taskHistory")).toHaveLength(1)

		deliver({ type: "taskHistoryUpdated" })
		expect(read("taskHistory")).toHaveLength(1)
	})

	it("inserts, updates and re-sorts a single item, newest first", () => {
		renderProbe(["taskHistory"])
		deliver({ type: "taskHistoryItemUpdated", taskHistoryItem: item("old", 1) })
		deliver({ type: "taskHistoryItemUpdated", taskHistoryItem: item("new", 5) })
		expect(read("taskHistory").map((h: { id: string }) => h.id)).toEqual(["new", "old"])

		deliver({ type: "taskHistoryItemUpdated", taskHistoryItem: { ...item("old", 1), task: "renamed" } })
		expect(read("taskHistory")).toHaveLength(2)
		expect(read("taskHistory").find((h: { id: string }) => h.id === "old").task).toBe("renamed")
	})

	it("keeps the focused item in step when it is the one updated", () => {
		renderProbe(["currentTaskItem"])
		deliver({ type: "stateInit", state: { currentTaskItem: item("a", 1) } })
		deliver({ type: "taskHistoryItemUpdated", taskHistoryItem: { ...item("a", 1), task: "renamed" } })
		expect(read("currentTaskItem").task).toBe("renamed")

		deliver({ type: "taskHistoryItemUpdated", taskHistoryItem: item("b", 2) })
		expect(read("currentTaskItem").id).toBe("a")
	})

	it("ignores an item-update with no item", () => {
		renderProbe(["taskHistory"])
		deliver({ type: "taskHistoryItemUpdated" })
		expect(read("taskHistory")).toEqual([])
	})
})

describe("parallel tasks and their notifications", () => {
	it("stores the parallel task list and the focused id the host names", () => {
		renderProbe(["parallelTasks", "focusedTaskId"])
		deliver({ type: "parallelTasksUpdated", parallelTasks: [{ id: "a" }], focusedTaskId: "a" })
		expect(read("parallelTasks")).toHaveLength(1)
		expect(read("focusedTaskId")).toBe("a")

		deliver({ type: "parallelTasksUpdated" })
		expect(read("parallelTasks")).toHaveLength(1)
	})

	it("keeps one notification per (task, kind) pair", () => {
		renderProbe(["taskNotifications"])
		deliver({
			type: "taskNotification",
			notification: { taskId: "a", type: "needs_input", message: "one", timestamp: 1 },
		})
		deliver({
			type: "taskNotification",
			notification: { taskId: "a", type: "needs_input", message: "two", timestamp: 2 },
		})
		expect(read("taskNotifications")).toHaveLength(1)
		expect(read("taskNotifications")[0].message).toBe("two")

		deliver({
			type: "taskNotification",
			notification: { taskId: "a", type: "completed", message: "done", timestamp: 3 },
		})
		expect(read("taskNotifications")).toHaveLength(2)
	})

	it("ignores a notification message with no notification", () => {
		renderProbe(["taskNotifications"])
		deliver({ type: "taskNotification" })
		expect(read("taskNotifications")).toEqual([])
	})

	it("clears every notification for one task", () => {
		renderProbe(["taskNotifications", "parallelTasks"])
		deliver({
			type: "taskNotification",
			notification: { taskId: "a", type: "needs_input", message: "one", timestamp: 1 },
		})
		deliver({
			type: "taskNotification",
			notification: { taskId: "b", type: "needs_input", message: "two", timestamp: 2 },
		})

		deliver({ type: "taskNotificationCleared", taskId: "a", parallelTasks: [{ id: "b" }] })
		expect(read("taskNotifications")).toHaveLength(1)
		expect(read("taskNotifications")[0].taskId).toBe("b")
		expect(read("parallelTasks")).toHaveLength(1)
	})
})

describe("launch-time host traffic", () => {
	it("announces itself exactly once", () => {
		renderProbe(["version"])
		expect(posted("webviewDidLaunch")).toHaveLength(1)
	})

	it("asks for the VS Code LM catalogue when that provider is selected", () => {
		renderProbe(["version"])
		expect(posted("requestVsCodeLmModels")).toHaveLength(0)

		deliver({ type: "stateInit", state: { apiConfiguration: { apiProvider: "vscode-lm" } } })
		expect(posted("requestVsCodeLmModels")).toHaveLength(1)
	})
})
