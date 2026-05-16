import React, { useState } from "react"
import RagSearchResult from "./RagSearchResult"
import { Trans } from "react-i18next"

interface RagSearchResultsDisplayProps {
	results: Array<{
		filePath: string
		score: number
		startLine: number
		endLine: number
		codeChunk: string
	}>
}

const RagSearchResultsDisplay: React.FC<RagSearchResultsDisplayProps> = ({ results }) => {
	const [ragSearchResultsExpanded, setRagSearchResultsExpanded] = useState(false)

	return (
		<div className="flex flex-col -mt-4 gap-1">
			<div
				onClick={() => setRagSearchResultsExpanded(!ragSearchResultsExpanded)}
				className="cursor-pointer flex items-center justify-between px-2 py-2 border bg-[var(--vscode-editor-background)] border-[var(--vscode-editorGroup-border)]">
				<span>
					<Trans
						i18nKey="chat:ragSearch.didSearch"
						count={results.length}
						values={{ count: results.length }}
					/>
				</span>
				<span className={`codicon codicon-chevron-${ragSearchResultsExpanded ? "up" : "down"}`}></span>
			</div>

			{ragSearchResultsExpanded && (
				<div className="flex flex-col gap-1">
					{results.map((result, idx) => (
						<RagSearchResult
							key={idx}
							filePath={result.filePath}
							score={result.score}
							startLine={result.startLine}
							endLine={result.endLine}
							language="plaintext"
							snippet={result.codeChunk}
						/>
					))}
				</div>
			)}
		</div>
	)
}

export default RagSearchResultsDisplay
