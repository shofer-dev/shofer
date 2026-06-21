# Shofer — Launch & Promotion

A single working doc for taking Shofer to market. It contains the ready-to-post copy in four voices (announcement, news brief, full news article, Show HN), a **master publishing table** mapping every target venue to its requirements and the right copy variant, a launch playbook drawn from comparable tools, and the competitive landscape for positioning.

**Contents**

1. [Master publishing table](#1-master-publishing-table)
2. [Copy variants](#2-copy-variants)
    - 2.1 [Announcement (promotional, first-person)](#21-announcement-promotional-first-person)
    - 2.2 [Short news brief](#22-short-news-brief)
    - 2.3 [Full news article](#23-full-news-article)
    - 2.4 [Show HN submission](#24-show-hn-submission)
3. [Post flair / tags](#3-post-flair--tags)
4. [Launch / announcement playbook](#4-launch--announcement-playbook)
5. [Competitive landscape](#5-competitive-landscape)

---

## 1. Master publishing table

Ordered roughly easiest → hardest. **Tier** reflects how lenient the venue is _in practice_ for a low-karma / new account. **Copy** references the variant in [§2](#2-copy-variants) that best fits the venue's orientation.

> Reddit karma/account-age thresholds are not published (enforced by private AutoModerator rules), so tiers are based on observed practice. Start at the top, build karma by commenting, then work down.

### Reddit

| #   | Venue                               | Orientation that works                                     | Tier | Ease & requirements                                                                               | Recommended copy                                                                                                             | Flair / format                           | Images / GIF        |
| --- | ----------------------------------- | ---------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | ------------------- |
| 1   | r/Shofer_dev                        | Anything (your own sub)                                    | 1    | Zero barrier — your sub, post first as home base                                                  | Announcement (§2.1)                                                                                                          | Any                                      | ✅ Yes              |
| 2   | r/SideProject                       | "Show & tell" maker projects                               | 1    | Very newcomer-friendly; almost no karma gate                                                      | Announcement (§2.1) or News brief (§2.2)                                                                                     | `Show & Tell` / `Launch`                 | ✅ Yes              |
| 3   | r/coolgithubprojects                | Repo sharing                                               | 1    | Purpose-built; very low barrier                                                                   | News brief (§2.2)                                                                                                            | Tag primary language (e.g. `TypeScript`) | ✅ Yes              |
| 4   | r/devtools                          | Developer tools audience                                   | 1    | Small and lenient; exact audience                                                                 | News brief (§2.2) or Full article (§2.3)                                                                                     | —                                        | ✅ Yes              |
| 5   | r/AI_Agents                         | Agent architecture; lead with deterministic-workflow angle | 1    | Relatively open and growing                                                                       | Full article (§2.3)                                                                                                          | —                                        | ✅ Yes              |
| 6   | r/IndieDev / r/indiehackers         | Maker communities                                          | 1    | Lenient                                                                                           | News brief (§2.2)                                                                                                            | —                                        | ✅ Yes              |
| 7   | r/ChatGPTCoding                     | Coding tools; single best _audience_ fit                   | 2    | Fairly open but actively moderated; some karma helps                                              | Announcement (§2.1) or News brief (§2.2)                                                                                     | `Resources & Tips` / `Project Showcase`  | ✅ Yes              |
| 8   | r/vscode                            | Frame as a VS Code extension                               | 2    | Moderate barrier                                                                                  | News brief (§2.2)                                                                                                            | —                                        | ✅ Yes              |
| 9   | r/LocalLLaMA                        | Lead hard with local/offline (Ollama, BYOM)                | 2    | Large with spam filters; account age/karma helps; self-promo tolerated only if it reads technical | Full article (§2.3) — lead with local/offline                                                                                | `Resources` / `Tutorial \| Guide`        | ✅ Yes              |
| 10  | r/opensource                        | Open-source projects                                       | 3    | Requires `Promotional` flair; gates low-karma/new accounts — build karma first                    | Announcement (§2.1) with `Promotional` flair, _or_ Full article (§2.3) reframed as pure technical writeup under `Discussion` | `Promotional` (required for self-promo)  | ✅ Yes              |
| 11  | r/Anthropic / r/ClaudeAI / r/OpenAI | Only via migration / "use these models in VS Code" framing | 3    | Moderate-to-strict; no generic announcements                                                      | Custom — migration framing (e.g. "Use Claude in VS Code with deterministic agent workflows")                                 | —                                        | ✅ Yes              |
| 12  | r/programming                       | Genuine technical writeup only                             | 4    | Very strict; generic tool posts removed; high bar                                                 | Full article (§2.3) — methodology angle ("building a deterministic, non-LLM-driven multi-agent executor")                    | Text/link only — **no image posts**      | ❌ No inline images |
| 13  | r/MachineLearning                   | Research-framed only                                       | 4    | Strict                                                                                            | Full article (§2.3) — research framing                                                                                       | —                                        | ✅ Yes              |

### Beyond Reddit

| #   | Venue                                                | Orientation that works                                                                | Ease & requirements                                                     | Recommended copy                                              | Format                      | Images / GIF                           |
| --- | ---------------------------------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------- | --------------------------- | -------------------------------------- |
| 14  | **GitHub** (repo README)                             | The canonical launch surface; polish before any post drives traffic                   | Zero barrier — it's your repo                                           | Custom README (lead with the _methodology_, not feature list) | Markdown                    | ✅ Embed GIF/screenshot                |
| 15  | **Hacker News** (Show HN)                            | Technical writeup with a strong hook; first-person "I built this"                     | No karma gate, but heavy moderation & flagging; time with the blog post | Show HN submission (§2.4)                                     | Text + link                 | ❌ Links only (no inline image upload) |
| 16  | **Dev.to / Hashnode / blog**                         | Long-form technical writeup, one per standout feature                                 | Zero barrier — free account                                             | Full article (§2.3); reuse as the r/programming writeup angle | Markdown                    | ✅ Embed GIF/screenshot                |
| 17  | **Demo video** (YouTube / asciinema / GIF in README) | Short screen-record of live agent visualization on a real repo — most shareable asset | Zero barrier to upload; production effort to record                     | Custom (visual; minimal text)                                 | Video / MP4-GIF / asciinema | ✅ Native video                        |
| 18  | **Conference / lightning talk**                      | Metrics-driven angle (cost caps, token savings) earns press pickup                    | High effort (CFP, travel/prep); high leverage                           | Custom talk — lead with real before/after numbers             | Slides + video              | ✅ Slides                              |
| 19  | **X / Twitter**                                      | Short-form amplification linking back to repo + blog                                  | Zero barrier                                                            | Custom short post — hook + GIF + link                         | Short text + media          | ✅ GIF/video                           |
| 20  | **LinkedIn**                                         | Professional / engineering-leadership audience                                        | Zero barrier                                                            | News brief (§2.2)                                             | Text + image                | ✅ Yes                                 |
| 21  | **Discord** (dev communities)                        | Short-form, conversational                                                            | Zero barrier                                                            | Custom short message — hook + repo link                       | Chat message                | ✅ Yes                                 |

### Practical sequencing

1. **Polish the GitHub README** first (venue #14) — it's the landing page every other link points to.
2. **Record the demo GIF/video** (#17) — it's the most shareable asset and embeds everywhere.
3. **Post Tier-1 Reddit subs** (#1–6) spread over several days, rewriting the lead per sub; comment to gather karma.
4. **Publish one long-form blog post** (#16) using the Full article (§2.3).
5. **Submit to Hacker News** (#15) timed with the blog post, using the Show HN variant (§2.4).
6. **Move to Tier-2 Reddit** (#7–9) once you have some karma.
7. **Amplify on X / LinkedIn / Discord** (#19–21) linking back to repo + blog.
8. **Save r/opensource (#10) and r/programming (#12)** for when your account has more standing; r/programming only as the technical writeup.
9. **Pursue a conference/lightning talk** (#18) with the metrics-driven angle for press pickup.

---

## 2. Copy variants

Four voices, each suited to a different venue orientation. See the table in [§1](#1-master-publishing-table) for which to use where.

### 2.1 Announcement (promotional, first-person)

**Title:** Shofer — an OpenSource AI coding agent with deterministic multi-agent workflows and unparalleled observability

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

### 2.2 Short news brief

**Headline:** Open-source VS Code agent "Shofer" targets deterministic multi-agent workflows

A new open-source AI coding agent named **Shofer** has been released under the Apache 2.0 license. Built as a VS Code extension rather than an editor fork, the project's distinguishing claim is a _deterministic, non-LLM-driven_ multi-agent workflow executor: collaboration patterns are declared in `.slang` files and driven by a separate runtime, making agent runs repeatable and inspectable rather than ad-hoc.

The project also ships live in-editor visualizations of the agent tree (topology, sequence, and swimlane views) with per-agent cost and active-time breakdowns; a persistent "Live Memory" companion that accumulates codebase knowledge across sessions; kernel-level command sandboxing on Linux via Landlock and Bubblewrap; semantic search over both code and git history; and hard per-task and per-session USD cost caps that work across providers.

Shofer supports dozens of LLM providers under a bring-your-own-model model and includes migration paths from Copilot, Claude Code, OpenCode, and Roo Code. The source is available at [github.com/shofer-dev/shofer](https://github.com/shofer-dev/shofer).

### 2.3 Full news article

> Reads as third-person journalism — the framing r/programming, Dev.to, and Hashnode require. Can also serve as a draft handed to a journalist covering the space.

#### An open-source agent that wants multi-agent runs to be repeatable

The crowded field of AI coding agents gained another entrant this week with the release of **Shofer**, an Apache-2.0 VS Code extension whose central proposition is that multi-agent collaboration should not be left to the improvisation of a runtime LLM.

Most agentic coding tools that support sub-agents let the model decide, at runtime, when and whether to spawn them. Shofer takes a different approach: a multi-agent collaboration pattern — the agents involved, how messages route between them, control flow, convergence points, and per-agent budgets — is declared in a `.slang` file and executed by a dedicated, non-LLM runtime. The stated payoff is that runs become deterministic, repeatable, and inspectable. The project ships with two built-in workflows, for collaborative troubleshooting and feature implementation.

"We wanted agent runs you could actually reason about after the fact," the project's documentation reads. The executor, rather than the LLM, owns the topology — which the team argues is what makes the runs auditable rather than a black box.

#### Live visualization as a first-class surface

Where many agents surface their work as a linear transcript, Shofer renders the executing agent tree in-editor as topology, sequence, and swimlane diagrams, updated live. A cost-and-active-time breakdown spans the whole tree, giving a per-agent accounting that the project positions as an observability feature rather than a nicety.

The emphasis on visibility extends to a separate component called **Live Memory** — a persistent, read-only AI companion that runs on a cheaper large-context model and accumulates knowledge of a codebase over time. Crucially, it survives individual task completion and stays current as the repository evolves, so its context grows without being paid for on every interaction.

#### Sandboxing at the OS level

On Linux, Shofer runs shell commands inside an OS-level write-only sandbox built on Landlock and Bubblewrap, scoped to the active git worktree. The framing is deliberate: rather than relying on the model to respect boundaries — a soft, advisory guarantee — the sandbox provides a hard, deterministic one at the kernel level.

#### Cost controls that span providers

Runaway agent loops are a well-known operational risk. Shofer addresses this with per-task and per-session USD cost caps that halt execution when exceeded. Because the caps sit in Shofer's own accounting layer rather than in any single provider's billing, they apply uniformly across the dozens of providers the extension supports under its bring-your-own-model policy.

#### Retrieval across code _and_ history

Shofer's semantic search operates over both the working codebase and git history. A dedicated `git_search` tool is aimed at answering _why_ and _when_ a change was made — the intent and provenance of a line — rather than only _where_ a symbol lives, the question conventional code search answers.

#### Positioning: extension, not fork

The broader industry has been moving toward full VS Code _forks_ (Cursor, Windsurf, Void), on the logic that native editor access unlocks capabilities — predictive multi-file edits, deep background indexing — that the extension API cannot match. Shofer's bet is the opposite: stay an extension, avoid editor lock-in, and compete on what extensions can do well.

The project's answer to the inevitable "why not a fork?" question rests on four points: users keep their real VS Code or Cursor installation with no lock-in; the Apache-2.0 license; the deterministic multi-agent orchestration; and the OS-level sandboxing. None of those, the team argues, require forking the editor.

#### Migration and availability

Shofer ships migration guides for users coming from GitHub Copilot, Claude Code, OpenCode, and Roo Code — the last being the closest direct competitor, itself a fork of Cline. The extension supports dozens of LLM providers, local models included, and runs on Linux, macOS, and Windows (with the kernel-level sandbox currently Linux-only).

The source code, documentation, and user manual are available at [github.com/shofer-dev/shofer](https://github.com/shofer-dev/shofer), with a project site at [shofer.dev](https://shofer.dev).

### 2.4 Show HN submission

**Title:** Show HN: Shofer – open-source VS Code agent with deterministic, non-LLM multi-agent workflows

**Text:**

Hi HN. I built Shofer, an open-source (Apache 2.0) AI coding agent that runs as a VS Code extension.

The thing I kept running into with agentic coding tools is that "multi-agent" usually means the LLM decides at runtime whether and how to spawn sub-agents — which makes runs hard to reproduce, hard to debug, and hard to reason about after the fact.

So Shofer takes a different approach: you declare a multi-agent collaboration pattern in a `.slang` file (agents, message routing, control flow, convergence points, budgets), and a _non-LLM_ executor drives it. The LLM does the thinking inside each agent; the executor owns the topology. Runs are repeatable and inspectable.

A few other things I think are worth pointing out:

- The agent tree renders live in-editor as topology / sequence / swimlane diagrams, with a cost + active-time breakdown across the whole tree. The goal was to make agent runs less of a black box.
- A persistent, read-only "Live Memory" runs on a cheap large-context model, accumulates codebase knowledge over time, and survives task completion — so it keeps getting smarter about your repo without burning tokens on every interaction.
- On Linux, shell commands run in an OS-level write-only sandbox (Landlock + bwrap) scoped to the active git worktree — a hard guarantee, not an advisory one.
- `git_search` does semantic search over git history, so you can ask _why_ and _when_ something changed, not just _where_ a symbol lives.
- Hard per-task and per-session USD cost caps that halt runaway loops, and they work across any provider.

It's an extension, not a fork — you keep your real VS Code/Cursor install, no lock-in. BYO model, dozens of providers supported, local models included. Migration guides for Copilot / Claude Code / OpenCode / Roo Code.

Repo: https://github.com/shofer-dev/shofer
Site: https://shofer.dev
Manual: https://github.com/shofer-dev/shofer/blob/master/USER_MANUAL.md

Happy to go deep on the architecture — the workflow executor and the sandboxing are the parts I find most interesting to talk about.

---

## 3. Post flair / tags

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
