import { useCallback, useRef, useState, type Dispatch, type SetStateAction, type RefObject } from "react"

export interface ViewBox {
	x: number
	y: number
	w: number
	h: number
}

interface Options {
	/** Elements matching this selector do not initiate a pan on mousedown. */
	noPanSelector?: string
}

/** Convert a client (screen) point to SVG user-space, honouring viewBox + preserveAspectRatio. */
function clientToSvg(svg: SVGSVGElement, clientX: number, clientY: number): { x: number; y: number } | null {
	const ctm = svg.getScreenCTM()
	if (!ctm) return null
	const pt = svg.createSVGPoint()
	pt.x = clientX
	pt.y = clientY
	const p = pt.matrixTransform(ctm.inverse())
	return { x: p.x, y: p.y }
}

/**
 * Shared SVG pan + zoom for the Trace and Sequence views.
 *
 * - **Pan**: dragging the background moves the viewBox; the delta is converted
 *   through the live screen CTM so the content tracks the cursor 1:1 at any zoom.
 * - **Zoom**: the wheel scales the viewBox *anchored at the cursor* — the point
 *   under the pointer stays put (no more jump-to-centre).
 *
 * The component owns the `viewBox` state (and its fit/refit logic); this hook
 * only wires the interaction handlers.
 */
export function useSvgPanZoom(
	svgRef: RefObject<SVGSVGElement>,
	viewBox: ViewBox,
	setViewBox: Dispatch<SetStateAction<ViewBox>>,
	options: Options = {},
) {
	const [isPanning, setIsPanning] = useState(false)
	// Pan anchor: starting client point, starting viewBox origin, and the
	// svg-units-per-screen-pixel scale captured at drag start (zoom can't change
	// mid-drag, so it stays valid for the whole gesture).
	const panStart = useRef({ x: 0, y: 0, vbX: 0, vbY: 0, sx: 1, sy: 1 })
	const { noPanSelector } = options

	const onMouseDown = useCallback(
		(e: React.MouseEvent<SVGSVGElement>) => {
			if (noPanSelector && (e.target as Element).closest?.(noPanSelector)) return
			const ctm = svgRef.current?.getScreenCTM()
			setIsPanning(true)
			panStart.current = {
				x: e.clientX,
				y: e.clientY,
				vbX: viewBox.x,
				vbY: viewBox.y,
				sx: ctm && ctm.a ? 1 / ctm.a : 1,
				sy: ctm && ctm.d ? 1 / ctm.d : 1,
			}
		},
		[noPanSelector, svgRef, viewBox.x, viewBox.y],
	)

	const onMouseMove = useCallback(
		(e: React.MouseEvent<SVGSVGElement>) => {
			if (!isPanning) return
			const dx = (e.clientX - panStart.current.x) * panStart.current.sx
			const dy = (e.clientY - panStart.current.y) * panStart.current.sy
			setViewBox((vb) => ({ ...vb, x: panStart.current.vbX - dx, y: panStart.current.vbY - dy }))
		},
		[isPanning, setViewBox],
	)

	const onMouseUp = useCallback(() => setIsPanning(false), [])

	const onWheel = useCallback(
		(e: React.WheelEvent<SVGSVGElement>) => {
			e.preventDefault()
			const scale = e.deltaY > 0 ? 1.15 : 0.87
			const svg = svgRef.current
			const anchor = svg ? clientToSvg(svg, e.clientX, e.clientY) : null
			setViewBox((vb) => {
				const a = anchor ?? { x: vb.x + vb.w / 2, y: vb.y + vb.h / 2 }
				// Keep the anchor (point under the cursor) fixed while scaling.
				return {
					x: a.x - scale * (a.x - vb.x),
					y: a.y - scale * (a.y - vb.y),
					w: vb.w * scale,
					h: vb.h * scale,
				}
			})
		},
		[svgRef, setViewBox],
	)

	/** Zoom the buttons use — anchored at the viewBox centre. */
	const zoomBy = useCallback(
		(scale: number) => {
			setViewBox((vb) => {
				const cx = vb.x + vb.w / 2
				const cy = vb.y + vb.h / 2
				const nw = vb.w * scale
				const nh = vb.h * scale
				return { x: cx - nw / 2, y: cy - nh / 2, w: nw, h: nh }
			})
		},
		[setViewBox],
	)

	return {
		isPanning,
		zoomBy,
		handlers: { onMouseDown, onMouseMove, onMouseUp, onMouseLeave: onMouseUp, onWheel },
	}
}
