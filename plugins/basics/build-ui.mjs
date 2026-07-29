/**
 * build-ui.mjs — builds the Basics plugin's shipped artifacts.
 *
 * Named `build-ui.mjs` because that is the file the extension bundle looks for and
 * runs per plugin (`src/esbuild.mjs` → `buildBundledPluginUis`), but it builds BOTH
 * halves of this plugin:
 *
 *  1. The four UI bundles — `ui/row.tsx` (checkpoints' `chat-message-addon`),
 *     `ui/panel.tsx` (file-changes' `chat-footer`), `ui/indicator.tsx` and
 *     `ui/settings.tsx` (worktrees' `chat-input-toolbar` / `settings-tab`) — ESM with
 *     `react` and `@shofer/plugin-ui` externalized (the host injects an import map so
 *     both resolve to the webview's running instances; a second React copy silently
 *     breaks hooks, and a re-implemented component kit drifts from the product).
 *
 *  2. The vendored dependencies under `src/vendor/` — `diff` (file-changes), and
 *     `simple-git` + `ignore` (checkpoints / worktrees), each pre-bundled to a single
 *     ESM file.
 *
 * Why vendor instead of importing bare? The plugin's entry is TypeScript, so the
 * host's plugin loader bundles it at load time — and it resolves bare imports through
 * the shipped plugin SDK (`dist/plugin-sdk/node_modules`), which contains
 * `@shofer/types` and nothing else. A bare `import "diff"` therefore resolves in this
 * repo and fails in an installed extension. A *relative* import of a pre-bundled copy
 * resolves everywhere, and keeps the plugin free of `node_modules` (which packaging
 * excludes) so it stays packable to a single `.shofer-plugin`.
 *
 * The alternative — pre-bundling `src/main.ts` itself — would also have to inline
 * `@shofer/types`, giving this plugin a second copy of zod; the host validates a
 * tool's `parameters` with its own copy, so that must stay shared.
 *
 * Run from this directory (esbuild is a workspace dependency):
 *
 *   node build-ui.mjs
 */

import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"

import * as esbuild from "esbuild"

const here = dirname(fileURLToPath(import.meta.url))

for (const entry of ["row", "panel", "indicator", "settings"]) {
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
		// This directory's tsconfig maps `@shofer/plugin-ui` to a declaration file so
		// `tsgo -p .` can typecheck the plugin standalone; esbuild must not follow that
		// mapping and try to bundle a `.d.ts`.
		tsconfigRaw: {},
		legalComments: "none",
	})
	console.log(`[basics] built ui/${entry}.js`)
}

/** The vendored packages: entry re-exports of exactly what the features use. */
const VENDORED = {
	diff: `export { createTwoFilesPatch, parsePatch } from "diff"\n`,
	"simple-git": `export { simpleGit } from "simple-git"\n`,
	ignore: `export { default } from "ignore"\n`,
}

for (const [name, contents] of Object.entries(VENDORED)) {
	await esbuild.build({
		stdin: {
			contents,
			resolveDir: here,
			sourcefile: `vendor-${name}-entry.mjs`,
			loader: "js",
		},
		outfile: resolve(here, `src/vendor/${name}.mjs`),
		bundle: true,
		format: "esm",
		platform: "node",
		target: "node20",
		// `plugins/` is outside the pnpm workspace, so this directory has no
		// `node_modules`; resolve each package from the workspace that owns it. The
		// vendored copy is therefore whatever version the repo is on — the plugin has
		// no independent version of its own to drift from.
		nodePaths: [resolve(here, "../../packages/core/node_modules"), resolve(here, "../../node_modules")],
		// Node built-ins stay external — they are provided by the runtime, and bundling
		// them would be both impossible and pointless.
		external: ["node:*", "fs", "fs/promises", "path", "os", "events", "child_process", "util", "stream", "crypto"],
		// This directory's tsconfig maps the vendored packages to their type
		// declarations so `tsgo -p .` can typecheck the plugin standalone; esbuild must
		// not follow those mappings.
		tsconfigRaw: {},
		legalComments: "none",
	})
	console.log(`[basics] built src/vendor/${name}.mjs`)
}
