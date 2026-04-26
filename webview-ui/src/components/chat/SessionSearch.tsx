import React, { useCallback, useEffect, useMemo, useRef, useState } from "react"

import type { ClineMessage } from "@roo-code/types"

import { Input } from "@src/components/ui/input"

/**
 * Floating in-session search box for the currently loaded Roo-Code task.
 *
 * Triggered by Ctrl+F (Cmd+F on macOS) from `ChatView`. Performs a
 * case-insensitive substring search against the `text` field of every
 * `ClineMessage` in the active task and exposes prev/next navigation.
 *
 * The component is purely presentational w.r.t. scrolling and highlighting:
 * matched message timestamps are reported via `onNavigate`; the parent
 * (`ChatView`) is responsible for scrolling the virtualized list and
 * applying the highlight ring on the matched `ChatRow`.
 */

interface SessionSearchProps {
	messages: ClineMessage[]
	isOpen: boolean
	onClose: () => void
	/** Invoked with the timestamp of the currently selected match (or null when there is no match). */
	onNavigate: (ts: number | null) => void
}

const SessionSearch: React.FC<SessionSearchProps> = ({ messages, isOpen, onClose, onNavigate }) => {
	const [query, setQuery] = useState("")
	const [currentIndex, setCurrentIndex] = useState(0)
	const inputRef = useRef<HTMLInputElement>(null)

	// Compute matching message timestamps for the current query. We dedupe by
	// `ts` so that a single message containing multiple occurrences is still
	// navigated to once (the `ChatRow` is the smallest scroll unit).
	const matchTimestamps = useMemo<number[]>(() => {
		const trimmed = query.trim()
		if (!trimmed) return []
		const needle = trimmed.toLowerCase()
		const seen = new Set<number>()
		const result: number[] = []
		for (const msg of messages) {
			const text = msg.text
			if (!text) continue
			if (text.toLowerCase().includes(needle) && !seen.has(msg.ts)) {
				seen.add(msg.ts)
				result.push(msg.ts)
			}
		}
		return result
	}, [query, messages])

	// Keep currentIndex within bounds whenever results change (e.g. user
	// edited the query or messages streamed in).
	useEffect(() => {
		if (matchTimestamps.length === 0) {
			setCurrentIndex(0)
			return
		}
		setCurrentIndex((prev) => (prev >= matchTimestamps.length ? 0 : prev))
	}, [matchTimestamps])

	// Notify parent of currently-selected match (or clear highlight).
	useEffect(() => {
		if (!isOpen) {
			onNavigate(null)
			return
		}
		const ts = matchTimestamps[currentIndex] ?? null
		onNavigate(ts)
	}, [isOpen, matchTimestamps, currentIndex, onNavigate])

	// Auto-focus + select-all when the search box opens so subsequent Ctrl+F
	// presses behave like a typical browser/editor find experience.
	useEffect(() => {
		if (!isOpen) return
		const handle = window.setTimeout(() => {
			inputRef.current?.focus()
			inputRef.current?.select()
		}, 0)
		return () => window.clearTimeout(handle)
	}, [isOpen])

	const goNext = useCallback(() => {
		if (matchTimestamps.length === 0) return
		setCurrentIndex((prev) => (prev + 1) % matchTimestamps.length)
	}, [matchTimestamps.length])

	const goPrev = useCallback(() => {
		if (matchTimestamps.length === 0) return
		setCurrentIndex((prev) => (prev - 1 + matchTimestamps.length) % matchTimestamps.length)
	}, [matchTimestamps.length])

	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent<HTMLInputElement>) => {
			if (e.key === "Enter") {
				e.preventDefault()
				if (e.shiftKey) goPrev()
				else goNext()
			} else if (e.key === "Escape") {
				e.preventDefault()
				onClose()
			}
		},
		[goNext, goPrev, onClose],
	)

	if (!isOpen) return null

	const status = query.trim()
		? matchTimestamps.length > 0
			? `${currentIndex + 1} / ${matchTimestamps.length}`
			: "0 / 0"
		: ""

	return (
		<div
			role="search"
			aria-label="Search session"
			className="absolute top-2 right-3 z-30 flex items-center gap-2 px-2 py-1.5 rounded-md border border-vscode-panel-border bg-vscode-editor-background shadow-md">
			<span className="codicon codicon-search text-vscode-descriptionForeground text-xs" />
			<Input
				ref={inputRef}
				value={query}
				onChange={(e) => setQuery(e.target.value)}
				onKeyDown={handleKeyDown}
				placeholder="Find in session"
				aria-label="Find in session"
				className="h-7 w-56 rounded-md text-xs px-2 py-0"
			/>
			<span className="text-xs text-vscode-descriptionForeground min-w-[3.5rem] text-right tabular-nums">
				{status}
			</span>
			<button
				type="button"
				onClick={goPrev}
				disabled={matchTimestamps.length === 0}
				title="Previous match (Shift+Enter)"
				aria-label="Previous match"
				className="p-1 rounded hover:bg-vscode-toolbar-hoverBackground disabled:opacity-40 disabled:cursor-default text-vscode-foreground">
				<span className="codicon codicon-arrow-up text-xs" />
			</button>
			<button
				type="button"
				onClick={goNext}
				disabled={matchTimestamps.length === 0}
				title="Next match (Enter)"
				aria-label="Next match"
				className="p-1 rounded hover:bg-vscode-toolbar-hoverBackground disabled:opacity-40 disabled:cursor-default text-vscode-foreground">
				<span className="codicon codicon-arrow-down text-xs" />
			</button>
			<button
				type="button"
				onClick={onClose}
				title="Close (Esc)"
				aria-label="Close search"
				className="p-1 rounded hover:bg-vscode-toolbar-hoverBackground text-vscode-foreground">
				<span className="codicon codicon-close text-xs" />
			</button>
		</div>
	)
}

export default SessionSearch
