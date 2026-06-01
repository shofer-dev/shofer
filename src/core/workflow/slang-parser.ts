/**
 * Slang parser — public API for Shofer workflow specifications.
 *
 * This module delegates to the vendored upstream parser (@riktar/slang, MIT)
 * and resolver for parsing and static analysis.
 *
 * Files: slang-parser-upstream.ts (lexer + parser), slang-resolver.ts (dependency analysis)
 */

import { parseWithRecovery } from "./slang-parser-upstream"
import { analyzeFlow } from "./slang-resolver"
import type { Program } from "./slang-ast"

export type { Program as SlangAST } from "./slang-ast"

/**
 * Parse a .slang source file and return the AST + errors.
 */
export function parseSlang(source: string): { ast: Program; errors: string[] } {
	const result = parseWithRecovery(source)
	const errors = result.errors.map((e) => `${e.code}: ${e.message} at ${e.line}:${e.column}`)
	return { ast: result.program, errors }
}

/**
 * Validate a slang AST for structural correctness.
 * Returns human-readable warning/error messages.
 */
export function validateSlangAST(program: Program): string[] {
	const warnings: string[] = []
	for (const flow of program.flows) {
		const diags = analyzeFlow(flow)
		for (const d of diags) {
			warnings.push(`[${d.level}] ${d.message}`)
		}
	}
	return warnings
}
