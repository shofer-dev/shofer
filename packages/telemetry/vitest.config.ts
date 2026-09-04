import { defineConfig } from "vitest/config"

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		watch: false,
		coverage: {
			provider: "v8",
			reporter: ["text-summary"],
			// Ratchet floor toward the 90% target: records what a real run
			// achieved and only moves up (enforced by run-all-tests.sh).
			thresholds: { statements: 54.6 },
		},
	},
})
