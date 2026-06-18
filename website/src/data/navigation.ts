export const siteConfig = {
	name: "Shofer",
	tagline: "Deterministic, observable multi-agent coding — open source, in VS Code",
	description:
		"Shofer is a new (June 2026) open-source AI coding agent for VS Code with unparalleled parallelism, usability and observability. Specify multi-agent workflows declaratively, and watch them execute as live diagrams — on top of all the standard features you expect from your AI-powered development environment.",
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
	{ label: "Demo", href: "#demo" },
	{ label: "Features", href: "#features" },
	{ label: "Migration", href: "#migration" },
	{ label: "Community", href: "#community" },
	{ label: "Docs", href: "https://github.com/shofer-dev/shofer/blob/master/USER_MANUAL.md", external: true },
	{ label: "GitHub", href: "https://github.com/shofer-dev/shofer", external: true },
]
