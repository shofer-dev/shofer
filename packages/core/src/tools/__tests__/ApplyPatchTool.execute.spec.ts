import { ApplyPatchTool } from "../ApplyPatchTool.js"
import {
	makeFakeEditTask,
	makeToolCallbacks,
	makeWorkspace,
	toolResults,
	withWorkspaceRoot,
	type FakeWorkspace,
} from "./helpers/fakeEditTask.js"

/**
 * `apply_patch` execute() paths — add / delete / update / move, each with its
 * refusal and its rejection.
 *
 * The suite runs against a real mkdtemp workspace so a "saved" assertion is
 * about bytes on disk rather than about a spy having been called: the delete
 * path really unlinks, and the move path really leaves the destination
 * populated and the source gone.
 */

let ws: FakeWorkspace
let restoreHost: () => void

beforeEach(async () => {
	ws = await makeWorkspace("shofer-apply-patch-")
	restoreHost = withWorkspaceRoot(ws.cwd)
})

afterEach(async () => {
	restoreHost()
	await ws.cleanup()
})

const patch = (body: string) => ["*** Begin Patch", body, "*** End Patch"].join("\n")

/**
 * The default provider state leaves the PREVENT_FOCUS_DISRUPTION experiment ON,
 * so the tool saves directly and never opens a diff view. A test that wants the
 * diff-view path (open → update → revert-on-reject) must turn it off explicitly.
 */
const DIFF_VIEW_STATE = { experiments: { preventFocusDisruption: false } }

describe("ApplyPatchTool — argument and parse failures", () => {
	it("reports a missing patch as a usage mistake", async () => {
		const task = makeFakeEditTask({ cwd: ws.cwd })
		const cbs = makeToolCallbacks()

		await new ApplyPatchTool().execute({ patch: "" }, task, cbs)

		expect(task.consecutiveMistakeCount).toBe(1)
		expect(task.recordToolError).toHaveBeenCalledWith("apply_patch")
		expect(toolResults(cbs)).toContain("Missing patch for apply_patch")
	})

	it("names the format problem when the patch does not parse", async () => {
		const task = makeFakeEditTask({ cwd: ws.cwd })
		const cbs = makeToolCallbacks()

		await new ApplyPatchTool().execute({ patch: "not a patch at all" }, task, cbs)

		expect(task.consecutiveMistakeCount).toBe(1)
		expect(toolResults(cbs)).toContain("Invalid patch format")
	})

	it("says so when the patch has boundaries but no file operations", async () => {
		const task = makeFakeEditTask({ cwd: ws.cwd })
		const cbs = makeToolCallbacks()

		await new ApplyPatchTool().execute({ patch: "*** Begin Patch\n*** End Patch" }, task, cbs)

		expect(toolResults(cbs)).toContain("No file operations found in patch.")
	})

	it("reports a hunk that cannot be applied to the file on disk", async () => {
		await ws.write("a.ts", "actual\n")
		const task = makeFakeEditTask({ cwd: ws.cwd })
		const cbs = makeToolCallbacks()

		await new ApplyPatchTool().execute(
			{ patch: patch(["*** Update File: a.ts", "@@", "-nowhere-in-the-file", "+replacement"].join("\n")) },
			task,
			cbs,
		)

		expect(task.consecutiveMistakeCount).toBe(1)
		expect(toolResults(cbs)).toContain("Failed to process patch")
	})
})

describe("ApplyPatchTool — Add File", () => {
	const addPatch = patch(["*** Add File: new/created.ts", "+const a = 1", "+const b = 2"].join("\n"))

	it("creates the file after approval and tracks the edit", async () => {
		const task = makeFakeEditTask({ cwd: ws.cwd })
		const cbs = makeToolCallbacks()

		await new ApplyPatchTool().execute({ patch: addPatch }, task, cbs)

		expect(await ws.read("new/created.ts")).toContain("const a = 1")
		expect(task.didEditFile).toBe(true)
		expect(task.fileContextTracker.trackFileContext).toHaveBeenCalledWith("new/created.ts", "shofer_edited")
		expect(task.recordToolUsage).toHaveBeenCalledWith("apply_patch")
		expect(toolResults(cbs)).toContain("File created.")
	})

	it("writes nothing and reverts the diff view when the user rejects", async () => {
		const task = makeFakeEditTask({ cwd: ws.cwd, state: DIFF_VIEW_STATE })
		const cbs = makeToolCallbacks(false)

		await new ApplyPatchTool().execute({ patch: addPatch }, task, cbs)

		expect(await ws.exists("new/created.ts")).toBe(false)
		expect(task.diffViewProvider.revertChanges).toHaveBeenCalled()
		expect(toolResults(cbs)).toContain("Changes were rejected by the user.")
	})

	it("refuses to add over an existing file and points at Update", async () => {
		await ws.write("new/created.ts", "already here\n")
		const task = makeFakeEditTask({ cwd: ws.cwd })
		const cbs = makeToolCallbacks()

		await new ApplyPatchTool().execute({ patch: addPatch }, task, cbs)

		expect(await ws.read("new/created.ts")).toBe("already here\n")
		expect(toolResults(cbs)).toContain("Use Update File instead")
	})

	it("saves without opening the diff view when focus-disruption prevention is on (the default)", async () => {
		const task = makeFakeEditTask({ cwd: ws.cwd, state: { diagnosticsEnabled: false, writeDelayMs: 0 } })
		const cbs = makeToolCallbacks()

		await new ApplyPatchTool().execute({ patch: addPatch }, task, cbs)

		expect(task.diffViewProvider.open).not.toHaveBeenCalled()
		expect(task.diffViewProvider.saveDirectly).toHaveBeenCalled()
		expect(await ws.read("new/created.ts")).toContain("const b = 2")
	})

	it("opens and updates the diff view when focus-disruption prevention is off", async () => {
		const task = makeFakeEditTask({ cwd: ws.cwd, state: DIFF_VIEW_STATE })
		const cbs = makeToolCallbacks()

		await new ApplyPatchTool().execute({ patch: addPatch }, task, cbs)

		expect(task.diffViewProvider.open).toHaveBeenCalledWith("new/created.ts")
		expect(task.diffViewProvider.scrollToFirstDiff).toHaveBeenCalled()
		expect(task.diffViewProvider.saveChanges).toHaveBeenCalled()
		expect(await ws.read("new/created.ts")).toContain("const a = 1")
	})
})

describe("ApplyPatchTool — Delete File", () => {
	const deletePatch = patch("*** Delete File: gone.ts")

	it("removes the file after approval", async () => {
		await ws.write("gone.ts", "bye\n")
		const task = makeFakeEditTask({ cwd: ws.cwd })
		const cbs = makeToolCallbacks()

		await new ApplyPatchTool().execute({ patch: deletePatch }, task, cbs)

		expect(await ws.exists("gone.ts")).toBe(false)
		expect(task.didEditFile).toBe(true)
		expect(toolResults(cbs)).toContain("Successfully deleted gone.ts")
	})

	it("keeps the file when the user rejects", async () => {
		await ws.write("gone.ts", "bye\n")
		const task = makeFakeEditTask({ cwd: ws.cwd })
		const cbs = makeToolCallbacks(false)

		await new ApplyPatchTool().execute({ patch: deletePatch }, task, cbs)

		expect(await ws.exists("gone.ts")).toBe(true)
		expect(toolResults(cbs)).toContain("Delete operation was rejected by the user.")
	})

	it("refuses to delete a file that is not there", async () => {
		const task = makeFakeEditTask({ cwd: ws.cwd })
		const cbs = makeToolCallbacks()

		await new ApplyPatchTool().execute({ patch: deletePatch }, task, cbs)

		// The absence is caught while the hunks are processed (a Delete hunk
		// reads the file to record its original content), so the model is told
		// the patch could not be processed rather than reaching the tool's own
		// per-file existence check.
		expect(task.consecutiveMistakeCount).toBe(1)
		expect(toolResults(cbs)).toContain("Failed to process patch")
		expect(toolResults(cbs)).toContain("ENOENT")
	})
})

describe("ApplyPatchTool — Update File", () => {
	const updatePatch = patch(["*** Update File: a.ts", "@@", "-const a = 1", "+const a = 2"].join("\n"))

	it("rewrites the file after approval", async () => {
		await ws.write("a.ts", "const a = 1\n")
		const task = makeFakeEditTask({ cwd: ws.cwd })
		const cbs = makeToolCallbacks()

		await new ApplyPatchTool().execute({ patch: updatePatch }, task, cbs)

		expect(await ws.read("a.ts")).toContain("const a = 2")
		expect(task.diffViewProvider.editType).toBe("modify")
		expect(toolResults(cbs)).toContain("File updated.")
	})

	it("refuses to update a file that is not there", async () => {
		const task = makeFakeEditTask({ cwd: ws.cwd })
		const cbs = makeToolCallbacks()

		await new ApplyPatchTool().execute({ patch: updatePatch }, task, cbs)

		expect(task.consecutiveMistakeCount).toBe(1)
		expect(toolResults(cbs)).toContain("Failed to process patch")
	})

	it("reports a no-op patch instead of writing an identical file", async () => {
		await ws.write("a.ts", "const a = 1\n")
		const task = makeFakeEditTask({ cwd: ws.cwd })
		const cbs = makeToolCallbacks()

		await new ApplyPatchTool().execute(
			{ patch: patch(["*** Update File: a.ts", "@@", "-const a = 1", "+const a = 1"].join("\n")) },
			task,
			cbs,
		)

		expect(toolResults(cbs)).toContain("No changes needed for 'a.ts'")
		expect(task.diffViewProvider.saveDirectly).not.toHaveBeenCalled()
	})

	it("leaves the file alone when the user rejects", async () => {
		await ws.write("a.ts", "const a = 1\n")
		const task = makeFakeEditTask({ cwd: ws.cwd, state: DIFF_VIEW_STATE })
		const cbs = makeToolCallbacks(false)

		await new ApplyPatchTool().execute({ patch: updatePatch }, task, cbs)

		expect(await ws.read("a.ts")).toBe("const a = 1\n")
		expect(toolResults(cbs)).toContain("Changes were rejected by the user.")
	})

	it("moves the file when the hunk carries a Move to", async () => {
		await ws.write("a.ts", "const a = 1\n")
		const task = makeFakeEditTask({ cwd: ws.cwd, state: DIFF_VIEW_STATE })
		const cbs = makeToolCallbacks()

		await new ApplyPatchTool().execute(
			{
				patch: patch(
					["*** Update File: a.ts", "*** Move to: sub/b.ts", "@@", "-const a = 1", "+const a = 2"].join("\n"),
				),
			},
			task,
			cbs,
		)

		expect(await ws.exists("a.ts")).toBe(false)
		expect(await ws.read("sub/b.ts")).toContain("const a = 2")
		expect(task.fileContextTracker.trackFileContext).toHaveBeenCalledWith("sub/b.ts", "shofer_edited")
	})

	it("refuses a move whose destination is write-protected", async () => {
		await ws.write("a.ts", "const a = 1\n")
		const task = makeFakeEditTask({ cwd: ws.cwd })
		// Only the move destination is protected — the source must stay editable
		// or the update would be refused before the move is even considered.
		task.shoferProtectedController.isWriteProtected = vi.fn((p: string) => p === "sub/b.ts")
		const cbs = makeToolCallbacks()

		await new ApplyPatchTool().execute(
			{
				patch: patch(
					["*** Update File: a.ts", "*** Move to: sub/b.ts", "@@", "-const a = 1", "+const a = 2"].join("\n"),
				),
			},
			task,
			cbs,
		)

		expect(await ws.exists("sub/b.ts")).toBe(false)
		expect(toolResults(cbs)).toContain("Cannot move file to write-protected path")
	})
})

describe("ApplyPatchTool — access control", () => {
	it("refuses any change to a .shoferignore'd path before touching disk", async () => {
		await ws.write("secret.ts", "const a = 1\n")
		const task = makeFakeEditTask({ cwd: ws.cwd, accessAllowed: false })
		const cbs = makeToolCallbacks()

		await new ApplyPatchTool().execute(
			{ patch: patch(["*** Update File: secret.ts", "@@", "-const a = 1", "+const a = 2"].join("\n")) },
			task,
			cbs,
		)

		expect(await ws.read("secret.ts")).toBe("const a = 1\n")
		expect(task.say).toHaveBeenCalledWith("shoferignore_error", "secret.ts")
		expect(cbs.askApproval).not.toHaveBeenCalled()
	})

	it("marks the approval as protected when the target is a protected path", async () => {
		await ws.write("a.ts", "const a = 1\n")
		const task = makeFakeEditTask({ cwd: ws.cwd, writeProtected: true })
		const cbs = makeToolCallbacks()

		await new ApplyPatchTool().execute(
			{ patch: patch(["*** Update File: a.ts", "@@", "-const a = 1", "+const a = 2"].join("\n")) },
			task,
			cbs,
		)

		// The 4th argument of askApproval is the protected flag the UI renders.
		expect(cbs.askApproval).toHaveBeenCalledWith("tool", expect.any(String), undefined, true)
	})
})
