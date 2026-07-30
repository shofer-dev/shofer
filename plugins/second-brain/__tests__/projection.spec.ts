// Projection goldens — the observation contract is a pure function, so these are
// byte-exact: caps, structure-aware elision, marker text, and (above all) locator
// retention. A locator lost in projection is the observer losing its index into the
// repository.

import {
	harvestLocators,
	looksLikeError,
	projectCommand,
	projectNarration,
	projectSubtaskFinal,
	projectToolCall,
	projectToolError,
	renderObservation,
} from "../src/projection.js"

describe("projectCommand", () => {
	it("keeps a short command whole", () => {
		const { text, locators } = projectCommand("go test ./...")
		expect(text).toBe("go test ./...")
		expect(locators).toEqual([])
	})

	it("elides a heredoc body, keeps the command shape, harvests paths", () => {
		const body = Array.from({ length: 40 }, (_, i) => `line ${i} of services/foo/deployment.yaml`).join("\n")
		const cmd = `kubectl apply -f - <<'YAML'\n${body}\nYAML`
		const { text, locators } = projectCommand(cmd)
		expect(text).toContain("kubectl apply -f - <<YAML")
		expect(text).toContain("lines elided")
		expect(text).toContain("YAML")
		expect(locators).toContain("services/foo/deployment.yaml")
		expect(text.length).toBeLessThan(cmd.length)
	})

	it("caps a long pipeline with an explicit marker and harvests from the cut tail", () => {
		const cmd = `echo start && ${"x".repeat(500)} && cat deploy/overlays/staging/kustomization.yaml`
		const { text, locators } = projectCommand(cmd)
		expect(text).toMatch(/…\[\+\d+ chars\]$/)
		expect(locators).toContain("deploy/overlays/staging/kustomization.yaml")
	})
})

describe("projectToolCall", () => {
	it("write_to_file: path whole, content head + size marker", () => {
		const content = `package health\n${"// filler\n".repeat(100)}`
		const o = projectToolCall("write_to_file", { path: "services/foo/health.go", content })
		expect(o.text).toContain("write_to_file services/foo/health.go")
		expect(o.text).toContain("package health")
		expect(o.text).toMatch(/…\[\+\d+ lines, \d+ chars\]/)
		expect(o.locators).toContain("services/foo/health.go")
	})

	it("apply_diff: path + capped bodies", () => {
		const o = projectToolCall("apply_diff", {
			path: "src/a.ts",
			diff: "x".repeat(600),
		})
		expect(o.text).toContain("apply_diff src/a.ts")
		expect(o.text).toMatch(/…\[\+\d+ lines, \d+ chars\]/)
	})

	it("read_file: locator args kept whole", () => {
		const o = projectToolCall("read_file", { path: "packages/core/src/task/Task.ts" })
		expect(o.text).toContain("packages/core/src/task/Task.ts")
		expect(o.locators).toContain("packages/core/src/task/Task.ts")
	})

	it("new_task: mode + prompt head", () => {
		const o = projectToolCall("new_task", { mode: "code", message: "m".repeat(600) })
		expect(o.text).toContain("new_task (mode: code)")
		expect(o.text).toMatch(/…\[\+200 chars\]/)
	})

	it("unknown tool: locator fields whole, the rest capped", () => {
		const o = projectToolCall("mystery_tool", { path: "a/b/c.txt", blob: "y".repeat(600) })
		expect(o.text).toContain("path: a/b/c.txt")
		expect(o.text).toMatch(/…\[\+200 chars\]/)
	})
})

describe("errors + narration + finals", () => {
	it("error heads keep the locator-bearing first lines", () => {
		const o = projectToolError("execute_command", "services/foo/health.go:12: undefined: Register\nmake: *** error")
		expect(o.kind).toBe("error")
		expect(o.text).toContain("services/foo/health.go:12")
		expect(o.locators).toContain("services/foo/health.go:12")
	})

	it("narration is capped with a marker, never silently", () => {
		const o = projectNarration("n".repeat(5000))
		expect(o.text).toMatch(/…\[\+1000 chars\]$/)
	})

	it("subtask finals carry the child id and a capped verdict", () => {
		const o = projectSubtaskFinal("child-1", "r".repeat(2000))
		expect(o.text).toContain("subtask child-1 concluded:")
		expect(o.text).toMatch(/…\[\+500 chars\]$/)
	})

	it("renderObservation is stable: [HH:MM:SS] kind: text", () => {
		expect(renderObservation({ at: Date.UTC(2026, 0, 1, 13, 41, 7), kind: "user", text: "hello" })).toBe(
			"[13:41:07] user: hello",
		)
	})
})

describe("looksLikeError", () => {
	it("classifies obvious failures", () => {
		expect(looksLikeError("Error: ENOENT no such file")).toBe(true)
		expect(looksLikeError("Command failed with exit code 2")).toBe(true)
		expect(looksLikeError("Traceback (most recent call last):")).toBe(true)
	})
	it("ambiguity resolves to not-an-error", () => {
		expect(looksLikeError("All 371 tests passed")).toBe(false)
		expect(looksLikeError("wrote 12 files")).toBe(false)
	})
})

describe("harvestLocators", () => {
	it("finds path and path:line tokens, deduped and bounded", () => {
		const span = "see services/foo/main.go:88 and deploy/base/config.yaml plus services/foo/main.go:88 again"
		expect(harvestLocators(span)).toEqual(["services/foo/main.go:88", "deploy/base/config.yaml"])
	})
})
