import { config } from "@shofer/config-eslint/base"

/** @type {import("eslint").Linter.Config} */
export default [
	...config,
	{
		// Test files legitimately use `any` and throwaway args for mocks — mirror the
		// leniency the extension's (src) eslint config already grants its tests.
		files: ["**/__tests__/**", "**/*.spec.ts", "**/*.test.ts"],
		rules: {
			"@typescript-eslint/no-explicit-any": "off",
			"@typescript-eslint/no-unused-vars": "off",
		},
	},
]
