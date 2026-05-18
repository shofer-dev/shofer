import { useState } from "react"

/**
 * ShoferHero — welcome-screen hero with a road-theme animation.
 *
 * On hover the scene comes alive:
 * - The "S" logo rotates like a wheel rolling along the road.
 * - A two-layer road surface scrolls beneath with parallax lane markings
 *   (fast centre dashes + slow edge dashes) to suggest forward motion.
 * - A distant sun glides slowly across the background.
 */
const ShoferHero = () => {
	const [imagesBaseUri] = useState(() => {
		const w = window as any
		return w.IMAGES_BASE_URI || ""
	})
	const [isHovered, setIsHovered] = useState(false)

	return (
		<div
			className="mb-4 relative forced-color-adjust-none group flex flex-col items-center w-30 pt-4 overflow-clip"
			onMouseEnter={() => setIsHovered(true)}
			onMouseLeave={() => setIsHovered(false)}>
			{/* Logo — rotates like a wheel rolling on the road */}
			<div
				style={{
					backgroundColor: "var(--vscode-foreground)",
					WebkitMaskImage: `url('${imagesBaseUri}/shofer-logo.svg')`,
					WebkitMaskRepeat: "no-repeat",
					WebkitMaskSize: "contain",
					maskImage: `url('${imagesBaseUri}/shofer-logo.svg')`,
					maskRepeat: "no-repeat",
					maskSize: "contain",
					animation: isHovered ? "logo-roll 1.6s linear infinite" : "none",
				}}
				className="z-5 mr-auto translate-y-0 transition-transform duration-500">
				<img src={imagesBaseUri + "/shofer-logo.svg"} alt="Shofer logo" className="h-8 opacity-0" />
			</div>

			{/* Road surface — visible on hover with parallax lane markings */}
			<div
				className="w-[200%] -mt-0.25 overflow-hidden opacity-0 group-hover:opacity-70 transition-opacity duration-300"
				data-testid="shofer-hero-ground">
				{/* Road base — subtle dark strip */}
				<div className="h-2 bg-vscode-foreground/5 rounded-sm relative overflow-hidden">
					{/* Fast centre lane dashes (foreground parallax) */}
					<div className="absolute inset-0 flex items-center opacity-0 group-hover:opacity-100 transition-opacity duration-300">
						<div className="w-full border-t-1 border-dashed border-vscode-foreground/30 animate-lane-marker-fast" />
					</div>
					{/* Slow edge dashes (background parallax — offset vertically for depth) */}
					<div className="absolute inset-0 flex items-center translate-y-0.5 opacity-0 group-hover:opacity-60 transition-opacity duration-300">
						<div className="w-full border-t-1 border-dashed border-vscode-foreground/15 animate-lane-marker-slow" />
					</div>
				</div>
			</div>

			{/* Side gradient fades for clean edges */}
			<div className="z-4 bg-gradient-to-r from-transparent to-vscode-sideBar-background absolute top-0 right-0 bottom-0 w-10 opacity-100" />
			<div className="z-3 bg-gradient-to-l from-transparent to-vscode-sideBar-background absolute top-0 left-0 bottom-0 w-10 opacity-100" />

			{/* Distant sun — slow horizontal pass */}
			<div className="bg-vscode-foreground/10 rounded-full size-10 z-1 absolute -bottom-4 animate-sun opacity-0 group-hover:opacity-100 transition-opacity duration-300 blur-[2px]" />
		</div>
	)
}

export default ShoferHero
