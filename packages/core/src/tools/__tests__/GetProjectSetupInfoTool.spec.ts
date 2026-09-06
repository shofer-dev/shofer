import { GetProjectSetupInfoTool } from "../GetProjectSetupInfoTool.js"
import {
	makeFakeEditTask,
	makeToolCallbacks,
	makeWorkspace,
	toolResults,
	type FakeWorkspace,
} from "./helpers/fakeEditTask.js"

/**
 * `get_project_setup_info` reads the workspace ROOT's file names and infers
 * languages, build systems, package managers and — from the manifests it can
 * open — frameworks. Everything is inference from real files, so the suite
 * builds real workspaces rather than mocking `readdir`.
 */

let ws: FakeWorkspace

beforeEach(async () => {
	ws = await makeWorkspace("shofer-project-setup-")
})

afterEach(async () => {
	await ws.cleanup()
})

async function analyze(approve = true): Promise<string> {
	const cbs = makeToolCallbacks(approve)
	await new GetProjectSetupInfoTool().execute({}, makeFakeEditTask({ cwd: ws.cwd }), cbs)
	return toolResults(cbs)
}

describe("GetProjectSetupInfoTool", () => {
	it("reports only the workspace root for an empty directory", async () => {
		expect(await analyze()).toBe(`Workspace Root: ${ws.cwd}`)
	})

	it("infers a TypeScript/npm project from its manifests", async () => {
		await ws.write("tsconfig.json", "{}")
		await ws.write("package.json", JSON.stringify({ dependencies: { react: "^18" } }))
		await ws.write("package-lock.json", "{}")

		const out = await analyze()

		expect(out).toContain("Languages: typescript, javascript")
		expect(out).toContain("Frameworks: react")
		expect(out).toContain("Build Systems: npm")
		expect(out).toContain("Package Managers: npm")
		expect(out).toContain("Config Files: tsconfig.json, package.json")
	})

	it("finds a framework declared only as a devDependency", async () => {
		await ws.write("package.json", JSON.stringify({ devDependencies: { next: "^14" } }))

		expect(await analyze()).toContain("Frameworks: nextjs")
	})

	it("infers a Go project and its framework from go.mod", async () => {
		await ws.write("go.mod", "module x\n\nrequire github.com/gin-gonic/gin v1.9.0\n")
		await ws.write("go.sum", "")

		const out = await analyze()

		expect(out).toContain("Languages: go")
		expect(out).toContain("Frameworks: gin")
		expect(out).toContain("Package Managers: go")
	})

	it("survives a package.json that is not valid JSON", async () => {
		await ws.write("package.json", "{ not json")

		const out = await analyze()

		// The language and build system are still inferred from the file's
		// presence; only the dependency-derived frameworks are lost.
		expect(out).toContain("Languages: javascript")
		expect(out).not.toContain("Frameworks:")
	})

	it("ignores glob-shaped indicators, which a plain name lookup cannot match", async () => {
		await ws.write("App.csproj", "")

		expect(await analyze()).not.toContain("csharp")
	})

	it("lists each config file once even when several detectors name it", async () => {
		await ws.write("pyproject.toml", "")

		const out = await analyze()

		expect(out).toContain("Languages: python")
		expect(out).toContain("Build Systems: poetry")
		expect(out.match(/pyproject\.toml/g)).toHaveLength(1)
	})

	it("pushes nothing when the user rejects", async () => {
		expect(await analyze(false)).toBe("")
	})

	it("routes an unreadable workspace through handleError", async () => {
		const cbs = makeToolCallbacks()
		const task = makeFakeEditTask({ cwd: `${ws.cwd}/does-not-exist` })

		await new GetProjectSetupInfoTool().execute({}, task, cbs)

		expect(cbs.handleError).toHaveBeenCalledWith("getting project setup info", expect.any(Error))
	})
})
