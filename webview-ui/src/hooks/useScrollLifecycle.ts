/**
 * useScrollLifecycle
 *
 * Simplified chat scroll lifecycle: always scroll to the bottom on task
 * switch and auto-follow new messages while the user stays at the bottom.
 *
 * **Task switch:** enters `HYDRATING_PINNED_TO_BOTTOM`, fires a deferred
 *   scroll-to-bottom, then transitions to `ANCHORED_FOLLOWING` so
 *   `followOutput="auto"` keeps the list pinned.
 *
 * **Hydration window:** retries up to `MAX_HYDRATION_RETRIES` at
 *   `HYDRATION_RETRY_WINDOW_MS` intervals before giving up and entering
 *   `ANCHORED_FOLLOWING`.
 *
 * **User escape intent** (wheel-up / keyboard-nav-up / pointer-scroll-up /
 *   row expansion) moves to `USER_BROWSING_HISTORY`, sets
 *   `followOutput=false`, and shows the scroll-to-bottom button.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useEvent } from "react-use"
import debounce from "debounce"
import type { VirtuosoHandle } from "react-virtuoso"

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

	// --- Pointer scroll tracking ---
	const pointerScrollActiveRef = useRef(false)
	const pointerScrollElementRef = useRef<HTMLElement | null>(null)
	const pointerScrollLastTopRef = useRef<number | null>(null)

	// --- Re-anchor frame ---
	const reanchorAnimationFrameRef = useRef<number | null>(null)

	// --- Disengage immune window ---
	// Set when the user explicitly enters browse mode. While active,
	// atBottomStateChange(true) from an in-flight programmatic scroll
	// cannot snap the user back to ANCHORED_FOLLOWING.
	const userDisengagedRef = useRef(false)
	const userDisengagedTimeoutRef = useRef<number | null>(null)

	// --- User-intent scroll-up flag ---
	// Set synchronously by escape-intent detectors (wheel, keyboard, pointer)
	// BEFORE calling enterUserBrowsingHistory. Checked by
	// atBottomStateChangeCallback to prevent the "not-at-bottom during
	// ANCHORED_FOLLOWING+streaming → auto-scroll-back" path from fighting
	// genuine user scroll-up intent. Cleared on re-anchor or after a brief
	// safety timeout.
	const userIntentScrollUpRef = useRef(false)
	const userIntentScrollUpTimeoutRef = useRef<number | null>(null)

	// --- Previous taskTs tracker ---
	// Tracks the last taskTs seen during render so we can detect task
	// switches synchronously (before the new Virtuoso mounts).
	const prevTaskTsRef = useRef(taskTs)

	// -----------------------------------------------------------------------
	// Render-phase ref synchronization (task switch)
	// -----------------------------------------------------------------------
	// When taskTs changes, synchronize scroll refs DURING the render phase
	// — before the new Virtuoso mounts and fires atBottomStateChangeCallback.
	// Without this, the callback reads stale refs from the previous task.
	//
	// This mirrors the Preload-Before-Publish Rule: refs that the Virtuoso
	// consumes must be set before the Virtuoso is "published" (mounted).
	if (taskTs !== prevTaskTsRef.current) {
		prevTaskTsRef.current = taskTs

		isAtBottomRef.current = false
		userDisengagedRef.current = false
		userIntentScrollUpRef.current = false

		if (userDisengagedTimeoutRef.current !== null) {
			window.clearTimeout(userDisengagedTimeoutRef.current)
			userDisengagedTimeoutRef.current = null
		}
		if (userIntentScrollUpTimeoutRef.current !== null) {
			window.clearTimeout(userIntentScrollUpTimeoutRef.current)
			userIntentScrollUpTimeoutRef.current = null
		}

		if (taskTs) {
			scrollPhaseRef.current = "HYDRATING_PINNED_TO_BOTTOM"
		} else {
			scrollPhaseRef.current = "USER_BROWSING_HISTORY"
		}
	}

	// -----------------------------------------------------------------------
	// Phase transitions
	// -----------------------------------------------------------------------

	const transitionScrollPhase = useCallback((nextPhase: ScrollPhase, _reason?: string) => {
		if (scrollPhaseRef.current === nextPhase) {
			return
		}
		scrollPhaseRef.current = nextPhase
		setScrollPhase(nextPhase)
	}, [])

	// -----------------------------------------------------------------------
	// Scroll commands
	// -----------------------------------------------------------------------
	// Must be declared before the phase-transition callbacks that depend on them.

	const scrollToBottomSmooth = useMemo(
		() =>
			debounce(
				() => {
					// Guard: if the user disengaged while this call was
					// queued (trailing edge), do not pull them back to
					// the bottom.  The leading-edge call fires
					// synchronously from handleRowHeightChange, which
					// already checks isAtBottomRef and the force-pin
					// condition; the trailing-edge call runs after the
					// debounce window and may have been overtaken by a
					// user scroll-up.
					if (scrollPhaseRef.current !== "ANCHORED_FOLLOWING") {
						return
					}
					virtuosoRef.current?.scrollToIndex({ index: "LAST", align: "end", behavior: "smooth" })
				},
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

	const cancelReanchorFrame = useCallback(() => {
		if (reanchorAnimationFrameRef.current !== null) {
			cancelAnimationFrame(reanchorAnimationFrameRef.current)
			reanchorAnimationFrameRef.current = null
		}
	}, [])

	const enterAnchoredFollowing = useCallback(
		(reason?: string) => {
			transitionScrollPhase("ANCHORED_FOLLOWING", reason)
			setShowScrollToBottom(false)
			// Clear the user-intent flag when re-engaging follow mode.
			userIntentScrollUpRef.current = false
		},
		[transitionScrollPhase],
	)

	const enterUserBrowsingHistory = useCallback(
		(_source: ScrollFollowDisengageSource) => {
			console.log(
				`[scroll] enterUserBrowsingHistory source=${_source} ` +
					`prevPhase=${scrollPhaseRef.current} isAtBottom=${isAtBottomRef.current}`,
			)
			transitionScrollPhase("USER_BROWSING_HISTORY", _source)
			setShowScrollToBottom(true)
			// Cancel any pending debounced scroll-to-bottom calls
			// (trailing-edge) that were scheduled before the user
			// disengaged. Without this, a trailing scrollToBottomSmooth
			// fires ~10 ms after the user scrolls up, pulling them right
			// back to the bottom.
			scrollToBottomSmooth.clear()
			// Cancel any in-flight browser smooth-scroll animation.
			// scrollToBottomSmooth uses behavior: "smooth", which runs on
			// the compositor thread; clear() above only kills the debounce
			// timer — it does NOT abort the animation.  Issuing an instant
			// scrollTo interrupts the in-flight smooth scroll at the
			// current position in all browsers.
			const scroller = scrollContainerRef.current?.querySelector(".scrollable") as HTMLElement | null
			if (scroller) {
				scroller.scrollTo({ top: scroller.scrollTop, behavior: "auto" })
			}
			// Open a brief immune window so any in-flight programmatic
			// scroll-to-bottom that completes after this point cannot
			// pull the user back to ANCHORED_FOLLOWING.
			userDisengagedRef.current = true
			if (userDisengagedTimeoutRef.current !== null) {
				window.clearTimeout(userDisengagedTimeoutRef.current)
			}
			userDisengagedTimeoutRef.current = window.setTimeout(() => {
				userDisengagedRef.current = false
				userDisengagedTimeoutRef.current = null
			}, 500)
			// Clear the user-intent-scroll-up flag after a brief safety
			// window. By this point atBottomStateChangeCallback has had
			// time to see the flag and skip the auto-scroll-back.
			if (userIntentScrollUpTimeoutRef.current !== null) {
				window.clearTimeout(userIntentScrollUpTimeoutRef.current)
			}
			userIntentScrollUpTimeoutRef.current = window.setTimeout(() => {
				userIntentScrollUpRef.current = false
				userIntentScrollUpTimeoutRef.current = null
			}, 200)
		},
		[scrollToBottomSmooth, scrollContainerRef, transitionScrollPhase],
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
	// Scroll-to-bottom hydration (for new / never-viewed tasks)
	// -----------------------------------------------------------------------

	const finishHydrationWindow = useCallback(() => {
		if (!isMountedRef.current || !isHydratingRef.current) {
			return
		}

		if (scrollPhaseRef.current === "HYDRATING_PINNED_TO_BOTTOM") {
			if (isAtBottomRef.current) {
				enterAnchoredFollowing("hydration-complete")
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
				enterAnchoredFollowing("hydration-retry-exhausted")
			}
		}

		clearHydrationWindow()
	}, [clearHydrationWindow, enterAnchoredFollowing, scrollToBottomAuto])

	const startHydrationWindow = useCallback(() => {
		isHydratingRef.current = true
		hydrationRetryCountRef.current = 0
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
			if (userDisengagedTimeoutRef.current !== null) {
				window.clearTimeout(userDisengagedTimeoutRef.current)
			}
			if (userIntentScrollUpTimeoutRef.current !== null) {
				window.clearTimeout(userIntentScrollUpTimeoutRef.current)
			}
		}
	}, [cancelReanchorFrame, clearHydrationWindow, scrollToBottomSmooth])

	// Keep phase ref in sync with state
	useEffect(() => {
		scrollPhaseRef.current = scrollPhase
	}, [scrollPhase])

	// Task switch: always enter hydration and scroll to the bottom.
	useEffect(() => {
		isAtBottomRef.current = false
		clearHydrationWindow()
		cancelReanchorFrame()
		// Clear any disengage immune window from the previous task.
		userDisengagedRef.current = false
		if (userDisengagedTimeoutRef.current !== null) {
			window.clearTimeout(userDisengagedTimeoutRef.current)
			userDisengagedTimeoutRef.current = null
		}

		if (taskTs) {
			transitionScrollPhase("HYDRATING_PINNED_TO_BOTTOM")
			setShowScrollToBottom(false)
			startHydrationWindow()
		} else {
			transitionScrollPhase("USER_BROWSING_HISTORY")
			setShowScrollToBottom(false)
		}

		return () => {
			clearHydrationWindow()
			cancelReanchorFrame()
		}
	}, [cancelReanchorFrame, clearHydrationWindow, startHydrationWindow, taskTs, transitionScrollPhase])

	// -----------------------------------------------------------------------
	// Row height change handler
	// -----------------------------------------------------------------------

	const handleRowHeightChange = useCallback(
		(isTaller: boolean) => {
			// Strict: while in USER_BROWSING_HISTORY, never auto-scroll
			if (
				scrollPhaseRef.current === "USER_BROWSING_HISTORY" ||
				scrollPhaseRef.current === "HYDRATING_PINNED_TO_BOTTOM"
			) {
				return
			}

			const shouldForcePinForAnchoredStreaming =
				scrollPhaseRef.current === "ANCHORED_FOLLOWING" && isStreaming && !userIntentScrollUpRef.current
			if (isAtBottomRef.current || shouldForcePinForAnchoredStreaming) {
				if (shouldForcePinForAnchoredStreaming && !isAtBottomRef.current) {
					console.log(
						"[scroll] handleRowHeightChange: force-pin for streaming " +
							`isTaller=${isTaller} isAtBottom=${isAtBottomRef.current} ` +
							`userIntent=${userIntentScrollUpRef.current}`,
					)
				}
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
		enterAnchoredFollowing("scroll-to-bottom-click")
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
		return scrollPhaseRef.current === "USER_BROWSING_HISTORY" ? false : "auto"
	}, [])

	// -----------------------------------------------------------------------
	// Virtuoso callback: atBottomStateChange
	// -----------------------------------------------------------------------

	const atBottomStateChangeCallback = useCallback(
		(isAtBottom: boolean) => {
			isAtBottomRef.current = isAtBottom

			const currentPhase = scrollPhaseRef.current

			// Strict: while in USER_BROWSING_HISTORY, never auto-scroll or re-anchor
			if (currentPhase === "USER_BROWSING_HISTORY") {
				setShowScrollToBottom(true)
				return
			}

			if (!isAtBottom && isHydratingRef.current) {
				setShowScrollToBottom(false)
				return
			}

			if (isAtBottom) {
				enterAnchoredFollowing("atBottomStateChange")
				return
			}

			if (currentPhase === "ANCHORED_FOLLOWING" && !isAtBottom && pointerScrollActiveRef.current) {
				enterUserBrowsingHistory("pointer-scroll-up")
				return
			}

			if (currentPhase === "ANCHORED_FOLLOWING" && isStreaming && !userIntentScrollUpRef.current) {
				console.log(
					"[scroll] atBottomStateChange: streaming safety-net re-scroll " +
						`isAtBottom=${isAtBottom} userIntentScrollUp=${userIntentScrollUpRef.current}`,
				)
				scrollToBottomAuto()
				setShowScrollToBottom(false)
				return
			}

			setShowScrollToBottom(false)
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
				// Set the flag synchronously BEFORE the phase transition so
				// atBottomStateChangeCallback can see it even if it fires
				// before enterUserBrowsingHistory completes.
				userIntentScrollUpRef.current = true
				enterUserBrowsingHistory("wheel-up")
			}
		},
		[enterUserBrowsingHistory, scrollContainerRef],
	)
	// Capture phase: must fire BEFORE the wheel event reaches Virtuoso's
	// internal scrollable element.  Without this, Virtuoso processes the
	// scroll first → atBottomStateChange(false) fires while
	// scrollPhaseRef is still ANCHORED_FOLLOWING + isStreaming →
	// scrollToBottomAuto() snaps the user back to the bottom before
	// handleWheel ever gets a chance to set userIntentScrollUpRef.
	useEvent("wheel", handleWheel, window, { passive: true, capture: true })

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
				// Set the flag synchronously BEFORE the phase transition so
				// atBottomStateChangeCallback can see it even if it fires
				// before enterUserBrowsingHistory completes.
				userIntentScrollUpRef.current = true
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
				// Set the flag synchronously BEFORE the phase transition so
				// atBottomStateChangeCallback can see it even if it fires
				// before enterUserBrowsingHistory completes.
				userIntentScrollUpRef.current = true
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
		scrollToBottomAuto,
		isAtBottomRef,
		scrollPhaseRef,
	}
}
