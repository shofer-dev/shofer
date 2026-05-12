# Shofer Code Statistics

Generated via `git diff --shortstat` on the `extensions/shofer` repository.

## Three-Stage Line Count

### Stage Boundaries

| Stage          | From                                     | To                                | Dates                   | Commits |
| -------------- | ---------------------------------------- | --------------------------------- | ----------------------- | ------- |
| **Shofer**     | `9f169b7e4` (Initial commit)             | `385c54d3c` (Refactor Shofer)     | 2024-07-05 → 2024-10-05 | 784     |
| **Shofer**     | `6502b3cb2` (Rename Shofer — fork point) | `67def7214` (last pre-Alexandros) | 2024-10-06 → 2026-04-13 | 6,261   |
| **Alexandros** | `30a1c1fcb` (first commit)               | `502facb10` (HEAD)                | 2026-04-14 → 2026-05-08 | 180     |

### Lines Added (all files — `git diff --shortstat insertions`)

| Stage          | Files Changed | Insertions (+) | Deletions (-) |
| -------------- | :-----------: | :------------: | :-----------: |
| **Shofer**     |      140      |   **47,472**   |      904      |
| **Shofer**     |     2,694     |  **510,358**   |    46,548     |
| **Alexandros** |      260      |   **22,775**   |     4,772     |
| **Total**      |       —       |  **580,605**   |       —       |

### Lines Added (source code only — excluding lockfiles, locales, snapshots, dist, SVG, CHANGELOG)

| Stage          | Insertions (+) | Deletions (-) |   Net    |
| -------------- | :------------: | :-----------: | :------: |
| **Shofer**     |     26,345     |      902      | +25,443  |
| **Shofer**     |    491,746     |    25,466     | +466,280 |
| **Alexandros** |     22,775     |     4,772     | +18,003  |

### Codebase Size at Each Boundary (total source lines, same exclusions)

| Boundary                     | Total Lines |
| ---------------------------- | :---------: |
| End of Shofer (`385c54d3c`)  |   20,117    |
| Pre-Alexandros (`67def7214`) |   438,602   |
| HEAD (current)               |   456,544   |

---

## Shofer Phase Breakdown

The Shofer phase spans **18 months** (Oct 2024 → Apr 2026) and **6,261 commits** — a full commercial product built on top of the Shofer skeleton.

### Category Breakdown (excluding lockfiles, locales, snapshots, dist, SVG, CHANGELOG)

| Category                          | Insertions  | Files     | % of Total |
| --------------------------------- | ----------- | --------- | ---------- |
| **Tests (.spec/.test/**tests**)** | **204,561** | 664       | **41.6%**  |
| TypeScript source (.ts)           | 189,569     | 1,178     | 38.6%      |
| JSON (config, pkg.json, i18n)     | 56,906      | 402       | 11.6%      |
| YAML (CI/CD, docker, etc.)        | 24,105      | 23        | 4.9%       |
| Docs (.md)                        | 5,030       | 49        | 1.0%       |
| CSS                               | 2,813       | 5         | 0.6%       |
| Shell/JS/Other                    | 8,762       | 190       | 1.8%       |
| **TOTAL**                         | **491,746** | **2,511** | **100.0%** |

### Tests vs Production Code

Tests outweigh production code — a **107.9% test/code ratio**:

| What                      | Lines   |
| ------------------------- | ------- |
| Test code                 | 204,561 |
| Production TypeScript/TSX | 189,569 |

### Top Test Files

| File                                                | Lines Added |
| --------------------------------------------------- | ----------- |
| `src/core/webview/__tests__/ShoferProvider.spec.ts` | 3,677       |
| `src/services/mcp/__tests__/McpHub.spec.ts`         | 2,371       |
| `src/core/config/__tests__/importExport.spec.ts`    | 2,269       |
| `src/core/task/__tests__/Task.spec.ts`              | 2,190       |
| `.../code-index/__tests__/config-manager.spec.ts`   | 1,931       |
| `.../vector-store/__tests__/qdrant-client.spec.ts`  | 1,778       |
| `src/api/providers/__tests__/openai-native.spec.ts` | 1,763       |
| `.../config/__tests__/CustomModesManager.spec.ts`   | 1,760       |
| `.../skills/__tests__/SkillsManager.spec.ts`        | 1,759       |

### Production Code by Subsystem

| Directory                     | Lines  | Files | Purpose                                      |
| ----------------------------- | ------ | ----- | -------------------------------------------- |
| `packages/`                   | 23,754 | 178   | Shared types, IPC, cloud, evals, telemetry   |
| `apps/cli/`                   | 15,150 | 95    | Headless CLI tool                            |
| `src/api/providers/`          | 13,791 | 53    | 30+ LLM provider integrations                |
| `src/services/`               | 14,522 | 85    | MCP, code indexing, embeddings, search, etc. |
| `src/core/webview/`           | 8,099  | 10    | Extension host ↔ UI messaging               |
| `src/core/tools/`             | 7,443  | 32    | Tool implementations                         |
| `src/core/task/`              | 5,207  | 5     | Task orchestration engine                    |
| `src/core/config/`            | 2,825  | 4     | Settings, modes, profiles                    |
| `src/core/assistant-message/` | 2,076  | 4     | LLM response parsing                         |
| `src/services/mcp/`           | 2,081  | 2     | MCP server integration                       |

### JSON Breakdown

Excluding lockfiles, the ~57K JSON lines are:

| Category               | Approx. Lines | Description                                                       |
| ---------------------- | ------------- | ----------------------------------------------------------------- |
| i18n translation files | ~48,000       | 18+ languages × ~2.7K per locale (settings, chat, commands, etc.) |
| Web app config         | ~3,400        | `apps/web-shofer-code/` package.json, nextjs config, etc.         |
| Package manifests      | ~1,250        | 18 `package.json` files across monorepo                           |
| Other JSON             | ~5,250        | Schema files, tsconfigs, evals fixtures                           |

### YAML Breakdown

| File                                  | Lines  |
| ------------------------------------- | ------ |
| `pnpm-lock.yaml`                      | 22,438 |
| CI/CD workflows (`github/workflows/`) | ~1,200 |
| Docker compose                        | ~200   |
| Issue templates                       | ~270   |

---

## Raw Commands Used

```bash
# Stage boundaries
git log --format="%h %ad %s" --date=short <commit> -1

# All-files line counts
git diff --shortstat <from> <to>

# Source-only line counts (no lockfiles, locales, snaps, dist, flags, icons, changelog)
git diff --shortstat <from> <to> -- . \
  ':(exclude)**/package-lock.json' \
  ':(exclude)**/pnpm-lock.yaml' \
  ':(exclude)**/yarn.lock' \
  ':(exclude)locales' \
  ':(exclude)**/locales' \
  ':(exclude)*.snap' \
  ':(exclude)dist' \
  ':(exclude)out' \
  ':(exclude)*.vsix' \
  ':(exclude)CHANGELOG.md' \
  ':(exclude)*.svg' \
  ':(exclude)node_modules' \
  ':(exclude)releases'

# Total source lines at a commit
git ls-tree -r <commit> --name-only | \
  grep -v 'node_modules\|pnpm-lock\|package-lock\|yarn.lock\|locales/\|\.snap$\|dist/\|out/\|\.vsix$\|CHANGELOG\|\.svg$\|releases/' | \
  xargs -I{} git show <commit>:{} 2>/dev/null | wc -l
```
