# Shofer — Launch & Promotion

A single working doc for taking Shofer to market: the ready-to-post announcement, where and how to post it, a launch playbook drawn from comparable tools, and the competitive landscape for positioning.

**Contents**

1. [Ready-to-post announcement](#1-ready-to-post-announcement)
2. [Post flair / tags](#2-post-flair--tags)
3. [Where to post — ordered by ease](#3-where-to-post--ordered-easiest--hardest)
4. [Launch / announcement playbook](#4-launch--announcement-playbook)
5. [Competitive landscape](#5-competitive-landscape)

---

## 1. Ready-to-post announcement

**Title:** Shofer — an Apache-2.0 AI coding agent with deterministic multi-agent workflows and unparalleled observability

**Body:**

Hey r/opensource,

I want to share **Shofer** ([github.com/shofer-dev/shofer](https://github.com/shofer-dev/shofer)), an open-source (Apache 2.0) AI coding agent that lives — for now — inside VS Code. The name comes from the French _chauffeur_ — a driver.

The space is crowded, so I'll be upfront about what's actually _different_ vs. what's just table stakes.

**What I think genuinely sets it apart:**

- **Deterministic multi-agent workflows.** Instead of an LLM ad-hoc deciding to spawn sub-agents at runtime, you can encapsulate a multi-agent collaboration pattern in a `.slang` file — agents, message routing, control flow, convergence points, budgets. A _non-LLM_ executor drives it, so runs are repeatable and inspectable. Ships with two built-in ones (collaborative troubleshooting; feature implementation).
- **Live agent visualizations and analytics.** You watch the agent tree execute as topology / sequence / swimlane diagrams in-editor, with a cost+active-time breakdown across the whole tree. Less black box.
- **Live Memory.** A persistent, _read-only_ AI companion that accumulates codebase knowledge over time — and survives task completion. It runs on a cheap large-context model of your choice, and it stays up to date as the codebase evolves, so it keeps getting smarter about your repo without burning tokens.
- **Kernel-level command sandboxing (Linux).** Shell commands run in an OS-level write-only sandbox (Landlock/bwrap) scoped to the active git worktree. It's a deterministic guarantee.
- **Semantic search over code _and_ git history.** `git_search` finds _why_ and _when_ a change was made, not just where it lives.
- **Hard cost caps.** Per-task / per-session USD limits that halt runaway loops, across any provider.

**The honest "table stakes" part** — parallel tasks, custom modes, RAG, MCP support, git worktree & submodule support, bring-your-own-model (BYOM), and support for dozens of LLM providers.

It's an open-source project — Apache 2.0, contributions welcome, migration guides if you're coming from Copilot / Claude Code / OpenCode.

Links: [GitHub](https://github.com/shofer-dev/shofer) · [Website](https://shofer.dev) · [User Manual](https://github.com/shofer-dev/shofer/blob/master/USER_MANUAL.md)

Happy to answer questions about the architecture.

---

## 2. Post flair / tags

**Post flair / tags (set at submission):**

- **r/opensource:** use the **`Promotional`** flair — the sub requires self-promotion posts to be flaired this way, and posting your own project without it risks removal. (If you reframe a future post as a pure technical writeup with no "check out my tool" ask, `Discussion` can fit instead.)
- **Cross-posting elsewhere, pick the closest available flair per sub:**
    - r/ChatGPTCoding → `Resources & Tips` or `Project Showcase`
    - r/LocalLLaMA → `Resources` / `Tutorial | Guide` (no generic "show off" flair; lead with local/offline)
    - r/SideProject → `Show & Tell` / `Launch`
    - r/coolgithubprojects → tag with the primary language (e.g. `TypeScript`)
    - r/programming → no self-promo flair; only post as a technical writeup
- **General etiquette:** always check the sub's sidebar/rules for required flair before submitting, and disclose you're the author. Many subs auto-remove unflaired or undisclosed self-promotion.

---

## 3. Where to post — ordered easiest → hardest

**For a low-karma account**

Note: subs don't publish their exact karma/account-age thresholds (they're enforced by private AutoModerator rules), so this is ordered by how lenient each is _in practice_. With low karma, start at the top, build some karma by commenting, then work down the list.

_Tier 1 — minimal/no barrier, self-promo welcome:_

1. **r/Shofer_dev** — your own sub, zero barrier. Post here first as home base.
2. **r/SideProject** — very newcomer-friendly, built for "show & tell." Almost no karma gate.
3. **r/coolgithubprojects** — purpose-built for sharing repos; very low barrier.
4. **r/devtools** — small and lenient; exact audience.
5. **r/AI_Agents** — relatively open and growing; lead with the deterministic-workflow angle.
6. **r/IndieDev / r/indiehackers** — lenient maker communities.

_Tier 2 — moderate; some karma/account age helps, self-promo tolerated if not salesy:_ 7. **r/ChatGPTCoding** — fairly open but actively moderated; your single best _audience_ fit. A little karma helps. 8. **r/vscode** — moderate barrier; frame as a VS Code extension. 9. **r/LocalLLaMA** — large with spam filters; account age/karma helps. Self-promo is tolerated only if it reads technical, not promotional — lead hard with local/offline (Ollama).

_Tier 3 — stricter; meaningful karma/age and tight self-promo rules:_ 10. **r/opensource** — requires the `Promotional` flair and gates low-karma/new accounts. Come back once you've built some karma. 11. **r/Anthropic / r/ClaudeAI / r/OpenAI** — moderate-to-strict; only via the relevant migration/"use these models in VS Code" framing, not the generic announcement.

_Tier 4 — hardest; high bar, self-promo essentially disallowed:_ 12. **r/programming** — very strict; generic tool posts get removed. Only viable as a genuine technical writeup (e.g. "building a deterministic, non-LLM-driven multi-agent executor"). 13. **r/MachineLearning** — strict; research-framed only.

Practical sequence: post Tier 1 first (spread over several days, rewriting the lead per sub), comment and gather karma, then move to Tier 2, and save r/opensource and r/programming for when your account has more standing.

---

## 4. Launch / announcement playbook

**What worked for comparable AI dev tools**

Reddit is only one channel. These recent open-source AI-dev tools each combined a GitHub launch with one or two amplification moves. Patterns worth copying for Shofer:

- **Superpowers** (agentic skills / TDD-enforcing framework for Claude Code & Codex; `obra/superpowers` by Jesse Vincent / Prime Radiant) — _launched directly as an open-source GitHub repo._ Takeaway: a clean, opinionated GitHub repo with a strong README _is_ the launch. The framework-with-a-methodology angle (enforced engineering practices) is what gave it a hook beyond "another tool." Shofer's equivalent hook is the **deterministic, non-LLM-driven workflow executor** — lead writeups with the _methodology_, not the feature list.
- **Understand Anything** (multi-agent pipeline that turns a codebase into an interactive knowledge graph; `Lum1104/Understand-Anything` by Yash Thakker, May 2026) — _GitHub launch amplified with detailed write-ups on a company blog (explainx.ai) and Dev.to, plus a demo video_ mapping a real repo. Takeaway: pair the repo with (1) a long-form blog post and (2) a **short screen-recorded demo** of the live agent visualization on a real codebase — that visual is Shofer's most shareable asset.
- **Headroom** (local proxy doing lossless context compression to cut LLM inference cost; `chopratejas/headroom` by Tejas Chopra, Netflix) — _open-sourced on GitHub, then revealed via a conference talk with concrete cost-saving metrics, which drove press pickup (The Register)._ Takeaway: **numbers travel.** Shofer has two metric-driven stories — hard per-task USD cost caps and KV-cache-friendly Live Memory. A post or talk framed around "how we cap and cut agent spend" with real before/after numbers earns coverage that a feature tour won't.

Channels to line up alongside Reddit, in rough order of effort:

1. **GitHub** — the repo README is the canonical launch surface; make sure it's polished before any post drives traffic.
2. **Dev.to / Hashnode / personal or company blog** — one long-form technical writeup per standout feature (workflow executor; Live Memory; sandboxing). Reuse as the r/programming "writeup" angle.
3. **Demo video** (YouTube / asciinema / GIF in README) — record the live agent diagrams executing a workflow on a real repo; embed everywhere.
4. **Hacker News** ("Show HN: Shofer — …") — high-leverage for technical writeups with a strong hook; time it with the blog post.
5. **Conference talk / lightning talk** — the metrics-driven angle (cost caps, token savings) is the kind of content that earns press pickup, per Headroom.
6. **X/Twitter, LinkedIn, Discord** — short-form amplification linking back to the repo and blog.

---

## 5. Competitive landscape

**VS Code extension agents (for positioning & comparison posts)**

Shofer competes in the _extension_ category (not the IDE-fork category). Knowing the field sharpens both the migration guides and any "X vs Y" framed posts. The main extension-based agents:

- **Cline** — the original; Roo Code is a direct fork of it. Strong model flexibility (OpenRouter, Anthropic, OpenAI, local) and an early MCP champion. Leans **human-in-the-loop** (approve before executing). The blueprint of the category.
- **Roo Code** — Cline fork; generally beats Cline on custom modes and speed. _Shofer ships a `/migrate-from-roocode` path_ — this is the closest direct competitor to position against.
- **Kilo** — another Roo Code fork, fully open-source and strictly VS Code-first. Same autonomous-agent experience, community-driven trajectory. Overlaps heavily with Shofer's open-source positioning.
- **Cody (Sourcegraph)** — strongest at **retrieving context across massive codebases** (their search heritage). Model choice + chat + inline autocomplete. Shofer's counter is `rag_search` + `git_search` (semantic over code _and_ git history).
- **GitHub Copilot** — the 800-lb gorilla; Chat + Agent Mode now make it a direct competitor, with model switching (incl. Claude). Deeply integrated and stable, but fewer autonomous workspace-editing features. _Shofer ships `/migrate-from-copilot`._
- **Codeium** — best purely _free_ option for autocomplete + chat; fast, but not agentic multi-file autonomous editing. Less of a direct competitor (different job).
- **Phind** — strength is **web search for latest docs** synthesized against your local files; great for bleeding-edge frameworks. Overlaps with Shofer's Web Search mode.
- **Continue.dev** — excellent for local models and flexibility; popular open-source extension. Overlaps with Shofer's BYO-model / local-first story.

**Landscape caveat to address head-on:** the industry is shifting toward full VS Code _forks_ (Cursor, Windsurf, Void) because native editor access enables things extensions can't (predictive multi-file edits, deep background indexing) under VS Code's API limits. When posting, pre-empt the "why an extension, not a fork?" question — Shofer's answer is **no lock-in (stay in your real VS Code/Cursor install), Apache-2.0 openness, deterministic multi-agent orchestration, and OS-level sandboxing** — capabilities that don't require forking the editor. Lean into what extensions _can_ uniquely do well rather than competing on the fork's turf.

**Positioning summary for posts:** against forks → "keep your editor, no lock-in, open source." Against other extensions → "the only one with _deterministic, declarative_ multi-agent workflows + live visualization + kernel-level sandboxing," not just another autonomous agent.
