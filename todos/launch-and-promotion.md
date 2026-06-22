# Shofer — Launch & Promotion

A single working doc for taking Shofer to market. It is organized as a **five-phase execution plan** (§2–§6): each phase contains numbered steps, and every step carries its ready-to-post copy inline — the phases are the single source of truth for all launch copy. Supporting reference material follows: a master venue table (§1), post flair/tags (§7), a playbook drawn from comparable tools (§8), the competitive landscape (§9), and platform-specific mechanics for X/Twitter (§10) and tech-news aggregators (§11).

**Contents**

1. [Master publishing table](#1-master-publishing-table)
2. [Phase 1 — Foundations & Assets (Pre-Launch)](#2-phase-1--foundations--assets-pre-launch)
    - 2.1 [Step 1: Polish the GitHub README](#step-1-polish-the-github-readme)
    - 2.2 [Step 2: Record the Demo Video](#step-2-record-the-demo-video)
    - 2.3 [Step 3: Publish the Long-Form Blog Post](#step-3-publish-the-long-form-blog-post)
3. [Phase 2 — The Core Launch](#3-phase-2--the-core-launch)
    - 3.1 [Step 4: Hacker News (Show HN)](#step-4-hacker-news-show-hn)
    - 3.2 [Step 5: Social Amplification (X / Twitter)](#step-5-social-amplification-x--twitter)
    - 3.3 [Step 6: Professional Amplification (LinkedIn)](#step-6-professional-amplification-linkedin)
4. [Phase 3 — Reddit Tier 1 (The Safe Zones)](#4-phase-3--reddit-tier-1-the-safe-zones)
    - 4.1 [Step 7: The "Zero-Barrier" Subs](#step-7-the-zero-barrier-subs)
5. [Phase 4 — Reddit Tier 2 & Dev Platforms (Moderate Filter)](#5-phase-4--reddit-tier-2--dev-platforms-moderate-filter)
    - 5.1 [Step 8: Targeted Developer Platforms](#step-8-targeted-developer-platforms)
    - 5.2 [Step 9: The Mid-Tier Subreddits](#step-9-the-mid-tier-subreddits)
6. [Phase 5 — The High-Bar Channels (Strict Moderation)](#6-phase-5--the-high-bar-channels-strict-moderation)
    - 6.1 [Step 10: Strict Subreddits](#step-10-strict-subreddits)
    - 6.2 [Step 11: Tech Aggregators & News](#step-11-tech-aggregators--news)
7. [Post flair / tags](#7-post-flair--tags)
8. [Launch / announcement playbook](#8-launch--announcement-playbook)
9. [Competitive landscape](#9-competitive-landscape)
10. [X (Twitter) launch guide](#10-x-twitter-launch-guide)
11. [Tech news & aggregator sites](#11-tech-news--aggregator-sites)

---

## 1. Master publishing table

Ordered roughly easiest → hardest. **Tier** reflects how lenient the venue is _in practice_ for a low-karma / new account. **Copy** references the phase step (§2–§6) whose canonical copy best fits the venue's orientation.

> Reddit karma/account-age thresholds are not published (enforced by private AutoModerator rules), so tiers are based on observed practice. Start at the top, build karma by commenting, then work down.

### Reddit

| #   | Venue                               | Orientation that works                                     | Tier | Status      | Ease & requirements                                                                               | Recommended copy                                                                                                                 | Flair / format                           | Images / GIF        |
| --- | ----------------------------------- | ---------------------------------------------------------- | ---- | ----------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | ------------------- |
| 1   | r/Shofer_dev                        | Anything (your own sub)                                    | 1    | ✅ Posted   | Zero barrier — your sub, post first as home base                                                  | Step 7 — Announcement                                                                                                            | Any                                      | ✅ Yes              |
| 2   | r/SideProject                       | "Show & tell" maker projects                               | 1    | 🚫 Filtered | Very newcomer-friendly; almost no karma gate                                                      | Step 7 — Announcement, or Step 9 — Short news brief                                                                              | `Show & Tell` / `Launch`                 | ✅ Yes              |
| 3   | r/coolgithubprojects                | Repo sharing                                               | 1    | 🚫 Filtered | Purpose-built; very low barrier                                                                   | Step 9 — Short news brief                                                                                                        | Tag primary language (e.g. `TypeScript`) | ✅ Yes              |
| 4   | r/devtools                          | Developer tools audience                                   | 1    | 🚫 Filtered | Small and lenient; exact audience                                                                 | Step 9 — Short news brief, or Step 3 — Full news article                                                                         | —                                        | ✅ Yes              |
| 5   | r/AI_Agents                         | Agent architecture; lead with deterministic-workflow angle | 1    | 🚫 Filtered | Relatively open and growing                                                                       | Step 3 — Full news article                                                                                                       | —                                        | ✅ Yes              |
| 6   | r/IndieDev / r/indiehackers         | Maker communities                                          | 1    | 🚫 Filtered | Lenient                                                                                           | Step 9 — Short news brief                                                                                                        | —                                        | ✅ Yes              |
| 7   | r/ChatGPTCoding                     | Coding tools; single best _audience_ fit                   | 2    | 🚫 Filtered | Fairly open but actively moderated; some karma helps                                              | Step 7 — Announcement, or Step 9 — Short news brief                                                                              | `Resources & Tips` / `Project Showcase`  | ✅ Yes              |
| 8   | r/vscode                            | Frame as a VS Code extension                               | 2    | 🚫 Filtered | Moderate barrier                                                                                  | Step 9 — Short news brief                                                                                                        | —                                        | ✅ Yes              |
| 9   | r/LocalLLaMA                        | Lead hard with local/offline (Ollama, BYOM)                | 2    | 🚫 Filtered | Large with spam filters; account age/karma helps; self-promo tolerated only if it reads technical | Step 3 — Full news article (lead with local/offline)                                                                             | `Resources` / `Tutorial \| Guide`        | ✅ Yes              |
| 10  | r/opensource                        | Open-source projects                                       | 3    | 🚫 Filtered | Requires `Promotional` flair; gates low-karma/new accounts — build karma first                    | Step 7 — Announcement with `Promotional` flair, _or_ Step 3 — Full article reframed as pure technical writeup under `Discussion` | `Promotional` (required for self-promo)  | ✅ Yes              |
| 11  | r/Anthropic / r/ClaudeAI / r/OpenAI | Only via migration / "use these models in VS Code" framing | 3    | 🚫 Filtered | Moderate-to-strict; no generic announcements                                                      | Custom — migration framing (e.g. "Use Claude in VS Code with deterministic agent workflows")                                     | —                                        | ✅ Yes              |
| 12  | r/programming                       | Genuine technical writeup only                             | 4    | 🚫 Filtered | Very strict; generic tool posts removed; high bar                                                 | Step 3 — Full news article (methodology angle)                                                                                   | Text/link only — **no image posts**      | ❌ No inline images |
| 13  | r/MachineLearning                   | Research-framed only                                       | 4    | 🚫 Filtered | Strict                                                                                            | Step 3 — Full news article (research framing)                                                                                    | —                                        | ✅ Yes              |
| 14  | r/FunMachineLearning                | Meme-friendly ML humor; low-barrier "fun" post             | 1    | 🚫 Filtered | Very newcomer-friendly; "fun" framing only                                                        | Step 9 — Short news brief (keep it light)                                                                                        | —                                        | ✅ Yes              |
| 15  | r/machinelearningnews               | ML news sharing; project announcements                     | 2    | 🚫 Filtered | Moderate; auto-filters new-account posts                                                          | Step 9 — Short news brief                                                                                                        | —                                        | ✅ Yes              |

### Beyond Reddit

| #   | Venue                                                | Orientation that works                                                                | Ease & requirements                                                     | Recommended copy                                     | Format                      | Images / GIF                           | Status    |
| --- | ---------------------------------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------- | --------------------------- | -------------------------------------- | --------- |
| 16  | **GitHub** (repo README)                             | The canonical launch surface; polish before any post drives traffic                   | Zero barrier — it's your repo                                           | Step 1 — Custom README (lead with the _methodology_) | Markdown                    | ✅ Embed GIF/screenshot                | ✅ Posted |
| 17  | **Hacker News** (Show HN)                            | Technical writeup with a strong hook; first-person "I built this"                     | No karma gate, but heavy moderation & flagging; time with the blog post | Step 4 — Show HN submission                          | Text + link                 | ❌ Links only (no inline image upload) | ⬜        |
| 18  | **Dev.to / Hashnode / blog**                         | Long-form technical writeup, one per standout feature                                 | Zero barrier — free account                                             | Step 3 — Full news article                           | Markdown                    | ✅ Embed GIF/screenshot                | ⬜        |
| 19  | **Demo video** (YouTube / asciinema / GIF in README) | Short screen-record of live agent visualization on a real repo — most shareable asset | Zero barrier to upload; production effort to record                     | Step 2 — Custom (visual; minimal text)               | Video / MP4-GIF / asciinema | ✅ Native video                        | ⬜        |
| 20  | **Conference / lightning talk**                      | Metrics-driven angle (cost caps, token savings) earns press pickup                    | High effort (CFP, travel/prep); high leverage                           | Custom talk — lead with real before/after numbers    | Slides + video              | ✅ Slides                              | ⬜        |
| 21  | **X / Twitter**                                      | Short-form amplification linking back to repo + blog                                  | Zero barrier                                                            | Step 5 — 4-tweet thread                              | Short text + media          | ✅ GIF/video                           | ⬜        |
| 22  | **LinkedIn**                                         | Professional / engineering-leadership audience                                        | Zero barrier                                                            | Step 6 — LinkedIn post                               | Text + image                | ✅ Yes                                 | ✅ Posted |
| 23  | **Discord** (dev communities)                        | Short-form, conversational                                                            | Zero barrier                                                            | Custom short message — hook + repo link              | Chat message                | ✅ Yes                                 | ⬜        |
| 24  | **DevHunt**                                          | Weekly-cycle dev-tool launch platform; GitHub login required                          | Zero barrier; weekly voting cycle                                       | Step 8 — Short news brief                            | Profile page + link         | ✅ Yes                                 | ⬜        |
| 25  | **Uneed / StartupBase**                              | Dev/startup product-discovery platforms                                               | Zero barrier                                                            | Step 8 — Short news brief                            | Profile page + link         | ✅ Yes                                 | ⬜        |

---

## 2. Phase 1 — Foundations & Assets (Pre-Launch)

> Before linking to your project anywhere, the landing surfaces must be optimized to catch the traffic. Complete all three steps before moving to Phase 2.

### Step 1: Polish the GitHub README

This is your canonical launch surface. Every post you make across the internet will point here.

- **Format:** Standard Markdown.
- **Crucial focus:** Place your Demo Video/GIF immediately at the top. Below the video, lead with the methodology (the deterministic, non-LLM-driven workflow executor) before listing standard features. Add a fast "Quickstart" block so developers can try it before reading the philosophy.

### Step 2: Record the Demo Video

- **Format:** Native `.mp4` for X (Twitter) and LinkedIn; `.gif` or asciinema for GitHub and Reddit.
- **Content:** Record the live agent visualizations (topology/sequence/swimlane diagrams) executing a workflow on a real repository. This is your most shareable asset.

### Step 3: Publish the Long-Form Blog Post

Publish this on Dev.to, Hashnode, or your personal/company blog. This will serve as the destination link for strict tech aggregators and Reddit's r/programming.

- **Format:** Markdown with embedded Demo Video.

> This copy also serves as the canonical "Full news article" referenced by the master table (venues #5, #9, #12, #13, #18).

**Exact copy to use (full news article):**

#### An open-source agent that wants multi-agent runs to be repeatable

The crowded field of AI coding agents gained another entrant this week with the release of Shofer, an Apache-2.0 VS Code extension whose central proposition is that multi-agent collaboration should not be left to the improvisation of a runtime LLM.

Most agentic coding tools that support sub-agents let the model decide, at runtime, when and whether to spawn them. Shofer takes a different approach: a multi-agent collaboration pattern — the agents involved, how messages route between them, control flow, convergence points, and per-agent budgets — is declared in a `.slang` file and executed by a dedicated, non-LLM runtime. The stated payoff is that runs become deterministic, repeatable, and inspectable. The project ships with two built-in workflows, for collaborative troubleshooting and feature implementation.

"We wanted agent runs you could actually reason about after the fact," the project's documentation reads. The executor, rather than the LLM, owns the topology — which the team argues is what makes the runs auditable rather than a black box.

##### Live visualization as a first-class surface

Where many agents surface their work as a linear transcript, Shofer renders the executing agent tree in-editor as topology, sequence, and swimlane diagrams, updated live. A cost-and-active-time breakdown spans the whole tree, giving a per-agent accounting that the project positions as an observability feature rather than a nicety.

The emphasis on visibility extends to a separate component called Live Memory — a persistent, read-only AI companion that runs on a cheaper large-context model and accumulates knowledge of a codebase over time. Crucially, it survives individual task completion and stays current as the repository evolves, so its context grows without being paid for on every interaction.

##### Sandboxing at the OS level

On Linux, Shofer runs shell commands inside an OS-level write-only sandbox built on Landlock and Bubblewrap, scoped to the active git worktree. The framing is deliberate: rather than relying on the model to respect boundaries — a soft, advisory guarantee — the sandbox provides a hard, deterministic one at the kernel level.

##### Cost controls that span providers

Runaway agent loops are a well-known operational risk. Shofer addresses this with per-task and per-session USD cost caps that halt execution when exceeded. Because the caps sit in Shofer's own accounting layer rather than in any single provider's billing, they apply uniformly across the dozens of providers the extension supports under its bring-your-own-model policy.

##### Retrieval across code and history

Shofer's semantic search operates over both the working codebase and git history. A dedicated `git_search` tool is aimed at answering _why_ and _when_ a change was made — the intent and provenance of a line — rather than only _where_ a symbol lives, the question conventional code search answers.

##### Positioning: extension, not fork

The broader industry has been moving toward full VS Code forks (Cursor, Windsurf, Void), on the logic that native editor access unlocks capabilities — predictive multi-file edits, deep background indexing — that the extension API cannot match. Shofer's bet is the opposite: stay an extension, avoid editor lock-in, and compete on what extensions can do well.

The project's answer to the inevitable "why not a fork?" question rests on four points: users keep their real VS Code or Cursor installation with no lock-in; the Apache-2.0 license; the deterministic multi-agent orchestration; and the OS-level sandboxing. None of those, the team argues, require forking the editor.

##### Migration and availability

Shofer ships migration guides for users coming from GitHub Copilot, Claude Code, OpenCode, and Roo Code — the last being the closest direct competitor, itself a fork of Cline. The extension supports dozens of LLM providers, local models included, and runs on Linux, macOS, and Windows (with the kernel-level sandbox currently Linux-only).

The source code, documentation, and user manual are available at [github.com/shofer-dev/shofer](https://github.com/shofer-dev/shofer), with a project site at [shofer.dev](https://shofer.dev).

---

## 3. Phase 2 — The Core Launch

> These are the highest-leverage spikes. Coordinate these to launch on the same day.

### Step 4: Hacker News (Show HN)

Time this immediately after your blog post (Step 3) goes live.

- **Action:** Submit to [news.ycombinator.com](https://news.ycombinator.com/submit). Do not include a picture (it's not supported).

**Exact copy to use (Show HN):**

**Title:** Show HN: Shofer – open-source VS Code agent with deterministic multi-agent workflows

**Text:**

Hi HN. I built Shofer, an open-source (Apache 2.0) AI coding agent that runs as a VS Code extension.

I built a new IDE-Native AI coding assistant because I was tired of the unpredictability of multi-agent runs that I couldn't debug. The thing I kept running into with agentic tools is that "multi-agent" usually means the LLM decides at runtime whether and how to spawn sub-agents — which makes runs hard to reproduce and hard to reason about after the fact.

So Shofer takes a different approach: you declare a multi-agent collaboration pattern in a `.slang` file (agents, message routing, control flow, convergence points, budgets), and a non-LLM executor drives it. The LLM does the thinking inside each agent; the executor owns the topology. Runs are repeatable and inspectable.

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

### Step 5: Social Amplification (X / Twitter)

Use an X Thread to demonstrate the visual components. Post between Tuesday–Thursday, 9–11 AM ET.

- **Format:** 4-Tweet Thread. Attach native video to Tweet 1.
- **Mechanics:** see [§10](#10-x-twitter-launch-guide) for account setup, hashtags, timing rationale, and post-launch engagement.

**Exact copy to use:**

**Tweet 1** (attach video):

> I built an open-source AI coding agent that doesn't let the LLM decide how to collaborate.
>
> Multi-agent runs are declared in `.slang` files and driven by a non-LLM executor — repeatable, inspectable, debuggable.
>
> It's called Shofer. Here's what it looks like in action 👇
>
> #OpenSource #AIAgents #VSCode

**Tweet 2:**

> The agent tree renders live in-editor — topology, sequence, and swimlane diagrams — with per-agent cost & active-time breakdowns. Less black box.
>
> There's also a persistent "Live Memory" companion that accumulates codebase knowledge over time and survives task completion.

**Tweet 3:**

> Three more things I think are worth pointing out:
> • OS-level command sandboxing (Landlock + bwrap) — a hard guarantee, not advisory
> • Hard per-task USD cost caps across any provider
> • Semantic search over git history to find _why_ and _when_ something changed

**Tweet 4:**

> Apache 2.0, BYO model, dozens of providers, migration guides from Copilot / Claude Code / Roo Code.
>
> GitHub: github.com/shofer-dev/shofer

### Step 6: Professional Amplification (LinkedIn)

Post to your personal network.

- **Format:** Text + Image. Include empty lines between paragraphs for mobile readability. The 🔷 renders as visual bullets (LinkedIn has no markdown).

**Exact copy to use:**

I built a new IDE-Native AI coding assistant because I was tired of the unpredictability of multi-agent runs that I couldn't debug.

Every agentic tool I tried (Copilot, Claude Code, Cursor) had the same problem: when the workload spreads across multiple agents, their collaboration is a black box. Non-reproducible and non-diagnosable, which is a no-go for implementing something like "reusable software design patterns" for multi-agent collaboration.

So I built Shofer — an open-source VS Code extension that you can use to fully replace the closed options (Copilot/Claude Code/Cursor) as well as open-source ones (Cline/RooCode/Kilo).

On top of the standard features that the aforementioned tools have, it introduces:

🔷 Multi-agent collaboration patterns are declared in .slang files and driven by a non-LLM executor. The LLM does the thinking inside each agent; the executor owns the topology, message routing, convergence points, and budgets. Runs are repeatable and auditable. Think of it like "design patterns for agents" that you write once and reuse.

🔷 Live in-editor observability — the agent tree renders as topology, sequence, and swimlane diagrams, updated live. Per-agent cost and active-time breakdowns across the whole tree. Less black box.

🔷 OS-level sandboxing — on Linux, shell commands run in a write-only sandbox (Landlock + Bubblewrap) scoped to the git worktree. A hard kernel-level guarantee, not "please don't do that."

🔷 Persistent Live Memory — a cheap, read-only AI companion that accumulates codebase knowledge across sessions and survives task completion. It gets smarter about your repo without burning tokens on every interaction.

🔷 Hard per-task USD cost caps that halt runaway loops.

It's an extension, not a fork — you keep your real VS Code or Cursor install.

Stars, feedback, issues, and contributions all help — repo's at https://github.com/shofer-dev/shofer and the landing page at https://shofer.dev

---

## 4. Phase 3 — Reddit Tier 1 (The Safe Zones)

> Begin pushing to lenient subreddits to build initial karma and traffic. Spread posts over several days; rewrite the lead per sub. Comment actively to gather karma before advancing to Phase 4.

### Step 7: The "Zero-Barrier" Subs

- **Where to post:** r/Shofer_dev, r/SideProject, r/coolgithubprojects, r/IndieDev, r/FunMachineLearning.
- **Action:** Submit as a standard text post or link. Ensure you use the specific flairs mapped in [§7](#7-post-flair--tags) (e.g., `Show & Tell` for r/SideProject).

> This copy also serves as the canonical "Announcement" referenced by the master table (venues #1, #2, #7, #10).

**Exact copy to use (announcement variant):**

**Title:** Shofer — an OpenSource AI coding agent with deterministic multi-agent workflows and unparalleled observability

**Body:**

Hey everyone,

I want to share Shofer ([github.com/shofer-dev/shofer](https://github.com/shofer-dev/shofer)), an open-source (Apache 2.0) AI coding agent that lives — for now — inside VS Code. The name comes from the French _chauffeur_ — a driver.

The space is crowded, so I'll be upfront about what's actually different vs. what's just table stakes.

**What I think genuinely sets it apart:**

- **Deterministic multi-agent workflows.** Instead of an LLM ad-hoc deciding to spawn sub-agents at runtime, you can encapsulate a multi-agent collaboration pattern in a `.slang` file — agents, message routing, control flow, convergence points, budgets. A non-LLM executor drives it, so runs are repeatable and inspectable. Ships with two built-in ones (collaborative troubleshooting; feature implementation).
- **Live agent visualizations and analytics.** You watch the agent tree execute as topology / sequence / swimlane diagrams in-editor, with a cost+active-time breakdown across the whole tree. Less black box.
- **Live Memory.** A persistent, read-only AI companion that accumulates codebase knowledge over time — and survives task completion. It runs on a cheap large-context model of your choice, and it stays up to date as the codebase evolves, so it keeps getting smarter about your repo without burning tokens.
- **Kernel-level command sandboxing (Linux).** Shell commands run in an OS-level write-only sandbox (Landlock/bwrap) scoped to the active git worktree. It's a deterministic guarantee.
- **Semantic search over code and git history.** `git_search` finds _why_ and _when_ a change was made, not just where it lives.
- **Hard cost caps.** Per-task / per-session USD limits that halt runaway loops, across any provider.

**The honest "table stakes" part** — parallel tasks, custom modes, RAG, MCP support, git worktree & submodule support, bring-your-own-model (BYOM), and support for dozens of LLM providers.

It's an open-source project — Apache 2.0, contributions welcome, migration guides if you're coming from Copilot / Claude Code / OpenCode.

Links: [GitHub](https://github.com/shofer-dev/shofer) · [Website](https://shofer.dev) · [User Manual](https://github.com/shofer-dev/shofer/blob/master/USER_MANUAL.md)

Happy to answer questions about the architecture.

---

## 5. Phase 4 — Reddit Tier 2 & Dev Platforms (Moderate Filter)

> Once your Reddit account has cleared the lowest karma hurdles via Tier 1 engagement, move to these specialized communities.

### Step 8: Targeted Developer Platforms

Submit to dedicated launch platforms that operate outside the 24-hour hype cycle.

- **Where to post:** DevHunt (weekly cycle, GitHub login required) and Uneed / StartupBase.
- **Copy:** Use the Short News Brief (Step 9, below) as the descriptive text for your profile pages on these platforms.

### Step 9: The Mid-Tier Subreddits

- **Where to post:** r/ChatGPTCoding, r/LocalLLaMA, r/vscode, r/machinelearningnews, r/AI_Agents.
- **Action:** Adjust your tone per sub. For r/LocalLLaMA, aggressively highlight the BYOM and local offline capabilities.

> This copy also serves as the canonical "Short news brief" referenced by the master table (venues #3, #4, #6, #8, #14, #15, #24, #25).

**Exact copy to use (short news brief variant):**

**Title:** Open-source VS Code agent "Shofer" brings design-pattern-style repeatability to multi-agent coding workflows

**Body:**

A new open-source AI coding assistant named Shofer has been released under the Apache 2.0 license. Built as a VS Code extension, the project's distinguishing feature is a deterministic, non-LLM-driven multi-agent workflow execution: making agent runs in a repeatable and inspectable manner, rather than ad-hoc. Think of it like "design patterns for multi-agent collaboration" that can be written once and shared with many.

The project also ships with beautiful live in-editor visualizations to help you introspect the agent interactions. Other noteworthy features are: an always-up-to-date "Live Memory" that accumulates codebase knowledge across sessions; kernel-level command sandboxing; semantic search over both code and git history; and hard per-task and per-session USD cost caps that work across providers.

Shofer supports dozens of LLM providers under a bring-your-own-model model and includes migration paths from Copilot, Claude Code, OpenCode, and Roo Code. The source is available at github.com/shofer-dev/shofer.

---

## 6. Phase 5 — The High-Bar Channels (Strict Moderation)

> These venues aggressively filter generic marketing. Save them for when your account has solid karma and you can pitch purely on architectural merit.

### Step 10: Strict Subreddits

- **Where to post:** r/opensource (requires `Promotional` flair), r/programming, r/MachineLearning.
- **Action:** Submit the link directly to your Dev.to / blog post (from Step 3) rather than making a text post. For r/programming, do not use inline images or marketing fluff.
- **Copy:** [Step 3 — Full news article](#step-3-publish-the-long-form-blog-post). For r/opensource, the [Step 7 — Announcement](#step-7-the-zero-barrier-subs) with `Promotional` flair is also acceptable.

### Step 11: Tech Aggregators & News

These provide the longest "shelf life" for traffic, but require editorial approval.

- **Where to submit:** Slashdot, Ars Technica tip line, The Register tip line, TLDR Newsletter.
- **Action:** Submit via their web forms. See [§11](#11-tech-news--aggregator-sites) for the full site-by-site submission process and the master aggregator table.

**Exact copy to use (Slashdot blurb variant):**

> Shofer is an open-source (Apache 2.0) VS Code extension that takes a different approach to multi-agent AI coding: instead of letting the LLM decide at runtime whether and how to spawn sub-agents, collaboration patterns are declared in `.slang` files and driven by a deterministic, non-LLM executor. The project also includes live in-editor agent visualizations (topology, sequence, swimlane diagrams), a persistent read-only "Live Memory" companion, kernel-level command sandboxing via Landlock and Bubblewrap, and hard per-task cost caps. Source and documentation at github.com/shofer-dev/shofer.

---

## 7. Post flair / tags

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

## 8. Launch / announcement playbook

**What worked for comparable AI dev tools**

Reddit is only one channel. These recent open-source AI-dev tools each combined a GitHub launch with one or two amplification moves. Patterns worth copying for Shofer:

- **Superpowers** (agentic skills / TDD-enforcing framework for Claude Code & Codex; `obra/superpowers` by Jesse Vincent / Prime Radiant) — _launched directly as an open-source GitHub repo._ Takeaway: a clean, opinionated GitHub repo with a strong README _is_ the launch. The framework-with-a-methodology angle (enforced engineering practices) is what gave it a hook beyond "another tool." Shofer's equivalent hook is the **deterministic, non-LLM-driven workflow executor** — lead writeups with the _methodology_, not the feature list.
- **Understand Anything** (multi-agent pipeline that turns a codebase into an interactive knowledge graph; `Lum1104/Understand-Anything` by Yash Thakker, May 2026) — _GitHub launch amplified with detailed write-ups on a company blog (explainx.ai) and Dev.to, plus a demo video_ mapping a real repo. Takeaway: pair the repo with (1) a long-form blog post and (2) a **short screen-recorded demo** of the live agent visualization on a real codebase — that visual is Shofer's most shareable asset.
- **Headroom** (local proxy doing lossless context compression to cut LLM inference cost; `chopratejas/headroom` by Tejas Chopra, Netflix) — _open-sourced on GitHub, then revealed via a conference talk with concrete cost-saving metrics, which drove press pickup (The Register)._ Takeaway: **numbers travel.** Shofer has two metric-driven stories — hard per-task USD cost caps and KV-cache-friendly Live Memory. A post or talk framed around "how we cap and cut agent spend" with real before/after numbers earns coverage that a feature tour won't.

---

## 9. Competitive landscape

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

---

## 10. X (Twitter) launch guide

> The canonical 4-tweet thread copy lives in [Phase 2, Step 5](#step-5-social-amplification-x--twitter). This section covers the mechanics: account setup, hashtags, timing, and post-launch engagement.

### How to publish

- **Account:** use the [@Shofer_dev](https://x.com/Shofer_dev) account (create if not yet set up).
- **Format:** a thread of 3–5 posts (tweetstorm), not a single post. The first tweet is the hook; the rest are supporting points. X's algorithm heavily favors threads with high engagement on the first tweet.
- **Media:** attach a **GIF or short screen-recording** to the first tweet — video/GIF posts get ~3× the impressions of text-only. The live in-editor agent tree visualization (topology/sequence/swimlane diagrams) is the strongest visual asset.
- **Timing:** post Tuesday–Thursday, 9–11 AM ET (14:00–16:00 UTC) — peak dev-Twitter activity. Avoid weekends and US holidays.
- **Link:** include the GitHub repo link in the **last tweet of the thread** (links in the first tweet can suppress reach). Also add the link in a reply to the first tweet: "Repo: github.com/shofer-dev/shofer".

### Where to post (hashtags & communities)

**Hashtags** (2–3 per tweet, not more — over-hashtagging reduces reach):

- `#OpenSource` — broadest reach for project launches
- `#AI` / `#AIAgents` / `#AgenticAI` — the AI dev audience
- `#VSCode` — extension/tooling audience
- `#DevTools` — developer tools community
- `#BuildInPublic` — maker/indie audience (use if you share the journey, not just the launch)

**Tag relevant accounts** (if they engage, it amplifies to their followers):

- `@vscode` — VS Code official; they occasionally retweet extensions
- `@github` — GitHub official
- `@ollama` — if leading with local-model angle
- `@AnthropicAI`, `@OpenAI` — if highlighting model support

**Communities to engage with _before_ posting:**

- Spend 1–2 weeks commenting on posts in the `#BuildInPublic` and `#AIAgents` hashtags. A new account with zero engagement history posting a launch thread looks like spam.
- Follow and interact with accounts in the AI-dev-tools space: indie makers, open-source maintainers, and dev-tool reviewers.

### Post-launch engagement

- **Reply to every comment** within the first 2 hours — this signals to X that the thread is active and boosts it in feeds.
- **Quote-tweet your own thread** 24 hours later with a different angle (e.g., "One thing I didn't mention about the sandboxing…") to give it a second life.
- **DM small dev-tool accounts** (1K–10K followers) who cover open-source AI tools — a personal note with a demo GIF is far more effective than cold-posting.
- **Pin the thread** to the profile so it's the first thing visitors see.

---

## 11. Tech news & aggregator sites

These are high-leverage because they drive sustained traffic (unlike a Reddit post that dies in 24 hours) and often get picked up by Google News. Unlike Reddit, these have **no karma gates** — but they have editorial discretion.

> The canonical Slashdot blurb copy lives in [Phase 5, Step 11](#step-11-tech-aggregators--news). The [Step 3 — Full news article](#step-3-publish-the-long-form-blog-post) copy works well as the submission body for the remaining sites.

### Slashdot (`slashdot.org`)

**How it works:** Users submit stories; editors pick winners for the front page. Reader comments are threaded and can generate as much discussion as the article. Stories stay visible for days.

**Submission process:**

1. Go to [`slashdot.org/submission`](https://slashdot.org/submission)
2. Paste the URL of your blog post or GitHub repo
3. Write a **headline** and a **blurb** (1–2 paragraphs). The blurb must read like news, not an ad. Write in third-person, neutral tone.
4. Select the category **"Developer"** or **"Technology"** → **"Open Source"**
5. Include the "Open Source" topic tag.

**What works on Slashdot:**

- **Lead with the technical differentiator** — the deterministic, non-LLM multi-agent executor is exactly the kind of architecture detail Slashdot readers care about.
- **No fluff, no hype.** Skip marketing language entirely. State the facts: what it does, how it's different, what license, what's the sandboxing implementation.
- **Include a comparison** to familiar tools (Cursor, Copilot, Cline) — Slashdot readers want to know _where it fits_.
- The OS-level sandboxing angle (Landlock + bwrap) will resonate — Slashdot has a strong Linux/security audience.

### Similar tech aggregator / news sites

These follow a similar editorial-submission model — submit a blog post or repo link, editors decide. They have **no account-age/karma barriers.** The Full article (Step 3) copy works well as the submission blurb for each.

| Site                                     | URL                                                                                       | Audience                                             | Approach                                                                                                                                                                      | Status |
| ---------------------------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| **Slashdot**                             | [slashdot.org/submission](https://slashdot.org/submission)                                | Sysadmins, Linux, security-focused devs — broad tech | Lead with sandboxing + deterministic workflows                                                                                                                                | ⬜     |
| **The Register** (`theregister.com`)     | tip line: [theregister.com/Profile/contact](https://www.theregister.com/Profile/contact/) | Enterprise devs, IT decision-makers, UK/EU tech      | Pitch as "open-source competitor to Copilot with hard security guarantees." They love a contrarian angle. Metrics (cost caps) + sandboxing = strongest pitch.                 | ⬜     |
| **Hacker News** (`news.ycombinator.com`) | [Submit](https://news.ycombinator.com/submit)                                             | Startup founders, engineers, VCs                     | Already covered (Step 4 — Show HN). Also submit the blog post as a regular story (not Show HN) a few days later — two bites at the apple.                                     | ⬜     |
| **TechCrunch**                           | tip line or reporter DM                                                                   | Broader tech/business audience, press pickup         | Less likely unless you have funding/launch narrative. Worth a DM to a reporter covering dev tools but don't expect coverage without a news hook.                              | ⬜     |
| **Ars Technica**                         | tip line: [arstechnica.com/contact-us](https://arstechnica.com/contact-us/)               | Deeply technical, longer shelf-life                  | Lead with the architecture + sandboxing. They run occasional "cool open-source project" pieces.                                                                               | ⬜     |
| **InfoQ**                                | [infoq.com/contribute](https://www.infoq.com/contribute/)                                 | Enterprise architects, engineering leads             | Submit as a "news item" (not an article). The deterministic-agent-architecture angle is a fit for their "software architecture" beat.                                         | ⬜     |
| **TLDR Newsletter** (`tldr.tech`)        | Submit via their website or reply to a daily email                                        | 1M+ dev subscribers, curated daily roundup           | High-leverage if picked — submit a link to the blog post, not the repo. The short news brief (Step 9) is the right tone.                                                      | ⬜     |
| **Changelog** (`changelog.com`)          | [Submit](https://changelog.com/submit)                                                    | Podcast + newsletter, open-source focused            | Open-source projects are exactly their beat. Submit the repo + blog post. If invited on the podcast, the architecture walkthrough makes great audio.                          | ⬜     |
| **Product Hunt**                         | [producthunt.com](https://www.producthunt.com)                                            | Maker/startup audience, launch-day spike             | Schedule a launch date, prepare a gallery (demo GIF + screenshots), rally upvotes in the first hour. Best for consumer/dev-tool products. Use the Announcement (Step 7) tone. | ⬜     |
| **AlternativeTo**                        | [alternativeto.net](https://alternativeto.net)                                            | Users searching for "alternatives to X"              | List Shofer under "Alternatives to Cursor," "Alternatives to GitHub Copilot," "Alternatives to Cline." Long-tail passive traffic for years.                                   | ⬜     |
| **LibHunt / Saashub**                    | [libhunt.com](https://www.libhunt.com) / [saashub.com](https://www.saashub.com)           | Open-source discovery, SEO-heavy                     | Claim or submit the repo. These sites aggregate GitHub repos and rank by stars. Standard open-source listing — link to the repo, tag with languages/topics.                   | ⬜     |
