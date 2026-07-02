import { Package } from "@shofer/core"

export const DEFAULT_HEADERS = {
	"HTTP-Referer": "https://github.com/shofer-dev/shofer",
	"X-Title": "Shofer",
	"User-Agent": `Shofer/${Package.version}`,
}
