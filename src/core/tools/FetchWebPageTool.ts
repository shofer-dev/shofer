/**
 * FetchWebPageTool - Fetches and extracts content from web pages.
 *
 * Downloads web pages and extracts their text content, removing HTML markup.
 * Optionally filters content by a query. Ported from workspace-tools `workspace_fetchWebPage`.
 */

import { Task } from "../task/Task"
import type { ToolUse } from "../../shared/tools"

import { BaseTool, ToolCallbacks } from "./BaseTool"

interface FetchWebPageParams {
	urls: string[]
	query?: string | null
}

interface WebPageResult {
	url: string
	title?: string
	content: string
	error?: string
}

const MAX_OUTPUT_SIZE = 200 * 1024 // 200KB

import { type ClineSayTool } from "@roo-code/types"

export class FetchWebPageTool extends BaseTool<"fetch_web_page"> {
	readonly name = "fetch_web_page" as const

	async execute(params: FetchWebPageParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { urls, query } = params
		const { askApproval, handleError, pushToolResult } = callbacks

		if (!urls || urls.length === 0) {
			task.consecutiveMistakeCount++
			task.recordToolError("fetch_web_page")
			task.didToolFailInCurrentTurn = true
			pushToolResult(await task.sayAndCreateMissingParamError("fetch_web_page", "urls"))
			return
		}

		try {
			task.consecutiveMistakeCount = 0

			const sharedMessageProps: ClineSayTool = {
				tool: "fetchWebPage",
			}

			const completeMessage = JSON.stringify({
				...sharedMessageProps,
				content: `Fetching ${urls.length} URL(s)${query ? ` with query: ${query}` : ""}`,
			} satisfies ClineSayTool)

			const didApprove = await askApproval("tool", completeMessage)
			if (!didApprove) {
				return
			}

			const results: WebPageResult[] = []
			for (const url of urls) {
				try {
					const result = await fetchAndExtract(url, query ?? undefined)
					results.push(result)
				} catch (err) {
					results.push({ url, content: "", error: err instanceof Error ? err.message : String(err) })
				}
			}

			const sections = results.map((r) => {
				if (r.error) {
					return `## ${r.url}\n\nError: ${r.error}`
				}
				const title = r.title ? `# ${r.title}\n\n` : ""
				const content = truncateToSize(r.content, Math.floor(MAX_OUTPUT_SIZE / urls.length))
				return `## ${r.url}\n\n${title}${content}`
			})

			pushToolResult(sections.join("\n\n---\n\n"))
		} catch (error) {
			await handleError("fetching web page", error instanceof Error ? error : new Error(String(error)))
		}
	}
}

export const fetchWebPageTool = new FetchWebPageTool()

// ---- helpers ----

function truncateToSize(text: string, maxBytes: number): string {
	const encoder = new TextEncoder()
	const bytes = encoder.encode(text)
	if (bytes.length <= maxBytes) {
		return text
	}
	const truncated = new TextDecoder().decode(bytes.slice(0, maxBytes))
	return truncated + `\n\n... [truncated, ${bytes.length} bytes total]`
}

async function fetchAndExtract(url: string, query: string | undefined): Promise<WebPageResult> {
	let parsedUrl: URL
	try {
		parsedUrl = new URL(url)
		if (!["http:", "https:"].includes(parsedUrl.protocol)) {
			throw new Error("Only HTTP(S) URLs are supported")
		}
	} catch {
		throw new Error(`Invalid URL: ${url}`)
	}

	const response = await fetch(url, {
		headers: {
			"User-Agent": "Mozilla/5.0 (compatible; RooCode/1.0)",
			Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8",
		},
	})

	if (!response.ok) {
		throw new Error(`HTTP ${response.status}: ${response.statusText}`)
	}

	const contentType = response.headers.get("content-type") || ""
	const html = await response.text()

	let content: string
	let title: string | undefined

	if (contentType.includes("text/plain")) {
		content = html
	} else if (contentType.includes("application/json")) {
		try {
			content = JSON.stringify(JSON.parse(html), null, 2)
		} catch {
			content = html
		}
	} else {
		const extracted = extractTextFromHtml(html)
		content = extracted.content
		title = extracted.title
	}

	if (query && content) {
		content = filterByQuery(content, query)
	}

	return { url, title, content }
}

function extractTextFromHtml(html: string): { content: string; title?: string } {
	const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i)
	const title = titleMatch ? decodeHtmlEntities(titleMatch[1].trim()) : undefined

	let text = html
		.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
		.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
		.replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, "")
		.replace(/<!--[\s\S]*?-->/g, "")

	const mainContentPattern = /<(main|article|div[^>]*(?:content|main|article)[^>]*)[^>]*>([\s\S]*?)<\/\1>/gi
	const mainMatches = [...text.matchAll(mainContentPattern)]
	if (mainMatches.length > 0) {
		const contents = mainMatches.map((m) => m[2])
		text = contents.reduce((a, b) => (a.length > b.length ? a : b), "")
	}

	text = text.replace(/<[^>]+>/g, " ")
	text = decodeHtmlEntities(text)
	text = text
		.replace(/\s+/g, " ")
		.replace(/\n\s*\n/g, "\n\n")
		.trim()

	const paragraphs = text.split(/\n{2,}/).filter((p) => p.trim().length > 20)
	return { content: paragraphs.join("\n\n"), title }
}

function decodeHtmlEntities(text: string): string {
	const entities: Record<string, string> = {
		"&amp;": "&",
		"&lt;": "<",
		"&gt;": ">",
		"&quot;": '"',
		"&#39;": "'",
		"&apos;": "'",
		"&nbsp;": " ",
		"&mdash;": "—",
		"&ndash;": "–",
		"&hellip;": "…",
		"&copy;": "©",
		"&reg;": "®",
		"&trade;": "™",
	}
	let result = text
	for (const [entity, char] of Object.entries(entities)) {
		result = result.replace(new RegExp(entity, "g"), char)
	}
	result = result.replace(/&#(\d+);/g, (_, num) => String.fromCharCode(parseInt(num, 10)))
	result = result.replace(/&#x([a-fA-F0-9]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
	return result
}

function filterByQuery(content: string, query: string): string {
	const words = query
		.toLowerCase()
		.split(/\s+/)
		.filter((w) => w.length > 2)
	if (words.length === 0) {
		return content
	}

	const lines = content.split("\n")
	const relevantIndices = new Set<number>()

	for (let i = 0; i < lines.length; i++) {
		const lineLower = lines[i].toLowerCase()
		for (const word of words) {
			if (lineLower.includes(word)) {
				for (let j = Math.max(0, i - 2); j <= Math.min(lines.length - 1, i + 2); j++) {
					relevantIndices.add(j)
				}
				break
			}
		}
	}

	if (relevantIndices.size === 0) {
		return `No content matching query: "${query}"`
	}

	const sortedIndices = Array.from(relevantIndices).sort((a, b) => a - b)
	const sections: string[] = []
	let currentSection: string[] = []
	let lastIndex = -2

	for (const idx of sortedIndices) {
		if (idx > lastIndex + 1) {
			if (currentSection.length > 0) {
				sections.push(currentSection.join("\n"))
				currentSection = []
			}
		}
		currentSection.push(lines[idx])
		lastIndex = idx
	}
	if (currentSection.length > 0) {
		sections.push(currentSection.join("\n"))
	}

	return sections.join("\n\n...\n\n")
}
