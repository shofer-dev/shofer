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
	},
})
