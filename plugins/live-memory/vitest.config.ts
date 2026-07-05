import { fileURLToPath } from "node:url"

import { defineConfig } from "vitest/config"

/**
 * Standalone vitest project for the Live Memory plugin's pure domain-logic unit
 * tests (context-window / question-queue / pricing / memory-store). These sources
 * sit OUTSIDE every extension/package tsc + vitest root (the plugin is transpiled
 * at runtime by the P2 esbuild loader), so they get their own runner here. Vitest
 * transpiles the `.ts` sources directly; `@shofer/types` is aliased to its source
 * `index.ts` (mirroring this plugin's `tsconfig.json` `paths`) since the plugin dir
 * has no `node_modules` of its own. Run with:
 *
 *   pnpm --filter @shofer/core exec vitest run --root plugins/live-memory
 */
export default defineConfig({
	resolve: {
		alias: {
			"@shofer/types": fileURLToPath(new URL("../../packages/types/src/index.ts", import.meta.url)),
		},
	},
	test: {
		globals: false,
		environment: "node",
		watch: false,
		include: ["__tests__/*.spec.ts"],
	},
})
