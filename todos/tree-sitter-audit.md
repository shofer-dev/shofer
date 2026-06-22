# Tree-Sitter Language Query Audit

**Status:** Partially implemented (3/6 fixed)
**Created:** 2026-06-19

## Background

During a `rag_search` investigation, the CSS query was found to have `#match?` predicates
filtering captures to test-fixture strings only (e.g., `"test-keyframe-definition-fade"`),
which blocked ALL real-world CSS from being indexed. This audit checks whether similar
issues exist in other language queries, and identifies missing parser/query coverage.

**Related**: [`extensions/shofer/docs/rag_indexing.md`](../extensions/shofer/docs/rag_indexing.md)

---

## ✅ Predicate Audit (no test-only bugs elsewhere)

| Language   | Predicates Used               | Verdict                                                                                                                                                                      |
| ---------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ruby       | `#match?`, `#eq?`             | ✅ Legitimate — filters to Rails DSL keywords (`has_many`, `belongs_to`, `validates`, `before_action`, etc.) and Ruby metaprogramming (`attr_accessor`, `include`, `extend`) |
| Elixir     | `#match?`, `#eq?`             | ✅ Legitimate — identifies Elixir macros (`def`, `defmacro`, `defstruct`, `defmodule`, `test`, `for`)                                                                        |
| Elisp      | `#match?`, `#eq?`             | ✅ Legitimate — filters to Emacs definition forms (`defcustom`, `defface`, `defgroup`, `defadvice`); `^[^;]` excludes comment-named symbols                                  |
| Kotlin     | `#eq?`                        | ✅ Legitimate — identifies modifiers (`data`, `abstract`, `sealed`, `suspend`, `annotation`, `extension`)                                                                    |
| JavaScript | `#not-eq?`                    | ✅ Legitimate — excludes `constructor` from method definitions                                                                                                               |
| TypeScript | `#match?`, `#eq?`, `#not-eq?` | ✅ Legitimate — identifies test functions (`describe`, `test`, `it`) and constructors                                                                                        |
| HTML       | `#not-eq?`, `#match?`         | ✅ Legitimate — excludes `<script>`/`<style>` from element defs; identifies void elements                                                                                    |
| CSS        | ~~`#match?`~~                 | 🔧 **FIXED** — removed all 10 test-string predicates                                                                                                                         |

---

## 🐛 Unsupported-Language Bugs

Both bugs below have the same shape: the extension is advertised as supported in
`CODEBASE_INDEX_FILE_EXTENSIONS` but `loadRequiredLanguageParsers` has no matching
`case`, so the `default:` throws `"Unsupported language: <ext>"`. Impact depends
on the call site:

- **Indexing path** ([`processors/parser.ts::parseContent`](../extensions/shofer/src/services/code-index/processors/parser.ts:120)) catches the throw, emits `CODE_INDEX_ERROR` telemetry, and returns `[]` — so the file is silently dropped from the RAG index and every such file produces error spam.
- **Definitions path** ([`tree-sitter/index.ts::parseSourceCodeDefinitionsForFile`](../extensions/shofer/src/services/tree-sitter/index.ts:77), used by the `list_code_definition_names` tool) does NOT catch the throw → the tool call fails on the affected file.

### 1. ✅ `.elm` files are unindexable / crash `list_code_definition_names`

- **Status:** FIXED
- **Fix:** Added `.elm` to [`fallbackExtensions`](../extensions/shofer/src/services/code-index/shared/supported-extensions.ts:24) with comment "Elm — no WASM parser available".
- Option A chosen (no Elm WASM available).

### 2. ✅ `.htm` files are unindexable / crash `list_code_definition_names`

- **Status:** FIXED
- **Fix:** Added `case "htm":` alongside `case "html":` at [`languageParser.ts:168`](../extensions/shofer/src/services/tree-sitter/languageParser.ts:168), both sharing `parserKey = "html"`.

---

## ⚠️ Dead Code (no user impact, cleanup candidates)

### 3. 🔴 `.swift` parser loaded but never used — NOT FIXED

- **File**: [`languageParser.ts`](../extensions/shofer/src/services/tree-sitter/languageParser.ts:154-156)
- **File**: [`shared/supported-extensions.ts`](../extensions/shofer/src/services/code-index/shared/supported-extensions.ts:23)
- `.swift` is still in `fallbackExtensions` → `parseContent()` returns fallback-chunked blocks BEFORE reaching `loadRequiredLanguageParsers`. The switch case (loading swift WASM + `swiftQuery`) is never reached.
- **Options**: either remove `.swift` from fallbackExtensions (to actually use the parser) or remove the dead switch case.

### 4. ✅ `.scala` parser loaded but never used (doubly dead)

- **Status:** FIXED
- **Fix:** `.scala` removed from `fallbackExtensions`. [`case "scala":`](../extensions/shofer/src/services/tree-sitter/languageParser.ts:178) now imports and uses `scalaQuery` (was `luaQuery`). The parser is actually live.

---

## 🔍 Coverage Gaps (not indexed but commonly searched) — NOT IMPLEMENTED

| Extension        | Language | Notes                                               |
| ---------------- | -------- | --------------------------------------------------- |
| `.scss`          | SCSS     | CSS superset; would benefit from CSS parser + query |
| `.less`          | Less     | CSS preprocessor                                    |
| `.yaml` / `.yml` | YAML     | Config files, CI pipelines, Kubernetes manifests    |
| `.xml`           | XML      | Common in Java ecosystem, Android, etc.             |
| `.sql`           | SQL      | Database schemas and queries                        |
| `.sh` / `.bash`  | Shell    | Build scripts, CI, devops                           |
| `.dockerfile`    | Docker   | Container definitions                               |

---

## Priority

1. ✅ ~~Fix `.htm` crash~~ — DONE
2. ✅ ~~Fix `.elm` crash~~ — DONE
3. 🔴 **Cleanup dead `.swift` code** — either enable the parser or remove dead switch case
4. ✅ ~~Cleanup dead `.scala` code~~ — DONE
5. 🔵 **Expand indexed extensions** — SCSS, YAML, SQL, Shell for better search coverage
