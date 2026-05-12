import { z } from "zod"

/**
 * OrganizationAllowList
 * Controls which providers and models organization members can use.
 */
export const organizationAllowListSchema = z.object({
	allowAll: z.boolean(),
	providers: z.record(
		z.string(),
		z.object({
			allowAll: z.boolean(),
			models: z.array(z.string()).optional(),
		}),
	),
})

export type OrganizationAllowList = z.infer<typeof organizationAllowListSchema>

export const ORGANIZATION_ALLOW_ALL: OrganizationAllowList = {
	allowAll: true,
	providers: {},
} as const
