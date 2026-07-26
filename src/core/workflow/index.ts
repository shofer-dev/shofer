/**
 * Workflow abstraction — barrel export.
 *
 * The Workflow module provides:
 * - Slang parser (vendored from @riktar/slang, MIT) — relocated to `@shofer/core`
 *   (host-agnostic) and re-exported here so existing consumers of this barrel
 *   keep importing the slang surface unchanged.
 * - WorkflowTask: a Task subclass with a slang-driven loop (vscode-bound, stays here)
 * - .slang file discovery from project and global directories
 */

// Slang parser / AST / interpreter surface (relocated to @shofer/core)
export {
	// parser (upstream vendored)
	parseWithRecovery,
	parse,
	type ParseResult,
	tokenize,
	analyzeFlow,
	resolveDeps,
	detectDeadlocks,
	type DepGraph,
	type FlowDiagnostic,
	// AST types (upstream)
	type Program,
	type FlowDecl,
	type AgentDecl,
	type Operation,
	type StakeOp,
	type AwaitOp,
	type CommitOp,
	type EscalateOp,
	type WhenBlock,
	type LetOp,
	type SetOp,
	type RepeatBlock,
	type FuncCall,
	type Expr,
	type ConvergeStmt,
	type BudgetStmt,
	type BudgetItem,
	type Span,
	// parse + validate wrappers
	parseSlang,
	validateSlangAST,
	type SlangAST,
	validateSlangProgram,
	type SlangValidationResult,
	// flow state types + helpers
	type FlowState,
	type AgentState,
	type MailboxEntry,
	serializeFlowState,
	deserializeFlowState,
} from "@shofer/core"

// WorkflowTask (vscode-bound — stays in the extension)
export { WorkflowTask, createWorkflowTask, discoverWorkflows, type WorkflowTaskOptions } from "./WorkflowTask"
