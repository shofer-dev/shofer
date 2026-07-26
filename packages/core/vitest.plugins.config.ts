import { fileURLToPath } from "node:url"

import { defineConfig } from "vitest/config"

/**
 * Vitest project for the **bundled plugins** under `plugins/`.
 *
 * Those directories are deliberately outside the pnpm workspace (a plugin is a
 * self-contained package loaded at runtime, not a workspace member), so they have no
 * `node_modules` and cannot host a runnable vitest config of their own — a config
 * file there cannot even resolve `vitest/config`. Running them from here, where the
 * dev dependencies live, is what makes plugin tests runnable at all:
 *
 *   cd packages/core && npx vitest run --config vitest.plugins.config.ts
 *
 * Aliases cover the two specifiers a plugin's sources reach for that only exist in
 * the workspace: the `@shofer/types` SDK surface and the `simple-git` the checkpoints
 * plugin bundles at build time.
 */
export default defineConfig({
	resolve: {
		alias: {
			"@shofer/types": fileURLToPath(new URL("../types/src/index.ts", import.meta.url)),
			"simple-git": fileURLToPath(new URL("./node_modules/simple-git", import.meta.url)),
		},
	},
	test: {
		globals: true,
		environment: "node",
		watch: false,
		root: fileURLToPath(new URL("../../plugins", import.meta.url)),
		include: ["*/__tests__/*.spec.ts"],
		// The checkpoints suite drives real git over temp workspaces.
		testTimeout: 30_000,
		hookTimeout: 30_000,
	},
})
