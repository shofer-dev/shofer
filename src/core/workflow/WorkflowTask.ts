/**
 * Post a followup ask so the user can enter parameter values. The
 * webview (WorkflowView) renders a textbox. When the user responds,
 * {@link handleWebviewAskResponse} parses the values and starts the
 * slang loop.
 *
 * Asks one question per missing parameter, sequentially. Each answer
 * is type-coerced and stored directly — no key=value parsing needed.
 * If the user sends an empty answer, the default (per type) is used.
 */
private requestFlowParams(): void {
	const declParams = this.flowDecl.params!
	const missing = declParams.filter((p) => !(p.name in (this.flowState.params || {})))

	const askNext = (index: number): Promise<void> => {
		if (index >= missing.length) {
			// Fill defaults for any that were skipped, then start loop.
			for (const p of missing) {
				if (!(p.name in (this.flowState.params || {}))) {
					this.flowState.params[p.name] = defaultParamValue(p.paramType)
				}
			}
			outputLog(`[WorkflowTask#${this.taskId}] Flow params collected, starting slang loop`)
			void this.slangLoop()
			return Promise.resolve()
		}

		const p = missing[index]
		const dv = defaultParamValue(p.paramType)
		const hasDefault = dv !== "" && dv !== 0 && dv !== false
		const question = hasDefault
			? `What value for \`${p.name}\`? (${p.paramType}, default: ${JSON.stringify(dv)})`
			: `What value for \`${p.name}\`? (${p.paramType})`

		return this.ask("followup", JSON.stringify({ question })).then(({ text }) => {
			const raw = text?.trim() ?? ""
			if (raw) {
				this.flowState.params[p.name] = coerceParam(raw, p.paramType)
			} else if (hasDefault) {
				this.flowState.params[p.name] = dv
			}
			outputLog(
				`[WorkflowTask#${this.taskId}] Flow param ${p.name}=${JSON.stringify(this.flowState.params[p.name])} (type=${p.paramType})`,
			)
			return askNext(index + 1)
		})
	}

	outputLog(
		`[WorkflowTask#${this.taskId}] Collecting ${missing.length} flow param(s): ${missing.map((p) => p.name).join(", ")}`,
	)
	void askNext(0).catch((error) => {
		outputError(`[WorkflowTask#${this.taskId}] Failed to collect flow params:`, error)
		this.flowState.status = "error"
		void this.emitTaskCompleted("poor")
	})
}
