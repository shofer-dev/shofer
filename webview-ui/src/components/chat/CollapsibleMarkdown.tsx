import { useState } from "react"
import { useTranslation } from "react-i18next"
import { ChevronDown, ChevronUp } from "lucide-react"

import MarkdownBlock from "../common/MarkdownBlock"

const DEFAULT_CHAR_THRESHOLD = 600

interface CollapsibleMarkdownProps {
	/** Markdown body to render. May be arbitrarily long. */
	markdown: string | undefined
	/** Tailwind max-height class applied while collapsed. */
	collapsedMaxHeightClass?: string
	/** Bodies shorter than this many characters render in full, with no toggle. */
	charThreshold?: number
}

/**
 * Renders Markdown that can be arbitrarily long, clamped to a max height with a
 * Show more / Show less toggle so a long message body (peer messages, new_task
 * instructions, …) doesn't dominate the chat. Short bodies render in full with
 * no toggle.
 */
const CollapsibleMarkdown = ({
	markdown,
	collapsedMaxHeightClass = "max-h-40",
	charThreshold = DEFAULT_CHAR_THRESHOLD,
}: CollapsibleMarkdownProps) => {
	const { t } = useTranslation()
	const [expanded, setExpanded] = useState(false)
	const text = markdown ?? ""

	if (text.length <= charThreshold) {
		return <MarkdownBlock markdown={text} />
	}

	return (
		<div>
			<div className={expanded ? undefined : `${collapsedMaxHeightClass} overflow-hidden`}>
				<MarkdownBlock markdown={text} />
			</div>
			<button
				type="button"
				className="cursor-pointer flex gap-1 items-center mt-1 text-xs text-vscode-descriptionForeground hover:underline font-normal"
				onClick={() => setExpanded((v) => !v)}>
				{expanded ? (
					<>
						{t("chat:collapsibleMessage.showLess")}
						<ChevronUp className="size-3" />
					</>
				) : (
					<>
						{t("chat:collapsibleMessage.showMore")}
						<ChevronDown className="size-3" />
					</>
				)}
			</button>
		</div>
	)
}

export default CollapsibleMarkdown
