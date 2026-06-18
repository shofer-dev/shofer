// npx vitest run core/task-persistence/__tests__/taskMetadata.spec.ts

import * as os from "os"
import * as path from "path"

import type { ShoferMessage } from "@shofer/types"

import { taskMetadata } from "../taskMetadata"

vi.mock("../../../utils/storage", () => ({
	getTaskDirectoryPath: vi.fn(async (base: string, id: string) => path.join(base, "tasks", id)),
}))

/**
 * Regression coverage for the stale-rating bug (todos/stale_rating_bug.md).
 *
 * `taskMetadata` must NOT write `taskState` onto the HistoryItem. That field
 * is owned exclusively by `TaskManager.setState` (Single-Writer Persistence
 * Rule). When `taskMetadata` wrote a static `initialState` snapshot, every
 * metadata save (triggered by any new chat message) clobbered the live
 * lifecycle — reverting a re-activated task's `running` back to a stale
 * `completed:excellent` and surfacing the wrong icon after a restart.
 */
describe("taskMetadata", () => {
	function makeMessages(): ShoferMessage[] {
		return [{ ts: 1_700_000_000_000, type: "say", say: "text", text: "Do the thing" }]
	}

	it("never writes taskState onto the produced HistoryItem", async () => {
		const { historyItem } = await taskMetadata({
			taskId: "task-1",
			taskNumber: 1,
			messages: makeMessages(),
			globalStoragePath: os.tmpdir(),
			workspace: "/tmp/ws",
		})

		expect(historyItem).not.toHaveProperty("taskState")
	})

	it("does not accept an initialState argument (compile + runtime guard)", async () => {
		const { historyItem } = await taskMetadata({
			taskId: "task-2",
			taskNumber: 2,
			messages: makeMessages(),
			globalStoragePath: os.tmpdir(),
			workspace: "/tmp/ws",
			// `initialState` is intentionally not part of TaskMetadataOptions.
			...({ initialState: { lifecycle: "completed", rating: "excellent" } } as Record<string, unknown>),
		})

		expect(historyItem).not.toHaveProperty("taskState")
	})

	/**
	 * Regression coverage for the windowed-cold-load TaskHeader bug.
	 *
	 * On cold-load of a long task, `messages` is only the tail window, so
	 * `messages[0]` is NOT the originating prompt — it's typically an
	 * `api_req_started` whose `.text` is the wire-request JSON blob. Deriving
	 * `task`/`createdAt` from it and persisting via the upsert merge would
	 * clobber the canonical first prompt, which the webview then renders in the
	 * TaskHeader as a low-level JSON object. With `windowedMessages: true` both
	 * fields must be OMITTED (not `undefined`) so the merge preserves them.
	 */
	it("omits task/createdAt when messages is a tail window (windowedMessages)", async () => {
		const windowStart: ShoferMessage = {
			ts: 1_700_000_009_999,
			type: "say",
			say: "api_req_started",
			text: JSON.stringify({ request: "GET /v1/messages", tokensIn: 1234 }),
		}

		const { historyItem } = await taskMetadata({
			taskId: "task-3",
			taskNumber: 3,
			messages: [windowStart],
			globalStoragePath: os.tmpdir(),
			workspace: "/tmp/ws",
			windowedMessages: true,
		})

		// Must be absent (not present-but-undefined) so `{ ...existing, ...item }`
		// preserves the persisted values rather than overwriting them.
		expect(Object.prototype.hasOwnProperty.call(historyItem, "task")).toBe(false)
		expect(Object.prototype.hasOwnProperty.call(historyItem, "createdAt")).toBe(false)
	})

	it("still derives task/createdAt for a full (non-windowed) message array", async () => {
		const { historyItem } = await taskMetadata({
			taskId: "task-4",
			taskNumber: 4,
			messages: makeMessages(),
			globalStoragePath: os.tmpdir(),
			workspace: "/tmp/ws",
		})

		expect(historyItem.task).toBe("Do the thing")
		expect(historyItem.createdAt).toBe(1_700_000_000_000)
	})
})
