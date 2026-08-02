import { fileURLToPath } from "node:url"

import { defineConfig } from "vitest/config"

/**
 * Standalone vitest project for the Second Brain plugin's unit tests (catalogue,
 * digest, fork, gate, llm, observer, advice). These sources sit OUTSIDE every
 * extension/package tsc + vitest root — the plugin is transpiled at runtime by the
 * P2 esbuild loader — so they get their own runner here, and without this file the
 * suite is unrunnable by any committed command. `tsconfig.json` already excludes
 * `vitest.config.ts`, anticipating it.
 *
 * `@shofer/types` is aliased to its source `index.ts` (mirroring this plugin's
 * `tsconfig.json` `paths`) because the plugin dir has no `node_modules` of its own.
 *
 * `globals: true` — unlike the live-memory plugin's runner, every spec here relies
 * on the ambient `describe`/`it`/`expect`/`vi` per the repo-wide convention in
 * AGENTS.md ("do NOT import describe/it/expect/vi from vitest"); none of the seven
 * spec files imports them.
 *
 * Run from the shofer root with:
 *
 *   pnpm --filter @shofer/core exec vitest run --root ../../plugins/second-brain
 *
 * The `--root` is relative to the FILTERED package (`packages/core`), not the repo
 * root — `--root plugins/second-brain` silently resolves to
 * `packages/core/plugins/second-brain` and reports "No test files found". `npx vitest`
 * from this directory does not work either: the plugin has no `node_modules` of its own.
 */
export default defineConfig({
	resolve: {
		alias: {
			"@shofer/types": fileURLToPath(new URL("../../packages/types/src/index.ts", import.meta.url)),
		},
	},
	test: {
		globals: true,
		environment: "node",
		watch: false,
		include: ["__tests__/*.spec.ts"],
	},
})
