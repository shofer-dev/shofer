/**
 * Slang lexer — vendored from @riktar/slang (MIT).
 * Source: https://github.com/riktar/slang/blob/master/src/lexer.ts
 *
 * Tokenizes .slang source into a Token stream consumed by the parser.
 */

// ─── Error support (vendored from upstream errors.ts) ───

export enum SlangErrorCode {
	L100 = "L100", // Unterminated string
	L101 = "L101", // Unexpected character
	L102 = "L102", // Expected agent name after @
	P200 = "P200", // Unexpected token
	P201 = "P201", // Expected token
	P202 = "P202", // Expected expression
	P203 = "P203", // Expected operation
	P204 = "P204", // Expected flow body item
	P205 = "P205", // Expected budget kind
	P206 = "P206", // Expected agent name
	P207 = "P207", // Expected flow name
	P208 = "P208", // Unclosed block
	R300 = "R300",
	R301 = "R301",
	R302 = "R302",
	R303 = "R303",
	R304 = "R304",
	R305 = "R305",
	E400 = "E400",
	E401 = "E401",
	E402 = "E402",
	E403 = "E403",
	E404 = "E404",
	E405 = "E405",
	E406 = "E406",
	E407 = "E407",
}

const ERROR_MESSAGES: Record<SlangErrorCode, string> = {
	[SlangErrorCode.L100]: `Unterminated string literal — did you forget the closing "?"`,
	[SlangErrorCode.L101]: "Unexpected character `{char}` — SLANG doesn't recognize this symbol",
	[SlangErrorCode.L102]: "Expected an agent name after `@` — e.g. `@Writer`, `@out`",
	[SlangErrorCode.P200]: "Unexpected {got} — expected {expected}",
	[SlangErrorCode.P201]: "Expected `{expected}` but got `{got}`",
	[SlangErrorCode.P202]: "Expected an expression (number, string, identifier, or `[`)",
	[SlangErrorCode.P203]:
		"Expected an operation: `stake`, `await`, `commit`, `escalate`, `log`, `error`, `when`, `let`, `set`, or `repeat`",
	[SlangErrorCode.P204]: "Expected `import`, `agent`, `converge`, `budget`, or `deliver` inside a flow body",
	[SlangErrorCode.P205]: "Expected `tokens`, `rounds`, or `time` in budget declaration",
	[SlangErrorCode.P206]: "Expected an agent name (identifier) after `agent`",
	[SlangErrorCode.P207]: "Expected a flow name (string) after `flow`",
	[SlangErrorCode.P208]: "Unclosed `{open}` block — expected `{close}` before end of file",
	[SlangErrorCode.R300]: "Agent `{agent}` references unknown agent `@{ref}` — make sure it is declared",
	[SlangErrorCode.R301]: "Deadlock detected: {cycle} — these agents are waiting on each other in a cycle",
	[SlangErrorCode.R302]: "Agent `{agent}` has no `commit` — it will never signal completion",
	[SlangErrorCode.R303]: "Agent `{agent}` produces output but no agent awaits from it",
	[SlangErrorCode.R304]:
		"Flow has no `converge` statement — will stop only when all agents commit or budget is exceeded",
	[SlangErrorCode.R305]: "Flow has no `budget` statement — default is unlimited (no enforcement)",
	[SlangErrorCode.E400]: 'No flow found in source — define at least one `flow "name" { ... }`',
	[SlangErrorCode.E401]: "LLM adapter call failed: {message}",
	[SlangErrorCode.E402]: "Budget exceeded at round {round} — increase `budget:` limits or simplify the flow",
	[SlangErrorCode.E403]: "Runtime deadlock: agents {agents} cannot make progress",
	[SlangErrorCode.E404]: "Tool `{tool}` was declared but no handler was provided in runtime options",
	[SlangErrorCode.E405]: "Tool `{tool}` execution failed: {message}",
	[SlangErrorCode.E406]: "All {max} retries exhausted for agent `{agent}`: {message}",
	[SlangErrorCode.E407]: "Assertion failed: {message}",
}

export function formatErrorMessage(code: SlangErrorCode, params?: Record<string, string | number>): string {
	let msg = ERROR_MESSAGES[code] ?? `Unknown error (${code})`
	if (params) {
		for (const [key, value] of Object.entries(params)) {
			msg = msg.replaceAll(`{${key}}`, String(value))
		}
	}
	return msg
}

export class SlangError extends Error {
	constructor(
		public code: SlangErrorCode,
		message: string,
		public line: number,
		public column: number,
		public source?: string,
	) {
		const loc = `${line}:${column}`
		super(`${code}: ${message} (at ${loc})`)
		this.name = "SlangError"
	}

	toJSON() {
		return { code: this.code, message: this.message, line: this.line, column: this.column }
	}
}

// ─── Token Types ───

export enum TokenType {
	String = "String",
	Number = "Number",
	Ident = "Ident",
	AgentRef = "AgentRef",
	Flow = "flow",
	Agent = "agent",
	Stake = "stake",
	Await = "await",
	Commit = "commit",
	Escalate = "escalate",
	Log = "log",
	Error = "error",
	Import = "import",
	As = "as",
	When = "when",
	If = "if",
	Else = "else",
	Otherwise = "otherwise",
	Converge = "converge",
	Budget = "budget",
	Role = "role",
	Model = "model",
	Tools = "tools",
	Tokens = "tokens",
	Rounds = "rounds",
	Time = "time",
	Count = "count",
	Reason = "reason",
	Retry = "retry",
	Output = "output",
	Let = "let",
	Set = "set",
	Repeat = "repeat",
	Until = "until",
	Deliver = "deliver",
	Expect = "expect",
	Contains = "contains",
	True = "true",
	False = "false",
	Title = "title",
	Description = "description",
	Icon = "icon",
	Param = "param",
	LBrace = "{",
	RBrace = "}",
	LParen = "(",
	RParen = ")",
	LBracket = "[",
	RBracket = "]",
	Colon = ":",
	Comma = ",",
	Arrow = "->",
	BackArrow = "<-",
	Dot = ".",
	Star = "*",
	Eq = "=",
	Gt = ">",
	Gte = ">=",
	Lt = "<",
	Lte = "<=",
	EqEq = "==",
	Neq = "!=",
	And = "&&",
	Or = "||",
	EOF = "EOF",
}

const KEYWORDS: Record<string, TokenType> = {
	flow: TokenType.Flow,
	agent: TokenType.Agent,
	stake: TokenType.Stake,
	await: TokenType.Await,
	commit: TokenType.Commit,
	escalate: TokenType.Escalate,
	log: TokenType.Log,
	error: TokenType.Error,
	import: TokenType.Import,
	as: TokenType.As,
	when: TokenType.When,
	if: TokenType.If,
	else: TokenType.Else,
	otherwise: TokenType.Otherwise,
	converge: TokenType.Converge,
	budget: TokenType.Budget,
	role: TokenType.Role,
	model: TokenType.Model,
	tools: TokenType.Tools,
	tokens: TokenType.Tokens,
	rounds: TokenType.Rounds,
	time: TokenType.Time,
	count: TokenType.Count,
	reason: TokenType.Reason,
	retry: TokenType.Retry,
	output: TokenType.Output,
	let: TokenType.Let,
	set: TokenType.Set,
	repeat: TokenType.Repeat,
	until: TokenType.Until,
	deliver: TokenType.Deliver,
	expect: TokenType.Expect,
	contains: TokenType.Contains,
	true: TokenType.True,
	false: TokenType.False,
	title: TokenType.Title,
	description: TokenType.Description,
	icon: TokenType.Icon,
	param: TokenType.Param,
}

export interface Token {
	type: TokenType
	value: string
	line: number
	column: number
	offset: number
}

export class LexerError extends SlangError {
	constructor(code: SlangErrorCode, message: string, line: number, column: number, source?: string) {
		super(code, message, line, column, source)
		this.name = "LexerError"
	}
}

export function tokenize(source: string): Token[] {
	const tokens: Token[] = []
	let pos = 0
	let line = 1
	let column = 1

	function peek(): string {
		return source[pos] ?? "\0"
	}

	function peekAt(offset: number): string {
		return source[pos + offset] ?? "\0"
	}

	function advance(): string {
		const ch = source[pos] ?? "\0"
		pos++
		if (ch === "\n") {
			line++
			column = 1
		} else {
			column++
		}
		return ch
	}

	function makeToken(
		type: TokenType,
		value: string,
		startLine: number,
		startCol: number,
		startOffset: number,
	): Token {
		return { type, value, line: startLine, column: startCol, offset: startOffset }
	}

	while (pos < source.length) {
		const ch = peek()

		// Skip whitespace
		if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") {
			advance()
			continue
		}

		// Skip comments --
		if (ch === "-" && peekAt(1) === "-") {
			while (pos < source.length && peek() !== "\n") {
				advance()
			}
			continue
		}

		const startLine = line
		const startCol = column
		const startOffset = pos

		// Two-char tokens
		if (ch === "-" && peekAt(1) === ">") {
			advance()
			advance()
			tokens.push(makeToken(TokenType.Arrow, "->", startLine, startCol, startOffset))
			continue
		}
		if (ch === "<" && peekAt(1) === "-") {
			advance()
			advance()
			tokens.push(makeToken(TokenType.BackArrow, "<-", startLine, startCol, startOffset))
			continue
		}
		if (ch === ">" && peekAt(1) === "=") {
			advance()
			advance()
			tokens.push(makeToken(TokenType.Gte, ">=", startLine, startCol, startOffset))
			continue
		}
		if (ch === "<" && peekAt(1) === "=") {
			advance()
			advance()
			tokens.push(makeToken(TokenType.Lte, "<=", startLine, startCol, startOffset))
			continue
		}
		if (ch === "=" && peekAt(1) === "=") {
			advance()
			advance()
			tokens.push(makeToken(TokenType.EqEq, "==", startLine, startCol, startOffset))
			continue
		}
		if (ch === "!" && peekAt(1) === "=") {
			advance()
			advance()
			tokens.push(makeToken(TokenType.Neq, "!=", startLine, startCol, startOffset))
			continue
		}
		if (ch === "&" && peekAt(1) === "&") {
			advance()
			advance()
			tokens.push(makeToken(TokenType.And, "&&", startLine, startCol, startOffset))
			continue
		}
		if (ch === "|" && peekAt(1) === "|") {
			advance()
			advance()
			tokens.push(makeToken(TokenType.Or, "||", startLine, startCol, startOffset))
			continue
		}

		// Single =
		if (ch === "=") {
			advance()
			tokens.push(makeToken(TokenType.Eq, "=", startLine, startCol, startOffset))
			continue
		}

		// Single-char tokens
		const SINGLE_CHAR: Record<string, TokenType> = {
			"{": TokenType.LBrace,
			"}": TokenType.RBrace,
			"(": TokenType.LParen,
			")": TokenType.RParen,
			"[": TokenType.LBracket,
			"]": TokenType.RBracket,
			":": TokenType.Colon,
			",": TokenType.Comma,
			".": TokenType.Dot,
			"*": TokenType.Star,
			">": TokenType.Gt,
			"<": TokenType.Lt,
		}

		if (SINGLE_CHAR[ch]) {
			advance()
			tokens.push(makeToken(SINGLE_CHAR[ch], ch, startLine, startCol, startOffset))
			continue
		}

		// String literal
		if (ch === '"') {
			advance()
			let str = ""
			while (pos < source.length && peek() !== '"') {
				const c = advance()
				if (c === "\\") {
					const escaped = advance()
					if (escaped === "n") str += "\n"
					else if (escaped === "t") str += "\t"
					else if (escaped === '"') str += '"'
					else if (escaped === "\\") str += "\\"
					else str += escaped
				} else {
					str += c
				}
			}
			if (pos >= source.length) {
				throw new LexerError(
					SlangErrorCode.L100,
					formatErrorMessage(SlangErrorCode.L100),
					startLine,
					startCol,
					source,
				)
			}
			advance()
			tokens.push(makeToken(TokenType.String, str, startLine, startCol, startOffset))
			continue
		}

		// Number literal
		if (ch >= "0" && ch <= "9") {
			let num = ""
			while (pos < source.length && peek() >= "0" && peek() <= "9") {
				num += advance()
			}
			if (peek() === "." && peekAt(1) >= "0" && peekAt(1) <= "9") {
				num += advance()
				while (pos < source.length && peek() >= "0" && peek() <= "9") {
					num += advance()
				}
			}
			tokens.push(makeToken(TokenType.Number, num, startLine, startCol, startOffset))
			continue
		}

		// Agent reference @Name
		if (ch === "@") {
			advance()
			let name = ""
			while (pos < source.length && /[a-zA-Z_0-9*]/.test(peek())) {
				name += advance()
			}
			if (name === "") {
				throw new LexerError(
					SlangErrorCode.L102,
					formatErrorMessage(SlangErrorCode.L102),
					startLine,
					startCol,
					source,
				)
			}
			tokens.push(makeToken(TokenType.AgentRef, name, startLine, startCol, startOffset))
			continue
		}

		// Identifier / keyword
		if (/[a-zA-Z_]/.test(ch)) {
			let ident = ""
			while (pos < source.length && /[a-zA-Z_0-9]/.test(peek())) {
				ident += advance()
			}
			const keyword = KEYWORDS[ident]
			if (keyword) {
				tokens.push(makeToken(keyword, ident, startLine, startCol, startOffset))
			} else {
				tokens.push(makeToken(TokenType.Ident, ident, startLine, startCol, startOffset))
			}
			continue
		}

		throw new LexerError(
			SlangErrorCode.L101,
			formatErrorMessage(SlangErrorCode.L101, { char: ch }),
			startLine,
			startCol,
			source,
		)
	}

	tokens.push(makeToken(TokenType.EOF, "", line, column, pos))
	return tokens
}
