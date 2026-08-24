// pnpm --filter shofer test integrations/misc/__tests__/export-json.spec.ts

import { describe, it, expect, vi } from "vitest"

import { buildJsonTrace, buildJsonTraceTree, type JsonExportTrace } from "../export-json"

describe("buildJsonTrace", () => {
	it("includes the display title when provided, and omits it otherwise", () => {
		const withTitle = buildJsonTrace("t-1", "fix the bug in auth", "code", "2026-06-13T00:00:00.000Z", [], [], {
			title: "Fix auth bug",
		})
		expect(withTitle.title).toBe("Fix auth bug")
		// `task` (full description) remains distinct from the curated `title`.
		expect(withTitle.task).toBe("fix the bug in auth")

		const noTitle = buildJsonTrace("t-2", "untitled work", "code", "2026-06-13T00:00:00.000Z", [], [])
		expect(noTitle.title).toBeUndefined()
		expect("title" in noTitle).toBe(false)
	})
})

describe("buildJsonTraceTree — recursive sub-task export", () => {
	// A node-loader backed by a fixture map of id -> { children }.
	const makeLoader = (graph: Record<string, string[]>) =>
		vi.fn(async (id: string) => {
			if (!(id in graph)) throw new Error(`no such task ${id}`)
			const trace = buildJsonTrace(id, `task ${id}`, "code", "2026-06-13T00:00:00.000Z", [], [])
			return { trace, childIds: graph[id] }
		})

	it("nests each spawned sub-task's trace under the parent, in childIds order", async () => {
		// root wf -> children a, b ; a -> grandchild a1
		const loader = makeLoader({ wf: ["a", "b"], a: ["a1"], b: [], a1: [] })
		const tree = await buildJsonTraceTree("wf", loader)

		expect(tree.taskId).toBe("wf")
		expect(tree.subtasks?.map((t) => t.taskId)).toEqual(["a", "b"])
		// Recurses: agent a carries its own grandchild trace.
		const a = tree.subtasks![0]
		expect(a.subtasks?.map((t) => t.taskId)).toEqual(["a1"])
		// Leaf nodes have no subtasks field at all.
		expect(tree.subtasks![1].subtasks).toBeUndefined()
		expect(a.subtasks![0].subtasks).toBeUndefined()
	})

	it("guards against cycles / duplicate childIds without infinite recursion", async () => {
		// wf -> a -> wf (cycle), and wf lists `a` twice.
		const loader = makeLoader({ wf: ["a", "a"], a: ["wf"] })
		const tree = await buildJsonTraceTree("wf", loader)

		// `a` is included once; the back-edge to wf is dropped (already visited).
		expect(tree.subtasks?.map((t) => t.taskId)).toEqual(["a"])
		expect(tree.subtasks![0].subtasks).toBeUndefined()
	})

	it("skips an unreadable sub-task via onSkip and still exports the rest", async () => {
		const loader = makeLoader({ wf: ["good", "missing"], good: [] })
		const onSkip = vi.fn()
		const tree = await buildJsonTraceTree("wf", loader, { onSkip })

		expect(tree.subtasks?.map((t) => t.taskId)).toEqual(["good"])
		expect(onSkip).toHaveBeenCalledTimes(1)
		expect(onSkip.mock.calls[0][0]).toBe("missing")
		expect((onSkip.mock.calls[0][1] as Error).message).toContain("missing")
	})

	it("omits subtasks entirely for a childless task", async () => {
		const loader = makeLoader({ solo: [] })
		const tree = await buildJsonTraceTree("solo", loader)
		expect(tree.subtasks).toBeUndefined()
	})

	it("reports progress with a running count for each exported node", async () => {
		const loader = makeLoader({ wf: ["a", "b"], a: ["a1"], b: [], a1: [] })
		const onProgress = vi.fn()
		await buildJsonTraceTree("wf", loader, { onProgress })

		// One report per node (wf, a, a1, b) with a monotonically increasing count.
		expect(onProgress).toHaveBeenCalledTimes(4)
		expect(onProgress.mock.calls.map((c) => c[1])).toEqual([1, 2, 3, 4])
	})

	it("stops descending when isCancelled flips, returning the partial tree", async () => {
		const loader = makeLoader({ wf: ["a", "b"], a: [], b: [] })
		// Cancel right after the root is loaded so no children are visited.
		let loaded = 0
		const tree = await buildJsonTraceTree("wf", loader, {
			onProgress: () => {
				loaded++
			},
			isCancelled: () => loaded >= 1,
		})

		expect(tree.taskId).toBe("wf")
		expect(tree.subtasks).toBeUndefined()
		// Only the root was loaded; children were never read.
		expect(loader).toHaveBeenCalledTimes(1)
	})
})
