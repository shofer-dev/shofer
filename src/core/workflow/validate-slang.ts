/**
 * Slang program validator — validates a .slang source string for syntax and
 * structural correctness, returning errors and warnings in a single result.
 *
 * This is a thin convenience wrapper around {@link parseSlang} +
 * {@link validateSlangAST} that categorizes diagnostics and adds try/catch
 * guards.  It is the recommended entry point for any code path that needs to
 * check whether a .slang file is valid before executing it or surfacing it
 * in the UI.
 */

import { parseSlang, validateSlangAST } from "./slang-parser"

/**
 * Validation result returned by {@link validateSlangProgram}.
 */
export interface SlangValidationResult {
	/** True when there are no errors (syntax or structural). */
	valid: boolean
	/** Parse-level errors (syntax, lexer). */
	errors: string[]
	/** Structural/analysis-level errors (unknown agent refs, etc.). */
	structuralErrors: string[]
	/** Analysis-level warnings (missing converge, no-commit agents, etc.). */
	warnings: string[]
}

/**
 * Parse and validate a .slang source string.
 *
 * Delegates to {@link parseSlang} for lexing/parsing and
 * {@link validateSlangAST} for structural analysis, then categorizes the
 * diagnostics into errors, structural errors, and warnings.
 *
 * @param source - Raw .slang file contents.
 * @returns A {@link SlangValidationResult} with categorized diagnostics
 *          and a `valid` flag.
 */
export function validateSlangProgram(source: string): SlangValidationResult {
	let ast: ReturnType<typeof parseSlang>["ast"]
	let errors: string[]

	try {
		;({ ast, errors } = parseSlang(source))
	} catch (e) {
		return {
			valid: false,
			errors: [`Parse error: ${e instanceof Error ? e.message : String(e)}`],
			structuralErrors: [],
			warnings: [],
		}
	}

	if (errors.length > 0) {
		return { valid: false, errors, structuralErrors: [], warnings: [] }
	}

	// validateSlangAST returns formatted strings: "[level] message"
	const structuralErrors: string[] = []
	const warnings: string[] = []

	for (const d of validateSlangAST(ast)) {
		if (d.startsWith("[error]")) {
			structuralErrors.push(d.slice(8))
		} else if (d.startsWith("[warning]")) {
			warnings.push(d.slice(10))
		} else {
			warnings.push(d)
		}
	}

	return {
		valid: structuralErrors.length === 0,
		errors,
		structuralErrors,
		warnings,
	}
}
