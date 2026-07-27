/**
 * build-ui.mjs — builds the File Changes plugin's shipped artifacts.
 *
 * Named `build-ui.mjs` because that is the file the extension bundle looks for and
 * runs per plugin (`src/esbuild.mjs` → `buildBundledPluginUis`), but it builds two
 * things:
 *
 *  1. `ui/panel.tsx` → `ui/panel.js` — the `chat-footer` bundle, ESM with `react` and
 *     `@shofer/plugin-ui` externalized (the host injects an import map so both resolve
 *     to the webview's running instances; a second React copy silently breaks hooks, and
 *     a re-implemented component kit drifts from the product).
 *
 *  2. `src/vendor/diff.mjs` — the `diff` package, pre-bundled.
 *
 * Why vendor `diff` instead of importing it? The plugin's entry is TypeScript, so the
 * host's plugin loader bundles it at load time — and it resolves bare imports through
 * the shipped plugin SDK (`dist/plugin-sdk/node_modules`), which contains
 * `@shofer/types` and nothing else. A bare `import "diff"` therefore resolves in this
 * repo and fails in an installed extension. A *relative* import of a pre-bundled copy
 * resolves everywhere, and keeps the plugin free of `node_modules` (which packaging
 * excludes) so it stays packable to a single `.shofer-plugin`.
 *
 * The alternative — pre-bundling `src/main.ts` itself, as the checkpoints plugin does —
 * would also have to inline `@shofer/types`, giving this plugin a second copy of zod;
 * the host validates a tool's `parameters` with its own copy, so that must stay shared.
 *
 * Run from this directory (esbuild is a workspace dependency):
 *
 *   node build-ui.mjs
 */

import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"

import * as esbuild from "esbuild"

const here = dirname(fileURLToPath(import.meta.url))

await esbuild.build({
	entryPoints: [resolve(here, "ui/panel.tsx")],
	outfile: resolve(here, "ui/panel.js"),
	bundle: true,
	format: "esm",
	platform: "browser",
	target: "es2020",
	jsx: "automatic",
	external: [
		"react",
		"react-dom",
		"react-dom/client",
		"react/jsx-runtime",
		"react/jsx-dev-runtime",
		// The host's component kit + translation hook — resolved by the webview's import
		// map to the running instances, exactly like React.
		"@shofer/plugin-ui",
	],
	legalComments: "none",
})
console.log("[file-changes] built ui/panel.js")

await esbuild.build({
	stdin: {
		contents: `export { createTwoFilesPatch, parsePatch } from "diff"\n`,
		resolveDir: here,
		sourcefile: "vendor-diff-entry.mjs",
		loader: "js",
	},
	outfile: resolve(here, "src/vendor/diff.mjs"),
	bundle: true,
	format: "esm",
	platform: "node",
	target: "node20",
	// `plugins/` is outside the pnpm workspace, so this directory has no
	// `node_modules`; resolve the package from the workspace that owns it. The vendored
	// copy is therefore whatever version the repo is on — the plugin has no
	// independent version of its own to drift from.
	nodePaths: [resolve(here, "../../packages/core/node_modules"), resolve(here, "../../node_modules")],
	// This directory's tsconfig maps `diff` to its @types declaration so `tsgo -p .`
	// can typecheck the plugin standalone; esbuild must not follow that mapping.
	tsconfigRaw: {},
	legalComments: "none",
})
console.log("[file-changes] built src/vendor/diff.mjs")
