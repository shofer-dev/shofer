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
}

type FieldValue = string | boolean

/**
 * Typed input form for workflow flow-parameter collection. Replaces the
 * free-text followup textbox: each declared parameter renders the widget that
 * matches its type (string→text, number→number, boolean→checkbox), and a
 * single `>` button submits all answers at once. The form lives in the chat
 * message row, so it persists in history; after submission it renders
 * read-only.
 */
export function WorkflowParamForm({ params, onSubmit, isAnswered = false }: WorkflowParamFormProps) {
	const { t } = useAppTranslation()

	const [values, setValues] = useState<Record<string, FieldValue>>(() => {
		const seed: Record<string, FieldValue> = {}
		for (const p of params) {
			if (p.type === "boolean") {
				seed[p.name] = typeof p.default === "boolean" ? p.default : false
			} else {
				seed[p.name] = p.default !== undefined && p.default !== "" ? String(p.default) : ""
			}
		}
		return seed
	})

	const setField = (name: string, v: FieldValue) => setValues((prev) => ({ ...prev, [name]: v }))

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
			const v = values[p.name]
			if (p.type === "boolean") {
				out[p.name] = !!v
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
				return (
					<div key={p.name} className="flex flex-col gap-1">
						<label htmlFor={fieldId} className="text-sm font-medium text-vscode-foreground">
							{p.name} <span className="text-xs text-vscode-descriptionForeground">({p.type})</span>
						</label>
						{p.description && (
							<div className="text-xs text-vscode-descriptionForeground">{p.description}</div>
						)}
						{p.type === "boolean" ? (
							<div className="flex items-center gap-2 text-sm text-vscode-foreground">
								<input
									id={fieldId}
									type="checkbox"
									checked={!!values[p.name]}
									disabled={isAnswered}
									onChange={(e) => setField(p.name, e.target.checked)}
								/>
								<span>{String(!!values[p.name])}</span>
							</div>
						) : (
							<input
								id={fieldId}
								type={p.type === "number" ? "number" : "text"}
								value={String(values[p.name] ?? "")}
								disabled={isAnswered}
								placeholder={
									p.default !== undefined && p.default !== "" ? `default: ${p.default}` : undefined
								}
								onChange={(e) => setField(p.name, e.target.value)}
								onKeyDown={(e) => {
									if (e.key === "Enter" && !e.shiftKey) {
										e.preventDefault()
										submit()
									}
								}}
								className={cn(
									"w-full rounded border px-2 py-1 text-sm outline-none",
									"bg-vscode-input-background text-vscode-input-foreground",
									"border-vscode-input-border focus:border-vscode-focusBorder",
									isAnswered && "opacity-70",
								)}
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
