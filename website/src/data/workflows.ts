export interface Workflow {
	name: string
	icon: string
	description: string
	agents: string
	demoImage: string
	docsSlug: string
}

export const workflows: Workflow[] = [
	{
		name: "Collaborative Debug",
		icon: "🐞",
		description:
			"Two developers independently triage, converge on the root cause through peer review, get user sign-off, then one fixes while the other reviews — iterating until both are satisfied.",
		agents: "Orchestrator + Developer1 + Developer2",
		demoImage: "/images/workflows/debug.png",
		docsSlug: "debug",
	},
	{
		name: "Implement a Feature",
		icon: "🔧",
		description:
			"The Architect designs, you approve, then Developer implements while Reviewer inspects — iterating until done. Full design → implementation → review pipeline.",
		agents: "Architect + Developer + Reviewer",
		demoImage: "/images/workflows/implement-feature.png",
		docsSlug: "implement-feature",
	},
]
