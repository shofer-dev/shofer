import os from "node:os"
import path from "node:path"

import { defineConfig } from "vitest/config"

export default defineConfig({
	server: {
		fs: {
			// vite >=6.4.3 applies server.fs.allow to module loading (GHSA-fx2h-pf6j-xcff),
			// and setting `allow` replaces the workspace-root default — so re-add it. The
			// plugin-loader/basics/live-memory suites load plugin code from mkdtemp dirs
			// under the OS tmpdir; in production that import is plain Node `import()` with
			// no vite in the path, so allowing tmpdir here just restores prod behavior.
			allow: [path.resolve(import.meta.dirname, "../.."), os.tmpdir()],
		},
	},
	test: {
		globals: true,
		environment: "node",
		watch: false,
		setupFiles: ["./src/test-setup.ts"],
		// vitest's 5s default is wrong for this package, not for a handful of tests in
		// it: a meaningful share of these 383 files drive a REAL esbuild transpile plus
		// a dynamic import (the suites named above), or compile a tree-sitter wasm
		// grammar. Unloaded each costs 1-2s; with the whole suite saturating the worker
		// pool they routinely cross 5s, and the failure is a bare "Test timed out in
		// 5000ms" on a DIFFERENT test each run — which reads as a regression in whatever
		// was just changed rather than as scheduling noise. A dozen spec files had
		// independently worked around it with per-test `}, 30_000)` overrides; this
		// makes that number the package default so a file doing real work does not
		// have to know to opt in. Per-test overrides LARGER than this (live-memory's
		// 60s cold-esbuild bundle) still apply. A genuinely hung test still fails.
		testTimeout: 30_000,
	},
})
