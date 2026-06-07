/**
 * Slang parser — vendored from @riktar/slang (MIT).
 * Source: https://github.com/riktar/slang/blob/master/src/parser.ts
 *
 * Converts a Token stream from the lexer into a typed AST (Program).
 * Supports error recovery for IDE/editor use cases.
 */

import { Token, TokenType, tokenize } from "./slang-lexer"
import { SlangErrorCode, SlangError, formatErrorMessage } from "./slang-lexer"
import type {
	Program,
	FlowDecl,
	FlowBodyItem,
	ImportStmt,
	FlowParam,
	AgentDecl,
	AgentMeta,
	Operation,
	StakeOp,
	AwaitOp,
	CommitOp,
	EscalateOp,
	WhenBlock,
	ElseBlock,
	LetOp,
	SetOp,
	RepeatBlock,
	FuncCall,
	Argument,
	Recipient,
	Source,
	ConvergeStmt,
	BudgetStmt,
	BudgetItem,
	DeliverStmt,
	ExpectStmt,
	ParamMetaDecl,
	Expr,
	Span,
	Position,
	OutputSchema,
	OutputField,
} from "./slang-ast"

export class ParseError extends SlangError {
	public token: Token
	constructor(code: SlangErrorCode, message: string, token: Token, source?: string) {
		super(code, message, token.line, token.column, source)
		this.token = token
		this.name = "ParseError"
	}
}

export interface ParseResult {
	program: Program
	errors: ParseError[]
}

/** Parse with error recovery — returns AST + collected errors. */
export function parseWithRecovery(source: string): ParseResult {
	const tokens = tokenize(source)
	const parser = new Parser(tokens, source, true)
	const program = parser.parseProgram()
	return { program, errors: parser.errors }
}

/** Parse (fail-fast) — throws on first error. */
export function parse(source: string): Program {
	const tokens = tokenize(source)
	const parser = new Parser(tokens, source, false)
	return parser.parseProgram()
}

class Parser {
	private pos = 0
	public errors: ParseError[] = []

	constructor(
		private tokens: Token[],
		private source: string,
		private recovering: boolean,
	) {}

	private peek(): Token {
		return this.tokens[this.pos]!
	}

	private advance(): Token {
		const t = this.tokens[this.pos]!
		this.pos++
		return t
	}

	private check(type: TokenType): boolean {
		return this.peek().type === type
	}

	private match(...types: TokenType[]): Token | null {
		if (types.includes(this.peek().type)) {
			return this.advance()
		}
		return null
	}

	private expect(type: TokenType, message?: string): Token {
		const t = this.peek()
		if (t.type !== type) {
			// Produce a friendlier message when a reserved keyword is used where an
			// identifier / name was expected.  The generic message "Expected Ident
			// but got count" is confusing because "count" looks like a valid name.
			const isKeywordAsIdent =
				type === TokenType.Ident && t.type !== TokenType.EOF && /^[a-zA-Z_][a-zA-Z_0-9]*$/.test(t.value)
			const msg =
				message ??
				(isKeywordAsIdent
					? `Expected an identifier (name) but got '${t.value}' — '${t.value}' is a reserved keyword and cannot be used as a name, variable, or parameter.`
					: formatErrorMessage(SlangErrorCode.P201, { expected: type, got: t.value }))
			const err = new ParseError(SlangErrorCode.P201, msg, t, this.source)
			if (!this.recovering) throw err
			this.errors.push(err)
			return { type, value: "", line: t.line, column: t.column, offset: t.offset }
		}
		return this.advance()
	}

	private posOf(token: Token): Position {
		return { line: token.line, column: token.column, offset: token.offset }
	}

	private spanFrom(start: Token, end?: Token): Span {
		const e = end ?? this.tokens[this.pos - 1]!
		return { start: this.posOf(start), end: this.posOf(e) }
	}

	// ─── Program ───

	parseProgram(): Program {
		const start = this.peek()
		const flows: FlowDecl[] = []
		while (!this.check(TokenType.EOF)) {
			try {
				flows.push(this.parseFlowDecl())
			} catch (e) {
				if (e instanceof ParseError && this.recovering) {
					this.errors.push(e)
					this.synchronize([TokenType.Flow])
				} else {
					throw e
				}
			}
		}
		return { type: "Program", flows, span: this.spanFrom(start) }
	}

	// ─── Flow ───

	private parseFlowDecl(): FlowDecl {
		const start = this.expect(TokenType.Flow)
		const name = this.expect(TokenType.String).value

		let params: FlowParam[] | undefined
		if (this.check(TokenType.LParen)) {
			params = this.parseFlowParams()
		}

		this.expect(TokenType.LBrace)

		// Parse flow-level meta fields (title, description, icon) before the main body.
		let title: string | undefined
		let description: string | undefined
		let icon: string | undefined
		while (this.check(TokenType.Title) || this.check(TokenType.Description) || this.check(TokenType.Icon)) {
			if (this.check(TokenType.Title)) {
				this.advance()
				this.expect(TokenType.Colon)
				title = this.expect(TokenType.String).value
			} else if (this.check(TokenType.Description)) {
				this.advance()
				this.expect(TokenType.Colon)
				description = this.expect(TokenType.String).value
			} else if (this.check(TokenType.Icon)) {
				this.advance()
				this.expect(TokenType.Colon)
				icon = this.expect(TokenType.String).value
			}
		}

		const body = this.parseFlowBody()
		const end = this.expect(TokenType.RBrace)
		return { type: "FlowDecl", name, params, body, title, description, icon, span: this.spanFrom(start, end) }
	}

	private parseFlowParams(): FlowParam[] {
		this.expect(TokenType.LParen)
		const params: FlowParam[] = []
		if (!this.check(TokenType.RParen)) {
			params.push(this.parseFlowParam())
			while (this.match(TokenType.Comma)) {
				if (!this.check(TokenType.RParen)) {
					params.push(this.parseFlowParam())
				}
			}
		}
		this.expect(TokenType.RParen)
		return params
	}

	private parseFlowParam(): FlowParam {
		const name = this.expect(TokenType.Ident).value
		this.expect(TokenType.Colon)
		const paramType = this.expect(TokenType.String).value
		return { name, paramType }
	}

	private parseFlowBody(): FlowBodyItem[] {
		const items: FlowBodyItem[] = []
		while (!this.check(TokenType.RBrace) && !this.check(TokenType.EOF)) {
			const t = this.peek()
			switch (t.type) {
				case TokenType.Import:
					items.push(this.parseImportStmt())
					break
				case TokenType.Agent:
					items.push(this.parseAgentDecl())
					break
				case TokenType.Converge:
					items.push(this.parseConvergeStmt())
					break
				case TokenType.Budget:
					items.push(this.parseBudgetStmt())
					break
				case TokenType.Deliver:
					items.push(this.parseDeliverStmt())
					break
				case TokenType.Expect:
					items.push(this.parseExpectStmt())
					break
				case TokenType.Param:
					items.push(this.parseParamMetaDecl())
					break
				default:
					throw new ParseError(SlangErrorCode.P204, formatErrorMessage(SlangErrorCode.P204), t, this.source)
			}
		}
		return items
	}

	// ─── Import ───

	private parseImportStmt(): ImportStmt {
		const start = this.expect(TokenType.Import)
		const path = this.expect(TokenType.String).value
		this.expect(TokenType.As)
		const alias = this.expect(TokenType.Ident).value
		return { type: "ImportStmt", path, alias, span: this.spanFrom(start) }
	}

	// ─── Agent ───

	private parseAgentDecl(): AgentDecl {
		const start = this.expect(TokenType.Agent)
		const name = this.expect(TokenType.Ident).value
		const meta: AgentMeta = {}
		const operations: Operation[] = []

		// Parse agent body
		this.expect(TokenType.LBrace)

		while (!this.check(TokenType.RBrace) && !this.check(TokenType.EOF)) {
			if (this.check(TokenType.Role)) {
				this.advance()
				this.expect(TokenType.Colon)
				meta.role = this.expect(TokenType.String).value
			} else if (this.check(TokenType.Model)) {
				this.advance()
				this.expect(TokenType.Colon)
				meta.model = this.expect(TokenType.String).value
			} else if (this.check(TokenType.Tools)) {
				this.advance()
				this.expect(TokenType.Colon)
				this.expect(TokenType.LBracket)
				meta.tools = []
				if (!this.check(TokenType.RBracket)) {
					meta.tools.push(this.expect(TokenType.Ident).value)
					while (this.match(TokenType.Comma)) {
						meta.tools.push(this.expect(TokenType.Ident).value)
					}
				}
				this.expect(TokenType.RBracket)
			} else if (
				this.check(TokenType.Ident) &&
				this.peek().value === "mode" &&
				this.tokens[this.pos + 1]?.type === TokenType.Colon
			) {
				// Shofer extension: 'mode: "slug"' in agent config
				this.advance() // "mode"
				this.expect(TokenType.Colon)
				;(meta as any).mode = this.expect(TokenType.String).value
			} else if (this.check(TokenType.Retry)) {
				this.advance()
				this.expect(TokenType.Colon)
				meta.retry = parseInt(this.expect(TokenType.Number).value, 10)
			} else if (
				this.check(TokenType.Ident) &&
				this.peek().value === "peers" &&
				this.tokens[this.pos + 1]?.type === TokenType.Colon
			) {
				// Shofer extension: 'peers: [@Agent1, @Agent2]' — declared direct-message peers.
				this.advance() // "peers"
				this.expect(TokenType.Colon)
				this.expect(TokenType.LBracket)
				meta.peers = []
				if (!this.check(TokenType.RBracket)) {
					const refToken =
						this.peek().type === TokenType.AgentRef ? this.advance() : this.expect(TokenType.Ident)
					meta.peers.push(refToken.value)
					while (this.match(TokenType.Comma)) {
						const refToken =
							this.peek().type === TokenType.AgentRef ? this.advance() : this.expect(TokenType.Ident)
						meta.peers.push(refToken.value)
					}
				}
				this.expect(TokenType.RBracket)
			} else if (this.isOperationStart()) {
				operations.push(this.parseOperation())
			} else {
				throw new ParseError(
					SlangErrorCode.P203,
					formatErrorMessage(SlangErrorCode.P203),
					this.peek(),
					this.source,
				)
			}
		}

		const end = this.expect(TokenType.RBrace)
		return { type: "AgentDecl", name, meta, operations, span: this.spanFrom(start, end) }
	}

	// ─── Operations ───

	private parseOperation(): Operation {
		const t = this.peek()
		switch (t.type) {
			case TokenType.Stake:
				return this.parseStakeOp()
			case TokenType.Await:
				return this.parseAwaitOp()
			case TokenType.Commit:
				return this.parseCommitOp()
			case TokenType.Escalate:
				return this.parseEscalateOp()
			case TokenType.When:
				return this.parseWhenBlock()
			case TokenType.Let:
				return this.parseLetOp()
			case TokenType.Set:
				return this.parseSetOp()
			case TokenType.Repeat:
				return this.parseRepeatBlock()
			default:
				throw new ParseError(SlangErrorCode.P203, formatErrorMessage(SlangErrorCode.P203), t, this.source)
		}
	}

	private parseStakeOp(): StakeOp {
		const start = this.expect(TokenType.Stake)
		const call = this.parseFuncCall()
		const recipients: Recipient[] = []

		// Optional recipients: -> @Agent1, @Agent2 or -> @out
		if (this.match(TokenType.Arrow)) {
			// Accept both Ident and AgentRef for recipients (Shofer extension)
			const refToken = this.peek()
			const ref = refToken.type === TokenType.AgentRef ? this.advance().value : this.expect(TokenType.Ident).value
			recipients.push({ ref })
			while (this.match(TokenType.Comma)) {
				// Accept both Ident and AgentRef for recipients (Shofer extension)
				const refToken = this.peek()
				const ref =
					refToken.type === TokenType.AgentRef ? this.advance().value : this.expect(TokenType.Ident).value
				recipients.push({ ref })
			}
		}

		const condition = this.parseOptionalCondition()

		// Optional output: { field: "type", ... }
		let output: OutputSchema | undefined
		if (this.check(TokenType.Output)) {
			this.advance()
			this.expect(TokenType.Colon)
			output = this.parseOutputSchema()
		}

		let binding: string | undefined
		this.parseStakeBinding()

		return { type: "StakeOp", call, recipients, condition, output, binding, span: this.spanFrom(start) }
	}

	// parseStakeBinding is a no-op hook — binding is set by LetOp/SetOp
	private parseStakeBinding(): void {
		// No-op: binding is set by the LetOp/SetOp that wraps this StakeOp
	}

	private parseAwaitOp(): AwaitOp {
		const start = this.expect(TokenType.Await)
		const binding = this.expect(TokenType.Ident).value
		this.expect(TokenType.BackArrow)
		const sources: Source[] = []
		// Accept Ident, AgentRef, or Star for sources (Shofer extension: * is wildcard)
		sources.push(this.parseSource())
		while (this.match(TokenType.Comma)) {
			sources.push(this.parseSource())
		}

		// Optional trailing options (currently unused but part of the grammar)
		const options: Record<string, Expr> = {}
		while (this.match(TokenType.Comma)) {
			const key = this.expect(TokenType.Ident).value
			this.expect(TokenType.Colon)
			options[key] = this.parseExpr()
		}

		return { type: "AwaitOp", binding, sources, options, span: this.spanFrom(start) }
	}

	/** Parse a single await source: Ident | AgentRef | Star. */
	private parseSource(): Source {
		const t = this.peek()
		if (t.type === TokenType.Star) {
			this.advance()
			return { ref: "*" }
		}
		if (t.type === TokenType.AgentRef) {
			return { ref: this.advance().value }
		}
		// Accept bare Ident as a source ref (Shofer extension).
		return { ref: this.expect(TokenType.Ident).value }
	}

	private parseCommitOp(): CommitOp {
		const start = this.expect(TokenType.Commit)
		let value: Expr | undefined
		let condition: Expr | undefined

		// Parse optional value expression (must come before optional 'if' guard).
		if (
			!this.check(TokenType.If) &&
			!this.isOperationStart() &&
			!this.check(TokenType.RBrace) &&
			!this.check(TokenType.EOF)
		) {
			value = this.parseExpr()
		}

		// Parse optional 'if' guard.
		condition = this.parseOptionalCondition()

		return { type: "CommitOp", value, condition, span: this.spanFrom(start) }
	}

	private parseEscalateOp(): EscalateOp {
		const start = this.expect(TokenType.Escalate)
		const target = this.expect(TokenType.AgentRef).value

		let reason: string | undefined
		if (this.check(TokenType.Reason)) {
			this.advance()
			this.expect(TokenType.Colon)
			reason = this.expect(TokenType.String).value
		}

		const condition = this.parseOptionalCondition()

		return { type: "EscalateOp", target, reason, condition, span: this.spanFrom(start) }
	}

	private parseWhenBlock(): WhenBlock {
		const start = this.expect(TokenType.When)
		const condition = this.parseExpr()
		this.expect(TokenType.LBrace)
		const body = this.parseOperationList()
		this.expect(TokenType.RBrace)

		let elseBlock: ElseBlock | undefined
		if (this.match(TokenType.Otherwise)) {
			this.expect(TokenType.LBrace)
			const elseBody = this.parseOperationList()
			const endElse = this.expect(TokenType.RBrace)
			elseBlock = { type: "ElseBlock", body: elseBody, span: this.spanFrom(start, endElse) }
		}

		return { type: "WhenBlock", condition, body, elseBlock, span: this.spanFrom(start) }
	}

	private parseLetOp(): LetOp {
		const start = this.expect(TokenType.Let)
		const name = this.expect(TokenType.Ident).value
		this.expect(TokenType.Eq)
		const value = this.parseExpr()
		return { type: "LetOp", name, value, span: this.spanFrom(start) }
	}

	private parseSetOp(): SetOp {
		const start = this.expect(TokenType.Set)
		const name = this.expect(TokenType.Ident).value
		this.expect(TokenType.Eq)
		const value = this.parseExpr()
		return { type: "SetOp", name, value, span: this.spanFrom(start) }
	}

	private parseRepeatBlock(): RepeatBlock {
		const start = this.expect(TokenType.Repeat)
		this.expect(TokenType.Until)
		const condition = this.parseExpr()
		this.expect(TokenType.LBrace)
		const body = this.parseOperationList()
		this.expect(TokenType.RBrace)
		return { type: "RepeatBlock", condition, body, span: this.spanFrom(start) }
	}

	private parseOperationList(): Operation[] {
		const ops: Operation[] = []
		while (!this.check(TokenType.RBrace) && !this.check(TokenType.EOF)) {
			if (this.isOperationStart()) {
				ops.push(this.parseOperation())
			} else {
				break
			}
		}
		return ops
	}

	// ─── FuncCall ───

	private parseFuncCall(): FuncCall {
		const start = this.expect(TokenType.Ident)
		const args: Argument[] = []
		if (this.match(TokenType.LParen)) {
			if (!this.check(TokenType.RParen)) {
				args.push(this.parseArgument())
				while (this.match(TokenType.Comma)) {
					if (!this.check(TokenType.RParen)) {
						args.push(this.parseArgument())
					}
				}
			}
			this.expect(TokenType.RParen)
		}
		return { type: "FuncCall", name: start.value, args, span: this.spanFrom(start) }
	}

	private parseArgument(): Argument {
		// Check for named arg: name: expr
		//
		// The name may be a reserved keyword (e.g. `contains`, `output`, `time`,
		// `count`). The trailing colon disambiguates a keyword used as a parameter
		// NAME from the same keyword used as an operator/expression — a positional
		// expression argument is never immediately followed by a colon. Without
		// this, an argument like `contains: contains_ok` fails to parse because
		// `contains` tokenizes as TokenType.Contains rather than TokenType.Ident.
		const isNamePosition = this.check(TokenType.Ident) || isKeywordToken(this.peek().type)
		if (isNamePosition && this.tokens[this.pos + 1]?.type === TokenType.Colon) {
			const name = this.advance().value
			this.advance() // :
			return { name, value: this.parseExpr() }
		}
		return { value: this.parseExpr() }
	}

	// ─── Output Schema ───

	private parseOutputSchema(): OutputSchema {
		this.expect(TokenType.LBrace)
		const fields: OutputField[] = []
		if (!this.check(TokenType.RBrace)) {
			fields.push(this.parseOutputField())
			while (this.match(TokenType.Comma)) {
				if (!this.check(TokenType.RBrace)) {
					fields.push(this.parseOutputField())
				}
			}
		}
		this.expect(TokenType.RBrace)
		return { fields }
	}

	private parseOutputField(): OutputField {
		// Field names may be reserved keywords (e.g. `contains`, `output`); accept
		// any keyword token in name position, mirroring parseArgument.
		const name =
			this.check(TokenType.Ident) || isKeywordToken(this.peek().type)
				? this.advance().value
				: this.expect(TokenType.Ident).value
		this.expect(TokenType.Colon)
		const fieldType = this.expect(TokenType.String).value
		return { name, fieldType }
	}

	// ─── Converge / Budget / Deliver / Expect ───

	private parseConvergeStmt(): ConvergeStmt {
		const start = this.expect(TokenType.Converge)
		this.expect(TokenType.When)
		this.expect(TokenType.Colon)
		const condition = this.parseExpr()
		return { type: "ConvergeStmt", condition, span: this.spanFrom(start) }
	}

	private parseBudgetStmt(): BudgetStmt {
		const start = this.expect(TokenType.Budget)
		this.expect(TokenType.Colon)
		const items: BudgetItem[] = []
		items.push(this.parseBudgetItem())
		while (this.match(TokenType.Comma)) {
			items.push(this.parseBudgetItem())
		}
		return { type: "BudgetStmt", items, span: this.spanFrom(start) }
	}

	private parseBudgetItem(): BudgetItem {
		const t = this.peek()
		let kind: BudgetItem["kind"]
		if (t.type === TokenType.Tokens) kind = "tokens"
		else if (t.type === TokenType.Rounds) kind = "rounds"
		else if (t.type === TokenType.Time) kind = "time"
		else throw new ParseError(SlangErrorCode.P205, formatErrorMessage(SlangErrorCode.P205), t, this.source)
		this.advance()
		this.expect(TokenType.LParen)
		const value = this.parseExpr()
		this.expect(TokenType.RParen)
		return { kind, value }
	}

	private parseDeliverStmt(): DeliverStmt {
		const start = this.expect(TokenType.Deliver)
		const call = this.parseFuncCall()
		return { type: "DeliverStmt", call, span: this.spanFrom(start) }
	}

	private parseExpectStmt(): ExpectStmt {
		const start = this.expect(TokenType.Expect)
		const expr = this.parseExpr()
		return { type: "ExpectStmt", expr, span: this.spanFrom(start) }
	}

	private parseParamMetaDecl(): ParamMetaDecl {
		const start = this.expect(TokenType.Param)
		const name = this.expect(TokenType.Ident).value
		let description: string | undefined
		this.expect(TokenType.LBrace)
		while (!this.check(TokenType.RBrace) && !this.check(TokenType.EOF)) {
			if (this.check(TokenType.Description)) {
				this.advance()
				this.expect(TokenType.Colon)
				description = this.expect(TokenType.String).value
			} else {
				// Skip unknown meta fields inside param block
				this.advance()
			}
		}
		this.expect(TokenType.RBrace)
		return { type: "ParamMetaDecl", name, description, span: this.spanFrom(start) }
	}

	// ─── Expressions ───

	private parseExpr(): Expr {
		return this.parseOr()
	}

	private parseOr(): Expr {
		let left = this.parseAnd()
		while (this.match(TokenType.Or)) {
			const right = this.parseAnd()
			left = { type: "BinaryExpr", op: "||", left, right, span: this.spanFrom(this.tokens[this.pos - 1]!) }
		}
		return left
	}

	private parseAnd(): Expr {
		let left = this.parseComparison()
		while (this.match(TokenType.And)) {
			const right = this.parseComparison()
			left = { type: "BinaryExpr", op: "&&", left, right, span: this.spanFrom(this.tokens[this.pos - 1]!) }
		}
		return left
	}

	private parseComparison(): Expr {
		let left = this.parseContains()
		const compOps = [TokenType.Gt, TokenType.Gte, TokenType.Lt, TokenType.Lte, TokenType.EqEq, TokenType.Neq]
		if (compOps.includes(this.peek().type)) {
			const op = this.advance()
			const right = this.parseContains()
			left = { type: "BinaryExpr", op: op.value as any, left, right, span: this.spanFrom(op) }
		}
		return left
	}

	private parseContains(): Expr {
		let left = this.parseDotAccess()
		if (this.check(TokenType.Contains)) {
			const op = this.advance()
			const right = this.parseDotAccess()
			left = { type: "BinaryExpr", op: "contains", left, right, span: this.spanFrom(op) }
		}
		return left
	}

	private parseDotAccess(): Expr {
		let expr = this.parsePrimary()
		while (this.match(TokenType.Dot)) {
			const t = this.peek()
			let prop: string
			if (t.type === TokenType.Ident || isKeywordToken(t.type)) {
				prop = this.advance().value
			} else {
				prop = this.expect(TokenType.Ident).value
			}
			expr = { type: "DotAccess", object: expr, property: prop, span: this.spanFrom(this.tokens[this.pos - 1]!) }
		}
		return expr
	}

	private parsePrimary(): Expr {
		const t = this.peek()

		if (t.type === TokenType.Number) {
			this.advance()
			return { type: "NumberLit", value: parseFloat(t.value), span: this.spanFrom(t) }
		}
		if (t.type === TokenType.String) {
			this.advance()
			return { type: "StringLit", value: t.value, span: this.spanFrom(t) }
		}
		if (t.type === TokenType.True) {
			this.advance()
			return { type: "BoolLit", value: true, span: this.spanFrom(t) }
		}
		if (t.type === TokenType.False) {
			this.advance()
			return { type: "BoolLit", value: false, span: this.spanFrom(t) }
		}
		if (t.type === TokenType.Ident) {
			this.advance()
			return { type: "Ident", name: t.value, span: this.spanFrom(t) }
		}
		if (t.type === TokenType.AgentRef) {
			this.advance()
			return { type: "AgentRef", name: t.value, span: this.spanFrom(t) }
		}
		if (t.type === TokenType.LBracket) {
			return this.parseListLit()
		}
		if (t.type === TokenType.LParen) {
			this.advance()
			const expr = this.parseExpr()
			this.expect(TokenType.RParen)
			return expr
		}

		throw new ParseError(SlangErrorCode.P202, formatErrorMessage(SlangErrorCode.P202), t, this.source)
	}

	private parseListLit(): Expr {
		const start = this.expect(TokenType.LBracket)
		const elements: Expr[] = []
		if (!this.check(TokenType.RBracket)) {
			elements.push(this.parseExpr())
			while (this.match(TokenType.Comma)) {
				elements.push(this.parseExpr())
			}
		}
		this.expect(TokenType.RBracket)
		return { type: "ListLit", elements, span: this.spanFrom(start) }
	}

	// ─── Helpers ───

	private parseOptionalCondition(): Expr | undefined {
		if (this.match(TokenType.If)) {
			return this.parseExpr()
		}
		return undefined
	}

	private isOperationStart(): boolean {
		const t = this.peek().type
		return (
			t === TokenType.Stake ||
			t === TokenType.Await ||
			t === TokenType.Commit ||
			t === TokenType.Escalate ||
			t === TokenType.When ||
			t === TokenType.Let ||
			t === TokenType.Set ||
			t === TokenType.Repeat
		)
	}

	private synchronize(syncTokens: TokenType[]): void {
		while (!this.check(TokenType.EOF)) {
			if (syncTokens.includes(this.peek().type)) return
			this.advance()
		}
	}
}

// ─── Helpers (global) ───

function isKeywordToken(type: TokenType): boolean {
	return (
		type === TokenType.Output ||
		type === TokenType.Role ||
		type === TokenType.Model ||
		type === TokenType.Tools ||
		type === TokenType.Tokens ||
		type === TokenType.Rounds ||
		type === TokenType.Time ||
		type === TokenType.Count ||
		type === TokenType.Reason ||
		type === TokenType.Retry ||
		type === TokenType.Budget ||
		type === TokenType.Commit ||
		type === TokenType.Stake ||
		type === TokenType.Await ||
		type === TokenType.Agent ||
		type === TokenType.Flow ||
		type === TokenType.Deliver ||
		type === TokenType.Expect ||
		type === TokenType.Contains ||
		type === TokenType.True ||
		type === TokenType.False ||
		type === TokenType.Set ||
		type === TokenType.Let ||
		type === TokenType.When ||
		type === TokenType.If ||
		type === TokenType.Else ||
		type === TokenType.Otherwise ||
		type === TokenType.Converge ||
		type === TokenType.Import ||
		type === TokenType.As ||
		type === TokenType.Escalate ||
		type === TokenType.Repeat ||
		type === TokenType.Until ||
		type === TokenType.Title ||
		type === TokenType.Description ||
		type === TokenType.Icon ||
		type === TokenType.Param
	)
}
