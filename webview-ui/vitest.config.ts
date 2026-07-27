import { defineConfig } from "vitest/config"
import path from "path"
import { resolveVerbosity } from "../src/utils/vitest-verbosity"

const { silent, reporters, onConsoleLog } = resolveVerbosity()

export default defineConfig({
	test: {
		globals: true,
		setupFiles: ["./vitest.setup.ts"],
		watch: false,
		reporters,
		silent,
		environment: "jsdom",
		include: ["src/**/*.spec.ts", "src/**/*.spec.tsx"],
		onConsoleLog,
	},
	resolve: {
		alias: {
			"@": path.resolve(__dirname, "./src"),
			"@src": path.resolve(__dirname, "./src"),
			"@shofer/core": path.resolve(__dirname, "../packages/core/src"),
			"@shofer/shared": path.resolve(__dirname, "../src/shared"),
			"@shofer/types": path.resolve(__dirname, "../packages/types/src"),
			// A plugin's UI imports the kit as a bare specifier, which the webview resolves
			// at runtime through its import map; this is the test-time equivalent, so a
			// plugin's component can be rendered in a spec.
			"@shofer/plugin-ui": path.resolve(__dirname, "./src/plugin-ui/index.ts"),
			"@shofer": path.resolve(__dirname, "../src/shared"),
			// Mock the vscode module for tests since it's not available outside
			// VS Code extension context.
			vscode: path.resolve(__dirname, "./src/__mocks__/vscode.ts"),
		},
	},
})
