import {
	ShoferEventName,
	type AskResponse,
	type ServerEvent,
	type ShoferMessage,
	type TaskSnapshot,
} from "@shofer/types"

import { TaskAttachmentManager, type AttachClient, type AttachViewHost } from "../TaskAttachmentManager"

/**
 * The attachment primitive, against a mocked ShoferApi client + event stream. What is
 * being pinned here is the contract a real `shofer serve` host satisfies: backfill
 * the transcript (including an ask raised BEFORE the attach), stream what comes next,
 * round-trip the answer, and leave nothing behind on detach.
 */

const message = (ts: number, text: string): ShoferMessage => ({ ts, type: "say", say: "text", text })
const ask = (ts: number): ShoferMessage => ({ ts, type: "ask", ask: "tool", askId: "a1", text: "{}" })

function makeView(): AttachViewHost & { posts: unknown[]; initStates: number } {
	const view = {
		posts: [] as unknown[],
		initStates: 0,
		async postMessageToWebview(msg: unknown) {
			view.posts.push(msg)
		},
		async postInitState() {
			view.initStates += 1
		},
	}
	return view
}

function makeClient(snapshot: TaskSnapshot | undefined) {
	let emit: (event: ServerEvent) => void = () => {}
	let subscribed = 0
	let unsubscribed = 0
	const answered: AskResponse[] = []
	const sent: string[] = []
	const cancelled: string[] = []
	const client: AttachClient = {
		getTaskSnapshot: vi.fn(async () => snapshot),
		subscribeTask: vi.fn((_taskId: string, listener: (event: ServerEvent) => void) => {
			subscribed += 1
			emit = listener
			return () => {
				unsubscribed += 1
				emit = () => {}
			}
		}),
		sendMessage: vi.fn(async (_taskId: string, text: string) => {
			sent.push(text)
		}),
		cancelTask: vi.fn(async (taskId: string) => {
			cancelled.push(taskId)
		}),
		respondToAsk: vi.fn(async (_taskId: string, response: AskResponse) => {
			answered.push(response)
		}),
	}
	return {
		client,
		answered,
		sent,
		cancelled,
		counts: () => ({ subscribed, unsubscribed }),
		emit: (event: ServerEvent) => emit(event),
	}
}

const snapshotOf = (over: Partial<TaskSnapshot> = {}): TaskSnapshot => ({
	taskId: "t1",
	summary: "do the thing",
	createdAt: 1700,
	state: { lifecycle: "running" },
	messages: [message(1, "hello"), ask(2)],
	outstandingAsk: { ask: "tool", askId: "a1", text: "{}", ts: 2 },
	tokenUsage: { totalTokensIn: 10, totalTokensOut: 4, totalCost: 0.01, contextTokens: 99 },
	...over,
})

describe("TaskAttachmentManager", () => {
	it("backfills the full transcript, including an ask raised before the attach", async () => {
		const manager = new TaskAttachmentManager(() => harness.client)
		const harness = makeClient(snapshotOf())
		const view = makeView()

		const task = await manager.attach(view, { address: "http://host:1", taskId: "t1" })

		expect(task.messages.map((m) => m.ts)).toEqual([1, 2])
		expect(task.messages[1]!.ask).toBe("tool")
		expect(manager.get(view)).toBe(task)
		expect(view.initStates).toBe(1)
	})

	it("renders a synthetic header from the owning host's title and counters", async () => {
		const harness = makeClient(snapshotOf())
		const manager = new TaskAttachmentManager(() => harness.client)
		const view = makeView()

		const task = await manager.attach(view, { address: "http://host:1", taskId: "t1" })
		expect(task.toTaskItem()).toMatchObject({
			id: "t1",
			ts: 1700,
			task: "do the thing",
			tokensIn: 10,
			tokensOut: 4,
			totalCost: 0.01,
			taskState: { lifecycle: "running" },
		})
	})

	it("subscribes BEFORE backfilling and replays what arrived during the fetch", async () => {
		let resolveSnapshot: (s: TaskSnapshot) => void = () => {}
		let emit: (event: ServerEvent) => void = () => {}
		const client: AttachClient = {
			getTaskSnapshot: vi.fn(() => new Promise<TaskSnapshot>((r) => (resolveSnapshot = r))),
			subscribeTask: vi.fn((_id: string, listener: (event: ServerEvent) => void) => {
				emit = listener
				return () => {}
			}),
			sendMessage: vi.fn(async () => {}),
			cancelTask: vi.fn(async () => {}),
			respondToAsk: vi.fn(async () => {}),
		}
		const manager = new TaskAttachmentManager(() => client)
		const view = makeView()

		const attaching = manager.attach(view, { address: "http://host:1", taskId: "t1" })
		// Fired while the snapshot is still in flight — the hole a subscribe-after
		// design would leave.
		emit({
			type: ShoferEventName.Message,
			args: [{ taskId: "t1", action: "created", message: message(3, "mid-flight") }],
		})
		resolveSnapshot(snapshotOf({ messages: [message(1, "hello")], outstandingAsk: undefined }))

		const task = await attaching
		expect(task.messages.map((m) => m.text)).toEqual(["hello", "mid-flight"])
	})

	it("appends and updates streamed messages, mirroring both posts to the webview", async () => {
		const harness = makeClient(snapshotOf({ messages: [], outstandingAsk: undefined }))
		const manager = new TaskAttachmentManager(() => harness.client)
		const view = makeView()
		await manager.attach(view, { address: "http://host:1", taskId: "t1" })

		harness.emit({
			type: ShoferEventName.Message,
			args: [{ taskId: "t1", action: "created", message: message(5, "partial") }],
		})
		harness.emit({
			type: ShoferEventName.Message,
			args: [{ taskId: "t1", action: "updated", message: message(5, "final") }],
		})
		await Promise.resolve()

		expect(manager.get(view)!.messages).toEqual([message(5, "final")])
		expect(view.posts).toEqual([
			{ type: "shoferMessageAppended", shoferMessage: message(5, "partial") },
			{ type: "messageUpdated", shoferMessage: message(5, "final") },
		])
	})

	it("ignores another task's messages on the same stream", async () => {
		const harness = makeClient(snapshotOf({ messages: [], outstandingAsk: undefined }))
		const manager = new TaskAttachmentManager(() => harness.client)
		const view = makeView()
		await manager.attach(view, { address: "http://host:1", taskId: "t1" })

		harness.emit({
			type: ShoferEventName.Message,
			args: [{ taskId: "other", action: "created", message: message(5, "not mine") }],
		})
		await Promise.resolve()
		expect(manager.get(view)!.messages).toEqual([])
	})

	it("tracks lifecycle and token usage off the stream", async () => {
		const harness = makeClient(snapshotOf({ messages: [], outstandingAsk: undefined }))
		const manager = new TaskAttachmentManager(() => harness.client)
		const view = makeView()
		const task = await manager.attach(view, { address: "http://host:1", taskId: "t1" })

		harness.emit({
			type: ShoferEventName.TaskTokenUsageUpdated,
			args: ["t1", { totalTokensIn: 99, totalTokensOut: 1, totalCost: 0.5, contextTokens: 7 }, {}],
		})
		harness.emit({ type: ShoferEventName.TaskCompleted, args: ["t1", {}, {}, { rating: "well" }] })
		await Promise.resolve()

		expect(task.lifecycle).toBe("completed")
		expect(task.toTaskItem()).toMatchObject({ tokensIn: 99, totalCost: 0.5, taskState: { rating: "well" } })
	})

	it("maps an aborted task's reason onto error vs paused", async () => {
		for (const [reason, lifecycle] of [
			["error", "error"],
			["user", "paused"],
		] as const) {
			const harness = makeClient(snapshotOf({ messages: [], outstandingAsk: undefined }))
			const manager = new TaskAttachmentManager(() => harness.client)
			const view = makeView()
			const task = await manager.attach(view, { address: "http://host:1", taskId: "t1" })
			harness.emit({ type: ShoferEventName.TaskAborted, args: ["t1", { reason }] })
			await Promise.resolve()
			expect(task.lifecycle).toBe(lifecycle)
		}
	})

	it("round-trips an ask answer, a follow-up message and a cancel to the owning host", async () => {
		const harness = makeClient(snapshotOf())
		const manager = new TaskAttachmentManager(() => harness.client)
		const view = makeView()
		await manager.attach(view, { address: "http://host:1", taskId: "t1" })

		await manager.respondToAsk(view, { askResponse: "yesButtonClicked", askId: "a1" })
		await manager.sendMessage(view, "carry on")
		await manager.cancelTask(view)

		expect(harness.answered).toEqual([{ askResponse: "yesButtonClicked", askId: "a1" }])
		expect(harness.sent).toEqual(["carry on"])
		expect(harness.cancelled).toEqual(["t1"])
	})

	it("detach tears the connection down; re-attach backfills afresh", async () => {
		const harness = makeClient(snapshotOf())
		const manager = new TaskAttachmentManager(() => harness.client)
		const view = makeView()

		await manager.attach(view, { address: "http://host:1", taskId: "t1" })
		manager.detach(view)
		expect(manager.get(view)).toBeUndefined()
		expect(harness.counts()).toMatchObject({ subscribed: 1, unsubscribed: 1 })

		// Events after detach reach nothing.
		harness.emit({
			type: ShoferEventName.Message,
			args: [{ taskId: "t1", action: "created", message: message(9, "late") }],
		})
		await Promise.resolve()
		expect(manager.get(view)).toBeUndefined()

		const task = await manager.attach(view, { address: "http://host:1", taskId: "t1" })
		expect(task.messages.map((m) => m.ts)).toEqual([1, 2])
		expect(harness.counts()).toMatchObject({ subscribed: 2 })
	})

	it("keeps per-view focus: two views can watch different tasks", async () => {
		const first = makeClient(snapshotOf({ taskId: "t1", messages: [message(1, "one")] }))
		const second = makeClient(snapshotOf({ taskId: "t2", messages: [message(1, "two")] }))
		const manager = new TaskAttachmentManager((target) => (target.taskId === "t1" ? first.client : second.client))
		const sidebar = makeView()
		const tab = makeView()

		await manager.attach(sidebar, { address: "http://host:1", taskId: "t1" })
		await manager.attach(tab, { address: "http://host:2", taskId: "t2" })

		expect(manager.get(sidebar)!.taskId).toBe("t1")
		expect(manager.get(tab)!.taskId).toBe("t2")
		expect(manager.isAttachedTo(sidebar, "t2")).toBe(false)
		expect(manager.isAttachedTo(tab, "t2")).toBe(true)

		manager.detach(sidebar)
		expect(manager.get(tab)!.taskId).toBe("t2")
	})

	it("attaching again in the same view replaces the previous attachment", async () => {
		const first = makeClient(snapshotOf({ taskId: "t1" }))
		const second = makeClient(snapshotOf({ taskId: "t2" }))
		const manager = new TaskAttachmentManager((target) => (target.taskId === "t1" ? first.client : second.client))
		const view = makeView()

		await manager.attach(view, { address: "http://host:1", taskId: "t1" })
		await manager.attach(view, { address: "http://host:1", taskId: "t2" })

		expect(first.counts()).toMatchObject({ unsubscribed: 1 })
		expect(manager.get(view)!.taskId).toBe("t2")
	})

	it("refuses to attach to a task the host does not have, leaving no connection open", async () => {
		const harness = makeClient(undefined)
		const manager = new TaskAttachmentManager(() => harness.client)
		const view = makeView()

		await expect(manager.attach(view, { address: "http://host:1", taskId: "gone" })).rejects.toThrow()
		expect(manager.get(view)).toBeUndefined()
		expect(harness.counts()).toMatchObject({ subscribed: 1, unsubscribed: 1 })
	})

	it("surfaces an unreachable host and closes the stream", async () => {
		// i18n is not initialized under test, so `t()` yields the key — assert on
		// that rather than on English copy that would drift.
		let unsubscribed = 0
		const client: AttachClient = {
			getTaskSnapshot: vi.fn(async () => {
				throw new Error("ECONNREFUSED")
			}),
			subscribeTask: vi.fn(() => () => {
				unsubscribed += 1
			}),
			sendMessage: vi.fn(async () => {}),
			cancelTask: vi.fn(async () => {}),
			respondToAsk: vi.fn(async () => {}),
		}
		const manager = new TaskAttachmentManager(() => client)
		await expect(manager.attach(makeView(), { address: "http://host:1", taskId: "t1" })).rejects.toThrow(
			/attach.errors.unreachable/,
		)
		expect(unsubscribed).toBe(1)
	})

	it("throws rather than silently no-oping when a view drives a task it is not attached to", async () => {
		const manager = new TaskAttachmentManager(() => makeClient(snapshotOf()).client)
		await expect(manager.sendMessage(makeView(), "hi")).rejects.toThrow()
	})
})
