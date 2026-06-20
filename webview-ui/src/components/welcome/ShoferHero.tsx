import { useState } from "react"

import { vscode } from "@src/utils/vscode"

/**
 * ShoferHero — welcome-screen hero showing the Shofer logo, linking to
 * shofer.dev. The logo is rendered as a theme-tinted mask so it adapts to
 * light/dark sidebar backgrounds.
 */
const ShoferHero = () => {
	const [imagesBaseUri] = useState(() => {
		const w = window as any
		return w.IMAGES_BASE_URI || ""
	})

	return (
		<div
			role="link"
			aria-label="Visit shofer.dev"
			title="Visit shofer.dev"
			onClick={() => vscode.postMessage({ type: "openExternal", url: "https://shofer.dev/" })}
			className="flex flex-col items-center shrink-0 cursor-pointer">
			{/* Logo — theme-tinted via mask so it adapts to light/dark backgrounds */}
			<div
				style={{
					backgroundColor: "var(--vscode-foreground)",
					WebkitMaskImage: `url('${imagesBaseUri}/shofer.svg')`,
					WebkitMaskRepeat: "no-repeat",
					WebkitMaskSize: "contain",
					WebkitMaskPosition: "center",
					maskImage: `url('${imagesBaseUri}/shofer.svg')`,
					maskRepeat: "no-repeat",
					maskSize: "contain",
					maskPosition: "center",
				}}>
				<img src={imagesBaseUri + "/shofer.svg"} alt="Shofer logo" className="h-24 opacity-0" />
			</div>
		</div>
	)
}

export default ShoferHero
