/**
 * build-ui.mjs — builds the Worktrees plugin's shipped UI bundles.
 *
 * Two entries, because the plugin renders in two regions: the branch chip in the chat
 * input (`ui/indicator.tsx`) and the management panel in Settings (`ui/settings.tsx`).
 * Both are ESM with `react` and `@shofer/plugin-ui` externalized — the host injects an
 * import map so each resolves to the webview's running instance; a second React copy
 * silently breaks hooks, and a re-implemented component kit drifts from the product.
 *
 * The extension half (`src/main.ts`) is NOT bundled here: it imports only Node built-ins
 * and its own sources, so the host loads the TypeScript entry directly, as `plugin.json`
 * declares.
 *
 * Run from this directory (esbuild is a workspace dependency):
 *
 *   node build-ui.mjs
 */

import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"

import * as esbuild from "esbuild"

const here = dirname(fileURLToPath(import.meta.url))

for (const entry of ["indicator", "settings"]) {
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
	console.log(`[worktrees] built ui/${entry}.js`)
}
