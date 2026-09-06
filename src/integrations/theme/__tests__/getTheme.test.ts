// npx vitest src/integrations/theme/__tests__/getTheme.test.ts

/**
 * `getTheme` resolves the user's active colour theme into the Monaco form the
 * webview's code blocks need. It has to cope with themes that are contributed by
 * an extension, themes that ship with VS Code (resolved off a name→file table),
 * theme JSON carrying `//` comments (illegal JSON, but VS Code accepts it), and
 * a theme that `include`s another. Every failure path returns `undefined` rather
 * than throwing, because the caller is a state broadcast and a thrown theme
 * would take the whole webview snapshot with it.
 */

const hoisted = vi.hoisted(() => ({
	colorTheme: undefined as string | undefined,
	allExtensions: [] as unknown[],
	files: new Map<string, string>(),
	convertTheme: vi.fn((parsed: Record<string, unknown>) => ({ base: parsed.base ?? "unknown", parsed })),
	logs: [] as unknown[],
}))

vi.mock("vscode", () => ({
	workspace: {
		getConfiguration: () => ({ get: () => hoisted.colorTheme }),
	},
	extensions: {
		get all() {
			return hoisted.allExtensions
		},
		getExtension: () => ({ extensionUri: { fsPath: "/ext" } }),
	},
}))

vi.mock("fs/promises", () => {
	const readFile = async (p: string) => {
		const content = hoisted.files.get(p)
		if (content === undefined) throw new Error(`ENOENT: ${p}`)
		return content
	}
	return { default: { readFile }, readFile }
})

vi.mock("monaco-vscode-textmate-theme-converter/lib/cjs", () => ({
	convertTheme: (parsed: Record<string, unknown>) => hoisted.convertTheme(parsed),
}))

vi.mock("@shofer/core", async (importOriginal) => ({
	...(await importOriginal<typeof import("@shofer/core")>()),
	apiLog: {
		info: (...args: unknown[]) => hoisted.logs.push(args),
		error: (...args: unknown[]) => hoisted.logs.push(args),
		warn: vi.fn(),
		debug: vi.fn(),
	},
}))

import * as path from "path"

import { getTheme, mergeJson } from "../getTheme"

const DEFAULT_THEMES_DIR = path.join("/ext", "integrations", "theme", "default-themes")

beforeEach(() => {
	vi.clearAllMocks()
	hoisted.colorTheme = undefined
	hoisted.allExtensions = []
	hoisted.files = new Map()
	hoisted.logs = []
	hoisted.convertTheme.mockImplementation((parsed: Record<string, unknown>) => ({
		base: parsed.base ?? "unknown",
		parsed,
	}))
})

describe("getTheme", () => {
	it("defaults to 'Default Dark Modern' and loads its bundled file", async () => {
		hoisted.files.set(path.join(DEFAULT_THEMES_DIR, "dark_modern.json"), '{"base":"vs-dark"}')

		const theme = await getTheme()

		expect(theme).toBeDefined()
		expect(theme!.base).toBe("vs-dark")
	})

	it("prefers a theme CONTRIBUTED by an installed extension, matched on its label", async () => {
		hoisted.colorTheme = "Dracula"
		hoisted.allExtensions = [
			{ extensionPath: "/ext/other", packageJSON: {} },
			{
				extensionPath: "/ext/dracula",
				packageJSON: { contributes: { themes: [{ label: "Dracula", path: "themes/dracula.json" }] } },
			},
		]
		hoisted.files.set(path.join("/ext/dracula", "themes/dracula.json"), '{"base":"vs-dark","name":"Dracula"}')

		const theme = await getTheme()

		expect(theme!.parsed).toMatchObject({ name: "Dracula" })
	})

	it("ignores a contributed theme whose label does not match", async () => {
		hoisted.colorTheme = "Default Dark Modern"
		hoisted.allExtensions = [
			{
				extensionPath: "/ext/other",
				packageJSON: { contributes: { themes: [{ label: "Nord", path: "themes/nord.json" }] } },
			},
		]
		hoisted.files.set(path.join(DEFAULT_THEMES_DIR, "dark_modern.json"), '{"base":"vs-dark"}')

		const theme = await getTheme()

		expect(theme!.base).toBe("vs-dark")
	})

	it("strips `//` comment lines, which real VS Code theme files carry", async () => {
		hoisted.colorTheme = "Dark+"
		hoisted.files.set(
			path.join(DEFAULT_THEMES_DIR, "dark_plus.json"),
			'// the default dark theme\n{"base":"vs-dark"}\n  // trailing note',
		)

		await expect(getTheme()).resolves.toMatchObject({ base: "vs-dark" })
	})

	it("merges an `include`d base theme underneath the theme's own keys", async () => {
		hoisted.colorTheme = "Light+"
		hoisted.files.set(
			path.join(DEFAULT_THEMES_DIR, "light_plus.json"),
			'{"include":"light_vs.json","colors":{"a":1}}',
		)
		hoisted.files.set(path.join(DEFAULT_THEMES_DIR, "light_vs.json"), '{"base":"vs","colors":{"b":2}}')

		const theme = await getTheme()

		expect(theme!.parsed).toMatchObject({ base: "vs", colors: { a: 1, b: 2 } })
	})

	it("keeps a converter-supplied base of 'vs' or 'hc-black' verbatim", async () => {
		hoisted.colorTheme = "Dark High Contrast"
		hoisted.files.set(path.join(DEFAULT_THEMES_DIR, "hc_black.json"), '{"base":"hc-black"}')

		await expect(getTheme()).resolves.toMatchObject({ base: "hc-black" })
	})

	it("infers 'vs' for an unrecognised base when the theme NAME says Light", async () => {
		hoisted.colorTheme = "Light (Visual Studio)"
		hoisted.files.set(path.join(DEFAULT_THEMES_DIR, "light_vs.json"), "{}")

		await expect(getTheme()).resolves.toMatchObject({ base: "vs" })
	})

	it("infers 'vs-dark' otherwise", async () => {
		hoisted.colorTheme = "Dark (Visual Studio)"
		hoisted.files.set(path.join(DEFAULT_THEMES_DIR, "dark_vs.json"), "{}")

		await expect(getTheme()).resolves.toMatchObject({ base: "vs-dark" })
	})

	it("returns undefined (never throws) when the theme file cannot be read", async () => {
		hoisted.colorTheme = "Default Dark Modern"

		await expect(getTheme()).resolves.toBeUndefined()
		expect(hoisted.logs).not.toHaveLength(0)
	})

	it("an UNKNOWN theme name parses as an empty theme rather than failing", async () => {
		hoisted.colorTheme = "Some Third-Party Theme Nobody Installed"

		const theme = await getTheme()

		expect(theme).toMatchObject({ parsed: {} })
	})
})

describe("mergeJson", () => {
	it("takes keys absent from the first object", () => {
		expect(mergeJson({ a: 1 }, { b: 2 })).toEqual({ a: 1, b: 2 })
	})

	it("lets the SECOND object win for scalars", () => {
		expect(mergeJson({ a: 1 }, { a: 2 })).toEqual({ a: 2 })
	})

	it("concatenates arrays by default", () => {
		expect(mergeJson({ a: [1] }, { a: [2] })).toEqual({ a: [1, 2] })
	})

	it("uses a merge key to let the second object REPLACE matching array items", () => {
		const first = {
			rules: [
				{ scope: "comment", v: 1 },
				{ scope: "string", v: 1 },
			],
		}
		const second = { rules: [{ scope: "comment", v: 2 }] }

		expect(
			mergeJson(first, second, undefined, {
				rules: (a: { scope: string }, b: { scope: string }) => a.scope === b.scope,
			}),
		).toEqual({
			rules: [
				{ scope: "string", v: 1 },
				{ scope: "comment", v: 2 },
			],
		})
	})

	it("recurses into nested objects", () => {
		expect(mergeJson({ colors: { a: 1, b: 1 } }, { colors: { b: 2 } })).toEqual({ colors: { a: 1, b: 2 } })
	})

	it("'overwrite' replaces wholesale instead of merging", () => {
		expect(mergeJson({ colors: { a: 1 } }, { colors: { b: 2 } }, "overwrite")).toEqual({ colors: { b: 2 } })
	})

	it("does not mutate its first argument", () => {
		const first = { colors: { a: 1 } }
		mergeJson(first, { colors: { b: 2 } })
		expect(first).toEqual({ colors: { a: 1 } })
	})

	it("falls back to a shallow spread when the merge itself throws", () => {
		// The catch handler re-reads `second` (it stringifies it for the log and
		// then spreads it), so a value that throws on EVERY read escapes the
		// guard. This one throws only on the first read, which is what the
		// fallback is actually able to survive.
		let reads = 0
		const exploding = {
			get boom() {
				if (reads++ === 0) throw new Error("nope")
				return 1
			},
		}
		expect(mergeJson({ a: 1 }, exploding as never)).toMatchObject({ a: 1, boom: 1 })
		expect(hoisted.logs).not.toHaveLength(0)
	})
})
