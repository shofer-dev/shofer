import React, { useMemo, useState } from "react"

import type { McpServer } from "@shofer/types"

import { vscode } from "@src/utils/vscode"
import { useAppTranslation } from "@src/i18n/TranslationContext"
import { Button, Input, Textarea } from "@src/components/ui"

type TransportType = "stdio" | "sse" | "streamable-http"

/**
 * The shape of the editable fields, derived from the parsed `mcp.json` entry.
 * Records (env/headers) and arrays (args/watchPaths) are edited as multi-line
 * text and converted on save, mirroring the `mcp.json` schema fields documented
 * in `docs/mcp.md`.
 */
type EditorState = {
	type: TransportType
	command: string
	args: string // one argument per line
	cwd: string
	env: string // KEY=VALUE per line
	url: string
	headers: string // KEY=VALUE per line
	watchPaths: string // one path per line
}

const recordToLines = (record: unknown): string => {
	if (!record || typeof record !== "object") {
		return ""
	}
	return Object.entries(record as Record<string, unknown>)
		.map(([key, value]) => `${key}=${String(value)}`)
		.join("\n")
}

const arrayToLines = (value: unknown): string =>
	Array.isArray(value) ? (value as unknown[]).map((item) => String(item)).join("\n") : ""

const linesToArray = (text: string): string[] =>
	text
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0)

const linesToRecord = (text: string): Record<string, string> => {
	const record: Record<string, string> = {}
	for (const rawLine of text.split("\n")) {
		const line = rawLine.trim()
		if (!line) {
			continue
		}
		const eq = line.indexOf("=")
		if (eq === -1) {
			// Tolerate a bare key with an empty value.
			record[line] = ""
			continue
		}
		const key = line.slice(0, eq).trim()
		const value = line.slice(eq + 1).trim()
		if (key) {
			record[key] = value
		}
	}
	return record
}

const inferType = (config: Record<string, unknown>): TransportType => {
	if (config.type === "sse" || config.type === "streamable-http" || config.type === "stdio") {
		return config.type
	}
	return config.url ? "streamable-http" : "stdio"
}

const buildInitialState = (configJson: string): EditorState => {
	let config: Record<string, unknown> = {}
	try {
		config = JSON.parse(configJson) ?? {}
	} catch {
		config = {}
	}
	return {
		type: inferType(config),
		command: typeof config.command === "string" ? config.command : "",
		args: arrayToLines(config.args),
		cwd: typeof config.cwd === "string" ? config.cwd : "",
		env: recordToLines(config.env),
		url: typeof config.url === "string" ? config.url : "",
		headers: recordToLines(config.headers),
		watchPaths: arrayToLines(config.watchPaths),
	}
}

const labelStyle: React.CSSProperties = {
	display: "block",
	fontSize: "11px",
	textTransform: "uppercase",
	opacity: 0.7,
	marginBottom: "3px",
}

const fieldStyle: React.CSSProperties = { marginBottom: "10px" }

const hintStyle: React.CSSProperties = {
	fontSize: "11px",
	color: "var(--vscode-descriptionForeground)",
	marginTop: "2px",
}

/**
 * Inline editor for the full set of configurable `mcp.json` properties of a
 * single server. Fields shown depend on the selected transport `type`. Saving
 * sends a partial config patch to the extension, which validates it, writes it
 * to the appropriate config file, and reconnects the server.
 */
const McpServerConfigEditor = ({ server }: { server: McpServer }) => {
	const { t } = useAppTranslation()
	const initial = useMemo(() => buildInitialState(server.config), [server.config])
	const [state, setState] = useState<EditorState>(initial)

	// `server.config` changes after a successful save (the extension re-pushes
	// state); fold those external updates back into the form.
	const [baseline, setBaseline] = useState(server.config)
	if (server.config !== baseline) {
		setBaseline(server.config)
		setState(buildInitialState(server.config))
	}

	const isStdio = state.type === "stdio"
	const isDirty = JSON.stringify(state) !== JSON.stringify(initial)

	const update = (patch: Partial<EditorState>) => setState((prev) => ({ ...prev, ...patch }))

	const handleSave = () => {
		// Build a patch covering every editable field. Fields irrelevant to the
		// selected transport are sent as `undefined` so the extension drops them
		// from the stored config (clean transport switches).
		const serverConfig: Record<string, unknown> = { type: state.type }

		if (isStdio) {
			serverConfig.command = state.command.trim() || undefined
			const args = linesToArray(state.args)
			serverConfig.args = args.length > 0 ? args : undefined
			serverConfig.cwd = state.cwd.trim() || undefined
			const env = linesToRecord(state.env)
			serverConfig.env = Object.keys(env).length > 0 ? env : undefined
			// Clear url-based fields.
			serverConfig.url = undefined
			serverConfig.headers = undefined
		} else {
			serverConfig.url = state.url.trim() || undefined
			const headers = linesToRecord(state.headers)
			serverConfig.headers = Object.keys(headers).length > 0 ? headers : undefined
			// Clear stdio fields.
			serverConfig.command = undefined
			serverConfig.args = undefined
			serverConfig.cwd = undefined
			serverConfig.env = undefined
		}

		const watchPaths = linesToArray(state.watchPaths)
		serverConfig.watchPaths = watchPaths.length > 0 ? watchPaths : undefined

		vscode.postMessage({
			type: "updateMcpServerConfig",
			serverName: server.name,
			source: server.source || "global",
			serverConfig,
		})
	}

	const handleReset = () => setState(initial)

	return (
		<div style={{ padding: "8px 12px 4px 12px" }} onClick={(e) => e.stopPropagation()}>
			<div style={fieldStyle}>
				<label style={labelStyle}>{t("mcp:configEditor.type")}</label>
				<select
					value={state.type}
					onChange={(e) => update({ type: e.target.value as TransportType })}
					style={{
						width: "100%",
						padding: "4px",
						background: "var(--vscode-dropdown-background)",
						color: "var(--vscode-dropdown-foreground)",
						border: "1px solid var(--vscode-dropdown-border)",
						borderRadius: "2px",
						outline: "none",
						cursor: "pointer",
					}}>
					<option value="stdio">{t("mcp:configEditor.types.stdio")}</option>
					<option value="sse">{t("mcp:configEditor.types.sse")}</option>
					<option value="streamable-http">{t("mcp:configEditor.types.streamableHttp")}</option>
				</select>
			</div>

			{isStdio ? (
				<>
					<div style={fieldStyle}>
						<label style={labelStyle}>{t("mcp:configEditor.command")}</label>
						<Input
							value={state.command}
							onChange={(e) => update({ command: e.target.value })}
							placeholder="node"
						/>
					</div>
					<div style={fieldStyle}>
						<label style={labelStyle}>{t("mcp:configEditor.args")}</label>
						<Textarea
							value={state.args}
							onChange={(e) => update({ args: e.target.value })}
							placeholder={"path/to/server.js\n--flag"}
							rows={3}
						/>
						<div style={hintStyle}>{t("mcp:configEditor.argsHint")}</div>
					</div>
					<div style={fieldStyle}>
						<label style={labelStyle}>{t("mcp:configEditor.cwd")}</label>
						<Input
							value={state.cwd}
							onChange={(e) => update({ cwd: e.target.value })}
							placeholder="${workspaceFolder}"
						/>
					</div>
					<div style={fieldStyle}>
						<label style={labelStyle}>{t("mcp:configEditor.env")}</label>
						<Textarea
							value={state.env}
							onChange={(e) => update({ env: e.target.value })}
							placeholder={"API_KEY=value\nDEBUG=true"}
							rows={3}
						/>
						<div style={hintStyle}>{t("mcp:configEditor.keyValueHint")}</div>
					</div>
				</>
			) : (
				<>
					<div style={fieldStyle}>
						<label style={labelStyle}>{t("mcp:configEditor.url")}</label>
						<Input
							value={state.url}
							onChange={(e) => update({ url: e.target.value })}
							placeholder="http://localhost:3000"
						/>
					</div>
					<div style={fieldStyle}>
						<label style={labelStyle}>{t("mcp:configEditor.headers")}</label>
						<Textarea
							value={state.headers}
							onChange={(e) => update({ headers: e.target.value })}
							placeholder={"Authorization=Bearer token"}
							rows={3}
						/>
						<div style={hintStyle}>{t("mcp:configEditor.keyValueHint")}</div>
					</div>
				</>
			)}

			<div style={fieldStyle}>
				<label style={labelStyle}>{t("mcp:configEditor.watchPaths")}</label>
				<Textarea
					value={state.watchPaths}
					onChange={(e) => update({ watchPaths: e.target.value })}
					placeholder={"./build/server.js"}
					rows={2}
				/>
				<div style={hintStyle}>{t("mcp:configEditor.watchPathsHint")}</div>
			</div>

			<div style={{ display: "flex", gap: "8px", marginTop: "4px" }}>
				<Button variant="primary" disabled={!isDirty} onClick={handleSave}>
					{t("mcp:configEditor.save")}
				</Button>
				<Button variant="secondary" disabled={!isDirty} onClick={handleReset}>
					{t("mcp:configEditor.reset")}
				</Button>
			</div>
		</div>
	)
}

export default McpServerConfigEditor
