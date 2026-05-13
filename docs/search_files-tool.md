# `search_files` Tool — Design & Reference

## Purpose

Unified file-content search using VS Code's indexed [`workspace.findTextInFiles`](https://code.visualstudio.com/api/references/vscode-api#workspace.findTextInFiles) API as its sole backend. Consolidates the old ripgrep-backed `search_files` and the separate `get_search_results` tool into one implementation.

## Input Parameters

All parameters below are in the OpenAI function-calling schema (`strict: true`, `additionalProperties: false`).

| Parameter | Type | Required | Default | Description |
|-----------|------|:--------:|:-------:|-------------|
| `path` | `string` | ✅ | — | Directory to search recursively, relative to workspace root |
| `query` | `string` | ✅ | — | The search pattern (regex or literal text) |
| `fileTypes` | `string \| null` | ✅ | `null` | Glob pattern to filter files (e.g., `*.ts`, `**/*.go`). `null` = all files. |
| `excludePattern` | `string \| null` | ✅ | `null` | Glob pattern to exclude files (e.g., `**/node_modules/**`). `null` = no exclusions. |
| `isRegex` | `boolean \| null` | ✅ | `true` | Whether `query` is a regular expression. When `false`, query is matched literally. |
| `caseSensitive` | `boolean \| null` | ✅ | `false` | Case-sensitive matching. |
| `wholeWord` | `boolean \| null` | ✅ | `false` | Match whole words only (wraps query in `\b` boundaries). Ignored when `isRegex=true`. |
| `maxResults` | `number \| null` | ✅ | `100` | Maximum total results across all files. |
| `contextBefore` | `number \| null` | ✅ | `1` | Lines of context to show before each match. |
| `contextAfter` | `number \| null` | ✅ | `1` | Lines of context to show after each match. |

### Parameter Migration Notes

| Old `search_files` | Old `get_search_results` | New `search_files` |
|---|---|---|
| `path` | *(whole workspace)* | `path` (required) |
| `regex` | `query` | `query` (renamed from `regex`) |
| `file_pattern` | `includePattern` | `fileTypes` (renamed) |
| — | `excludePattern` | `excludePattern` |
| *(always regex)* | `isRegex` | `isRegex` (default `true`) |
| *(smart-case)* | `caseSensitive` | `caseSensitive` (default `false`) |
| — | `wholeWord` | `wholeWord` (default `false`) |
| *(hard 300)* | `maxResults` | `maxResults` (default `100`) |
| *(hard 1 line)* | — | `contextBefore` (default `1`) |
| *(hard 1 line)* | — | `contextAfter` (default `1`) |

## VS Code API Mapping

```typescript
// Path resolution — use Node's path.resolve, NOT vscode.Uri.joinPath.
// Uri.joinPath treats "/" as a segment character, URL-encoding directory paths.
const resolvedPath = path.resolve(task.cwd, relDirPath)

// Query construction
const textQuery: vscode.TextSearchQuery = {
    pattern: wholeWord && !isRegex
        ? `\\b${escapeRegex(query)}\\b`  // wrap literal with word boundaries
        : query,
    isRegExp: isRegex || (wholeWord && !isRegex),
    isCaseSensitive: caseSensitive ?? false,
    isWordMatch: wholeWord ?? false,
}

// Always use RelativePattern — never pass a bare Uri/string as `include`.
// When fileTypes is null, use "**/*" to match all files recursively.
const searchOptions: vscode.FindTextInFilesOptions = {
    maxResults: maxResults ?? 100,
    beforeContext: contextBefore ?? 1,
    afterContext: contextAfter ?? 1,
    include: fileTypes
        ? new vscode.RelativePattern(resolvedPath, fileTypes)
        : new vscode.RelativePattern(resolvedPath, "**/*"),
    exclude: excludePattern ?? undefined,
}

await vscode.workspace.findTextInFiles(textQuery, searchOptions, (result) => {
    // result.uri, result.ranges, result.preview
})
```

### Preview Text & Match Line Position

VS Code's `TextSearchResult.preview.text` format:

```
<beforeContext lines — one per \n>
<match line>
<afterContext lines — one per \n>
```

The match line is at **index `beforeContext`** (0-based) within the split preview text.  
The implementation uses `Math.min(beforeContext, previewLines.length - 1)` to guard against edge cases where the match is near the start/end of the file and fewer context lines are available.

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
- Header: `Found N results.` (or `Found N results.` / `Showing first M of N results.` when truncated)
- Per file: `## relative/path/to/file` followed by matching blocks
- Match lines: `>` prefix, 4-digit padded line number, `| ` separator, then line text
- Context lines: space prefix (no `>`), same line-number padding
- Non-contiguous blocks within the same file are separated by `----`
- Two blank lines between files
- Truncation when `results.length > maxResults`

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

| File | Status |
|------|--------|
| [`src/core/tools/SearchFilesTool.ts`](extensions/shofer/src/core/tools/SearchFilesTool.ts) | ✅ Implemented |
| [`src/core/prompts/tools/native-tools/search_files.ts`](extensions/shofer/src/core/prompts/tools/native-tools/search_files.ts) | ✅ Schema with all new params |
| [`src/core/prompts/tools/native-tools/index.ts`](extensions/shofer/src/core/prompts/tools/native-tools/index.ts) | ✅ `get_search_results` removed |
| [`src/core/assistant-message/NativeToolCallParser.ts`](extensions/shofer/src/core/assistant-message/NativeToolCallParser.ts) | ✅ Maps all 10 params; `file_pattern` → `fileTypes` fallback |
| `src/core/tools/GetSearchResultsTool.ts` | ✅ Deleted |
| `src/core/prompts/tools/native-tools/get_search_results.ts` | ✅ Deleted |
| [`docs/native_tools.md`](extensions/shofer/docs/native_tools.md) | ✅ `get_search_results` row removed, `search_files` updated |
| [`src/core/tools/__tests__/SearchFilesTool.spec.ts`](extensions/shofer/src/core/tools/__tests__/SearchFilesTool.spec.ts) | ✅ 29 unit tests |

### Files NOT Modified

| File | Reason |
|------|--------|
| `src/services/ripgrep/index.ts` | Still used by `read_command_output` and `list_files` |

## Design Decisions & Pitfalls

### 1. Path resolution: `path.resolve` not `Uri.joinPath`

[`vscode.Uri.joinPath`](https://code.visualstudio.com/api/references/vscode-api#Uri.joinPath) treats each argument as a single path *segment*. Passing `"extensions/shofer/src"` encodes the slashes, producing a malformed URI. All other tools in the codebase ([`ListFilesTool`](extensions/shofer/src/core/tools/ListFilesTool.ts), [`WriteToFileTool`](extensions/shofer/src/core/tools/WriteToFileTool.ts), etc.) use `path.resolve(task.cwd, relPath)` — `SearchFilesTool` follows the same convention.

### 2. `include` must be a `GlobPattern`, never a bare `Uri`

[`FindTextInFilesOptions.include`](https://code.visualstudio.com/api/references/vscode-api#FindTextInFilesOptions) accepts `GlobPattern = string | RelativePattern`. A bare `Uri` is not a valid `GlobPattern`. The implementation always constructs a [`vscode.RelativePattern`](https://code.visualstudio.com/api/references/vscode-api#RelativePattern), falling back to `"**/*"` when no `fileTypes` filter is provided.

### 3. Match line index in preview text

VS Code's [`TextSearchResult.preview.text`](https://code.visualstudio.com/api/references/vscode-api#TextSearchResult) includes `beforeContext` lines above the match, then the match line, then `afterContext` lines. The match line is at index `beforeContext` (not `0`). The code uses `Math.min(beforeContext, previewLines.length - 1)` to handle edge cases (match on line 1, match on last line).

### 4. Whole-word literal search

When `wholeWord=true` and `isRegex=false`, the literal query is wrapped in `\b` word-boundary anchors and the regex special characters in the query are escaped. The resulting `TextSearchQuery` has `isRegExp=true` and `isWordMatch=true` — both are set because VS Code applies `isWordMatch` only to regex searches.

## Backward Compatibility

- `regex` param renamed to `query` — the old tool description used "regex" because it always did regex search. Now that literal search is also supported, `query` is more accurate.
- `file_pattern` renamed to `fileTypes` — clearer and matches VS Code's "files to include" UX terminology. Legacy `file_pattern` is still accepted in the native tool call parser.
- `path` is now required — it was required in the old `search_files` anyway.
- All new params are nullable with sensible defaults, so existing call patterns degrade gracefully.
