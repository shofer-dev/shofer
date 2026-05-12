"use server"

import { getModelId, shoferSettingsSchema } from "@shofer/types"
import { getRuns, getLanguageScores } from "@shofer/evals"

import { formatScore } from "@/lib"

export async function getEvalRuns() {
	const languageScores = await getLanguageScores()

	const runs = (await getRuns())
		.filter((run) => !!run.taskMetrics)
		.filter(({ settings }) => shoferSettingsSchema.safeParse(settings).success)
		.sort((a, b) => b.passed - a.passed)
		.map((run) => {
			const settings = shoferSettingsSchema.parse(run.settings)

			return {
				...run,
				label: run.description || run.model,
				score: formatScore(run.passed / (run.passed + run.failed)),
				languageScores: languageScores[run.id],
				taskMetrics: run.taskMetrics!,
				modelId: getModelId(settings),
			}
		})

	return runs
}
