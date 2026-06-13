import { useMemo, useState } from "react"
import { SendHorizontal } from "lucide-react"

import type { ParamField } from "@shofer/types"

import { useAppTranslation } from "@src/i18n/TranslationContext"
import { cn } from "@src/lib/utils"
import { StandardTooltip } from "@src/components/ui"

interface WorkflowParamFormProps {
	/** Typed fields to render, one per flow input parameter. */
	params: ParamField[]
	/**
	 * Called with the JSON-serialized answers ({ name: value }) when the user
	 * submits. Values are typed: number fields emit numbers, boolean fields
	 * emit booleans, string fields emit strings.
	 */
	onSubmit?: (json: string) => void
	/** When true the form is read-only (the question has already been answered). */
	isAnswered?: boolean
	/**
	 * Final submitted values, present once answered. Used to seed the read-only
	 * display after a reload (when the component re-mounts with no local edits).
	 */
	answeredValues?: Record<string, string | number | boolean | string[]>
}

type FieldValue = string | boolean | string[]

/** The concrete widget to render for a field, derived from its type + metadata. */
type Widget = "checkbox" | "dropdown" | "radio" | "multiselect" | "slider" | "number" | "textarea"

function widgetFor(p: ParamField): Widget {
	if (p.type === "boolean") return "checkbox"
	if (p.options && p.options.length > 0) {
		if (p.widget === "radio") return "radio"
		if (p.widget === "checkbox") return "multiselect"
		return "dropdown"
	}
	if (p.type === "number" && (p.widget === "slider" || (p.min !== undefined && p.max !== undefined))) return "slider"
	if (p.type === "number") return "number"
	return "textarea"
}

/**
 * Typed input form for workflow flow-parameter collection. Replaces the
 * free-text followup textbox: each declared parameter renders the widget that
 * matches its type (string→text, number→number, boolean→checkbox), and a
 * single `>` button submits all answers at once. The form lives in the chat
 * message row, so it persists in history; after submission it renders
 * read-only.
 */
export function WorkflowParamForm({ params, onSubmit, isAnswered = false, answeredValues }: WorkflowParamFormProps) {
	const { t } = useAppTranslation()

	const [values, setValues] = useState<Record<string, FieldValue>>(() => {
		const seed: Record<string, FieldValue> = {}
		for (const p of params) {
			const w = widgetFor(p)
			// Prefer the submitted value (read-only replay after reload), then the default.
			const incoming = answeredValues?.[p.name] ?? p.default
			if (w === "multiselect") {
				seed[p.name] = Array.isArray(incoming) ? incoming : []
			} else if (w === "checkbox") {
				seed[p.name] = typeof incoming === "boolean" ? incoming : false
			} else if (w === "slider") {
				const n = typeof incoming === "number" ? incoming : Number(incoming)
				seed[p.name] = Number.isFinite(n) ? String(n) : String(p.min ?? 0)
			} else {
				seed[p.name] = incoming !== undefined && incoming !== "" ? String(incoming) : ""
			}
		}
		return seed
	})

	const setField = (name: string, v: FieldValue) => setValues((prev) => ({ ...prev, [name]: v }))

	// Toggle one option in a multi-select (checkbox group) field.
	const toggleMulti = (name: string, option: string, checked: boolean) =>
		setValues((prev) => {
			const cur = Array.isArray(prev[name]) ? (prev[name] as string[]) : []
			const next = checked ? [...cur, option] : cur.filter((o) => o !== option)
			return { ...prev, [name]: next }
		})

	// A number field is invalid only when non-empty and non-numeric (blank → default).
	const invalid = useMemo(
		() =>
			params.some((p) => {
				if (p.type !== "number") return false
				const raw = String(values[p.name] ?? "").trim()
				return raw !== "" && Number.isNaN(Number(raw))
			}),
		[params, values],
	)

	const submit = () => {
		if (isAnswered || invalid || !onSubmit) return
		const out: Record<string, unknown> = {}
		for (const p of params) {
			const w = widgetFor(p)
			const v = values[p.name]
			if (w === "checkbox") {
				out[p.name] = !!v
			} else if (w === "multiselect") {
				out[p.name] = Array.isArray(v) ? v : []
			} else if (p.type === "number") {
				const raw = String(v ?? "").trim()
				out[p.name] = raw === "" ? "" : Number(raw)
			} else {
				out[p.name] = String(v ?? "")
			}
		}
		onSubmit(JSON.stringify(out))
	}

	return (
		<div className="flex flex-col gap-3 rounded-md border border-vscode-input-border/40 bg-vscode-input-background/30 p-3">
			{params.map((p) => {
				const fieldId = `wf-param-${p.name}`
				const w = widgetFor(p)
				const inputCls = cn(
					"w-full rounded border px-2 py-1 text-sm outline-none",
					"bg-vscode-input-background text-vscode-input-foreground",
					"border-vscode-input-border focus:border-vscode-focusBorder",
					isAnswered && "opacity-70",
				)
				const placeholder =
					p.default !== undefined && p.default !== "" && !Array.isArray(p.default)
						? `default: ${p.default}`
						: undefined
				const current = values[p.name]
				const selected = Array.isArray(current) ? current : []
				return (
					<div key={p.name} className="flex flex-col gap-1">
						<label htmlFor={fieldId} className="text-sm font-medium text-vscode-foreground">
							{p.name} <span className="text-xs text-vscode-descriptionForeground">({p.type})</span>
						</label>
						{p.description && (
							<div className="text-xs text-vscode-descriptionForeground">{p.description}</div>
						)}
						{w === "checkbox" ? (
							<div className="flex items-center gap-2 text-sm text-vscode-foreground">
								<input
									id={fieldId}
									type="checkbox"
									checked={!!current}
									disabled={isAnswered}
									onChange={(e) => setField(p.name, e.target.checked)}
								/>
								<span>{String(!!current)}</span>
							</div>
						) : w === "dropdown" ? (
							<select
								id={fieldId}
								value={String(current ?? "")}
								disabled={isAnswered}
								onChange={(e) => setField(p.name, e.target.value)}
								className={inputCls}>
								<option value="">Select…</option>
								{p.options?.map((opt) => (
									<option key={opt} value={opt}>
										{opt}
									</option>
								))}
							</select>
						) : w === "radio" ? (
							<div className="flex flex-col gap-1">
								{p.options?.map((opt) => (
									<label key={opt} className="flex items-center gap-2 text-sm text-vscode-foreground">
										<input
											type="radio"
											name={fieldId}
											value={opt}
											checked={String(current ?? "") === opt}
											disabled={isAnswered}
											onChange={() => setField(p.name, opt)}
										/>
										{opt}
									</label>
								))}
							</div>
						) : w === "multiselect" ? (
							<div className="flex flex-col gap-1">
								{p.options?.map((opt) => (
									<label key={opt} className="flex items-center gap-2 text-sm text-vscode-foreground">
										<input
											type="checkbox"
											checked={selected.includes(opt)}
											disabled={isAnswered}
											onChange={(e) => toggleMulti(p.name, opt, e.target.checked)}
										/>
										{opt}
									</label>
								))}
							</div>
						) : w === "slider" ? (
							<div className="flex items-center gap-2">
								<input
									id={fieldId}
									type="range"
									min={p.min}
									max={p.max}
									step={p.step ?? 1}
									value={String(current ?? p.min ?? 0)}
									disabled={isAnswered}
									onChange={(e) => setField(p.name, e.target.value)}
									className="flex-1"
								/>
								<span className="w-10 text-right text-xs tabular-nums text-vscode-descriptionForeground">
									{String(current ?? p.min ?? 0)}
								</span>
							</div>
						) : w === "textarea" ? (
							<textarea
								id={fieldId}
								rows={3}
								value={String(current ?? "")}
								disabled={isAnswered}
								placeholder={placeholder}
								onChange={(e) => setField(p.name, e.target.value)}
								// Multiline: Enter inserts a newline; submit with Ctrl/Cmd+Enter.
								onKeyDown={(e) => {
									if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
										e.preventDefault()
										submit()
									}
								}}
								className={cn(inputCls, "min-h-[2.25rem] resize-y")}
							/>
						) : (
							<input
								id={fieldId}
								type="number"
								value={String(current ?? "")}
								disabled={isAnswered}
								placeholder={placeholder}
								onChange={(e) => setField(p.name, e.target.value)}
								onKeyDown={(e) => {
									if (e.key === "Enter" && !e.shiftKey) {
										e.preventDefault()
										submit()
									}
								}}
								className={inputCls}
							/>
						)}
					</div>
				)
			})}
			{!isAnswered && (
				<div className="flex justify-end">
					<StandardTooltip content={t("chat:sendMessage")}>
						<button
							aria-label={t("chat:sendMessage")}
							disabled={invalid || !onSubmit}
							onClick={submit}
							className={cn(
								"inline-flex items-center justify-center rounded-md px-3 py-1.5",
								"bg-vscode-button-background text-vscode-button-foreground",
								"hover:bg-vscode-button-hoverBackground",
								(invalid || !onSubmit) && "cursor-not-allowed opacity-50",
							)}>
							<SendHorizontal className="size-4" />
						</button>
					</StandardTooltip>
				</div>
			)}
		</div>
	)
}
