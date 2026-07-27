/**
 * build-ui.mjs — builds the Checkpoints plugin's shipped artifacts.
 *
 * Named `build-ui.mjs` because that is the file the extension bundle looks for and
 * runs per plugin (`src/esbuild.mjs` → `buildBundledPluginUis`), but it builds BOTH
 * halves of this plugin:
 *
 *  1. `ui/row.tsx` → `ui/row.js` — the `chat-message-addon` bundle, ESM with `react`
 *     and `@shofer/plugin-ui` externalized (the host injects an import map so both
 *     resolve to the webview's running instances; a second React copy silently breaks
 *     hooks, and a re-implemented component kit drifts from the product).
 *
 *  2. `src/main.ts` → `main.mjs` — the plugin entry, with `simple-git` **bundled in**.
 *     (`.mjs`, not `.js`: the plugin dir has no `package.json`, so a `.js` bundle makes
 *     Node reparse it as ESM on every load and warn.)
 *     (Sources live under `src/` so the built bundle never shadows them when the
 *     tests import the TypeScript.)
 *     A bundled plugin ships without `node_modules` (the packaging step excludes it),
 *     so an unbundled `import "simple-git"` would either fail to resolve or trigger a
 *     runtime `npm install` on first use. Bundling keeps the plugin a self-contained,
 *     dependency-free unit — which is also what makes it packable to a single
 *     `.shofer-plugin` archive.
 *
 *     `@shofer/types` is type-only in this plugin, so it erases at compile time and
 *     never reaches the bundle.
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
	entryPoints: [resolve(here, "ui/row.tsx")],
	outfile: resolve(here, "ui/row.js"),
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
console.log("[checkpoints] built ui/row.js")

await esbuild.build({
	entryPoints: [resolve(here, "src/main.ts")],
	outfile: resolve(here, "main.mjs"),
	bundle: true,
	format: "esm",
	platform: "node",
	target: "node20",
	// `plugins/` is outside the pnpm workspace, so this directory has no
	// `node_modules`; resolve build-time deps from the workspace that owns them.
	// The bundled `simple-git` is therefore whatever version the repo is on — the
	// plugin has no independent version of its own to drift from.
	nodePaths: [resolve(here, "../../packages/core/node_modules"), resolve(here, "../../node_modules")],
	// Node built-ins stay external — they are provided by the runtime, and bundling
	// them would be both impossible and pointless.
	external: ["node:*", "fs", "fs/promises", "path", "os", "events", "child_process", "util", "stream", "crypto"],
	legalComments: "none",
})
console.log("[checkpoints] built main.mjs (simple-git bundled)")
