import React, { Component, useEffect, useMemo, useRef, useState } from "react"

import type {
	PluginUIApi,
	PluginUIContext,
	PluginUiContribution,
	PluginUiMessageSummary,
	PluginUiRegion,
	PluginUiTaskSummary,
} from "@shofer/types"

import { useExtensionState } from "@src/context/ExtensionStateContext"

import { PluginUIComponent, resolvePluginComponent } from "./pluginComponentResolver"
import { postPluginUiMessage, requestPluginUi, subscribePluginUiMessages } from "./pluginUiChannel"

/**
 * PluginSlot (design §6.8, §12; Phase 4 step 4.4).
 *
 * Renders every enabled plugin's UI contribution for a given webview `region`. Each
 * contribution's component is resolved (dynamic import / co-bundled registry — NOT an
 * iframe, owner decision §14 Q1) and handed a restricted {@link PluginUIApi}: a scoped
 * message channel to its extension-side plugin plus a read-only {@link PluginUIContext}.
 *
 * Isolation guarantees:
 *  - **Non-breaking:** with zero contributions for the region, {@link PluginSlot}
 *    renders `null` (no wrapper DOM) — the host layout is byte-for-byte unchanged.
 *  - **Crash isolation:** a plugin component that throws while rendering is caught by
 *    {@link PluginErrorBoundary}, which renders nothing and logs a warning — it can
 *    never break the surrounding host UI.
 */

/** Error boundary around one plugin component: on throw, render nothing + warn once. */
class PluginErrorBoundary extends Component<{ pluginName: string; children: React.ReactNode }, { crashed: boolean }> {
	constructor(props: { pluginName: string; children: React.ReactNode }) {
		super(props)
		this.state = { crashed: false }
	}

	static getDerivedStateFromError(): { crashed: boolean } {
		return { crashed: true }
	}

	componentDidCatch(error: unknown): void {
		// Surfaced (logged) so the failure is visible, but the host UI keeps working.
		console.warn(`[plugin:${this.props.pluginName}] UI component crashed and was unmounted:`, error)
	}

	render(): React.ReactNode {
		if (this.state.crashed) return null
		return this.props.children
	}
}

/**
 * Build the per-mount, plugin-scoped {@link PluginUIApi}: a `postMessage`/`onMessage`
 * channel namespaced to `pluginName` (so a plugin can neither spoof nor observe
 * another's channel) plus the read-only context blob.
 */
function usePluginUiApi(
	pluginName: string,
	region: PluginUiRegion,
	task: PluginUiTaskSummary,
	message?: PluginUiMessageSummary,
): PluginUIApi {
	// A single window listener per mount, demuxed to the mount's subscribers by name.
	const listenersRef = useRef(new Set<(message: unknown) => void>())

	useEffect(() => {
		const unsubscribe = subscribePluginUiMessages(pluginName, (message) => {
			for (const listener of listenersRef.current) listener(message)
		})
		return unsubscribe
	}, [pluginName])

	const context = useMemo<PluginUIContext>(
		() => ({ region, pluginName, task, message }),
		[region, pluginName, task, message],
	)

	return useMemo<PluginUIApi>(
		() => ({
			postMessage: (outgoing: unknown) => postPluginUiMessage(pluginName, outgoing),
			request: (method: string, params?: unknown, opts?: { mutates?: boolean }) =>
				requestPluginUi(pluginName, method, params, opts),
			onMessage: (listener: (message: unknown) => void) => {
				listenersRef.current.add(listener)
				return () => listenersRef.current.delete(listener)
			},
			context,
		}),
		[pluginName, context],
	)
}

/** Resolve + render a single contribution's component inside an error boundary. */
function PluginContributionMount({
	contribution,
	region,
	task,
	message,
}: {
	contribution: PluginUiContribution
	region: PluginUiRegion
	task: PluginUiTaskSummary
	message?: PluginUiMessageSummary
}) {
	const [Component, setComponent] = useState<PluginUIComponent | null>(null)
	const api = usePluginUiApi(contribution.pluginName, region, task, message)

	useEffect(() => {
		let cancelled = false
		console.log(
			`[plugin:${contribution.pluginName}] loading UI component for region "${region}" (componentId=${contribution.componentId}, source=${contribution.source ?? "(co-bundled)"})`,
		)
		resolvePluginComponent(contribution)
			.then((resolved) => {
				if (cancelled) return
				setComponent(() => resolved ?? null)
				console.log(
					`[plugin:${contribution.pluginName}] UI component for "${region}" ${resolved ? "loaded ✓" : "resolved to NOTHING (no default/component export?)"}`,
				)
			})
			.catch((error) => {
				if (!cancelled) setComponent(null)
				// This is the usual failure when the shared-React shims aren't served
				// (import map → `react.js` 404) — the plugin's `import "react"` rejects here.
				console.warn(`[plugin:${contribution.pluginName}] failed to load UI component for "${region}":`, error)
			})
		return () => {
			cancelled = true
		}
		// componentId + source fully identify the module to load; `region` appears only
		// in log strings, so reloading when it changes (but the module doesn't) is waste.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [contribution, contribution.componentId, contribution.source])

	if (!Component) return null

	return (
		<PluginErrorBoundary pluginName={contribution.pluginName}>
			<Component api={api} />
		</PluginErrorBoundary>
	)
}

/**
 * Pure renderer: given the contributions already filtered for a region, render each.
 * Split out from {@link PluginSlot} (which reads context) so it is trivially testable.
 * Renders `null` when there are no contributions (non-breaking).
 */
export function PluginSlotView({
	region,
	contributions,
	task,
	message,
}: {
	region: PluginUiRegion
	contributions: PluginUiContribution[]
	task: PluginUiTaskSummary
	message?: PluginUiMessageSummary
}) {
	if (contributions.length === 0) return null
	return (
		<>
			{contributions.map((contribution) => (
				<PluginContributionMount
					key={contribution.componentId}
					contribution={contribution}
					region={region}
					task={task}
					message={message}
				/>
			))}
		</>
	)
}

/**
 * Region slot for plugin UI contributions. Reads the pushed contributions snapshot
 * from {@link useExtensionState} and renders those for `region`. With no
 * UI-contributing plugins the snapshot is empty and this renders nothing.
 */
export function PluginSlot({
	region,
	pluginName,
	message,
}: {
	region: PluginUiRegion
	/**
	 * Restrict the slot to one plugin's contribution. Used by `chat-message-addon`,
	 * where the mount exists for a specific plugin's timeline row — every other
	 * plugin's addon component would be rendering someone else's message.
	 */
	pluginName?: string
	message?: PluginUiMessageSummary
}) {
	const { pluginUiContributions, mode, currentTaskItem } = useExtensionState()

	const contributions = useMemo(
		() =>
			(pluginUiContributions?.contributions ?? []).filter(
				(c) => c.region === region && (!pluginName || c.pluginName === pluginName),
			),
		[pluginUiContributions, region, pluginName],
	)

	const task = useMemo<PluginUiTaskSummary>(
		() => ({ taskId: currentTaskItem?.id, mode }),
		[currentTaskItem?.id, mode],
	)

	return <PluginSlotView region={region} contributions={contributions} task={task} message={message} />
}
