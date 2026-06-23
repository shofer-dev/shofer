import React, { useCallback, useEffect, useMemo, useRef, useState } from "react"

import type { ShoferMessage } from "@shofer/types"

import { Input } from "@src/components/ui/input"

/**
 * Floating in-session search box for the currently loaded Shofer task.
 *
 * Triggered by Ctrl+F (Cmd+F on macOS) from `ChatView`. Performs a
 * case-insensitive substring search against the `text` field of every
 * `ShoferMessage` in the active task and exposes prev/next navigation.
 *
 * Match counts and navigation targets (message `ts`) are derived from the
 * raw message text. The actual *visual* highlighting of matched substrings
 * is painted on top of the rendered DOM via the CSS Custom Highlight API
 * (`CSS.highlights` + `::highlight(...)` rules in `index.css`), which lets
 * us highlight inside markdown-rendered content without mutating the React
 * DOM. Matches inside the currently-selected row use a stronger highlight
 * color to disambiguate from other matches.
 *
 * The parent (`ChatView`) is responsible for scrolling the virtualized
 * list to the selected match (reported via `onNavigate`).
 */

interface SessionSearchProps {
	messages: ShoferMessage[]
	isOpen: boolean
	onClose: () => void
	/** Invoked with the timestamp of the currently selected match (or null when there is no match). */
	onNavigate: (ts: number | null) => void
}

// Highlight registry names (must match `::highlight(...)` rules in index.css).
const HL_ALL = "session-search-all"
const HL_CURRENT = "session-search-current"

/** Minimum browser plumbing for the CSS Custom Highlight API. */
type HighlightCtor = new (...ranges: Range[]) => unknown
type HighlightRegistry = {
	set: (name: string, highlight: unknown) => void
	delete: (name: string) => void
}
const getHighlightRegistry = (): HighlightRegistry | null => {
	const cssAny = (typeof CSS !== "undefined" ? CSS : undefined) as unknown as
		| { highlights?: HighlightRegistry }
		| undefined
	const HighlightClass = (globalThis as unknown as { Highlight?: HighlightCtor }).Highlight
	if (!cssAny?.highlights || !HighlightClass) return null
	return cssAny.highlights
}
const getHighlightCtor = (): HighlightCtor | null =>
	(globalThis as unknown as { Highlight?: HighlightCtor }).Highlight ?? null

/**
 * Message `say` types whose `text` field carries machine-readable data
 * (JSON blobs, serialized wire requests, commit hashes, …) rather than
 * user-visible prose. These rows either render nothing or show only a
 * minimal icon/tooltip, so their raw `text` must be excluded from the
 * substring search — otherwise queries match against hidden payloads the
 * user never sees (e.g. the `wireRequest` JSON inside an
 * `api_req_started` message).
 */
const MACHINE_DATA_SAY_TYPES = new Set<string>([
	"api_req_started",
	"api_req_finished",
	"api_req_retried",
	"api_req_retry_delayed",
	"api_req_rate_limit_wait",
	"api_req_deleted",
	"checkpoint_saved",
])

const SessionSearch: React.FC<SessionSearchProps> = ({ messages, isOpen, onClose, onNavigate }) => {
	const [query, setQuery] = useState("")
	const [currentIndex, setCurrentIndex] = useState(0)
	const inputRef = useRef<HTMLInputElement>(null)

	// Compute matching message timestamps for the current query. We dedupe by
	// `ts` so that a single message containing multiple occurrences is still
	// navigated to once (the `ChatRow` is the smallest scroll unit).
	//
	// Messages whose `text` is machine-readable data (see
	// `MACHINE_DATA_SAY_TYPES`) are skipped so the search only matches
	// content the user can actually read in the chat.
	const matchTimestamps = useMemo<number[]>(() => {
		const trimmed = query.trim()
		if (!trimmed) return []
		const needle = trimmed.toLowerCase()
		const seen = new Set<number>()
		const result: number[] = []
		for (const msg of messages) {
			// Skip machine-data messages — their `text` is not user-visible prose.
			if (msg.type === "say" && msg.say && MACHINE_DATA_SAY_TYPES.has(msg.say)) continue
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

	// Paint per-occurrence text highlights via the CSS Custom Highlight API.
	//
	// We re-scan the rendered DOM (rows are tagged with `data-message-ts`)
	// every time the query, the selected match, or the set of mounted rows
	// changes. Virtuoso virtualizes the list, so a MutationObserver bumps
	// `domVersion` whenever rows are added/removed — that keeps highlights
	// in sync as the user scrolls into matches that weren't previously
	// rendered.
	const [domVersion, setDomVersion] = useState(0)
	useEffect(() => {
		if (!isOpen) return
		let pending = 0
		const bump = () => {
			if (pending) return
			pending = window.setTimeout(() => {
				pending = 0
				setDomVersion((v) => v + 1)
			}, 80)
		}
		const observer = new MutationObserver(bump)
		observer.observe(document.body, { childList: true, subtree: true, characterData: true })
		return () => {
			observer.disconnect()
			if (pending) window.clearTimeout(pending)
		}
	}, [isOpen])

	useEffect(() => {
		const registry = getHighlightRegistry()
		const HighlightCls = getHighlightCtor()
		if (!registry || !HighlightCls) return

		const cleanup = () => {
			registry.delete(HL_ALL)
			registry.delete(HL_CURRENT)
		}

		const needle = query.trim().toLowerCase()
		if (!isOpen || !needle) {
			cleanup()
			return cleanup
		}

		const currentTs = matchTimestamps[currentIndex]
		const matchSet = new Set(matchTimestamps)
		const allRanges: Range[] = []
		const currentRanges: Range[] = []

		const rows = document.querySelectorAll<HTMLElement>("[data-message-ts]")
		rows.forEach((row) => {
			const ts = Number(row.getAttribute("data-message-ts"))
			if (!matchSet.has(ts)) return
			const target = ts === currentTs ? currentRanges : allRanges

			const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT, {
				acceptNode: (node) => {
					// Skip text nodes inside <script>/<style> just in case.
					const parent = node.parentElement
					if (!parent) return NodeFilter.FILTER_REJECT
					const tag = parent.tagName
					if (tag === "SCRIPT" || tag === "STYLE") return NodeFilter.FILTER_REJECT
					return NodeFilter.FILTER_ACCEPT
				},
			})
			let node = walker.nextNode()
			while (node) {
				const text = node.textContent ?? ""
				const lower = text.toLowerCase()
				let from = 0
				while (true) {
					const idx = lower.indexOf(needle, from)
					if (idx < 0) break
					const range = document.createRange()
					range.setStart(node, idx)
					range.setEnd(node, idx + needle.length)
					target.push(range)
					from = idx + needle.length
				}
				node = walker.nextNode()
			}
		})

		registry.set(HL_ALL, new HighlightCls(...allRanges))
		registry.set(HL_CURRENT, new HighlightCls(...currentRanges))

		return cleanup
	}, [isOpen, query, matchTimestamps, currentIndex, domVersion])

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
