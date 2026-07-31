/**
 * build-ui.mjs — builds the Second Brain plugin's three UI bundles.
 *
 * `ui/badge.tsx` (chat-input-toolbar), `ui/advisory.tsx` (chat-message-addon) and
 * `ui/panel.tsx` (sidebar-panel) compile to their `.js` siblings as ES modules with
 * React externalized — the host's import map resolves those specifiers to the
 * webview's single shared React instance (PLUGINS.md §6). Run automatically by the
 * extension bundle (`src/esbuild.mjs` → buildBundledPluginUis), or by hand:
 *
 *   node plugins/second-brain/build-ui.mjs
 */

import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"

import * as esbuild from "esbuild"

const here = dirname(fileURLToPath(import.meta.url))

for (const name of ["badge", "advisory", "panel"]) {
	await esbuild.build({
		entryPoints: [resolve(here, `ui/${name}.tsx`)],
		outfile: resolve(here, `ui/${name}.js`),
		// Pin the working dir: esbuild derives its banner path from cwd, so without
		// this the bundle differs between a repo-root run and the extension build
		// (which runs from the plugin dir) — and the committed artifact flip-flops.
		absWorkingDir: here,
		bundle: true,
		format: "esm",
		platform: "browser",
		target: "es2020",
		jsx: "automatic",
		external: ["react", "react-dom", "react-dom/client", "react/jsx-runtime", "react/jsx-dev-runtime"],
		legalComments: "none",
	})
	console.log(`[second-brain] built ui/${name}.js`)
}
