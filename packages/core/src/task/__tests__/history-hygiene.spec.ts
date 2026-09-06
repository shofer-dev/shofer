import * as os from "os"
import * as path from "path"

import type { ProviderSettings } from "@shofer/types"
import { createInMemoryHost, setHost, ShoferEventName, type TaskProviderLike } from "@shofer/types"
import { TelemetryService } from "@shofer/telemetry"

// The same intra-core stubs the other Task specs use: `Task` reaches these by
// relative import, so a barrel mock cannot intercept them.
vi.mock("../../ignore/ShoferIgnoreController.js", () => ({
	ShoferIgnoreController: class {
		validateAccess() {
			return true
		}
		validateCommand() {
			return undefined
		}
		filterPaths(paths: string[]) {
			return paths
		}
		getInstructions() {
			return undefined
		}
		async initialize() {}
		dispose() {}
	},
}))

vi.mock("../../utils/storage.js", async (importOriginal) => ({
	...((await importOriginal()) as Record<string, unknown>),
	getTaskDirectoryPath: vi.fn(async (root: string, taskId: string) => `${root}/tasks/${taskId}`),
	getSettingsDirectoryPath: vi.fn(async (root: string) => `${root}/settings`),
}))

vi.mock("fs/promises", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>
	const stubs = {
		mkdir: vi.fn().mockResolvedValue(undefined),
		writeFile: vi.fn().mockResolvedValue(undefined),
		appendFile: vi.fn().mockResolvedValue(undefined),
		rename: vi.fn().mockResolvedValue(undefined),
		readFile: vi.fn().mockResolvedValue("[]"),
		unlink: vi.fn().mockResolvedValue(undefined),
		rmdir: vi.fn().mockResolvedValue(undefined),
	}
	return { ...actual, ...stubs, default: stubs }
})

import { Task } from "../Task.js"

/**
 * Two pieces of API-history hygiene that run just before a request goes out,
 * plus the small task-scoped surfaces around them.
 *
 * `_cleanupOrphanedToolUses` exists because a STRICT provider answers HTTP 400
 * — not a soft error — when a `tool_use` has no answering `tool_result`, or a
 * `tool_result` answers a `tool_use` that has scrolled out of the window. Both
 * happen for real: a turn interrupted mid-tool-call leaves the first, and a
 * context-window truncation leaves the second. So the fix is asymmetric on
 * purpose: a missing RESULT is SYNTHESIZED (the model must be told the call was
 * interrupted), while an unanchored RESULT is DROPPED (there is nothing it
 * could answer).
 *
 * `buildCleanConversationHistory` decides what reasoning goes back on the wire.
 * Encrypted reasoning is re-sent as its own item; PLAIN-TEXT reasoning is sent
 * only when the model's `preserveReasoning` says so — the Provider
 * Reasoning-Preservation Rule, from the consumer's side.
 */

const BASE_CONFIG: ProviderSettings = {
	apiProvider: "anthropic",
	apiModelId: "claude-3-5-sonnet-20241022",
	apiKey: "test-api-key",
}

let provider: TaskProviderLike

function makeTask(overrides: Partial<ConstructorParameters<typeof Task>[0]> = {}): Task {
	return new Task({
		provider: provider as never,
		apiConfiguration: BASE_CONFIG,
		task: "do a thing",
		startTask: false,
		...overrides,
	} as never)
}

beforeEach(() => {
	vi.clearAllMocks()
	setHost(createInMemoryHost())
	if (!TelemetryService.hasInstance()) {
		TelemetryService.createInstance([])
	}

	provider = {
		context: { globalStorageUri: { fsPath: path.join(os.tmpdir(), "shofer-history-hygiene") } },
		getState: vi.fn().mockResolvedValue({}),
		log: vi.fn(),
		postMessageToWebview: vi.fn().mockResolvedValue(undefined),
		postStateToWebview: vi.fn().mockResolvedValue(undefined),
		postTaskStateUpdate: vi.fn(),
		getCurrentTask: vi.fn().mockReturnValue(undefined),
		getSkillsManager: vi.fn().mockReturnValue(undefined),
		updateTaskHistory: vi.fn().mockResolvedValue([]),
	} as unknown as TaskProviderLike
})

const toolUse = (id: string) => ({ type: "tool_use" as const, id, name: "read_file", input: {} })
const toolResult = (id: string) => ({ type: "tool_result" as const, tool_use_id: id, content: "ok" })

/** Run the private cleanup over `history` and return what it left behind. */
function cleanup(task: Task, history: unknown[]): any[] {
	;(task as never as { apiConversationHistory: unknown[] }).apiConversationHistory = history
	;(task as never as { _cleanupOrphanedToolUses: () => void })._cleanupOrphanedToolUses()
	return (task as never as { apiConversationHistory: any[] }).apiConversationHistory
}

describe("_cleanupOrphanedToolUses — a tool_use with no result", () => {
	it("leaves a well-formed exchange untouched", () => {
		const history = [
			{ role: "assistant", content: [toolUse("c1")] },
			{ role: "user", content: [toolResult("c1")] },
		]

		expect(cleanup(makeTask(), history)).toEqual(history)
	})

	it("synthesizes an interrupted-call result for an unanswered tool_use", () => {
		const cleaned = cleanup(makeTask(), [
			{ role: "assistant", content: [toolUse("c1")] },
			{ role: "user", content: [{ type: "text", text: "never mind" }] },
		])

		expect(cleaned[1]).toEqual({
			role: "user",
			content: [
				{
					type: "tool_result",
					tool_use_id: "c1",
					content: "Tool execution was interrupted before completion.",
				},
			],
		})
		// The original user turn is preserved after the placeholder.
		expect(cleaned[2]).toMatchObject({ role: "user" })
	})

	it("synthesizes one result per unanswered call in a parallel batch", () => {
		const cleaned = cleanup(makeTask(), [
			{ role: "assistant", content: [toolUse("c1"), toolUse("c2"), toolUse("c3")] },
			{ role: "user", content: [toolResult("c2")] },
		])

		const placeholders = cleaned[1].content.map((b: { tool_use_id: string }) => b.tool_use_id)
		expect(placeholders).toEqual(["c1", "c3"])
	})

	it("covers a batch answered across SEVERAL consecutive tool_result turns", () => {
		const history = [
			{ role: "assistant", content: [toolUse("c1"), toolUse("c2")] },
			{ role: "user", content: [toolResult("c1")] },
			{ role: "user", content: [toolResult("c2")] },
		]

		expect(cleanup(makeTask(), history)).toEqual(history)
	})

	it("stops looking at the next ASSISTANT turn, so a later result does not count", () => {
		const cleaned = cleanup(makeTask(), [
			{ role: "assistant", content: [toolUse("c1")] },
			{ role: "assistant", content: [{ type: "text", text: "carrying on" }] },
			{ role: "user", content: [toolResult("c1")] },
		])

		expect(cleaned[1].content[0]).toMatchObject({ type: "tool_result", tool_use_id: "c1" })
	})

	it("ignores an assistant turn that carries no tool calls at all", () => {
		const history = [
			{ role: "assistant", content: [{ type: "text", text: "just talking" }] },
			{ role: "user", content: [{ type: "text", text: "ok" }] },
		]

		expect(cleanup(makeTask(), history)).toEqual(history)
	})

	it("does nothing to an empty history", () => {
		expect(cleanup(makeTask(), [])).toEqual([])
	})
})

describe("_cleanupOrphanedToolUses — a tool_result with no call", () => {
	it("drops a result whose tool_use is nowhere in the window", () => {
		const cleaned = cleanup(makeTask(), [
			{ role: "user", content: [toolResult("scrolled-away"), { type: "text", text: "and this" }] },
		])

		expect(cleaned[0].content).toEqual([{ type: "text", text: "and this" }])
	})

	it("removes the message entirely when nothing but orphans remain", () => {
		const cleaned = cleanup(makeTask(), [
			{ role: "user", content: [toolResult("scrolled-away")] },
			{ role: "assistant", content: [{ type: "text", text: "after" }] },
		])

		expect(cleaned).toEqual([{ role: "assistant", content: [{ type: "text", text: "after" }] }])
	})

	it("keeps a result whose tool_use appeared in an EARLIER assistant turn", () => {
		const history = [
			{ role: "assistant", content: [toolUse("c1")] },
			{ role: "user", content: [toolResult("c1")] },
		]

		expect(cleanup(makeTask(), history)).toEqual(history)
	})

	it("does not let a LATER tool_use anchor an earlier result", () => {
		// The API forbids forward references, so the scan runs BACKWARDS: the
		// leading result is dropped even though the same id is declared later.
		const cleaned = cleanup(makeTask(), [
			{ role: "user", content: [{ type: "text", text: "before" }, toolResult("c1")] },
			{ role: "assistant", content: [toolUse("c1")] },
			{ role: "user", content: [toolResult("c1")] },
		])

		expect(cleaned[0].content).toEqual([{ type: "text", text: "before" }])
		expect(cleaned[2].content).toEqual([toolResult("c1")])
	})
})

describe("buildCleanConversationHistory", () => {
	const build = (task: Task, messages: unknown[]) =>
		(task as never as { buildCleanConversationHistory: (m: unknown[]) => any[] }).buildCleanConversationHistory(
			messages,
		)

	it("re-sends a standalone ENCRYPTED reasoning item and drops a plain-text one", () => {
		const out = build(makeTask(), [
			{ type: "reasoning", encrypted_content: "enc", id: "r1", summary: ["s"] },
			{ type: "reasoning", text: "plain" },
			{ role: "user", content: "hi" },
		])

		expect(out).toEqual([
			{ type: "reasoning", summary: ["s"], encrypted_content: "enc", id: "r1" },
			{ role: "user", content: "hi" },
		])
	})

	it("splits an assistant turn's EMBEDDED encrypted reasoning into its own item", () => {
		const out = build(makeTask(), [
			{
				role: "assistant",
				content: [
					{ type: "reasoning", encrypted_content: "enc", id: "r1" },
					{ type: "text", text: "the answer" },
				],
			},
		])

		expect(out).toEqual([
			{ type: "reasoning", summary: [], encrypted_content: "enc", id: "r1" },
			{ role: "assistant", content: "the answer" },
		])
	})

	it("keeps the remaining blocks as an ARRAY when more than one survives", () => {
		const out = build(makeTask(), [
			{
				role: "assistant",
				content: [{ type: "reasoning", encrypted_content: "enc" }, { type: "text", text: "a" }, toolUse("c1")],
			},
		])

		expect(Array.isArray(out[1].content)).toBe(true)
		expect(out[1].content).toHaveLength(2)
	})

	it("empties an assistant turn whose only block was encrypted reasoning", () => {
		const out = build(makeTask(), [
			{ role: "assistant", content: [{ type: "reasoning", encrypted_content: "enc" }] },
		])

		expect(out[1]).toEqual({ role: "assistant", content: "" })
	})

	it("drops PLAIN-TEXT reasoning for a model that does not preserve it", () => {
		const task = makeTask()
		vi.spyOn(task.api, "getModel").mockReturnValue({ id: "m", info: {} } as never)

		const out = build(task, [
			{
				role: "assistant",
				content: [
					{ type: "reasoning", text: "chain of thought" },
					{ type: "text", text: "the answer" },
				],
			},
		])

		expect(out).toEqual([{ role: "assistant", content: "the answer" }])
	})

	it("KEEPS plain-text reasoning for a model whose info says preserveReasoning", () => {
		const task = makeTask()
		vi.spyOn(task.api, "getModel").mockReturnValue({ id: "m", info: { preserveReasoning: true } } as never)

		const out = build(task, [
			{
				role: "assistant",
				content: [
					{ type: "reasoning", text: "chain of thought" },
					{ type: "text", text: "the answer" },
				],
			},
		])

		expect(out[0].content).toHaveLength(2)
		expect(out[0].content[0]).toMatchObject({ type: "reasoning", text: "chain of thought" })
	})

	it("passes an OpenRouter reasoning_details message through with its details attached", () => {
		const out = build(makeTask(), [
			{ role: "assistant", content: [{ type: "text", text: "answer" }], reasoning_details: [{ type: "x" }] },
		])

		expect(out[0]).toEqual({ role: "assistant", content: "answer", reasoning_details: [{ type: "x" }] })
	})

	it("normalizes a string-content assistant message and skips one with no role", () => {
		const out = build(makeTask(), [{ role: "assistant", content: "plain string" }, { content: "no role at all" }])

		expect(out).toEqual([{ role: "assistant", content: "plain string" }])
	})
})

describe("per-task bookkeeping", () => {
	it("counts tool attempts and failures, and announces a failure with its message", () => {
		const task = makeTask()
		const failed = vi.fn()
		task.on(ShoferEventName.TaskToolFailed, failed)

		task.recordToolUsage("read_file")
		task.recordToolUsage("read_file")
		task.recordToolError("read_file", "ENOENT")
		task.recordToolError("write_to_file")

		expect(task.toolUsage.read_file).toEqual({ attempts: 2, failures: 1 })
		expect(task.toolUsage.write_to_file).toEqual({ attempts: 0, failures: 1 })
		expect(failed).toHaveBeenCalledWith(task.taskId, "read_file", "ENOENT")
		// A failure with no message is counted but not announced.
		expect(failed).toHaveBeenCalledTimes(1)
	})

	it("re-points the working directory and keeps the file tracker in step", () => {
		const task = makeTask()
		const trackerReassign = vi.spyOn(task.fileContextTracker, "reassignCwd")

		task.reassignCwd("/ws/.worktrees/feature")

		expect(task.cwd).toBe("/ws/.worktrees/feature")
		expect(trackerReassign).toHaveBeenCalledWith("/ws/.worktrees/feature")
	})

	it("answers a forwarded question only for the envelope it is parked on", () => {
		const task = makeTask()
		const handle = vi.spyOn(task, "handleWebviewAskResponse").mockImplementation(() => {})

		expect(task.answerForwardedQuestion("env-1", "yes")).toBe(false)

		task.setForwardedQuestion({ envelopeId: "env-1", question: "which one?" })
		expect(task.answerForwardedQuestion("env-2", "yes")).toBe(false)
		expect(task.answerForwardedQuestion("env-1", "the second")).toBe(true)
		expect(handle).toHaveBeenCalledWith("messageResponse", "the second")

		task.clearForwardedQuestion()
		expect(task.answerForwardedQuestion("env-1", "again")).toBe(false)
	})

	it("hands out one MessageManager and keeps it", () => {
		const task = makeTask()

		expect(task.messageManager).toBe(task.messageManager)
	})
})
