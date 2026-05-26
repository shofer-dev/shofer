# `grep_search` Tool — Design & Reference

## Purpose

Unified file-content search using **ripgrep** as its backend. Executes `rg` as a child process with `--json` output for structured, deterministic results that don't depend on VS Code's internal search index.

## Backend Rationale

The tool previously used VS Code's [`workspace.findTextInFiles`](https://code.visualstudio.com/api/references/vscode-api#workspace.findTextInFiles) API. In practice, `findTextInFiles` was found to have an incomplete search index — certain tokens (e.g., the Go `func` keyword) were systematically not found despite being present in files that `grep` and ripgrep locate instantly. Ripgrep provides a filesystem-level search that is:

- **Deterministic** — same results every time, regardless of VS Code indexing state
- **Fast** — ripgrep is optimized for code search performance
- **Complete** — searches the actual filesystem, not a cached index

### Trade-offs

| Aspect               | `findTextInFiles`                     | ripgrep                                              |
| -------------------- | ------------------------------------- | ---------------------------------------------------- |
| Completeness         | Depends on VS Code index (incomplete) | Filesystem-level (complete)                          |
| Regex syntax         | JavaScript regex                      | Rust regex (subtle differences)                      |
| `.gitignore` respect | Yes (default)                         | Yes (default)                                        |
| `.shoferignore`      | N/A                                   | Native `--ignore-file` flag + post-filter safety net |
| Performance          | Fast (indexed)                        | Fast (native binary)                                 |
| Submodule support    | Yes (VS Code handles boundaries)      | Yes (`--no-require-git` flag)                        |

**Known difference:** When `isRegex: true`, the pattern is interpreted as a **Rust regex** (ripgrep's native syntax), not JavaScript regex. For most common patterns (literals, character classes, quantifiers, alternation) the syntax is identical. Edge cases like lookahead/lookbehind may differ.

## Input Parameters

The OpenAI function-calling schema uses `additionalProperties: false`. **Strict mode is intentionally disabled** (mirroring `read_command_output`) so that optional parameters can be omitted by the model entirely; under `strict: true` OpenAI requires every property to appear in `required`, which forces verbose tool calls and produces "Missing required parameter" errors when a model omits one. The parser also accepts `regex` as an alias for `isRegex` for models that confabulate the parameter name (handled inside `NativeToolCallParser`, not exposed in the schema).

| Parameter        | Type              | Required | Default | Description                                                                                 |
| ---------------- | ----------------- | :------: | :-----: | ------------------------------------------------------------------------------------------- |
| `path`           | `string`          |    ✅    |    —    | Directory to search recursively, relative to workspace root                                 |
| `query`          | `string`          |    ✅    |    —    | The search pattern (regex or literal text)                                                  |
| `fileTypes`      | `string \| null`  |    —     | `null`  | Glob pattern to filter files (e.g., `*.ts`, `**/*.go`). `null` = all files.                 |
| `excludePattern` | `string \| null`  |    —     | `null`  | Glob pattern to exclude files (e.g., `**/node_modules/**`). `null` = no exclusions.         |
| `isRegex`        | `boolean \| null` |    —     | `true`  | Whether `query` is a regular expression. When `false`, query is matched literally.          |
| `caseSensitive`  | `boolean \| null` |    —     | `false` | Case-sensitive matching.                                                                    |
| `wholeWord`      | `boolean \| null` |    —     | `false` | Match whole words only (uses ripgrep `-w` flag). Works with both literal and regex queries. |
| `maxResults`     | `number \| null`  |    —     |  `100`  | Maximum total results across all files.                                                     |
| `contextBefore`  | `number \| null`  |    —     |   `1`   | Lines of context to show before each match.                                                 |
| `contextAfter`   | `number \| null`  |    —     |   `1`   | Lines of context to show after each match.                                                  |

## Ripgrep CLI Mapping

```typescript
// Core args for every invocation.
// --no-require-git prevents ripgrep from treating submodule .git files
// (gitdir: ../../.git/modules/...) as nested repository boundaries.
const args = ["--json", "--no-messages", "--no-require-git"]

// Pattern matching
if (isRegex) {
	args.push("-e", query) // regex search
} else {
	args.push("-F", "-e", query) // fixed-string (literal) search
}

// Flags
if (!caseSensitive) args.push("-i") // case-insensitive
if (wholeWord) args.push("-w") // whole-word match
if (fileTypes) args.push("-g", fileTypes) // include glob
if (excludePattern) args.push("-g", `!${excludePattern}`) // exclude glob

// Context
if (contextBefore > 0) args.push("-B", String(contextBefore))
if (contextAfter > 0) args.push("-A", String(contextAfter))

// Directory
args.push(directoryPath)
```

## Output Format

Results are returned as structured text, organized by file:

```
Found 12 results.

## src/utils/helpers.ts
   40 | function calculateTotal(items: number[]): number {
   41 |     let sum = 0
>  42 |     // TODO: Optimize this function for performance
   43 |     for (let i = 0; i < items.length; i++) {
   44 |         sum += items[i]

## src/api/handlers.ts
   88 |     const data = await fetchData()
>  89 |     // TODO: Add error handling
   90 |     return processData(data)
----

## src/components/App.tsx
  155 |     // Render main application shell
  156 |     return (
> 157 |         // TODO: Implement lazy loading
  158 |             <Suspense fallback={<Loading />}>
  159 |                 <Router>
```

Format specification:

- Header: `Found N results.` (or `Showing first M of more results.` when truncated)
- Per file: `## relative/path/to/file` followed by matching blocks
- Match lines: `>` prefix, 4-digit padded line number, `| ` separator, then line text
- Context lines: space prefix (no `>`), same line-number padding
- Non-contiguous blocks within the same file are separated by `----`
- Two blank lines between files

### No Results

```
No results found for: <query>
```

### Parameter Validation Errors

When `path` or `query` is missing/empty, a parameter-missing error is returned via `task.sayAndCreateMissingParamError()`.

## Examples

### Example 1: Find todos in TypeScript files

```
path: "src",
query: "TODO",
fileTypes: "*.ts",
isRegex: false,
caseSensitive: true,
wholeWord: true
```

### Example 2: Regex search for function definitions

```
path: ".",
query: "function\s+\w+",
fileTypes: "*.ts",
isRegex: true
```

### Example 3: Literal search with excludes

```
path: "src",
query: "console.log",
isRegex: false,
excludePattern: "**/*.test.ts"
```

### Example 4: Case-sensitive whole-word search

```
path: ".",
query: "ERROR",
fileTypes: "*.go",
caseSensitive: true,
wholeWord: true,
maxResults: 50
```

### Example 5: Minimal search (all defaults)

```
path: "src",
query: "authService"
```

Defaults: `isRegex=true`, `caseSensitive=false`, `wholeWord=false`, `fileTypes=null`, `excludePattern=null`, `maxResults=100`, `contextBefore=1`, `contextAfter=1`

## Implementation

| File                                                                                                                         | Status                           |
| ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| [`src/core/tools/GrepSearchTool.ts`](extensions/shofer/src/core/tools/GrepSearchTool.ts)                                     | ✅ Implemented (ripgrep backend) |
| [`src/core/prompts/tools/native-tools/grep_search.ts`](extensions/shofer/src/core/prompts/tools/native-tools/grep_search.ts) | ✅ Schema (unchanged)            |
| [`src/core/prompts/tools/native-tools/index.ts`](extensions/shofer/src/core/prompts/tools/native-tools/index.ts)             | ✅ Registered                    |
| [`src/core/assistant-message/NativeToolCallParser.ts`](extensions/shofer/src/core/assistant-message/NativeToolCallParser.ts) | ✅ Maps all 10 params            |
| [`src/core/tools/__tests__/GrepSearchTool.spec.ts`](extensions/shofer/src/core/tools/__tests__/GrepSearchTool.spec.ts)       | ✅ Updated for ripgrep           |

### Files NOT Modified

| File                            | Reason                     |
| ------------------------------- | -------------------------- |
| `src/services/ripgrep/index.ts` | Still used by `list_files` |

## Gaps, Issues & Improvement Areas

1. **Parser accepts `pattern` as a fallback for `query`.** Some models (notably when also using `sed`/`find_files`, which both use `pattern`) confabulate `pattern` as the parameter name for `grep_search`. The schema declares only `query` (keeping the API surface clean and consistent with `rag_search`/`lsp_search`/`git_search`), but the parser in [`NativeToolCallParser.ts`](../src/core/assistant-message/NativeToolCallParser.ts) silently falls back to `pattern` when `query` is missing — the same pattern used for [`fileTypes ?? file_pattern`](../src/core/assistant-message/NativeToolCallParser.ts:567). This is a parser-level resilience measure, not a schema alias.

2. **Trade-offs table `.shoferignore` row is stale.** The table says "Post-filter via `ShoferIgnoreController`" but the current implementation also passes `--ignore-file <path-to-.shoferignore>` to ripgrep natively (see [`buildRipgrepArgs`](../src/core/tools/GrepSearchTool.ts:220-222)), so ignored files are excluded at the search level — not solely via post-filter. The post-filter in `execute()` is retained as a safety net. The doc should reflect the dual `.shoferignore` exclusion strategy (native rg flag + post-filter safety net).

3. **Ripgrep CLI Mapping code example is simplified.** The code block at §Ripgrep CLI Mapping omits the `--ignore-file` argument that `buildRipgrepArgs` adds when `.shoferignore` is loaded. It also omits the `directoryPath` → `resolvedPath` (absolute) conversion. These are acceptable simplifications for a conceptual mapping, but they differ from the actual source.

4. **Output format example match-line padding off by one space.** The code at [`formatResults`](../src/core/tools/GrepSearchTool.ts:489-491) produces `${prefix} ${paddedNum}` where `paddedNum` is `String(lineNum).padStart(4, " ")`. For match lines this yields `>   42 |` (3 spaces between `>` and the number). The doc example shows `>  42 |` (2 spaces). The format spec says "4-digit padded" which is correct; the example drifted.

5. **"No results" message inconsistency across error paths.** When ripgrep executes successfully but produces no hits, the tool returns `No results found for: <query>`. When ripgrep itself errors (binary missing, spawn failure), the tool returns `"Search failed: Could not find ripgrep binary"` for missing binary OR `No results found for: <query>` for generic spawn errors (line 383). The doc only documents the `No results found for: <query>` message — the binary-missing message is an undocumented variant.

6. **The `2× maxResults` fetch buffer is not documented.** The tool fetches `2 * maxResults * linesPerResult` worth of ripgrep lines to ensure the post-processing hit count can exceed `maxResults` and trigger the truncation flag. This implementation detail is not mentioned in the doc but matters for understanding why the tool might return fewer than `maxResults` results even when more exist — if all `maxResults` hits come from the first `maxResults * linesPerResult` lines, the buffer is never exceeded.

7. **OpenAI schema `required` array marks all 10 params as required.** Although `fileTypes`, `excludePattern`, `isRegex`, etc. all have `null` defaults and are semantically optional, the schema declares them all `required` (lines 105-116 of `grep_search.ts`). This is intentional for `strict: true` mode but can confuse readers who see the doc's "Required" column showing ✅ for nullable params.

8. **Cross-reference to related tools not present.** The doc does not mention sibling search tools (`rag_search`, `git_search`) that share the same result-cap infrastructure via [`searchCap.ts`](../src/core/tools/helpers/searchCap.ts). Users choosing between `grep_search`, `rag_search`, and `git_search` would benefit from a brief comparison. The shared `formatTruncationHeader` ensures consistent header wording, which is an intentional design decision worth noting.
