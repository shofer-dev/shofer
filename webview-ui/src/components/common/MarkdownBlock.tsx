import React, { memo, useEffect, useMemo, useState } from "react"
import ReactMarkdown from "react-markdown"
import styled from "styled-components"
import { visit } from "unist-util-visit"
import rehypeKatex from "rehype-katex"
import remarkMath from "remark-math"
import remarkGfm from "remark-gfm"

import { vscode } from "@src/utils/vscode"

import CodeBlock from "./CodeBlock"
import MermaidBlock from "./MermaidBlock"

interface MarkdownBlockProps {
	markdown?: string
}

/**
 * §4.3: webview-side resolver for `<shofer-blob sha256="..." bytes="N"/>`
 * reference tokens emitted by the extension host when a tool-result /
 * message body exceeded the configured byte cap. The token is detected
 * here, an inline placeholder is rendered, and a `getBlobContent` request
 * is dispatched per unique sha256. When the host replies with a
 * `blobContent` extension message the cache is populated and the token is
 * replaced inline with the resolved text (or an error banner on miss).
 */
const BLOB_REF_PATTERN = /<shofer-blob sha256="([0-9a-f]{64})" bytes="(\d+)"\/>/g

type BlobState = { kind: "loading" } | { kind: "loaded"; content: string } | { kind: "error"; error: string }

const useBlobResolver = (markdown: string | undefined): string => {
	const [cache, setCache] = useState<Record<string, BlobState>>({})

	// Collect unique sha256s present in the current markdown.
	const refs = useMemo(() => {
		if (!markdown || !markdown.includes("<shofer-blob ")) return [] as string[]
		const set = new Set<string>()
		for (const m of markdown.matchAll(BLOB_REF_PATTERN)) set.add(m[1])
		return Array.from(set)
	}, [markdown])

	useEffect(() => {
		if (refs.length === 0) return
		const pending = refs.filter((sha) => !(sha in cache))
		if (pending.length === 0) return
		setCache((prev) => {
			const next = { ...prev }
			for (const sha of pending) next[sha] = { kind: "loading" }
			return next
		})
		for (const sha256 of pending) {
			vscode.postMessage({ type: "getBlobContent", sha256 })
		}
	}, [refs, cache])

	useEffect(() => {
		const handler = (event: MessageEvent) => {
			const msg = event.data
			if (msg?.type !== "blobContent" || !msg.blob?.sha256) return
			const { sha256, content, error } = msg.blob as {
				sha256: string
				content?: string
				error?: string
			}
			setCache((prev) => ({
				...prev,
				[sha256]:
					content !== undefined ? { kind: "loaded", content } : { kind: "error", error: error ?? "missing" },
			}))
		}
		window.addEventListener("message", handler)
		return () => window.removeEventListener("message", handler)
	}, [])

	return useMemo(() => {
		if (!markdown || refs.length === 0) return markdown ?? ""
		return markdown.replace(BLOB_REF_PATTERN, (_match, sha256: string, bytes: string) => {
			const state = cache[sha256]
			if (!state || state.kind === "loading") {
				return `\n\n_📎 Externalised content (${bytes} bytes, sha256 ${sha256.slice(0, 12)}…) — loading…_\n\n`
			}
			if (state.kind === "error") {
				return `\n\n_📎 Externalised content (${bytes} bytes, sha256 ${sha256.slice(0, 12)}…) — ${state.error}_\n\n`
			}
			return state.content
		})
	}, [markdown, refs, cache])
}

const StyledMarkdown = styled.div`
	* {
		font-weight: 400;
	}

	strong {
		font-weight: 600;
	}

	code:not(pre > code) {
		font-family: var(--vscode-editor-font-family, monospace);
		font-size: 0.85em;
		filter: saturation(110%) brightness(95%);
		color: var(--vscode-textPreformat-foreground) !important;
		background-color: var(--vscode-textPreformat-background) !important;
		padding: 1px 2px;
		white-space: pre-line;
		word-break: break-word;
		overflow-wrap: anywhere;
	}

	/* Target only Dark High Contrast theme using the data attribute VS Code adds to the body */
	body[data-vscode-theme-kind="vscode-high-contrast"] & code:not(pre > code) {
		color: var(
			--vscode-editorInlayHint-foreground,
			var(--vscode-symbolIcon-stringForeground, var(--vscode-charts-orange, #e9a700))
		);
	}

	/* KaTeX styling */
	.katex {
		font-size: 1.1em;
		color: var(--vscode-editor-foreground);
		font-family: KaTeX_Main, "Times New Roman", serif;
		line-height: 1.2;
		white-space: normal;
		text-indent: 0;
	}

	.katex-display {
		display: block;
		margin: 1em 0;
		text-align: center;
		padding: 0.5em;
		overflow-x: auto;
		overflow-y: hidden;
		background-color: var(--vscode-textCodeBlock-background);
		border-radius: 3px;
	}

	.katex-error {
		color: var(--vscode-errorForeground);
	}

	font-family:
		var(--vscode-font-family),
		system-ui,
		-apple-system,
		BlinkMacSystemFont,
		"Segoe UI",
		Roboto,
		Oxygen,
		Ubuntu,
		Cantarell,
		"Open Sans",
		"Helvetica Neue",
		sans-serif;

	font-size: var(--vscode-font-size, 13px);

	p,
	li,
	ol,
	ul {
		line-height: 1.35em;
	}

	li {
		margin: 0.5em 0;
	}

	ol,
	ul {
		padding-left: 2em;
		margin-left: 0;
	}

	ol {
		list-style-type: decimal;
	}

	ul {
		list-style-type: disc;
	}

	ol ol {
		list-style-type: lower-alpha;
	}

	ol ol ol {
		list-style-type: lower-roman;
	}

	p {
		white-space: pre-wrap;
		margin: 1em 0 0.25em;
	}

	/* Prevent layout shifts during streaming */
	pre {
		min-height: 3em;
		transition: height 0.2s ease-out;
	}

	/* Code block container styling */
	div:has(> pre) {
		position: relative;
		contain: layout style;
		padding: 0.5em 1em;
	}

	a {
		color: var(--vscode-textLink-foreground);
		text-decoration: none;
		text-decoration-color: var(--vscode-textLink-foreground);
		&:hover {
			color: var(--vscode-textLink-activeForeground);
			text-decoration: underline;
		}
	}

	h1 {
		font-size: 1.65em;
		font-weight: 700;
		margin: 1.35em 0 0.5em;
	}

	h2 {
		font-size: 1.35em;
		font-weight: 500;
		margin: 1.35em 0 0.5em;
	}

	h3 {
		font-size: 1.2em;
		font-weight: 500;
	}

	/* Table styles for remark-gfm */
	table {
		border-collapse: collapse;
		margin: 1em 0;
		width: auto;
		min-width: 50%;
		max-width: 100%;
		table-layout: fixed;
	}

	/* Table wrapper for horizontal scrolling */
	.table-wrapper {
		overflow-x: auto;
		margin: 1em 0;
	}

	th,
	td {
		border: 1px solid var(--vscode-panel-border);
		padding: 8px 12px;
		text-align: left;
		word-wrap: break-word;
		overflow-wrap: break-word;
	}

	th {
		background-color: var(--vscode-editor-background);
		font-weight: 600;
		color: var(--vscode-foreground);
	}

	tr:nth-child(even) {
		background-color: var(--vscode-editor-inactiveSelectionBackground);
	}

	tr:hover {
		background-color: var(--vscode-list-hoverBackground);
	}
`

const MarkdownBlock = memo(({ markdown }: MarkdownBlockProps) => {
	const resolvedMarkdown = useBlobResolver(markdown)
	const components = useMemo(
		() => ({
			table: ({ children, ...props }: any) => {
				return (
					<div className="table-wrapper">
						<table {...props}>{children}</table>
					</div>
				)
			},
			a: ({ href, children, ...props }: any) => {
				const handleClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
					// Only process file:// protocol or local file paths
					const isLocalPath = href?.startsWith("file://") || href?.startsWith("/") || !href?.includes("://")

					if (!isLocalPath) {
						return
					}

					e.preventDefault()

					// Handle absolute vs project-relative paths
					let filePath = href.replace("file://", "")

					// Extract line number if present
					const match = filePath.match(/(.*):(\d+)(-\d+)?$/)
					let values = undefined
					if (match) {
						filePath = match[1]
						values = { line: parseInt(match[2]) }
					}

					// Add ./ prefix if needed
					if (!filePath.startsWith("/") && !filePath.startsWith("./")) {
						filePath = "./" + filePath
					}

					vscode.postMessage({
						type: "openFile",
						text: filePath,
						values,
					})
				}

				return (
					<a {...props} href={href} onClick={handleClick}>
						{children}
					</a>
				)
			},
			pre: ({ children, ..._props }: any) => {
				// The structure from react-markdown v9 is: pre > code > text
				const codeEl = children as React.ReactElement

				if (!codeEl || !codeEl.props) {
					return <pre>{children}</pre>
				}

				const { className = "", children: codeChildren } = codeEl.props

				// Get the actual code text
				let codeString = ""
				if (typeof codeChildren === "string") {
					codeString = codeChildren
				} else if (Array.isArray(codeChildren)) {
					codeString = codeChildren.filter((child) => typeof child === "string").join("")
				}

				// Handle mermaid diagrams
				if (className.includes("language-mermaid")) {
					// A leading `%% shofer:noninteractive` marker (a Mermaid comment)
					// opts a diagram out of the zoom/save toolbox and click-to-open —
					// used by the inline per-round workflow topology snapshots, which
					// are decorative rather than artifacts to export.
					const NONINTERACTIVE = "%% shofer:noninteractive"
					const interactive = !codeString.startsWith(NONINTERACTIVE)
					const code = interactive ? codeString : codeString.slice(codeString.indexOf("\n") + 1)
					return (
						<div style={{ margin: "1em 0" }}>
							<MermaidBlock code={code} interactive={interactive} />
						</div>
					)
				}

				// Extract language from className
				const match = /language-(\w+)/.exec(className)
				const language = match ? match[1] : "text"

				// Wrap CodeBlock in a div to ensure proper separation
				return (
					<div style={{ margin: "1em 0" }}>
						<CodeBlock source={codeString} language={language} />
					</div>
				)
			},
			code: ({ children, className, ...props }: any) => {
				// This handles inline code
				return (
					<code className={className} {...props}>
						{children}
					</code>
				)
			},
		}),
		[],
	)

	return (
		<StyledMarkdown>
			<ReactMarkdown
				remarkPlugins={[
					remarkGfm,
					remarkMath,
					() => {
						return (tree: any) => {
							visit(tree, "code", (node: any) => {
								if (!node.lang) {
									node.lang = "text"
								} else if (node.lang.includes(".")) {
									node.lang = node.lang.split(".").slice(-1)[0]
								}
							})
						}
					},
				]}
				rehypePlugins={[rehypeKatex as any]}
				components={components}>
				{resolvedMarkdown || ""}
			</ReactMarkdown>
		</StyledMarkdown>
	)
})

export default MarkdownBlock
