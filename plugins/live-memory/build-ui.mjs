/**
 * build-ui.mjs — builds the Live Memory plugin's `sidebar-panel` UI bundle.
 *
 * Compiles `ui/panel.tsx` → `ui/panel.js` as an ES module with `react`,
 * `react-dom`, and `react/jsx-runtime` marked **external** — the host injects an
 * import map so those specifiers resolve to the webview's shared React instance
 * (PLUGINS.md §6, "Shipping your own UI bundle"). The built `panel.js` is committed
 * and shipped as the `contributes.ui` entry.
 *
 * Run from the repo root (esbuild is a workspace dependency):
 *
 *   node plugins/live-memory/build-ui.mjs
 *
 * Equivalent one-liner:
 *
 *   esbuild plugins/live-memory/ui/panel.tsx --bundle --format=esm --jsx=automatic \
 *     --external:react --external:react-dom --external:react/jsx-runtime \
 *     --outfile=plugins/live-memory/ui/panel.js
 */

import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"

import * as esbuild from "esbuild"

const here = dirname(fileURLToPath(import.meta.url))

// Both UI bundles: the `sidebar-panel` chat panel and the `chat-input-toolbar` status
// badge. Same options; React is externalized so each uses the host's single shared
// instance (a second copy silently breaks hooks/context).
for (const name of ["panel", "badge"]) {
	await esbuild.build({
		entryPoints: [resolve(here, `ui/${name}.tsx`)],
		outfile: resolve(here, `ui/${name}.js`),
		bundle: true,
		format: "esm",
		platform: "browser",
		target: "es2020",
		jsx: "automatic",
		external: ["react", "react-dom", "react-dom/client", "react/jsx-runtime", "react/jsx-dev-runtime"],
		legalComments: "none",
	})
	console.log(`[live-memory] built ui/${name}.js`)
}
