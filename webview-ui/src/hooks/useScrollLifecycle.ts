/**
 * useScrollLifecycle
 *
 * Simplified chat scroll lifecycle with a short, time-boxed hydration window.
 *
 * **Task switch behavior:**
 *   - If the task was previously viewed AND the user was browsing history
 *     (not at the bottom) last time → restore the exact saved scroll position
 *     via Virtuoso's `initialTopMostItemIndex` (one paint, no jump).
 *   - Otherwise (first visit OR user was at the bottom) → scroll to the
 *     *current* bottom so new messages are visible.
 *
 * **Position memory:**
 *   - `rangeChanged` callback continuously saves `{ startIndex, atBottom }`
 *     per task into an in-memory Map, guarded during the hydration window
 *     to avoid corrupting saved positions.
 *
 * **Hydration window:**
 *   - Retries up to `MAX_HYDRATION_RETRIES` at `HYDRATION_RETRY_WINDOW_MS`
 *     intervals.
 *   - After restoring a saved position, transitions to `USER_BROWSING_HISTORY`
 *     so new messages don't auto-scroll the user away.
 *   - After scrolling to bottom (first visit / was-at-bottom), transitions
 *     to `ANCHORED_FOLLOWING`.
 *
 * **User escape intent** (wheel-up / keyboard-nav-up / pointer-scroll-up /
 *   row expansion) moves to `USER_BROWSING_HISTORY` and prevents forced
 *   re-pinning.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useEvent } from "react-use"
import debounce from "debounce"
import type { ListRange, VirtuosoHandle } from "react-virtuoso"

/** Namespaced console logger for scroll lifecycle diagnostics.
 *  Prefix all messages with [scroll] so they are easy to grep in devtools. */
const log = (...args: unknown[]) => console.log("[scroll]", ...args)

const HYDRATION_WINDOW_MS = 600
const HYDRATION_RETRY_WINDOW_MS = 160
const MAX_HYDRATION_RETRIES = 3

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ScrollPhase = "HYDRATING_PINNED_TO_BOTTOM" | "ANCHORED_FOLLOWING" | "USER_BROWSING_HISTORY"

export type ScrollFollowDisengageSource = "wheel-up" | "row-expansion" | "keyboard-nav-up" | "pointer-scroll-up"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const isEditableKeyboardTarget = (target: EventTarget | null): boolean => {
	if (!(target instanceof HTMLElement)) {
		return false
	}
	if (target.isContentEditable) {
		return true
	}
	const tagName = target.tagName
	return tagName === "INPUT" || tagName === "TEXTAREA" || tagName === "SELECT"
}

// ---------------------------------------------------------------------------
// Hook interface
// ---------------------------------------------------------------------------

export interface UseScrollLifecycleOptions {
	virtuosoRef: React.RefObject<VirtuosoHandle | null>
	scrollContainerRef: React.RefObject<HTMLDivElement | null>
	taskTs: number | undefined
	isStreaming: boolean
	isHidden: boolean
	hasTask: boolean
}

export interface UseScrollLifecycleReturn {
	scrollPhase: ScrollPhase
	showScrollToBottom: boolean
	handleRowHeightChange: (isTaller: boolean) => void
	handleScrollToBottomClick: () => void
	enterUserBrowsingHistory: (source: ScrollFollowDisengageSource) => void
	followOutputCallback: () => "auto" | false
	atBottomStateChangeCallback: (isAtBottom: boolean) => void
	/** Callback for Virtuoso's rangeChanged prop — saves scroll position per task. */
	rangeChangedCallback: (range: ListRange) => void
	/** Pass to Virtuoso's initialTopMostItemIndex to start at the saved position
	 *  on first paint — avoids a visible scroll jump on task switch. */
	initialScrollIndex: number | undefined
	scrollToBottomAuto: () => void
	isAtBottomRef: React.MutableRefObject<boolean>
	scrollPhaseRef: React.MutableRefObject<ScrollPhase>
}

// ---------------------------------------------------------------------------
// Hook implementation
// ---------------------------------------------------------------------------

export function useScrollLifecycle({
	virtuosoRef,
	scrollContainerRef,
	taskTs,
	isStreaming,
	isHidden,
	hasTask,
}: UseScrollLifecycleOptions): UseScrollLifecycleReturn {
	// --- Mounted guard ---
	const isMountedRef = useRef(true)

	// --- Phase state ---
	const [scrollPhase, setScrollPhase] = useState<ScrollPhase>("USER_BROWSING_HISTORY")
	const scrollPhaseRef = useRef<ScrollPhase>("USER_BROWSING_HISTORY")

	// --- Visibility state ---
	const [showScrollToBottom, setShowScrollToBottom] = useState(false)

	// --- Bottom detection ---
	const isAtBottomRef = useRef(false)

	// --- Hydration window ---
	const isHydratingRef = useRef(false)
	const hydrationTimeoutRef = useRef<number | null>(null)
	const hydrationRetryCountRef = useRef(0)

	/** Per-task saved state: the visible startIndex and whether the user
	 *  was at the bottom when they last viewed this task.  Used to decide
	 *  whether to restore a browsing position or scroll to the (new) bottom
	 *  on the next visit. */
	const taskScrollPositionRef = useRef<Map<number, { startIndex: number; atBottom: boolean }>>(new Map())

	// --- Current taskTs ref (kept in sync for use in rangeChanged callback) ---
	const taskTsRef = useRef(taskTs)
	useEffect(() => {
		taskTsRef.current = taskTs
	}, [taskTs])

	// --- Initial scroll index for Virtuoso's initialTopMostItemIndex ---
	// Computed synchronously from the saved-position map when taskTs changes
	// so the Virtuoso (re-keyed on task.ts) starts at the correct position
	// on its first paint.
	//
	// Returns undefined when:
	//   - No task is selected
	//   - No saved position exists for this task (first visit)
	//   - The user was at the bottom when they left (scroll to new bottom)
	// Returns the saved startIndex only when the user was browsing history
	// (not at bottom), so the exact position is restored without a jump.
	const initialScrollIndex = useMemo(() => {
		if (taskTs === undefined) {
			log("initialScrollIndex: no taskTs")
			return undefined
		}
		const saved = taskScrollPositionRef.current.get(taskTs)
		if (saved !== undefined && saved.startIndex > 0 && !saved.atBottom) {
			log("initialScrollIndex:", saved.startIndex, "(atBottom was false)")
			return saved.startIndex
		}
		if (saved !== undefined) {
			log(
				"initialScrollIndex: saved exists but skipped",
				JSON.stringify({ startIndex: saved.startIndex, atBottom: saved.atBottom }),
			)
		} else {
			log("initialScrollIndex: no saved position for taskTs", taskTs)
		}
		return undefined
	}, [taskTs])

	// --- Pointer scroll tracking ---
	const pointerScrollActiveRef = useRef(false)
	const pointerScrollElementRef = useRef<HTMLElement | null>(null)
	const pointerScrollLastTopRef = useRef<number | null>(null)

	// --- Re-anchor frame ---
	const reanchorAnimationFrameRef = useRef<number | null>(null)

	// -----------------------------------------------------------------------
	// Phase transitions
	// -----------------------------------------------------------------------

	const transitionScrollPhase = useCallback((nextPhase: ScrollPhase) => {
		if (scrollPhaseRef.current === nextPhase) {
			return
		}
		scrollPhaseRef.current = nextPhase
		setScrollPhase(nextPhase)
	}, [])

	const enterAnchoredFollowing = useCallback(() => {
		transitionScrollPhase("ANCHORED_FOLLOWING")
		setShowScrollToBottom(false)
	}, [transitionScrollPhase])

	const enterUserBrowsingHistory = useCallback(
		(_source: ScrollFollowDisengageSource) => {
			transitionScrollPhase("USER_BROWSING_HISTORY")
			// Always show the scroll-to-bottom CTA when the user explicitly
			// disengages. If they happen to still be at the physical bottom,
			// the next Virtuoso atBottomStateChange(true) will hide it.
			setShowScrollToBottom(true)
		},
		[transitionScrollPhase],
	)

	const cancelReanchorFrame = useCallback(() => {
		if (reanchorAnimationFrameRef.current !== null) {
			cancelAnimationFrame(reanchorAnimationFrameRef.current)
			reanchorAnimationFrameRef.current = null
		}
	}, [])

	// -----------------------------------------------------------------------
	// Scroll commands
	// -----------------------------------------------------------------------

	const scrollToBottomSmooth = useMemo(
		() =>
			debounce(
				() => virtuosoRef.current?.scrollToIndex({ index: "LAST", align: "end", behavior: "smooth" }),
				10,
				{ immediate: true },
			),
		[virtuosoRef],
	)

	const scrollToBottomAuto = useCallback(() => {
		virtuosoRef.current?.scrollToIndex({
			index: "LAST",
			align: "end",
			behavior: "auto",
		})
	}, [virtuosoRef])

	const scrollToIndexAuto = useCallback(
		(index: number) => {
			virtuosoRef.current?.scrollToIndex({
				index,
				align: "start",
				behavior: "auto",
			})
		},
		[virtuosoRef],
	)

	const clearHydrationWindow = useCallback(() => {
		isHydratingRef.current = false
		hydrationRetryCountRef.current = 0
		if (hydrationTimeoutRef.current !== null) {
			window.clearTimeout(hydrationTimeoutRef.current)
			hydrationTimeoutRef.current = null
		}
	}, [])

	// -----------------------------------------------------------------------
	// rangeChanged — continuously save the visible range for the current task
	//
	// Skip saving during the hydration window so the initial Virtuoso render
	// (which may report startIndex=0 before the intended position is reached)
	// does not overwrite a previously saved position for this task.
	//
	// Saves both the visible startIndex and whether the user was at the
	// bottom at the time.  This lets us decide on re-entry whether to
	// restore the exact browsing position (user scrolled away) or scroll
	// to the current bottom (user was following new messages).  Virtuoso's
	// atBottomStateChange fires before rangeChanged, so isAtBottomRef is
	// always current by the time this callback runs.
	// -----------------------------------------------------------------------

	const rangeChangedCallback = useCallback((range: ListRange) => {
		if (isHydratingRef.current) {
			log("rangeChanged: SKIP (hydrating)")
			return
		}
		const currentTaskTs = taskTsRef.current
		if (currentTaskTs !== undefined) {
			log(
				"rangeChanged: save",
				JSON.stringify({
					taskTs: currentTaskTs,
					startIndex: range.startIndex,
					atBottom: isAtBottomRef.current,
				}),
			)
			taskScrollPositionRef.current.set(currentTaskTs, {
				startIndex: range.startIndex,
				atBottom: isAtBottomRef.current,
			})
		}
	}, [])

	// -----------------------------------------------------------------------
	// Scroll-to-index hydration (for restoring a saved position)
	//
	// The initial positioning is handled by Virtuoso's initialTopMostItemIndex
	// prop (communicated via initialScrollIndex return value) — no 2-rAF
	// scroll is needed here.  The retry loop still runs as a safety net in
	// case the Virtuoso measurement hasn't settled by the time the hydration
	// window expires.
	// -----------------------------------------------------------------------

	// Directly enter USER_BROWSING_HISTORY phase (no side effects like
	// showing the CTA button) — used when the hydration window ends after
	// restoring a saved browsing position.
	const enterBrowsingQuiet = useCallback(() => {
		transitionScrollPhase("USER_BROWSING_HISTORY")
		setShowScrollToBottom(true)
	}, [transitionScrollPhase])

	const restoreTargetIndexRef = useRef<number | null>(null)

	const finishRestoreWindow = useCallback(() => {
		if (!isMountedRef.current || !isHydratingRef.current) {
			log("finishRestoreWindow: unmounted or not hydrating, skip")
			return
		}

		if (scrollPhaseRef.current === "HYDRATING_PINNED_TO_BOTTOM") {
			const targetIndex = restoreTargetIndexRef.current
			if (targetIndex !== null) {
				if (hydrationRetryCountRef.current < MAX_HYDRATION_RETRIES) {
					hydrationRetryCountRef.current++
					log("finishRestoreWindow: retry", hydrationRetryCountRef.current, "targetIndex", targetIndex)
					scrollToIndexAuto(targetIndex)
					hydrationTimeoutRef.current = window.setTimeout(() => {
						finishRestoreWindow()
					}, HYDRATION_RETRY_WINDOW_MS)
					return
				}
			}
			// Retry budget exhausted (or no target index).
			// The user was browsing history, not following — stay in
			// browsing mode so new messages don't auto-scroll them away
			// from the restored position.
			log("finishRestoreWindow: entering browsing (retries exhausted)")
			enterBrowsingQuiet()
		}

		clearHydrationWindow()
	}, [clearHydrationWindow, enterBrowsingQuiet, scrollToIndexAuto])

	const startRestoreWindow = useCallback(
		(targetIndex: number) => {
			log("startRestoreWindow: targetIndex", targetIndex)
			isHydratingRef.current = true
			hydrationRetryCountRef.current = 0
			restoreTargetIndexRef.current = targetIndex
			if (hydrationTimeoutRef.current !== null) {
				window.clearTimeout(hydrationTimeoutRef.current)
			}
			hydrationTimeoutRef.current = window.setTimeout(() => {
				finishRestoreWindow()
			}, HYDRATION_WINDOW_MS)
		},
		[finishRestoreWindow],
	)

	// -----------------------------------------------------------------------
	// Scroll-to-bottom hydration (for new / never-viewed tasks)
	// -----------------------------------------------------------------------

	const finishHydrationWindow = useCallback(() => {
		if (!isMountedRef.current || !isHydratingRef.current) {
			return
		}

		if (scrollPhaseRef.current === "HYDRATING_PINNED_TO_BOTTOM") {
			if (isAtBottomRef.current) {
				enterAnchoredFollowing()
			} else if (hydrationRetryCountRef.current < MAX_HYDRATION_RETRIES) {
				hydrationRetryCountRef.current++
				scrollToBottomAuto()
				hydrationTimeoutRef.current = window.setTimeout(() => {
					finishHydrationWindow()
				}, HYDRATION_RETRY_WINDOW_MS)
				return
			} else {
				// Retry budget exhausted. Keep anchored follow rather than
				// downgrading to browsing mode due to non-user transient drift.
				enterAnchoredFollowing()
			}
		}

		clearHydrationWindow()
	}, [clearHydrationWindow, enterAnchoredFollowing, scrollToBottomAuto])

	const startHydrationWindow = useCallback(() => {
		log("startHydrationWindow: scroll to bottom")
		isHydratingRef.current = true
		hydrationRetryCountRef.current = 0
		restoreTargetIndexRef.current = null
		if (hydrationTimeoutRef.current !== null) {
			window.clearTimeout(hydrationTimeoutRef.current)
		}
		hydrationTimeoutRef.current = window.setTimeout(() => {
			finishHydrationWindow()
		}, HYDRATION_WINDOW_MS)

		// Defer the initial scroll-to-bottom by two animation frames so the
		// Virtuoso — which is re-keyed on task.ts — has time to mount and
		// measure its items before we command a scroll.
		requestAnimationFrame(() => {
			requestAnimationFrame(() => {
				if (isHydratingRef.current) {
					scrollToBottomAuto()
				}
			})
		})
	}, [finishHydrationWindow, scrollToBottomAuto])

	// -----------------------------------------------------------------------
	// Lifecycle effects
	// -----------------------------------------------------------------------

	// Mounted guard + global cleanup
	useEffect(() => {
		isMountedRef.current = true
		return () => {
			isMountedRef.current = false
			clearHydrationWindow()
			cancelReanchorFrame()
			scrollToBottomSmooth.clear()
		}
	}, [cancelReanchorFrame, clearHydrationWindow, scrollToBottomSmooth])

	// Keep phase ref in sync with state
	useEffect(() => {
		scrollPhaseRef.current = scrollPhase
	}, [scrollPhase])

	// Task switch: reset and begin a short hydration window.
	//
	// Decision matrix:
	//   - No task selected → USER_BROWSING_HISTORY (empty state)
	//   - Task previously viewed AND user was NOT at bottom last time
	//     → restore saved scroll position (user was reading history)
	//   - First visit OR user was at bottom last time
	//     → scroll to the *current* bottom and enter anchored following
	//     (new messages may have arrived since last visit)
	useEffect(() => {
		log("task-switch: taskTs", taskTs, "isHydrating", isHydratingRef.current)
		isAtBottomRef.current = false
		clearHydrationWindow()
		cancelReanchorFrame()

		if (taskTs) {
			transitionScrollPhase("HYDRATING_PINNED_TO_BOTTOM")
			setShowScrollToBottom(false)

			const saved = taskScrollPositionRef.current.get(taskTs)
			if (saved !== undefined) {
				log(
					"task-switch: found saved",
					JSON.stringify({ taskTs, startIndex: saved.startIndex, atBottom: saved.atBottom }),
				)
			} else {
				log("task-switch: no saved position for taskTs", taskTs)
			}

			if (saved !== undefined && saved.startIndex > 0 && !saved.atBottom) {
				// User was browsing history — restore exact position.
				startRestoreWindow(saved.startIndex)
			} else {
				// First visit or user was following the bottom —
				// scroll to the (possibly updated) bottom.
				startHydrationWindow()
			}
		} else {
			transitionScrollPhase("USER_BROWSING_HISTORY")
			setShowScrollToBottom(false)
		}

		return () => {
			clearHydrationWindow()
			cancelReanchorFrame()
		}
	}, [
		cancelReanchorFrame,
		clearHydrationWindow,
		startHydrationWindow,
		startRestoreWindow,
		taskTs,
		transitionScrollPhase,
	])

	// -----------------------------------------------------------------------
	// Row height change handler
	// -----------------------------------------------------------------------

	const handleRowHeightChange = useCallback(
		(isTaller: boolean) => {
			if (
				scrollPhaseRef.current === "USER_BROWSING_HISTORY" ||
				scrollPhaseRef.current === "HYDRATING_PINNED_TO_BOTTOM"
			) {
				return
			}

			const shouldForcePinForAnchoredStreaming = scrollPhaseRef.current === "ANCHORED_FOLLOWING" && isStreaming
			if (isAtBottomRef.current || shouldForcePinForAnchoredStreaming) {
				if (isTaller) {
					scrollToBottomSmooth()
				} else {
					scrollToBottomAuto()
				}
			}
		},
		[isStreaming, scrollToBottomSmooth, scrollToBottomAuto],
	)

	// -----------------------------------------------------------------------
	// Scroll-to-bottom click handler
	// -----------------------------------------------------------------------

	const handleScrollToBottomClick = useCallback(() => {
		enterAnchoredFollowing()
		scrollToBottomAuto()
		cancelReanchorFrame()
		reanchorAnimationFrameRef.current = requestAnimationFrame(() => {
			reanchorAnimationFrameRef.current = null
			if (scrollPhaseRef.current === "ANCHORED_FOLLOWING") {
				scrollToBottomAuto()
			}
		})
	}, [cancelReanchorFrame, enterAnchoredFollowing, scrollToBottomAuto])

	// -----------------------------------------------------------------------
	// Virtuoso callback: followOutput
	// -----------------------------------------------------------------------

	const followOutputCallback = useCallback((): "auto" | false => {
		return scrollPhase === "USER_BROWSING_HISTORY" ? false : "auto"
	}, [scrollPhase])

	// -----------------------------------------------------------------------
	// Virtuoso callback: atBottomStateChange
	// -----------------------------------------------------------------------

	const atBottomStateChangeCallback = useCallback(
		(isAtBottom: boolean) => {
			log(
				"atBottomStateChange:",
				isAtBottom,
				"phase:",
				scrollPhaseRef.current,
				"hydrating:",
				isHydratingRef.current,
			)
			isAtBottomRef.current = isAtBottom

			const currentPhase = scrollPhaseRef.current

			if (!isAtBottom && isHydratingRef.current && currentPhase !== "USER_BROWSING_HISTORY") {
				setShowScrollToBottom(false)
				return
			}

			if (isAtBottom) {
				if (currentPhase === "USER_BROWSING_HISTORY" && isHydratingRef.current) {
					setShowScrollToBottom(true)
					return
				}

				enterAnchoredFollowing()
				return
			}

			if (currentPhase === "ANCHORED_FOLLOWING" && !isAtBottom && pointerScrollActiveRef.current) {
				enterUserBrowsingHistory("pointer-scroll-up")
				return
			}

			if (currentPhase === "ANCHORED_FOLLOWING" && isStreaming) {
				scrollToBottomAuto()
				setShowScrollToBottom(false)
				return
			}

			setShowScrollToBottom(currentPhase === "USER_BROWSING_HISTORY")
		},
		[enterAnchoredFollowing, enterUserBrowsingHistory, isStreaming, scrollToBottomAuto],
	)

	// -----------------------------------------------------------------------
	// User intent: wheel
	// -----------------------------------------------------------------------

	const handleWheel = useCallback(
		(event: Event) => {
			const wheelEvent = event as WheelEvent
			if (wheelEvent.deltaY < 0 && scrollContainerRef.current?.contains(wheelEvent.target as Node)) {
				enterUserBrowsingHistory("wheel-up")
			}
		},
		[enterUserBrowsingHistory, scrollContainerRef],
	)
	useEvent("wheel", handleWheel, window, { passive: true })

	// -----------------------------------------------------------------------
	// User intent: pointer drag
	// -----------------------------------------------------------------------

	const handlePointerDown = useCallback(
		(event: Event) => {
			const pointerEvent = event as PointerEvent
			const pointerTarget = pointerEvent.target
			if (!(pointerTarget instanceof HTMLElement)) {
				pointerScrollActiveRef.current = false
				pointerScrollElementRef.current = null
				pointerScrollLastTopRef.current = null
				return
			}

			if (!scrollContainerRef.current?.contains(pointerTarget)) {
				pointerScrollActiveRef.current = false
				pointerScrollElementRef.current = null
				pointerScrollLastTopRef.current = null
				return
			}

			const scroller =
				(pointerTarget.closest(".scrollable") as HTMLElement | null) ??
				(pointerTarget.scrollHeight > pointerTarget.clientHeight ? pointerTarget : null)

			pointerScrollActiveRef.current = scroller !== null
			pointerScrollElementRef.current = scroller
			pointerScrollLastTopRef.current = scroller?.scrollTop ?? null
		},
		[scrollContainerRef],
	)

	const handlePointerEnd = useCallback(() => {
		pointerScrollActiveRef.current = false
		pointerScrollElementRef.current = null
		pointerScrollLastTopRef.current = null
	}, [])

	const handlePointerActiveScroll = useCallback(
		(event: Event) => {
			if (!pointerScrollActiveRef.current) {
				return
			}

			const scrollTarget = event.target
			if (!(scrollTarget instanceof HTMLElement)) {
				return
			}

			if (!scrollContainerRef.current?.contains(scrollTarget)) {
				return
			}

			if (pointerScrollElementRef.current !== scrollTarget) {
				return
			}

			const previousTop = pointerScrollLastTopRef.current
			const currentTop = scrollTarget.scrollTop
			pointerScrollLastTopRef.current = currentTop

			if (previousTop !== null && currentTop < previousTop) {
				enterUserBrowsingHistory("pointer-scroll-up")
			}
		},
		[enterUserBrowsingHistory, scrollContainerRef],
	)

	useEvent("pointerdown", handlePointerDown, window, { passive: true })
	useEvent("pointerup", handlePointerEnd, window, { passive: true })
	useEvent("pointercancel", handlePointerEnd, window, { passive: true })
	useEvent("scroll", handlePointerActiveScroll, window, { passive: true, capture: true })

	// -----------------------------------------------------------------------
	// User intent: keyboard navigation
	// -----------------------------------------------------------------------

	const handleScrollKeyDown = useCallback(
		(event: Event) => {
			const keyEvent = event as KeyboardEvent

			if (!hasTask || isHidden) {
				return
			}

			if (keyEvent.metaKey || keyEvent.ctrlKey || keyEvent.altKey) {
				return
			}

			if (keyEvent.key !== "PageUp" && keyEvent.key !== "Home" && keyEvent.key !== "ArrowUp") {
				return
			}

			if (isEditableKeyboardTarget(keyEvent.target)) {
				return
			}

			const activeElement = document.activeElement
			const focusInsideChat =
				activeElement instanceof HTMLElement && !!scrollContainerRef.current?.contains(activeElement)
			const eventTargetInsideChat =
				keyEvent.target instanceof Node && !!scrollContainerRef.current?.contains(keyEvent.target)

			if (focusInsideChat || eventTargetInsideChat || activeElement === document.body) {
				enterUserBrowsingHistory("keyboard-nav-up")
			}
		},
		[enterUserBrowsingHistory, hasTask, isHidden, scrollContainerRef],
	)
	useEvent("keydown", handleScrollKeyDown, window)

	// -----------------------------------------------------------------------
	// Return public API
	// -----------------------------------------------------------------------

	return {
		scrollPhase,
		showScrollToBottom,
		handleRowHeightChange,
		handleScrollToBottomClick,
		enterUserBrowsingHistory,
		followOutputCallback,
		atBottomStateChangeCallback,
		rangeChangedCallback,
		initialScrollIndex,
		scrollToBottomAuto,
		isAtBottomRef,
		scrollPhaseRef,
	}
}
