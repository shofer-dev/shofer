/**
 * Slang / workflow interpreter stack — barrel export (host-agnostic).
 *
 * The portable Slang parser, resolver, interpreter and flow-state machinery
 * were relocated into `@shofer/core` (Task-cluster A3). `WorkflowTask` itself
 * remains in the `shofer` extension (`src/core/workflow/`) because it depends
 * on vscode-bound providers; it consumes this surface via `@shofer/core`.
 *
 * Slang parser is vendored from @riktar/slang (MIT).
 */

// Slang parser (upstream vendored)
export { parseWithRecovery, parse, type ParseResult } from "./slang-parser-upstream.js"
export { tokenize } from "./slang-lexer.js"
export {
	analyzeFlow,
	resolveDeps,
	detectDeadlocks,
	type DepGraph,
	type FlowDiagnostic,
	type AgentDep,
} from "./slang-resolver.js"

// Slang AST types (upstream)
export type {
	Program,
	FlowDecl,
	AgentDecl,
	Operation,
	StakeOp,
	AwaitOp,
	CommitOp,
	EscalateOp,
	WhenBlock,
	LetOp,
	SetOp,
	RepeatBlock,
	FuncCall,
	Expr,
	ConvergeStmt,
	BudgetStmt,
	BudgetItem,
	Span,
	OutputSchema,
} from "./slang-ast.js"

// Slang AST helpers (value exports)
export {
	exprAsString,
	exprAsNumber,
	exprAsBoolean,
	exprAsStringList,
	exprAsIdent,
	contractToJsonSchema,
} from "./slang-ast.js"

// Convenience: parse + validate (our wrapper)
export { parseSlang, validateSlangAST, type SlangAST } from "./slang-parser.js"

// Unified validate (parse + analyze in one call)
export { validateSlangProgram, type SlangValidationResult } from "./validate-slang.js"

// Slang interpreter (pure control-flow evaluation)
export {
	compileAgentProgram,
	advanceAgent,
	allAgentsCommitted,
	checkConverge,
	committedCount,
	consumeMail,
	evalExpr,
	interpolate,
	routeOutput,
	toBool,
	formatEmittedValue,
	MAX_CONTROL_FLOW_STEPS,
	type AdvanceResult,
	type EmittedMessage,
	type Instr,
	type InterpreterLog,
} from "./slang-interpreter.js"

// Flow state types + helpers (for persistence/runtime)
export {
	type FlowState,
	type AgentState,
	type AgentStatus,
	type FlowStatus,
	type MailboxEntry,
	serializeFlowState,
	deserializeFlowState,
	topologyToMermaid,
} from "./slang-types.js"

// Aggregate-rating policy
export { aggregateRatings, RATING_ORDER } from "./aggregate-rating.js"
