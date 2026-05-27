# Shofer Landing Website

Static landing page for [Shofer](https://shofer.dev) — a state-of-the-art open-source AI coding assistant that runs as a VS Code extension. The site is a single-page marketing website designed to drive users to documentation, GitHub, and the extension itself.

## Tech Stack

| Layer               | Choice                                                                    | Rationale                                                                                                |
| ------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| **Framework**       | [Astro 5.7](https://astro.build/)                                         | Zero-runtime JS by default; compiles to static HTML. Component-driven workflow without SPA overhead.     |
| **Styling**         | [Tailwind CSS 3.4](https://tailwindcss.com/)                              | Utility-first CSS with dark mode (`class` strategy), custom color scales, and responsive breakpoints.    |
| **Typography**      | [@tailwindcss/typography](https://tailwindcss.com/docs/typography-plugin) | Prose defaults for any future content pages.                                                             |
| **Animations**      | [tailwindcss-animate](https://github.com/jamiebuilds/tailwindcss-animate) | Declarative `animate-fade-in`, `animate-slide-up`, `animate-slide-down`, `animate-glow-pulse` utilities. |
| **Icons**           | Inline SVG                                                                | Zero external icon dependencies. Each component defines its own SVG icons as template literals.          |
| **Font**            | [Inter](https://fonts.google.com/specimen/Inter) (Google Fonts)           | Clean, modern sans-serif with 9 weights. Preconnected for performance.                                   |
| **Package Manager** | npm (via local Nexus proxy)                                               | The workspace `.npmrc` routes through `localhost:30084/repository/npm-proxy/`.                           |

## Design System

### Color Palette

```
shofer-50  #f0f7ff   →   shofer-950  #0a2749
accent-purple  #8b5cf6
accent-emerald #10b981
accent-amber   #f59e0b
accent-rose    #f43f5e
```

- **Primary**: Shofer blue gradient (`from-shofer-600 via-accent-purple to-shofer-400`) used for the hero `text-gradient` headline and interactive accents.
- **Semantic accents**: Emerald for feature checkmarks, amber for migration badges, rose for the Roo-Code section icon.
- **Surfaces**: White/gray-50 (light) → gray-950/gray-900 (dark). Cards use `bg-white dark:bg-gray-900` with `border-gray-100 dark:border-gray-800`.

### Typography Scale

| Usage          | Class                                                            |
| -------------- | ---------------------------------------------------------------- |
| Hero headline  | `text-4xl sm:text-5xl lg:text-7xl font-extrabold tracking-tight` |
| Section titles | `text-3xl sm:text-4xl lg:text-5xl font-extrabold`                |
| Card titles    | `text-xl font-bold`                                              |
| Body           | `text-sm` to `text-lg` depending on context                      |
| Code           | `font-mono` for `.shofermodes`, slash commands                   |

### Dark Mode

- Strategy: `class` — toggled via `document.documentElement.classList.toggle("dark")`
- Persisted in `localStorage` under key `"theme"`
- Defaults to OS preference via `prefers-color-scheme: dark` media query
- Inline `<script is:inline>` in `<head>` applies the class before paint to prevent FOUC

### Animations

Defined in [`tailwind.config.mjs`](tailwind.config.mjs) under `theme.extend.keyframes`:

- `fade-in` — opacity 0 → 1, 600ms ease-out
- `slide-up` — translateY(24px) → 0 + fade, 600ms ease-out
- `slide-down` — translateY(-12px) → 0 + fade, 400ms ease-out
- `glow-pulse` — box-shadow pulse on hero background blobs, 3s infinite

All entry animations use `forwards` fill mode so elements stay visible after animating. Hover effects: card icons `scale-110` and border color transitions.

## File Structure

```
website/
├── astro.config.mjs              # Astro + Tailwind integration
├── package.json                  # Dependencies and scripts
├── tailwind.config.mjs           # Theme, colors, animations, plugins
├── README.md                     # This file
├── public/
│   └── favicon.svg               # Gradient "S" favicon
├── src/
│   ├── layouts/
│   │   └── Layout.astro          # Base HTML shell (head, meta, dark mode script)
│   ├── pages/
│   │   └── index.astro           # Single landing page (composes all sections)
│   ├── components/
│   │   ├── Header.astro          # Sticky nav + dark mode toggle + mobile menu
│   │   ├── Footer.astro          # Link columns + disclaimer
│   │   ├── Hero.astro            # Gradient hero with CTA buttons
│   │   ├── Features.astro        # 6 feature cards with SVG icons
│   │   ├── Modes.astro           # 5 mode cards (Code, Architect, Ask, Debug, Orchestrator)
│   │   ├── Migration.astro       # Roo-Code + Copilot comparison tables
│   │   └── Community.astro       # Discord/Reddit/GitHub links + CTA card
│   ├── data/
│   │   ├── navigation.ts         # Site config, nav items, social URLs
│   │   ├── features.ts           # Feature cards (title, description, highlights, docs link)
│   │   ├── modes.ts              # 5 built-in modes with icon, description, tool groups
│   │   ├── migrations.ts         # Roo-Code comparison rows + migration info
│   │   ├── copilot.ts            # Copilot comparison rows + migration info
│   │   └── community.ts          # Community link cards (Discord, Reddit, GitHub, Issues)
│   └── styles/
│       └── global.css            # Tailwind directives + custom utility classes
└── dist/                         # Build output (static HTML + CSS)
```

### Data-Driven Architecture

All content lives in [`src/data/`](src/data/) as TypeScript modules. Astro components import these and render them declaratively. To update copy, links, or feature lists, edit the data files — no HTML changes needed.

### Component Responsibilities

| Component         | Reads From                    | Key Props                                |
| ----------------- | ----------------------------- | ---------------------------------------- |
| `Header.astro`    | `navigation.ts`               | Nav items with external link flags       |
| `Hero.astro`      | `navigation.ts`               | Site config (name, tagline, description) |
| `Features.astro`  | `features.ts`                 | Inline SVG icon map, docs URLs           |
| `Modes.astro`     | `modes.ts`                    | Emoji icons, tool group strings          |
| `Migration.astro` | `migrations.ts`, `copilot.ts` | Comparison table rows, slash commands    |
| `Community.astro` | `community.ts`                | Inline SVG icon map, external URLs       |

## Responsive Design

All components use Tailwind's mobile-first breakpoints. See the table below for breakpoint-specific behavior:

| Component        | <640px               | ≥640px (sm)      | ≥768px (md) | ≥1024px (lg)                 |
| ---------------- | -------------------- | ---------------- | ----------- | ---------------------------- |
| Hero title       | `text-4xl`           | `text-5xl`       | —           | `text-7xl`                   |
| Hero badges      | `flex-wrap`, `gap-3` | `gap-6`          | —           | —                            |
| CTA buttons      | stacked (`flex-col`) | side-by-side     | —           | —                            |
| Features grid    | 1 col, `p-6`         | `p-8`            | 2 cols      | 3 cols                       |
| Modes grid       | 1 col                | 2 cols           | —           | 5 cols                       |
| Migration layout | stacked, no sticky   | —                | —           | side-by-side, sticky sidebar |
| Community grid   | 1 col, `p-6`         | 2 cols, `p-8`    | —           | 4 cols                       |
| Header nav       | hamburger menu       | hamburger        | —           | inline links                 |
| Footer           | 1 col                | —                | 4 cols      | —                            |
| Section padding  | `py-16`              | `py-24 sm:py-32` | —           | —                            |

Migration comparison tables use `overflow-x-auto` for horizontal scroll on viewports narrower than the table content.

## Build & Development

### Prerequisites

- Node.js ≥ 18
- npm (configured to use the local Nexus proxy via the workspace `.npmrc`)

### Install

```bash
cd extensions/shofer/website
npm install
```

### Development

```bash
npm run dev
```

Starts the Astro dev server at `http://localhost:4321` with HMR.

### Production Build

```bash
npm run build
```

Outputs static files to `dist/`:

```
dist/
├── index.html          (~55 KB — single-page app with all sections)
├── favicon.svg
└── _astro/
    └── index.*.css     (~24 KB — compiled Tailwind with used classes only)
```

The build is fully static — no JavaScript bundles, no runtime framework. Can be served from any CDN or static host.

### Preview

```bash
npm run preview
```

Serves the production build locally for verification.

## Content Sources

The website content is derived from the following Shofer documentation files (not automatically synced — manual updates needed when docs change):

- [`extensions/shofer/README.md`](../README.md) — Product overview, quick start, UI elements
- [`extensions/shofer/USER_MANUAL.md`](../USER_MANUAL.md) — Modes, settings, parallel tasks, worktrees, MCP, RAG, assistant agent
- [`extensions/shofer/docs/shofer_for_roocode_users.md`](../docs/shofer_for_roocode_users.md) — Roo-Code migration guide and comparison
- [`extensions/shofer/docs/shofer_for_copilot_users.md`](../docs/shofer_for_copilot_users.md) — Copilot migration guide and comparison
- [`extensions/shofer/src/media/walkthrough/`](../src/media/walkthrough/) — Walkthrough step content (welcome, modes, features, etc.)

## Design Decisions

1. **Single page, not multi-page.** The entire site is one scrolling page with anchor-linked sections. This matches the marketing/landing use case — users scan quickly, not read deeply.

2. **No JavaScript framework.** Astro compiles to zero runtime JS. The only inline scripts are the dark mode toggle (~200 bytes) and the mobile menu toggle (~100 bytes). No React, Vue, or Svelte.

3. **Data in TypeScript, not Markdown.** Content is structured data (comparison tables, feature lists with icons). TypeScript gives type-checking and autocomplete; Markdown would require frontmatter parsing with no type safety.

4. **Inline SVG over icon library.** Six components, ~15 unique icon shapes. Adding a 2 MB icon library for 15 SVGs is wasteful. Each icon is a template literal in the component that uses it.

5. **Tailwind v3 over v4.** `@astrojs/tailwind` v5.x (the stable release) requires Tailwind v3. The v4 ecosystem is still maturing and would require the Vite plugin directly.

6. **Class-based dark mode over media-query.** `darkMode: "class"` allows a user toggle. Media-query-only (`prefers-color-scheme`) would prevent manual override. The inline script in `<head>` reads `localStorage` before first paint.
