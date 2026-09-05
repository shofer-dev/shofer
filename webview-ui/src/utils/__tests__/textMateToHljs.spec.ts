// npx vitest src/utils/__tests__/textMateToHljs.spec.ts
//
// The VS Code colour theme (a TextMate rule list) is projected onto the hljs
// class names the markdown renderer emits. What matters is the FALLBACK: when
// the host's theme carries no rule we can use, the editor background decides
// whether the light or the dark built-in palette is served.

import { convertTextMateToHljs } from "../textMateToHljs"

/** Drive `fallbackTheme`'s background probe. */
const setEditorBackground = (value: string) => {
	document.body.style.setProperty("--vscode-editor-background", value)
}

beforeEach(() => {
	document.body.style.removeProperty("--vscode-editor-background")
})

describe("convertTextMateToHljs", () => {
	it("maps a matching TextMate scope onto its hljs class", () => {
		const theme = convertTextMateToHljs({
			rules: [
				{ token: "comment", foreground: "aabbcc" },
				{ token: "string", foreground: "ddeeff" },
			],
		})
		expect(theme[".hljs-comment"]).toBe("aabbcc")
		expect(theme[".hljs-string"]).toBe("ddeeff")
	})

	it("takes the first scope in a class's preference order", () => {
		// `.hljs-title.function_` prefers support.function over plain title.
		const theme = convertTextMateToHljs({
			rules: [
				{ token: "title", foreground: "111111" },
				{ token: "support.function", foreground: "222222" },
			],
		})
		expect(theme[".hljs-title.function_"]).toBe("222222")
		expect(theme[".hljs-title"]).toBe("111111")
	})

	it("skips rules missing a token or a foreground", () => {
		const theme = convertTextMateToHljs({
			rules: [{ token: "comment" }, { foreground: "aabbcc" }, { token: "keyword", foreground: "334455" }],
		})
		expect(theme[".hljs-comment"]).toBeUndefined()
		expect(theme[".hljs-keyword"]).toBe("334455")
	})

	it("falls back to the DARK palette against a dark editor background", () => {
		setEditorBackground("#1e1e1e")
		const theme = convertTextMateToHljs({ rules: [] })
		expect(theme[".hljs-comment"]).toBe("#6A9955")
		expect(theme[".hljs-keyword"]).toBe("#569cd6")
	})

	it("falls back to the LIGHT palette against a light editor background", () => {
		setEditorBackground("#ffffff")
		const theme = convertTextMateToHljs({ rules: [] })
		expect(theme[".hljs-comment"]).toBe("#008000")
		expect(theme[".hljs-keyword"]).toBe("#0000ff")
	})

	it("treats a theme with no usable rule as no theme at all", () => {
		setEditorBackground("#ffffff")
		const theme = convertTextMateToHljs({ rules: [{ token: "unknown.scope", foreground: "abcdef" }] })
		expect(theme[".hljs-comment"]).toBe("#008000")
	})

	it("tolerates an absent theme and an absent rules array", () => {
		setEditorBackground("#1e1e1e")
		expect(convertTextMateToHljs(undefined)[".hljs-comment"]).toBe("#6A9955")
		expect(convertTextMateToHljs({})[".hljs-comment"]).toBe("#6A9955")
	})

	it("ignores the alpha channel of an 8-digit background", () => {
		setEditorBackground("#ffffff00")
		expect(convertTextMateToHljs({ rules: [] })[".hljs-comment"]).toBe("#008000")
	})

	it("treats an unparseable background as dark rather than throwing", () => {
		setEditorBackground("not-a-colour")
		expect(() => convertTextMateToHljs({ rules: [] })).not.toThrow()
	})
})
