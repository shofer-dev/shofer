- **A child's dangerous-tool APPROVAL has no audience on a remotely driven host.**
  A child's `tool` / `command` / `use_mcp_server` approval asks are published only
  on the child's own stream, which a controller subscribed to the conversation's
  root does not consume, so a child that reaches for a gated tool parks. Unlike a
  QUESTION — which reaches its parent's mailbox as a `request` and is answered
  with `reply` — an approval has a different audience (whoever holds that
  authority on the project, not the parent), so it cannot inherit the question
  path: a controller's approval surface has to be part of the same change. Not
  urgent while deployed worker bundles auto-approve their declared groups; it is
  the first thing to break when one does not.

- **Three per-task shaping options have no caller.** `agentRole`,
  `agentToolGroups` and `agentContext` on `CreateTaskOptions` (and their
  `Task` fields) are live plumbing with nothing that sets them:
  `agentRole` prepends an `# Agent Role` block to the task's custom
  instructions, `agentToolGroups` narrows the assembled tool list to the
  declared groups (`restrictToolsToDeclaredGroups` in `build-tools.ts`), and
  `agentContext` is the first layer of the system-prompt section gates
  (`docs/system_prompt.md`). All three are threaded into the system-prompt cache
  key, so they work — nobody asks. Their sibling `completionSchema` is the
  exception: it IS driven, through `ctx.agent.spawn({ completionSchema })`
  (`docs/output_contract_enforcement.md`), which is also the shape of the fix.
  They were kept rather than deleted because they are general per-task shaping
  options and the plugin / agent-spawn seam is where a caller would want them.
  Two ways out, and one must be picked rather than left: **(a)** expose all
  three on `PluginAgentSpawnOptions` beside `completionSchema`, so one caller
  can describe a spawned task's role, tool surface and prompt sections through a
  single seam; or **(b)** delete them along with their prompt-assembly and
  build-tools threading. Leaving them is the status quo, which reads to the next
  reader as a supported feature.

- **Index identity is controller-scoped, not globally unique.** `_resolveIndexKeyPath`
  prefers the controller-assigned `codebaseIndexKey`, which fixes the case that bit us
  (executor pods all running `--workspace /home/node/workspace` colliding on one Qdrant
  collection despite unshared filesystems). It does NOT cover two _independent
  controllers_ that both sit at an identical path and share one Qdrant — they still
  derive the same collection name from different content. Closing that means deriving
  the key from something globally stable (git remote URL + repo root, or an explicit
  operator-assigned index id) rather than a path. Deferred: today every deployment has
  one controller per Qdrant, so the collision is unreachable.

- **The RAG indexer is transient.** The controller being the sole indexer is a
  consequence of the indexer living in-process. When it moves to a standalone k3s
  service that everyone queries, the plugin's `searchOnly` mode collapses — the controller
  becomes just another query client and the sole-writer invariant moves into the
  service. Don't build more machinery on top of "the controller is special" than the
  sole-writer rule already requires.

- **One dependency advisory left open**, and it is the only one: `pnpm audit`
  residue is 0 critical / 0 high / 0 moderate / 1 low.

    - `@ai-sdk/provider-utils` (via `sambanova-ai-provider`, runtime):
      GHSA-866g-f22w-33x8, low. There is genuinely no fixed release — the
      advisory covers `<=3.0.97` and the 3.x line stops at 3.0.31, so no
      patched 3.x exists. Escaping it means `@ai-sdk/provider-utils` 4.x/5.x,
      which belongs to AI SDK v6, while `sambanova-ai-provider` 1.2.2 pins
      `@ai-sdk/provider-utils` at exactly `3.0.5` against `@ai-sdk/provider`
      `2.0.0`. Forcing the jump would break the provider's API contract, so
      this waits on `sambanova-ai-provider` moving. Revisit when it does.

- **Three `pnpm.overrides` force a version outside the dependent's declared
  range.** Each replaces a transitive-only advisory the dependent has not
  picked up, and each was checked for module-format and API compatibility
  against the actual call site rather than assumed safe. Drop the override once
  the dependent's own range covers the fix:

    - `serialize-javascript@<7.0.5 → >=7.0.5` — `mocha` declares `^6.0.2` and
      no 6.x fix exists. 7.x is still CommonJS (`main: index.js`) with
      `engines.node >=20`, and `apps/vscode-e2e` (the only consumer, dev-only)
      runs mocha serially, where serialize-javascript is not even loaded — it
      is mocha's parallel-worker serializer.
    - `sharp@<0.35.0 → >=0.35.0` — `next` 16.2.12 (the newest) declares
      `sharp: ^0.34.5` as an _optional_ dep, used only by its image optimizer.
      The advisory is inherited libvips CVEs. `apps/web-evals` only, dev-only.
    - `uuid@<11.1.1 → >=11.1.1 <12` — `gaxios` 6.7.1 (under
      `google-auth-library` 9.15.1, a **runtime** dep of `packages/core` and
      also pulled by `@anthropic-ai/vertex-sdk` 0.7.0) declares `uuid ^9.0.1`
      and calls `require("uuid").v4()` for a multipart boundary;
      `@azure/msal-node` 3.5.3 (packaging-time, under `@vscode/vsce`) does
      `import { v4 } from "uuid"`. uuid 11 keeps both the CJS and ESM `v4`
      named exports, and both call sites were smoke-tested against it.
      Clearing this properly needs `google-auth-library` 10 (whose `gaxios` 7
      dropped `uuid` entirely), which in turn needs
      `@anthropic-ai/vertex-sdk` ≥0.19 and therefore `@anthropic-ai/sdk`
      `>=0.50.3` against the pinned `^0.37.0` — a real provider-code migration,
      not a version bump.

- **`undici` is capped at `>=6.27.0 <7` and that cap is correct, not debt.**
  6.27.0 is the _patched_ release; there is no open undici advisory. The cap is
  not silencing anything, and moving to 7 or 8 would be churn with no security
  benefit. (For the record, the Node floor is not what holds undici back:
  undici 7 needs only Node `>=20.18.1`, below the declared `>=20.19.2`. Only
  undici **8** needs Node `>=22.19.0`.)

- **A headless host's seeded approval posture is still persisted, and can shadow
  a policy added later.** `ExtensionHost` omits every approval key a `.shofer/`
  scope supplies, so an operator's config is authoritative and is never
  overwritten. But a key **no** scope supplies is still seeded, and the seed
  travels through `ContextProxy.setValue`, which write-throughs to the user
  scope's `~/.shofer/settings.json`. So a node with a persistent home that first
  ran with no approval config materialises `autoApprovalEnabled: true` (etc.)
  into its _user_ scope; if the operator later sets that key in the **global**
  scope without locking it, the unlocked merge (project > user > global) keeps
  the persisted seed winning. The workaround exists and is the intended one —
  name the key in the global scope's `locked.json`, which inverts the merge and
  makes the global value final — but "an unlocked global policy can be shadowed
  by a value the host itself wrote" is a sharp edge worth removing. The clean fix
  is an ephemeral settings-delivery path (a seed that populates `globalState`
  without write-through), which does not exist today; adding one touches every
  CLI-seeded setting, not just approvals, so it was left out of scope.
