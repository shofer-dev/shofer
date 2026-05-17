import { VSCodeLink } from "@vscode/webview-ui-toolkit/react"
import { useTranslation } from "react-i18next"
import { Trans } from "react-i18next"
import { BookOpen, ArrowLeftRight, ExternalLink } from "lucide-react"

const DOCS_BASE = "https://github.com/shofer-dev/shofer/blob/master"

const docsLinks = [
	{ icon: <BookOpen className="size-4 shrink-0 mt-0.5" />, path: "README.md", key: "chat:docs.readme" },
	{
		icon: <ArrowLeftRight className="size-4 shrink-0 mt-0.5" />,
		path: "ROOCODE_MIGRATION.md",
		key: "chat:docs.roocode",
	},
	{
		icon: <ExternalLink className="size-4 shrink-0 mt-0.5" />,
		path: "COPILOT_MIGRATION.md",
		key: "chat:docs.copilot",
	},
]

const ShoferTips = () => {
	const { t } = useTranslation("chat")

	return (
		<div className="flex flex-col gap-2 mb-4 max-w-[500px] text-vscode-descriptionForeground">
			<p className="my-0 pr-2 text-base font-medium">
				<Trans i18nKey="chat:about" />
			</p>
			<div className="gap-4">
				{docsLinks.map((link) => (
					<div key={link.path} className="flex items-start gap-2 mt-2 mr-6 leading-relaxed">
						{link.icon}
						<VSCodeLink className="text-muted-foreground underline" href={`${DOCS_BASE}/${link.path}`}>
							{t(link.key)}
						</VSCodeLink>
					</div>
				))}
			</div>
		</div>
	)
}

export default ShoferTips
