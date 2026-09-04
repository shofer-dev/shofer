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
			// Ratchet floor toward the 90% target: records what a real run
			// achieved and only moves up (enforced by run-all-tests.sh).
			thresholds: { statements: 28.5 },
		},
	},
})
