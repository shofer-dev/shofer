import { coverageConfigDefaults, defineConfig } from "vitest/config"
import os from "os"
import path from "path"
import { resolveVerbosity } from "./utils/vitest-verbosity"

const { silent, reporters, onConsoleLog } = resolveVerbosity()

/**
 * Worker concurrency cap. Vitest defaults to one worker per CPU core, which can
 * saturate memory/CPU on developer laptops. Default to half the available cores
 * (at least one) so local runs stay responsive; CI or power users can override
 * with VITEST_MAX_WORKERS to restore full parallelism.
 */
const maxWorkers = Number(process.env.VITEST_MAX_WORKERS) || Math.max(1, Math.floor(os.cpus().length / 2))

export default defineConfig({
	test: {
		globals: true,
		setupFiles: ["./vitest.setup.ts"],
		watch: false,
		reporters,
		silent,
		testTimeout: 20_000,
		hookTimeout: 20_000,
		onConsoleLog,
		maxWorkers,
		minWorkers: 1,
		coverage: {
			provider: "v8",
			reporter: ["text-summary"],
			// What is NOT source here. `src/webview-ui/` is the webview's BUILT
			// bundle copied in at package time — it is gitignored (see
			// `src/.gitignore`), its sources live in the sibling `webview-ui/`
			// package and are measured by that package's own suite, and the
			// minified artifact contributed 8.2k statements (30% of the whole
			// denominator) that no host test can ever execute. `esbuild.mjs` is
			// the build script and `__mocks__/` are test doubles.
			// `coverageConfigDefaults.exclude` must be spread back in: setting
			// `exclude` REPLACES vitest's defaults rather than adding to them,
			// so omitting it would pull node_modules and the tests themselves
			// into the denominator.
			exclude: [
				...coverageConfigDefaults.exclude,
				"webview-ui/**",
				"esbuild.mjs",
				"__mocks__/**",
				"utils/vitest-verbosity.ts",
			],
			// Ratchet floor: records what a real run achieved and only moves up
			// (enforced by run-all-tests.sh). A measured 90.08% is recorded at
			// 89.5 so ordinary churn cannot fail the gate on a rounding edge.
			thresholds: { statements: 89.5 },
		},
	},
	resolve: {
		alias: {
			vscode: path.resolve(__dirname, "./__mocks__/vscode.js"),
		},
	},
})
