import { execFile } from "child_process"
import { promisify } from "util"
import path from "path"
import crypto from "crypto"

import type { GitCommitBlock, IGitLogExtractor } from "../interfaces/git"
import { TelemetryService } from "@shofer/telemetry"
import { TelemetryEventName } from "@shofer/types"

const execFileAsync = promisify(execFile)

/**
 * Custom delimiters for parsing `git log` structured output.
 *
 * Format: %H|||%h|||%an <%ae>|||%aI|||%s|||%b|||ENDCOMMIT
 *
 * The `|||` separator is chosen because it is extremely unlikely to appear
 * in commit messages. `ENDCOMMIT` serves as an explicit commit boundary.
 */
const FIELD_SEPARATOR = "|||"
const COMMIT_TERMINATOR = "ENDCOMMIT"

/**
 * Maximum length of commit message content before truncation (7000 chars).
 *
 * Protects against exceeding the embedding model's context length.  The
 * `length / 4` token-estimation heuristic used by the Ollama embedder can
 * under-count for non-Latin scripts (CJK, etc.) and dense code blocks where
 * the tokenizer may assign one token per character.  7000 chars leaves some
 * headroom under the 8192-token limit of `nomic-embed-text` while capturing
 * most of the commit body for semantic search.
 *
 * The Ollama embedder applies a last-resort truncation at the token-estimation
 * level — see ollama.ts for the defence-in-depth guard.
 */
const MAX_CONTENT_LENGTH = 7000

/**
 * Extracts commit history from a git repository by running `git log`
 * with a structured format string and parsing the output.
 */
export class GitLogExtractor implements IGitLogExtractor {
	async extractCommits(workspacePath: string, maxHistoryDays: number, maxCommits: number): Promise<GitCommitBlock[]> {
		const args = this._buildLogArgs(`--since=${maxHistoryDays} days ago`, `--max-count=${maxCommits}`)
		return this._executeLog(workspacePath, args)
	}

	/**
	 * Extract commits since a specific ISO 8601 date (for incremental indexing).
	 * No cap on commit count — incremental scans are expected to be small.
	 */
	/**
	 * Extract commits since a specific ISO 8601 date (for incremental indexing).
	 * @param maxCommits - Hard cap on number of commits returned (safety ceiling).
	 */
	async extractCommitsSince(workspacePath: string, sinceDate: string, maxCommits: number): Promise<GitCommitBlock[]> {
		const args = this._buildLogArgs(`--since=${sinceDate}`, `--max-count=${maxCommits}`)
		return this._executeLog(workspacePath, args)
	}

	// --- Private ---

	/**
	 * Build the common `git log` argument array.
	 * @param sinceArg - The `--since=` argument value
	 * @param extraArgs - Additional optional args (e.g. `--max-count=N`)
	 */
	private _buildLogArgs(sinceArg: string, ...extraArgs: string[]): string[] {
		const formatStr = `%H${FIELD_SEPARATOR}%h${FIELD_SEPARATOR}%an <%ae>${FIELD_SEPARATOR}%aI${FIELD_SEPARATOR}%s${FIELD_SEPARATOR}%b${FIELD_SEPARATOR}${COMMIT_TERMINATOR}`
		return ["log", `--format=${formatStr}`, sinceArg, ...extraArgs, "--encoding=UTF-8"]
	}

	/**
	 * Execute `git log` with the given args and parse the output.
	 */
	private async _executeLog(workspacePath: string, args: string[]): Promise<GitCommitBlock[]> {
		// NOTE: --encoding=UTF-8 forces UTF-8 output. Invalid characters are
		// replaced with U+FFFD (replacement character) so the parser never
		// encounters raw byte sequences it cannot decode.
		try {
			const { stdout } = await execFileAsync("git", args, {
				cwd: workspacePath,
				maxBuffer: 50 * 1024 * 1024, // 50MB buffer for large histories
			})

			if (!stdout || stdout.trim().length === 0) {
				return []
			}

			return this._parseLogOutput(stdout)
		} catch (error) {
			// Log the error but return empty — the caller (GitIndexManager)
			// will handle the missing git case at a higher level.
			try {
				TelemetryService.instance.captureEvent(TelemetryEventName.CODE_INDEX_ERROR, {
					error: error instanceof Error ? error.message : String(error),
					stack: error instanceof Error ? error.stack : undefined,
					location: `GitLogExtractor.extractCommits(${path.basename(workspacePath)})`,
				})
			} catch {
				// Telemetry may not be initialized yet; swallow silently.
			}
			throw error
		}
	}

	/**
	 * Parse the structured `git log` output into GitCommitBlock[].
	 *
	 * The output format is:
	 * ```
	 * <full_hash>|||<short_hash>|||<author>|||<date>|||<subject>|||<body>|||ENDCOMMIT
	 * <full_hash>|||<short_hash>|||<author>|||<date>|||<subject>|||<body>|||ENDCOMMIT
	 * ```
	 *
	 * We split on the ENDCOMMIT token and then parse each commit block.
	 */
	private _parseLogOutput(raw: string): GitCommitBlock[] {
		const commits: GitCommitBlock[] = []

		// Split by commit terminator and process each block
		const blocks = raw.split(COMMIT_TERMINATOR)

		for (const block of blocks) {
			const trimmed = block.trim()
			if (!trimmed) continue

			const parsed = this._parseSingleCommit(trimmed)
			if (parsed) {
				commits.push(parsed)
			}
		}

		return commits
	}

	/**
	 * Parse a single commit block from the structured output.
	 *
	 * Format per block:
	 * ```
	 * <full_hash>|||<short_hash>|||<author>|||<date>|||<subject>|||<body>
	 * ```
	 *
	 * The body may contain newlines; we only split on the first 5 separators
	 * and treat the rest as the body.
	 */
	private _parseSingleCommit(block: string): GitCommitBlock | null {
		// Split by field separator, limiting to 6 pieces (the last piece is body)
		const parts = block.split(FIELD_SEPARATOR, 6)

		if (parts.length < 5) {
			return null // Not enough fields — malformed entry
		}

		const [commit_hash, short_hash, author, author_date, subject] = parts

		// Body is the 6th piece (if present) or empty string
		const body = parts.length >= 6 ? parts[5].trim() : ""

		// Construct content: subject + "\n\n" + body
		const contentRaw = body ? `${subject}\n\n${body}` : subject

		// Truncate if too long
		const content =
			contentRaw.length > MAX_CONTENT_LENGTH ? contentRaw.substring(0, MAX_CONTENT_LENGTH) : contentRaw

		// Compute SHA-256 hash of content for cache skipping
		const contentHash = crypto.createHash("sha256").update(content, "utf-8").digest("hex")

		return {
			commit_hash: commit_hash.trim(),
			short_hash: short_hash.trim(),
			author: author.trim(),
			author_date: author_date.trim(),
			subject: subject.trim(),
			body,
			content,
			contentHash,
		}
	}
}
