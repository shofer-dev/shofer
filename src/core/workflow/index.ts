/**
 * Workflow abstraction — barrel export.
 *
 * The Workflow module provides:
 * - Slang parser (vendored from @riktar/slang, MIT)
 * - WorkflowTask: a Task subclass with a slang-driven loop
 * - .slang file discovery from project and global directories
 */

// Slang parser (upstream vendored)
export { parseWithRecovery, parse, type ParseResult } from "./slang-parser-upstream"
export { tokenize } from "./slang-lexer"
export { analyzeFlow, resolveDeps, detectDeadlocks, type DepGraph, type FlowDiagnostic } from "./slang-resolver"

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
} from "./slang-ast"

// Convenience: parse + validate (our wrapper)
export { parseSlang, validateSlangAST, type SlangAST } from "./slang-parser"

// WorkflowTask
export { WorkflowTask, createWorkflowTask, discoverWorkflows, type WorkflowTaskOptions } from "./WorkflowTask"

// Flow state types (for persistence/runtime)
export {
	type FlowState,
	type AgentState,
	type MailboxEntry,
	serializeFlowState,
	deserializeFlowState,
} from "./slang-types"
