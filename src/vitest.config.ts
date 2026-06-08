import { defineConfig } from "vitest/config"
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
	},
	resolve: {
		alias: {
			vscode: path.resolve(__dirname, "./__mocks__/vscode.js"),
		},
	},
})
