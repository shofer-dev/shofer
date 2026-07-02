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
			// Parser tests embed source-fixture regexes and match multi-space output
			// literally; these stylistic rules only add noise in that context.
			"no-regex-spaces": "off",
			"no-useless-escape": "off",
		},
	},
]
