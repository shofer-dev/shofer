export const siteConfig = {
	name: "Shofer",
	tagline: "State-of-the-art open-source AI coding assistant",
	description:
		"Shofer is a locally-run, state-of-the-art, fully configurable AI coding agent that operates as a VS Code extension — running entirely on your machine, under your control.",
	url: "https://shofer.dev",
	ogImage: "/og-image.png",
	links: {
		github: "https://github.com/shofer-dev/shofer",
		discord: "https://discord.gg/x39UEEQ2",
		reddit: "https://reddit.com/r/Shofer_dev",
		docs: "https://github.com/shofer-dev/shofer/blob/master/USER_MANUAL.md",
	},
}

export interface NavItem {
	label: string
	href: string
	external?: boolean
}

export const navigation: NavItem[] = [
	{ label: "Features", href: "#features" },
	{ label: "Modes", href: "#modes" },
	{ label: "Migration", href: "#migration" },
	{ label: "Community", href: "#community" },
	{ label: "Docs", href: "https://github.com/shofer-dev/shofer/blob/master/USER_MANUAL.md", external: true },
	{ label: "GitHub", href: "https://github.com/shofer-dev/shofer", external: true },
]
