/**
 * A minimal `renderHook` for this package.
 *
 * The CLI's UI is Ink (React rendered to a terminal), so there is no DOM and
 * `@testing-library/react` cannot mount it. `ink-testing-library` renders a real
 * Ink tree against a fake stdout, which is all a hook needs: mount a probe
 * component that calls the hook and publishes its return value.
 *
 * Every state transition goes through React 19's `act` so effects and the
 * resulting re-render are flushed before the assertion runs — including updates
 * driven from OUTSIDE React (a zustand store write, a timer firing), which is
 * how most of these hooks are actually driven.
 *
 * Not a test file: it lives under `__tests__/helpers/` so vitest's `include`
 * (`src/**\/*.test.ts(x)`) does not collect it.
 */

import React from "react"
import { act } from "react"
import { render } from "ink-testing-library"

// React's `act` refuses to run unless the environment declares itself a test one.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

export interface RenderHookResult<TResult, TProps> {
	/** The hook's latest return value. */
	readonly current: TResult
	/** Re-render the probe with new props, flushed through `act`. */
	rerender: (props: TProps) => void
	/** Unmount the probe, so cleanup effects run. */
	unmount: () => void
	/** Run `fn` inside `act`, flushing whatever it triggers. */
	act: (fn: () => void) => void
	/**
	 * Await `fn` inside an ASYNC `act`, so a state update that lands in a
	 * microtask (a promise a mount effect started) is flushed before the
	 * assertion. Called with no argument it just drains the microtask queue.
	 */
	actAsync: (fn?: () => Promise<void> | void) => Promise<void>
	/** The frames Ink rendered (empty for a null-rendering probe). */
	lastFrame: () => string | undefined
}

/**
 * `ink-testing-library`'s `render`, wrapped in `act` so mount effects are flushed
 * and React does not warn about an unwrapped update.
 */
export function renderInk(element: React.ReactElement): ReturnType<typeof render> {
	let instance!: ReturnType<typeof render>
	act(() => {
		instance = render(element)
	})
	return instance
}

/**
 * Mount `hook` in an Ink tree and return a handle on its latest value.
 */
export function renderHook<TResult, TProps = undefined>(
	hook: (props: TProps) => TResult,
	initialProps?: TProps,
): RenderHookResult<TResult, TProps> {
	const box: { value: TResult } = { value: undefined as TResult }

	const Probe = ({ hookProps }: { hookProps: TProps }) => {
		box.value = hook(hookProps)
		return null
	}

	let instance!: ReturnType<typeof render>
	act(() => {
		instance = render(<Probe hookProps={initialProps as TProps} />)
	})

	return {
		get current() {
			return box.value
		},
		rerender: (props: TProps) => {
			act(() => {
				instance.rerender(<Probe hookProps={props} />)
			})
		},
		unmount: () => {
			act(() => {
				instance.unmount()
			})
		},
		act: (fn: () => void) => {
			act(fn)
		},
		actAsync: async (fn?: () => Promise<void> | void) => {
			await act(async () => {
				await fn?.()
				await Promise.resolve()
			})
		},
		lastFrame: () => instance.lastFrame(),
	}
}
