// Host-shared React shim (design §6.8, P4 external plugin UI).
//
// A third-party plugin's UI bundle is built with `react` **externalized**, so its
// `import React, { useState } from "react"` stays a bare specifier in the output.
// The webview injects an import map (see `getHtmlContent`) that resolves that bare
// specifier to THIS module, which re-exports the HOST's already-running React
// instance (published on the global by `webview-ui/src/index.tsx` at boot). Sharing
// the one instance is what keeps hooks/context working across the host↔plugin
// boundary — a plugin that bundled its own React would get a second, broken copy.
//
// Served verbatim from `public/` (never transformed), so it must be plain ESM.
const NS = globalThis.__shoferHostReact
const R = (NS && NS.default) || NS

export default R
export const Children = R.Children
export const Component = R.Component
export const Fragment = R.Fragment
export const Profiler = R.Profiler
export const PureComponent = R.PureComponent
export const StrictMode = R.StrictMode
export const Suspense = R.Suspense
export const cloneElement = R.cloneElement
export const createContext = R.createContext
export const createElement = R.createElement
export const createRef = R.createRef
export const forwardRef = R.forwardRef
export const isValidElement = R.isValidElement
export const lazy = R.lazy
export const memo = R.memo
export const startTransition = R.startTransition
export const useCallback = R.useCallback
export const useContext = R.useContext
export const useDebugValue = R.useDebugValue
export const useDeferredValue = R.useDeferredValue
export const useEffect = R.useEffect
export const useId = R.useId
export const useImperativeHandle = R.useImperativeHandle
export const useInsertionEffect = R.useInsertionEffect
export const useLayoutEffect = R.useLayoutEffect
export const useMemo = R.useMemo
export const useReducer = R.useReducer
export const useRef = R.useRef
export const useState = R.useState
export const useSyncExternalStore = R.useSyncExternalStore
export const useTransition = R.useTransition
export const version = R.version
