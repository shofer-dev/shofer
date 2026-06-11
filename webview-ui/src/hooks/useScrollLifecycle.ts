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
 *   `followOutput=false`.
 *
 * **Scroll-to-bottom button visibility:** `showScrollToBottom` reflects
 *   `!isAtBottom` in every lifecycle phase (except during the hydration
 *   window, where it is suppressed to avoid flicker).  This means the button
 *   appears even during ANCHORED_FOLLOWING when transient layout changes
 *   momentarily pull the user off the bottom — the old behaviour required an
 *   explicit user scroll-up gesture first.  The caller is expected to layer
 *   a blink / pulse animation on top of the button when a pending approval
 *   or question coexists with the scroll cue.
 */

import React, { useCallback, useEffect, useRef, useState } from "react"
import { useEvent } from "react-use"
import type { VirtuosoHandle } from "react-virtuoso"
import { vscode } from "@src/utils/vscode"

const HYDRATION_WINDOW_MS = 600
const HYDRATION_RETRY_WINDOW_MS = 160
const MAX_HYDRATION_RETRIES = 3

// ---------------------------------------------------------------------------
// Debug logging gate — set to true during scroll development only.
// Logs are posted to the Shofer Output Channel via webviewLog IPC.
// ---------------------------------------------------------------------------

const SCROLL_DEBUG = false

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
	/** When true, skip the hydration scroll-to-bottom cycle on task switch.
	 *  Use for re-entering already-completed or previously-viewed tasks
	 *  where the user's scroll position should be preserved.
	 *  The caller is responsible for snapshoting and restoring scrollTop
	 *  per task (externally, via the Virtuoso's scrollable element). */
	skipHydration?: boolean
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
	skipHydration = false,
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
		const prevTs = prevTaskTsRef.current
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

		const nextPhase: ScrollPhase = taskTs && !skipHydration ? "HYDRATING_PINNED_TO_BOTTOM" : "USER_BROWSING_HISTORY"
		scrollPhaseRef.current = nextPhase

		if (SCROLL_DEBUG) {
			vscode.postMessage({
				type: "webviewLog",
				text:
					`[scroll:taskSwitch] prevTs=${prevTs ?? "none"} taskTs=${taskTs ?? "none"} ` +
					`skipHydration=${skipHydration} → phase=${nextPhase}`,
			})
		}
	}

	// -----------------------------------------------------------------------
	// Phase transitions
	// -----------------------------------------------------------------------

	const transitionScrollPhase = useCallback(
		(nextPhase: ScrollPhase, _reason?: string) => {
			if (scrollPhaseRef.current === nextPhase) {
				return
			}
			const prev = scrollPhaseRef.current
			scrollPhaseRef.current = nextPhase
			setScrollPhase(nextPhase)
			if (SCROLL_DEBUG) {
				vscode.postMessage({
					type: "webviewLog",
					text:
						`[scroll:phase] ${prev} → ${nextPhase} ` +
						`reason=${_reason ?? "?"} taskTs=${taskTs} isAtBottom=${isAtBottomRef.current}`,
				})
			}
		},
		[taskTs],
	)

	// -----------------------------------------------------------------------
	// Scroll commands
	// -----------------------------------------------------------------------
	// Must be declared before the phase-transition callbacks that depend on them.

	const scrollToBottomAuto = useCallback(() => {
		if (SCROLL_DEBUG) {
			vscode.postMessage({
				type: "webviewLog",
				text: `[scroll:auto] scrollToIndex LAST taskTs=${taskTs}`,
			})
		}
		virtuosoRef.current?.scrollToIndex({
			index: "LAST",
			align: "end",
			behavior: "auto",
		})
	}, [virtuosoRef, taskTs])

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
			if (SCROLL_DEBUG) {
				vscode.postMessage({
					type: "webviewLog",
					text:
						`[scroll:disengage] source=${_source} ` +
						`prevPhase=${scrollPhaseRef.current} isAtBottom=${isAtBottomRef.current} ` +
						`taskTs=${taskTs}`,
				})
			}
			transitionScrollPhase("USER_BROWSING_HISTORY", _source)
			setShowScrollToBottom(true)
			// atBottomStateChangeCallback also sets showScrollToBottom
			// based on isAtBottom, so the flag is always coherent even
			// when Virtuoso hasn't yet reported the new scroll position.
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
		[transitionScrollPhase, taskTs],
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
				if (SCROLL_DEBUG) {
					vscode.postMessage({
						type: "webviewLog",
						text: `[scroll:hydrate] retry ${hydrationRetryCountRef.current}/${MAX_HYDRATION_RETRIES} taskTs=${taskTs}`,
					})
				}
				scrollToBottomAuto()
				hydrationTimeoutRef.current = window.setTimeout(() => {
					finishHydrationWindow()
				}, HYDRATION_RETRY_WINDOW_MS)
				return
			} else {
				// Retry budget exhausted. Keep anchored follow rather than
				// downgrading to browsing mode due to non-user transient drift.
				if (SCROLL_DEBUG) {
					vscode.postMessage({
						type: "webviewLog",
						text: `[scroll:hydrate] retries exhausted taskTs=${taskTs}`,
					})
				}
				enterAnchoredFollowing("hydration-retry-exhausted")
			}
		}

		clearHydrationWindow()
	}, [clearHydrationWindow, enterAnchoredFollowing, scrollToBottomAuto, taskTs])

	const startHydrationWindow = useCallback(() => {
		if (SCROLL_DEBUG) {
			vscode.postMessage({
				type: "webviewLog",
				text: `[scroll:hydrate] START taskTs=${taskTs} windowMs=${HYDRATION_WINDOW_MS}`,
			})
		}
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
	}, [finishHydrationWindow, scrollToBottomAuto, taskTs])

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
			if (userDisengagedTimeoutRef.current !== null) {
				window.clearTimeout(userDisengagedTimeoutRef.current)
			}
			if (userIntentScrollUpTimeoutRef.current !== null) {
				window.clearTimeout(userIntentScrollUpTimeoutRef.current)
			}
		}
	}, [cancelReanchorFrame, clearHydrationWindow])

	// Keep phase ref in sync with state
	useEffect(() => {
		scrollPhaseRef.current = scrollPhase
	}, [scrollPhase])

	// Task switch: enter hydration and scroll to the bottom.
	// When skipHydration is true (e.g. re-entering a completed task),
	// stay in USER_BROWSING_HISTORY so the user's previous scroll
	// position is preserved.
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

		if (taskTs && !skipHydration) {
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
	}, [cancelReanchorFrame, clearHydrationWindow, skipHydration, startHydrationWindow, taskTs, transitionScrollPhase])

	// -----------------------------------------------------------------------
	// Row height change handler
	// -----------------------------------------------------------------------

	const handleRowHeightChange = useCallback(
		(isTaller: boolean) => {
			// Strict: while not in ANCHORED_FOLLOWING, never auto-scroll
			if (
				scrollPhaseRef.current === "USER_BROWSING_HISTORY" ||
				scrollPhaseRef.current === "HYDRATING_PINNED_TO_BOTTOM"
			) {
				return
			}

			const shouldForcePinForAnchoredStreaming =
				scrollPhaseRef.current === "ANCHORED_FOLLOWING" && isStreaming && !userIntentScrollUpRef.current
			if (isAtBottomRef.current || shouldForcePinForAnchoredStreaming) {
				if (SCROLL_DEBUG && shouldForcePinForAnchoredStreaming && !isAtBottomRef.current) {
					vscode.postMessage({
						type: "webviewLog",
						text:
							`[scroll:forcePin] isTaller=${isTaller} isAtBottom=${isAtBottomRef.current} ` +
							`userIntent=${userIntentScrollUpRef.current} taskTs=${taskTs}`,
					})
				}
				scrollToBottomAuto()
			}
		},
		[isStreaming, scrollToBottomAuto, taskTs],
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
	//
	// Scroll-to-bottom button visibility is computed FIRST (before any
	// phase-transition or auto-scroll logic) so that the button is visible
	// in EVERY case where the user is not at the bottom — including during
	// ANCHORED_FOLLOWING when transient layout changes momentarily pull the
	// user off the bottom.  The only exception is the hydration window
	// (initial scroll-to-bottom after a task switch), where we suppress the
	// button to avoid a distracting flash.
	//
	// Previously the button only appeared after the phase had transitioned to
	// USER_BROWSING_HISTORY, which required an explicit scroll-up gesture
	// first.  Now the caller (ChatView / WorkflowView) can layer a blink
	// animation on the button when a pending approval also exists, prompting
	// the user to scroll down before they can see and act on the buttons.

	const atBottomStateChangeCallback = useCallback(
		(isAtBottom: boolean) => {
			isAtBottomRef.current = isAtBottom

			const currentPhase = scrollPhaseRef.current

			// --- Scroll-to-bottom button visibility (computed first) ---
			// Show the button in these cases:
			// 1. USER_BROWSING_HISTORY — always show (re-anchor CTA).
			// 2. ANCHORED_FOLLOWING / HYDRATING where !isAtBottom AND
			//    we are NOT about to auto-scroll-back:
			//    - Hydration: suppress during the hydration window.
			//    - Streaming safety-net: suppress when we're about to
			//      call scrollToBottomAuto() (line ~547 below) — avoids
			//      a one-frame flash before the re-scroll.
			const streamingSafetyNet =
				currentPhase === "ANCHORED_FOLLOWING" && isStreaming && !userIntentScrollUpRef.current
			const shouldShow = currentPhase === "USER_BROWSING_HISTORY"
				? true
				: !isAtBottom && !isHydratingRef.current && !streamingSafetyNet
			setShowScrollToBottom(shouldShow)

			// --- Phase-transition and auto-scroll logic (unchanged) ---

			// Strict: while in USER_BROWSING_HISTORY, never auto-scroll or re-anchor
			if (currentPhase === "USER_BROWSING_HISTORY") {
				return
			}

			if (!isAtBottom && isHydratingRef.current) {
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
				if (SCROLL_DEBUG) {
					vscode.postMessage({
						type: "webviewLog",
						text:
							`[scroll:safetyNet] streaming re-scroll ` +
							`isAtBottom=${isAtBottom} userIntentScrollUp=${userIntentScrollUpRef.current} ` +
							`taskTs=${taskTs}`,
					})
				}
				scrollToBottomAuto()
				return
			}

			// Not-at-bottom while ANCHORED_FOLLOWING (non-streaming):
			// this is a genuine user scroll-up intent not caught by
			// the other detectors. Transition to browse mode.
			if (currentPhase === "ANCHORED_FOLLOWING" && !isAtBottom && !isStreaming) {
				// set the user-intent flag so handleRowHeightChange won't
				// force-pin while we're in the middle of disengaging.
				userIntentScrollUpRef.current = true
				enterUserBrowsingHistory("pointer-scroll-up")
				return
			}
		},
		[enterAnchoredFollowing, enterUserBrowsingHistory, isStreaming, scrollToBottomAuto, taskTs],
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
