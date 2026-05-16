# `grep_search` Tool — Design & Reference

## Purpose

Unified file-content search using **ripgrep** as its backend. Executes `rg` as a child process with `--json` output for structured, deterministic results that don't depend on VS Code's internal search index.

## Backend Rationale

The tool previously used VS Code's [`workspace.findTextInFiles`](https://code.visualstudio.com/api/references/vscode-api#workspace.findTextInFiles) API. In practice, `findTextInFiles` was found to have an incomplete search index — certain tokens (e.g., the Go `func` keyword) were systematically not found despite being present in files that `grep` and ripgrep locate instantly. Ripgrep provides a filesystem-level search that is:

- **Deterministic** — same results every time, regardless of VS Code indexing state
- **Fast** — ripgrep is optimized for code search performance
- **Complete** — searches the actual filesystem, not a cached index

### Trade-offs

| Aspect               | `findTextInFiles`                     | ripgrep                                  |
| -------------------- | ------------------------------------- | ---------------------------------------- |
| Completeness         | Depends on VS Code index (incomplete) | Filesystem-level (complete)              |
| Regex syntax         | JavaScript regex                      | Rust regex (subtle differences)          |
| `.gitignore` respect | Yes (default)                         | Yes (default)                            |
| `.shoferignore`      | N/A                                   | Post-filter via `ShoferIgnoreController` |
| Performance          | Fast (indexed)                        | Fast (native binary)                     |

**Known difference:** When `isRegex: true`, the pattern is interpreted as a **Rust regex** (ripgrep's native syntax), not JavaScript regex. For most common patterns (literals, character classes, quantifiers, alternation) the syntax is identical. Edge cases like lookahead/lookbehind may differ.

## Input Parameters

All parameters below are in the OpenAI function-calling schema (`strict: true`, `additionalProperties: false`).

| Parameter        | Type              | Required | Default | Description                                                                         |
| ---------------- | ----------------- | :------: | :-----: | ----------------------------------------------------------------------------------- |
| `path`           | `string`          |    ✅    |    —    | Directory to search recursively, relative to workspace root                         |
| `query`          | `string`          |    ✅    |    —    | The search pattern (regex or literal text)                                          |
| `fileTypes`      | `string \| null`  |    ✅    | `null`  | Glob pattern to filter files (e.g., `*.ts`, `**/*.go`). `null` = all files.         |
| `excludePattern` | `string \| null`  |    ✅    | `null`  | Glob pattern to exclude files (e.g., `**/node_modules/**`). `null` = no exclusions. |
| `isRegex`        | `boolean \| null` |    ✅    | `true`  | Whether `query` is a regular expression. When `false`, query is matched literally.  |
| `caseSensitive`  | `boolean \| null` |    ✅    | `false` | Case-sensitive matching.                                                            |
| `wholeWord`      | `boolean \| null` |    ✅    | `false` | Match whole words only (uses ripgrep `-w` flag). Ignored when `isRegex=true`.       |
| `maxResults`     | `number \| null`  |    ✅    |  `100`  | Maximum total results across all files.                                             |
| `contextBefore`  | `number \| null`  |    ✅    |   `1`   | Lines of context to show before each match.                                         |
| `contextAfter`   | `number \| null`  |    ✅    |   `1`   | Lines of context to show after each match.                                          |

## Ripgrep CLI Mapping

```typescript
// Core args for every invocation
const args = ["--json", "--no-messages"]

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

| File                            | Reason                                               |
| ------------------------------- | ---------------------------------------------------- |
| `src/services/ripgrep/index.ts` | Still used by `read_command_output` and `list_files` |
