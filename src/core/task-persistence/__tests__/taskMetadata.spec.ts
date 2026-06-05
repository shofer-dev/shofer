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
})
