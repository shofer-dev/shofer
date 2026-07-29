/**
 * build-ui.mjs — builds the RAG Indexing plugin's shipped artifacts.
 *
 * Named `build-ui.mjs` because that is the file the extension bundle runs per plugin
 * (`src/esbuild.mjs` → `buildBundledPluginUis`), but it builds both halves:
 *
 *  1. `src/main.ts` → `main.mjs` — the plugin entry, with **everything bundled in**: the
 *     embedder SDKs (`openai`, the Bedrock client), the Qdrant client, and the pure
 *     helpers the plugin borrows from `@shofer/core` at build time (see
 *     `src/core-shared.ts`). A bundled plugin ships without `node_modules`, so an
 *     unbundled import would fail to resolve at runtime.
 *
 *  2. `ui/settings.tsx` + `ui/status.tsx` → `.js` — the two webview bundles, ESM with
 *     `react` and `@shofer/plugin-ui` external (the host's import map supplies both).
 *
 * **The tree-sitter grammars are NOT bundled, but the `web-tree-sitter` package IS.**
 * The grammars are 62 MB of `.wasm` that ship with the extension already, for
 * `list_code_definition_names`; the plugin borrows them from the host's asset directory
 * rather than shipping a second copy (`src/grammars.ts` finds it,
 * `src/engine/processors/parser.ts` passes it down). The package itself is a different
 * thing — a plain module import that has to resolve when `main.mjs` loads. Marking it
 * external saved none of those 62 MB and made the plugin unloadable: a bundled plugin
 * ships without `node_modules`, so the host reported
 * `Cannot find package 'web-tree-sitter'` and disabled it.
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
	entryPoints: [resolve(here, "src/main.ts")],
	outfile: resolve(here, "main.mjs"),
	bundle: true,
	format: "esm",
	platform: "node",
	target: "node20",
	// `plugins/` is outside the pnpm workspace, so this directory has no `node_modules`;
	// resolve build-time deps from the workspaces that own them. The bundled versions are
	// therefore whatever the repo is on — the plugin has no independent copy to drift.
	nodePaths: [
		resolve(here, "../../packages/core/node_modules"),
		resolve(here, "../../packages/types/node_modules"),
		resolve(here, "../../node_modules"),
	],
	// Node built-ins stay external — the runtime provides them.
	external: [
		"node:*",
		"fs",
		"fs/promises",
		"path",
		"os",
		"events",
		"child_process",
		"util",
		"stream",
		"crypto",
		"http",
		"https",
		"url",
		"zlib",
	],
	// Give the bundle a real `require`. Several bundled dependencies are CJS and call
	// `require("path")` / `require("fs")` at runtime (proper-lockfile is one). In ESM
	// output esbuild routes those through a `__require` shim that throws
	// `Dynamic require of "path" is not supported` — unless a `require` is in scope, which
	// the shim prefers. `createRequire(import.meta.url)` is that scope.
	banner: {
		js: [
			'import { createRequire as __pluginCreateRequire } from "node:module"',
			"const require = __pluginCreateRequire(import.meta.url)",
		].join("\n"),
	},
	loader: { ".json": "json" },
	legalComments: "none",
})
console.log("[rag-indexing] built main.mjs")

for (const entry of ["settings", "status"]) {
	await esbuild.build({
		entryPoints: [resolve(here, `ui/${entry}.tsx`)],
		outfile: resolve(here, `ui/${entry}.js`),
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
			// The host's component kit + translation hook — resolved by the webview's
			// import map to the running instances, exactly like React.
			"@shofer/plugin-ui",
		],
		// This directory's tsconfig maps bare specifiers to the workspace copies so
		// `tsgo -p .` can typecheck standalone; esbuild must not follow those mappings
		// for the browser bundles.
		tsconfigRaw: {},
		legalComments: "none",
	})
	console.log(`[rag-indexing] built ui/${entry}.js`)
}
