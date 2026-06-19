// npx vitest __tests__/dist_assets.spec.ts

import * as fs from "fs"
import * as path from "path"

describe("dist assets", () => {
	const distPath = path.join(__dirname, "../dist")

	describe("tiktoken", () => {
		// The worker bundle loads it from workers/, and the MAIN extension bundle
		// (src/utils/tiktoken.ts → tiktoken/lite) loads it from the dist root.
		// BOTH must exist or the extension throws "Missing tiktoken_bg.wasm" at
		// activation — guard against the root copy being dropped as "dead weight".
		it("should have tiktoken wasm file in workers dir", () => {
			expect(fs.existsSync(path.join(distPath, "workers", "tiktoken_bg.wasm"))).toBe(true)
		})

		it("should have tiktoken wasm file in dist root (main bundle loads it here)", () => {
			expect(fs.existsSync(path.join(distPath, "tiktoken_bg.wasm"))).toBe(true)
		})
	})

	describe("tree-sitter", () => {
		const treeSitterFiles = [
			"tree-sitter-bash.wasm",
			"tree-sitter-cpp.wasm",
			"tree-sitter-c_sharp.wasm",
			"tree-sitter-css.wasm",
			"tree-sitter-c.wasm",
			"tree-sitter-elisp.wasm",
			"tree-sitter-elixir.wasm",
			"tree-sitter-elm.wasm",
			"tree-sitter-embedded_template.wasm",
			"tree-sitter-go.wasm",
			"tree-sitter-html.wasm",
			"tree-sitter-javascript.wasm",
			"tree-sitter-java.wasm",
			"tree-sitter-json.wasm",
			"tree-sitter-kotlin.wasm",
			"tree-sitter-lua.wasm",
			"tree-sitter-objc.wasm",
			"tree-sitter-ocaml.wasm",
			"tree-sitter-php.wasm",
			"tree-sitter-python.wasm",
			"tree-sitter-ql.wasm",
			"tree-sitter-rescript.wasm",
			"tree-sitter-ruby.wasm",
			"tree-sitter-rust.wasm",
			"tree-sitter-scala.wasm",
			"tree-sitter-solidity.wasm",
			"tree-sitter-swift.wasm",
			"tree-sitter-systemrdl.wasm",
			"tree-sitter-tlaplus.wasm",
			"tree-sitter-toml.wasm",
			"tree-sitter-tsx.wasm",
			"tree-sitter-typescript.wasm",
			"tree-sitter-vue.wasm",
			"tree-sitter.wasm",
			"tree-sitter-yaml.wasm",
			"tree-sitter-zig.wasm",
		]

		test.each(treeSitterFiles)("should have %s file", (filename) => {
			expect(fs.existsSync(path.join(distPath, filename))).toBe(true)
		})
	})

	describe("slang visualization", () => {
		test.each(["slang-render.js", "slang-render.css", "dagre.min.js"])("should have %s file", (filename) => {
			expect(fs.existsSync(path.join(distPath, filename))).toBe(true)
		})
	})
})
