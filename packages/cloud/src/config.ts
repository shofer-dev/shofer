export const PRODUCTION_CLERK_BASE_URL = "https://clerk.shofer.com"
export const PRODUCTION_SHOFER_API_URL = "https://app.shofer.com"

export const getClerkBaseUrl = () => process.env.CLERK_BASE_URL || PRODUCTION_CLERK_BASE_URL

export const getShoferApiUrl = () => process.env.SHOFER_API_URL || PRODUCTION_SHOFER_API_URL
