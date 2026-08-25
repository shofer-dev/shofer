- **A sync child's dangerous-tool APPROVAL still has no audience on a remotely
  driven host.** `ask_followup_question` from a synchronously spawned child is
  now republished on the root conversation's event stream
  (`API.escalateFollowupToConversation`, `docs/parallelism.md`), but the same
  invisibility applies to the child's `tool` / `command` / `use_mcp_server`
  approval asks: they are published only on the child's own stream, which no
  controller subscribes to, so a child that reaches for a gated tool parks and
  takes its suspended parent with it. The mechanism generalises exactly — widen
  the predicate from `ask === "followup"` to the interactive-ask set — but the
  AUDIENCE differs (an approval goes to whoever holds that authority on the
  project, not to whoever set the work in motion), so a controller's approval
  surface has to be part of the same change rather than inheriting the question
  path by accident. Not urgent while deployed worker bundles auto-approve their
  declared groups; it is the first thing to break when one does not.

- **"Is a driver attached?" is answered per SERVER, not per controller.**
  `isConversationDriverAttached` reads the HTTP transport's live subscriber
  census (`createStreamSubscribers`), so it says an SSE connection is open on the
  conversation — not that a human is on the other end of it. A controller that
  holds the stream open while nobody is watching (a browser tab closed with the
  server-side consumer still running, which is the DESIGNED behaviour) reads as
  an audience, so the fail-fast in `AskFollowupQuestionTool` catches only the
  unambiguous case: nothing subscribed for long enough that no reconnect explains
  it (`SUBSCRIBER_REATTACH_GRACE_MS` in the census plus the one re-check in
  `confirmNoConversationDriver` — `docs/parallelism.md`). Bounding the resulting
  wait is the controller's job (it owns the durable question row and its
  deadline), and this host deliberately has no timer that resolves an ask; the
  two tolerance windows only bound how confidently it may assert that a question
  reaches nobody, and neither supplies an answer, an approval or a refusal.

- The marketplace removal left the `plugin` channel's `installFromFile` /
  `installFromUrl` / `uninstall` actions (and their host handlers) with no webview
  caller — install/uninstall are CLI verbs (`shofer plugin install|remove`) and
  `.shofer/plugins.json` declarations only. If a UI install surface is wanted
  again, re-home those affordances into Settings → Plugins (`PluginsSettings`),
  which already owns enable/disable, config, and AI consent.

- Parallel Live Memory

- "Global Settings (JSON-only, no settings UI)" expose these settings on the Settings UI. Move these out of settings.json:
  | Setting | Purpose | Default |
  | -------------------------------- | ---------------------------------------- | ----------------- |
  | `shofer.defaultCostLimit` | Per-task USD budget cap | `null` (disabled) |
  | `shofer.disabledTools` | Globally disable specific tools | `[]` |
  | `shofer.useAgentRules` | Load `AGENTS.md` rule files from project | `true` |
  | `shofer.commandExecutionTimeout` | Max seconds for command execution | `0` (no timeout) |
  | `shofer.commandTimeoutAllowlist` | Commands exempt from timeout | `[]` |

- DEV Simplify the Settings overlay (use VScode's own settings.json)

- DEV memories (copilot_memory, copilot_resolveMemoryFileUri) (filter by age)

- preemptive summarization (in the background)

- test the migration commands

- TypeScript 7 checker uses the **`@typescript/native-preview`** (`tsgo`) dev
  build, not stable `typescript@7`. Stable TS 7 can't be a devDep here: its
  package's real name is `typescript`, so under pnpm it hijacks the `typescript`
  peer of every TS 6-only consumer (typescript-eslint, tsup's `.d.ts` generator,
  zod-to-ts) and breaks them (TS 7 ships no classic compiler API). There is no
  distinctly-named stable wrapper to escape that collision: `@typescript/native`
  does not exist on npm (confirmed against the public registry — not a Nexus
  mirroring gap), and `@typescript/native-preview` has no non-`-dev` release yet.
  So `tsgo` (a pre-GA build of the same TS 7 engine) is the best available TS 7
  compiler with a non-colliding package name. Revisit when either a stable
  distinctly-named native package ships, or typescript-eslint + tsup gain TS 7 /
  API support — at which point the whole toolchain can collapse onto a single
  `typescript@7` and `check-types` can go back to `tsc`.

- Replace bare `console.log` in extension-host code (AGENTS.md Output Channel Logging Rule — use the shared output channel, not `console.log`): `src/integrations/diagnostics/index.ts` (3 calls), `src/api/providers/vscode-lm.ts` (1 call).

- Give `ask` messages a **typed per-category payload** instead of overloading
  `ShoferMessage.text`. Today an `ask`'s data is category-specific and untyped:
  `command` → raw shell string in `text`; `followup` → question/suggestions;
  `tool` → JSON-ish; `command_output` → empty. Every non-webview ShoferApi consumer
  (user-console, ACP clients) re-parses this per category with ad-hoc heuristics
  that drift. Keep the `ask` discriminant but replace the free-text payload with a
  typed field per category in `@shofer/types` (a discriminated union —
  `commandAsk:{command}`, `toolAsk:{tool,args}`, `followupAsk:{question,suggestions}`,
  …) so consumers get one stable, testable contract. NOT a flat opaque envelope
  (that just relocates the per-category logic). Blast radius: the message contract +
  the webview `ChatRow` per-category rendering + the ACP mapping + tests — do it when
  a second non-webview consumer needs interactive approvals (L2 runs auto-approve, so
  it doesn't today).

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
