import path from "path"
import { defineConfig } from "vitest/config"

export default defineConfig({
	resolve: {
		alias: {
			"@": path.resolve(__dirname, "src"),
		},
	},
	test: {
		globals: true,
		environment: "node",
		watch: false,
		testTimeout: 120_000, // 2m for integration tests.
		include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
		coverage: {
			provider: "v8",
			reporter: ["text-summary"],
			// The CLI is `src/**` — that is what tsup bundles and what ships.
			// `scripts/` holds the integration harness (`scripts/integration/cases/*`
			// are themselves TESTS, driven as subprocesses by scripts/smoke/harness.sh,
			// never imported by a unit test) plus a standalone api test runner, so
			// counting them here would measure the coverage of test code.
			include: ["src/**"],
			// Ratchet floor toward the 90% target: records what a real run
			// achieved and only moves up (enforced by run-all-tests.sh).
			thresholds: { statements: 98.5 },
		},
	},
})
