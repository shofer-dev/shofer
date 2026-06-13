export interface CommunityLink {
	label: string
	href: string
	description: string
	icon: string
}

export const communityLinks: CommunityLink[] = [
	{
		label: "Discord",
		href: "https://discord.gg/x39UEEQ2",
		description: "Chat with the team, get help, share feedback",
		icon: "MessageCircle",
	},
	{
		label: "Reddit",
		href: "https://www.reddit.com/r/Shofer_dev/",
		description: "Community discussions and tips",
		icon: "MessageSquare",
	},
	{
		label: "GitHub Issues",
		href: "https://github.com/shofer-dev/shofer/issues",
		description: "Bug reports, feature requests, and tracking",
		icon: "Bug",
	},
	{
		label: "GitHub",
		href: "https://github.com/shofer-dev/shofer",
		description: "Source code, roadmap, and contributing guide",
		icon: "Github",
	},
]
