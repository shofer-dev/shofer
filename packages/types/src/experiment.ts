import { z } from "zod"

import type { Keys, Equals, AssertEqual } from "./type-fu.js"

/**
 * ExperimentId
 */

export const experimentIds = [
	"preventFocusDisruption",
	"imageGeneration",
	"runSlashCommand",
	"customTools",
	"showToolInputOutput",
	"prometheusMetrics",
	"webviewLivenessMonitor",
	"disableMistakeLimitChecks",
] as const

export const experimentIdsSchema = z.enum(experimentIds)

export type ExperimentId = z.infer<typeof experimentIdsSchema>

/**
 * Experiments
 */

export const experimentsSchema = z.object({
	preventFocusDisruption: z.boolean().optional(),
	imageGeneration: z.boolean().optional(),
	runSlashCommand: z.boolean().optional(),
	customTools: z.boolean().optional(),
	showToolInputOutput: z.boolean().optional(),
	prometheusMetrics: z.boolean().optional(),
	webviewLivenessMonitor: z.boolean().optional(),
	disableMistakeLimitChecks: z.boolean().optional(),
})

export type Experiments = z.infer<typeof experimentsSchema>

type _AssertExperiments = AssertEqual<Equals<ExperimentId, Keys<Experiments>>>
