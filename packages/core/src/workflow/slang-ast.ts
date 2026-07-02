/**
 * Slang AST types — vendored from @riktar/slang (MIT).
 * Source: https://github.com/riktar/slang/blob/master/src/ast.ts
 *
 * These are the canonical AST node types produced by the upstream parser.
 * The adapter layer (slang-parser.ts) maps these to our Shofer-specific
 * flow types (FlowState, AgentState, etc.).
 */

// ─── Base ───

export interface Position {
	line: number
	column: number
	offset: number
}

export interface Span {
	start: Position
	end: Position
}

interface BaseNode {
	span: Span
}

// ─── Top Level ───

export interface Program extends BaseNode {
	type: "Program"
	flows: FlowDecl[]
}

export interface FlowDecl extends BaseNode {
	type: "FlowDecl"
	name: string
	/** Optional typed parameters: `flow "name" (param: "type") { ... }` */
	params?: FlowParam[]
	body: FlowBodyItem[]
	/** Optional UI title for the workflow. Distinct from `name` (the machine identifier). */
	title?: string
	/** Optional markdown description of the workflow. Multiline; rendered in the UI. */
	description?: string
	/** Optional icon key for the workflow (e.g. "rocket", "gear", "search"). Rendered in UI. */
	icon?: string
}

export interface FlowParam {
	name: string
	/** Advisory type annotation ("string" | "number" | "boolean"), not enforced at runtime */
	paramType: string
	/** Optional markdown description of this input variable. Multiline; rendered in the UI. */
	description?: string
	/**
	 * Presentation metadata, merged from the param's `param <name> { ... }` block.
	 * These drive the input widget rendered in the workflow param form:
	 *   - `options` present            → dropdown (single-select) by default
	 *   - `options` + widget "radio"   → radio group (single-select)
	 *   - `options` + widget "checkbox"→ checkbox group (multi-select; value is an array)
	 *   - number with `min` and `max`  → slider (`step` optional)
	 *   - plain string (no options)    → multiline, resizable textarea
	 */
	widget?: "dropdown" | "radio" | "checkbox"
	/** Fixed set of allowed values for dropdown/radio/checkbox widgets. */
	options?: string[]
	/** Slider bounds / step for a `number` param (min+max → slider). */
	min?: number
	max?: number
	step?: number
	/** Default value used when the field is left blank. Array for multi-select. */
	default?: string | number | boolean | string[]
}

export type FlowBodyItem = ImportStmt | AgentDecl | ConvergeStmt | BudgetStmt | DeliverStmt | ExpectStmt | ParamMetaDecl

/** Metadata for a flow parameter — defined inside the flow body via `param <name> { ... }`. */
export interface ParamMetaDecl extends BaseNode {
	type: "ParamMetaDecl"
	name: string
	description?: string
	/** Presentation metadata (merged onto the matching FlowParam). See FlowParam. */
	widget?: "dropdown" | "radio" | "checkbox"
	options?: string[]
	min?: number
	max?: number
	step?: number
	default?: string | number | boolean | string[]
}

// ─── Import ───

export interface ImportStmt extends BaseNode {
	type: "ImportStmt"
	path: string
	alias: string
}

// ─── Agent ───

export interface AgentDecl extends BaseNode {
	type: "AgentDecl"
	name: string
	meta: AgentMeta
	operations: Operation[]
}

export interface AgentMeta {
	role?: string
	/**
	 * Slang key `api_configuration:` — selects the agent Task's API-configuration
	 * profile by name. The legacy key `model:` is a deprecated alias that parses
	 * into this same field.
	 */
	apiConfiguration?: string
	tools?: string[]
	retry?: number
	/**
	 * Slang `context { ... }` block — controls ambient project context injected
	 * into the agent Task's system prompt. Each key is a boolean toggle for a
	 * specific system-prompt component. Unknown keys are ignored
	 * (forward-compatible).
	 *
	 * Supported keys:
	 *   - `include_agents_md`       — AGENTS.md / AGENT.md rules injection
	 *   - `include_subfolder_rules` — recursive .shofer/rules/ scanning
	 *   - `include_mode_rules`      — .shofer/rules-{mode}/ loading
	 *   - `include_user_rules`      — .shofer/rules/ loading (non-mode)
	 *   - `include_skills`          — skills listing section
	 *   - `require_todos`           — TODO enforcement
	 *   - `include_system_info`     — OS/shell/workspace info section
	 *   - `include_mcp`             — MCP tools in capabilities
	 *
	 * Absent keys inherit the global default for that component.
	 */
	context?: Record<string, boolean>
	/** Agent names (from @refs) this agent may send_message_to_task to directly.
	 *  Wildcards / external sinks are excluded. Absent ⇒ no sibling grant
	 *  (parent + own children only, per least-privilege). */
	peers?: string[]
}

// ─── Operations ───

export type Operation =
	| StakeOp
	| AwaitOp
	| CommitOp
	| EscalateOp
	| LogOp
	| ErrorOp
	| WhenBlock
	| LetOp
	| SetOp
	| RepeatBlock

export interface StakeOp extends BaseNode {
	type: "StakeOp"
	call: FuncCall
	recipients: Recipient[]
	condition?: Expr
	output?: OutputSchema
	binding?: string
	/**
	 * Optional per-stake wall-clock timeout in **seconds** (`timeout(N)`). When the
	 * agent does not produce a result within N seconds of dispatch, the attempt is
	 * abandoned and counts as a failed try (subject to `retries`). Absent ⇒ no
	 * per-stake cap — the wait is bounded only by the flow's `time(N)` budget.
	 */
	timeout?: number
	/**
	 * Optional max re-attempts for this stake (`retries(N)`) on a failed try —
	 * output-contract validation failure or a `timeout(N)` expiry. Absent ⇒ the
	 * default (`MAX_RETRIES`). `retries(0)` ⇒ fail on the first failed try.
	 */
	retries?: number
}

export interface OutputSchema {
	fields: OutputField[]
}

export interface OutputField {
	name: string
	fieldType: string // "string" | "number" | "boolean"
}

/**
 * Convert a WorkflowOutputStake's OutputSchema into a JSON Schema object
 * suitable for the `attempt_completion` tool's `result` parameter.
 *
 * The mapping is a pure, total function because `fieldType` is a closed
 * 3-value enum of flat scalars (no nesting, no recursion):
 *   - "string"  → { "type": "string" }
 *   - "number"  → { "type": "number" }
 *   - "boolean" → { "type": "boolean" }
 *
 * The returned schema is within BOTH the universal structural subset (all
 * providers accept it) AND the OpenAI strict-mode allowed subset (no
 * `pattern`, `minLength`, `minimum`/`maximum`, `minItems`, `uniqueItems`).
 * All fields are required and `additionalProperties: false` — matching
 * the existing post-hoc validator in `collectStakeResults()`.
 */
export function contractToJsonSchema(o: OutputSchema): Record<string, unknown> {
	const properties: Record<string, { type: string }> = {}
	for (const f of o.fields) {
		properties[f.name] = { type: f.fieldType }
	}
	return {
		type: "object",
		properties,
		required: o.fields.map((f) => f.name),
		additionalProperties: false,
	}
}

export interface AwaitOp extends BaseNode {
	type: "AwaitOp"
	binding: string
	sources: Source[]
	options: Record<string, Expr>
}

export interface CommitOp extends BaseNode {
	type: "CommitOp"
	value?: Expr
	condition?: Expr
}

export interface EscalateOp extends BaseNode {
	type: "EscalateOp"
	target: string // agent ref without @
	reason?: string
	/**
	 * Optional fixed answer set, e.g. `choices: ["ACK", "Reject"]`. When present
	 * the escalation is presented to the user as a multiple-choice prompt
	 * (clickable suggestion buttons) instead of a free-text question, so a simple
	 * sign-off needs no typing. The chosen text is delivered back to the agent
	 * exactly as a free-text answer would be.
	 */
	choices?: string[]
	/**
	 * Optional typed input form, e.g.
	 *   `escalate @Human reason: "…" form: { region: "string" { widget: "dropdown", options: [...] } … }`.
	 * Reuses the flow-param widget grammar ({@link FlowParam}) to render the full
	 * `ask_followup_question` form (dropdown / radio / checkbox / slider / number /
	 * text / boolean) mid-flow. The user's answers are delivered to the agent as a
	 * single object whose fields are coerced to each field's declared `paramType`,
	 * so the bound value is usable via DotAccess (e.g. `answers.region`). Mutually
	 * exclusive with `choices`; `form` takes precedence when both are present.
	 */
	form?: FlowParam[]
	condition?: Expr
}

/**
 * `log [value] [if cond]` — emit a message to the WorkflowTask view (the chat
 * stream) without affecting flow control. Non-blocking and non-terminal: the
 * agent continues to its next operation in the same advance.
 */
export interface LogOp extends BaseNode {
	type: "LogOp"
	value?: Expr
	condition?: Expr
}

/**
 * `error [value] [if cond]` — emit a message to the WorkflowTask view and
 * prematurely terminate the whole flow with status "error". Terminal.
 */
export interface ErrorOp extends BaseNode {
	type: "ErrorOp"
	value?: Expr
	condition?: Expr
}

export interface WhenBlock extends BaseNode {
	type: "WhenBlock"
	condition: Expr
	body: Operation[]
	elseBlock?: ElseBlock
}

export interface ElseBlock extends BaseNode {
	type: "ElseBlock"
	body: Operation[]
}

export interface LetOp extends BaseNode {
	type: "LetOp"
	name: string
	value: Expr
}

export interface SetOp extends BaseNode {
	type: "SetOp"
	name: string
	value: Expr
}

export interface RepeatBlock extends BaseNode {
	type: "RepeatBlock"
	condition: Expr
	body: Operation[]
}

// ─── Function Call ───

export interface FuncCall extends BaseNode {
	type: "FuncCall"
	name: string
	args: Argument[]
}

export interface Argument {
	name?: string // named argument key, undefined if positional
	value: Expr
}

// ─── Recipients / Sources ───

export interface Recipient {
	ref: string // "Analyst", "all", "out", "Human"
}

export interface Source {
	ref: string // "Analyst", "any", "*"
}

// ─── Flow Constraints ───

export interface ConvergeStmt extends BaseNode {
	type: "ConvergeStmt"
	condition: Expr
}

export interface BudgetStmt extends BaseNode {
	type: "BudgetStmt"
	items: BudgetItem[]
}

export interface BudgetItem {
	kind: "tokens" | "rounds" | "time"
	value: Expr
}

// ─── Deliver / Expect ───

export interface DeliverStmt extends BaseNode {
	type: "DeliverStmt"
	call: FuncCall
}

export interface ExpectStmt extends BaseNode {
	type: "ExpectStmt"
	expr: Expr
}

// ─── Expressions ───

export type Expr = NumberLit | StringLit | BoolLit | Ident | AgentRef | ListLit | DotAccess | BinaryExpr

export interface NumberLit extends BaseNode {
	type: "NumberLit"
	value: number
}

export interface StringLit extends BaseNode {
	type: "StringLit"
	value: string
}

export interface BoolLit extends BaseNode {
	type: "BoolLit"
	value: boolean
}

export interface Ident extends BaseNode {
	type: "Ident"
	name: string
}

export interface AgentRef extends BaseNode {
	type: "AgentRef"
	name: string // without @
}

export interface ListLit extends BaseNode {
	type: "ListLit"
	elements: Expr[]
}

export interface DotAccess extends BaseNode {
	type: "DotAccess"
	object: Expr
	property: string
}

export interface BinaryExpr extends BaseNode {
	type: "BinaryExpr"
	op: ">" | ">=" | "<" | "<=" | "==" | "!=" | "&&" | "||" | "contains"
	left: Expr
	right: Expr
}

// ─── Expression helpers ───

/** Extract a string literal value from an expression node (if possible). */
export function exprAsString(expr: Expr): string | undefined {
	if (expr.type === "StringLit") return expr.value
	return undefined
}

/** Extract a number literal value from an expression node (if possible). */
export function exprAsNumber(expr: Expr): number | undefined {
	if (expr.type === "NumberLit") return expr.value
	return undefined
}

/** Extract a boolean literal value from an expression node (if possible). */
export function exprAsBoolean(expr: Expr): boolean | undefined {
	if (expr.type === "BoolLit") return expr.value
	return undefined
}

/** Extract an identifier name from an expression node (if possible). */
export function exprAsIdent(expr: Expr): string | undefined {
	if (expr.type === "Ident") return expr.name
	return undefined
}

/**
 * Extract a list of string literals from a `["a", "b", ...]` list expression.
 * All-or-nothing: returns undefined if the node isn't a list of pure string
 * literals (so a malformed `options` is ignored rather than half-parsed).
 */
export function exprAsStringList(expr: Expr): string[] | undefined {
	if (expr.type !== "ListLit") return undefined
	const out: string[] = []
	for (const el of expr.elements) {
		const s = exprAsString(el)
		if (s === undefined) return undefined
		out.push(s)
	}
	return out
}
