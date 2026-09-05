// npx vitest src/vite-plugins/__tests__/sourcemapPlugin.spec.ts
//
// The build-time source-map normalizer. It runs against the real filesystem in
// a build, so `fs` is doubled here: what is under test is which directory it
// picks, which files it touches, and that a corrupt map cannot fail the build.

import fs from "fs"
import path from "path"

import { sourcemapPlugin } from "../sourcemapPlugin"

vi.mock("fs", () => ({
	default: {
		existsSync: vi.fn(),
		readdirSync: vi.fn(),
		readFileSync: vi.fn(),
		writeFileSync: vi.fn(),
	},
}))

const mockFs = vi.mocked(fs)

const run = async () => {
	const plugin = sourcemapPlugin()
	const hook = plugin.closeBundle as { handler: () => Promise<void> }
	await hook.handler()
}

/** The directory the plugin resolves for the given build mode. */
const assetsDirFor = (mode?: string) =>
	path.join(
		mode === "nightly"
			? path.resolve("../apps/vscode-nightly/build/webview-ui/build")
			: path.resolve("../src/webview-ui/build"),
		"assets",
	)

const written = () => mockFs.writeFileSync.mock.calls.map((c) => [String(c[0]), String(c[1])] as const)

let mode: string | undefined

beforeEach(() => {
	vi.clearAllMocks()
	mode = process.env.NODE_ENV
	vi.spyOn(console, "log").mockImplementation(() => {})
	vi.spyOn(console, "warn").mockImplementation(() => {})
	vi.spyOn(console, "error").mockImplementation(() => {})
})

afterEach(() => {
	if (mode === undefined) delete process.env.NODE_ENV
	else process.env.NODE_ENV = mode
	vi.restoreAllMocks()
})

describe("the plugin shape", () => {
	it("declares itself a build-only post hook", () => {
		const plugin = sourcemapPlugin()
		expect(plugin.name).toBe("vite-plugin-sourcemap")
		expect(plugin.apply).toBe("build")
		expect((plugin.closeBundle as { order: string }).order).toBe("post")
	})
})

describe("choosing the output directory", () => {
	it("uses the extension's own build directory by default", async () => {
		process.env.NODE_ENV = "production"
		mockFs.existsSync.mockReturnValue(false)

		await run()
		expect(mockFs.existsSync).toHaveBeenCalledWith(assetsDirFor("production"))
	})

	it("uses the nightly app's build directory under NODE_ENV=nightly", async () => {
		process.env.NODE_ENV = "nightly"
		mockFs.existsSync.mockReturnValue(false)

		await run()
		expect(mockFs.existsSync).toHaveBeenCalledWith(assetsDirFor("nightly"))
	})

	it("warns and stops when there is nothing built", async () => {
		mockFs.existsSync.mockReturnValue(false)
		await run()

		expect(mockFs.readdirSync).not.toHaveBeenCalled()
		expect(mockFs.writeFileSync).not.toHaveBeenCalled()
	})
})

describe("normalizing a map", () => {
	const withAssets = (files: string[], maps: Record<string, unknown>) => {
		mockFs.existsSync.mockImplementation((p) => {
			const s = String(p)
			if (s.endsWith("assets")) return true
			return Object.keys(maps).some((name) => s.endsWith(name))
		})
		mockFs.readdirSync.mockReturnValue(files as never)
		mockFs.readFileSync.mockImplementation((p) => {
			const name = Object.keys(maps).find((n) => String(p).endsWith(n))!
			return JSON.stringify(maps[name]) as never
		})
	}

	it("adds an empty sourceRoot and makes the sources relative", async () => {
		withAssets(["index.js"], { "index.js.map": { sources: ["/src/a.ts", "src/b.ts"], version: 3 } })

		await run()

		const [, body] = written()[0]
		expect(JSON.parse(body)).toMatchObject({ sourceRoot: "", sources: ["src/a.ts", "src/b.ts"] })
	})

	it("leaves a sourceRoot the bundler already set", async () => {
		withAssets(["index.js"], { "index.js.map": { sourceRoot: "webview", sources: [] } })

		await run()
		expect(JSON.parse(written()[0][1]).sourceRoot).toBe("webview")
	})

	it("writes the map back compact", async () => {
		withAssets(["index.js"], { "index.js.map": { sources: [], version: 3 } })

		await run()
		expect(written()[0][1]).not.toContain("\n")
	})

	it("skips a js file with no map beside it", async () => {
		mockFs.existsSync.mockImplementation((p) => String(p).endsWith("assets"))
		mockFs.readdirSync.mockReturnValue(["index.js"] as never)

		await run()
		expect(mockFs.writeFileSync).not.toHaveBeenCalled()
	})

	it("ignores non-js assets entirely", async () => {
		mockFs.existsSync.mockImplementation((p) => String(p).endsWith("assets"))
		mockFs.readdirSync.mockReturnValue(["index.css", "logo.svg"] as never)

		await run()
		expect(mockFs.writeFileSync).not.toHaveBeenCalled()
	})

	it("survives a corrupt map rather than failing the build", async () => {
		mockFs.existsSync.mockReturnValue(true)
		mockFs.readdirSync.mockReturnValue(["index.js"] as never)
		mockFs.readFileSync.mockReturnValue("{ not json" as never)

		await expect(run()).resolves.toBeUndefined()
		expect(mockFs.writeFileSync).not.toHaveBeenCalled()
	})

	it("processes every js file it finds", async () => {
		withAssets(["a.js", "b.js"], { "a.js.map": { sources: [] }, "b.js.map": { sources: [] } })

		await run()
		expect(written()).toHaveLength(2)
	})
})
