import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react"
import { useDeepCompareEffect, useEvent } from "react-use"
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso"
import removeMd from "remove-markdown"
import useSound from "use-sound"
import { LRUCache } from "lru-cache"
import { Trans } from "react-i18next"

import { useDebounceEffect } from "@src/utils/useDebounceEffect"
import { appendImages } from "@src/utils/imageUtils"
import { getCostBreakdownIfNeeded } from "@src/utils/costFormatting"
import { batchConsecutive } from "@src/utils/batchConsecutive"

import type { ShoferAsk, ShoferSayTool, ShoferMessage, ExtensionMessage, AudioType } from "@shofer/types"
import { isRetiredProvider } from "@shofer/types"

import { findLast } from "@shofer/shared/array"
import { SuggestionItem } from "@shofer/types"
import { combineApiRequests } from "@shofer/shared/combineApiRequests"
import { combineCommandSequences } from "@shofer/shared/combineCommandSequences"
import { getApiMetrics } from "@shofer/shared/getApiMetrics"
import { getAllModes } from "@shofer/shared/modes"
import { ProfileValidator } from "@shofer/shared/ProfileValidator"
import { getLatestTodo } from "@shofer/shared/todo"
import { escapeSpaces } from "@src/utils/path-mentions"

import { vscode } from "@src/utils/vscode"
import { type DroppedContextFile, extractUriPayload, parseDroppedUris } from "@src/utils/droppedContextFiles"
import { useAppTranslation } from "@src/i18n/TranslationContext"
import { useExtensionState } from "@src/context/ExtensionStateContext"
import { useSelectedModel } from "@src/components/ui/hooks/useSelectedModel"
import ShoferHero from "@src/components/welcome/ShoferHero"
import ShoferTips from "@src/components/welcome/ShoferTips"
import { StandardTooltip, Button } from "@src/components/ui"
// CloudUpsellDialog removed

import VersionIndicator from "../common/VersionIndicator"
import HistoryPreview from "../history/HistoryPreview"
import Announcement from "./Announcement"
import ChatRow from "./ChatRow"
import WarningRow from "./WarningRow"
import { ChatTextArea } from "./ChatTextArea"
import TaskHeader from "./TaskHeader"
import { TaskSelector } from "./TaskSelector"
import ProfileViolationWarning from "./ProfileViolationWarning"
import { CheckpointWarning } from "./CheckpointWarning"
import { QueuedMessages } from "./QueuedMessages"
import FileChangesPanel from "./FileChangesPanel"
import SessionSearch from "./SessionSearch"
import { useScrollLifecycle } from "@src/hooks/useScrollLifecycle"
import { TaskNotificationContainer } from "../tasks/TaskNotification"

export interface ChatViewProps {
	isHidden: boolean
	showAnnouncement: boolean
	hideAnnouncement: () => void
}

export interface ChatViewRef {
	acceptInput: () => void
}

export const MAX_IMAGES_PER_MESSAGE = 20 // This is the Anthropic limit.

const isMac = navigator.platform.toUpperCase().indexOf("MAC") >= 0

const ChatViewComponent: React.ForwardRefRenderFunction<ChatViewRef, ChatViewProps> = (
	{ isHidden, showAnnouncement, hideAnnouncement },
	ref,
) => {
	const [audioBaseUri] = useState(() => {
		return (window as unknown as { AUDIO_BASE_URI?: string }).AUDIO_BASE_URI || ""
	})

	const { t } = useAppTranslation()
	const modeShortcutText = `${isMac ? "⌘" : "Ctrl"} + . ${t("chat:forNextMode")}, ${isMac ? "⌘" : "Ctrl"} + Shift + . ${t("chat:forPreviousMode")}`

	const {
		shoferMessages: messages,
		currentTaskItem,
		currentTaskTodos,
		taskHistory,
		apiConfiguration,
		organizationAllowList,
		mode,
		setMode,
		alwaysAllowModeSwitch,
		customModes,
		soundEnabled,
		soundVolume,
		messageQueue = [],
		parallelTasks,
		taskNotifications,
		pendingWorktreeDir,
		setPendingWorktreeDir,
	} = useExtensionState()

	// Show a WarningRow when the user sends a message with a retired provider.
	const [showRetiredProviderWarning, setShowRetiredProviderWarning] = useState(false)

	// When the provider changes, clear the retired-provider warning.
	const providerName = apiConfiguration?.apiProvider
	useEffect(() => {
		setShowRetiredProviderWarning(false)
	}, [providerName])

	const messagesRef = useRef(messages)

	useEffect(() => {
		messagesRef.current = messages
	}, [messages])

	// Leaving this less safe version here since if the first message is not a
	// task, then the extension is in a bad state and needs to be debugged (see
	// Shofer.abort).
	const task = useMemo(() => messages.at(0), [messages])

	const latestTodos = useMemo(() => {
		// First check if we have initial todos from the state (for new subtasks)
		if (currentTaskTodos && currentTaskTodos.length > 0) {
			// Check if there are any todo updates in messages
			const messageBasedTodos = getLatestTodo(messages)
			// If there are message-based todos, they take precedence (user has updated them)
			if (messageBasedTodos && messageBasedTodos.length > 0) {
				return messageBasedTodos
			}
			// Otherwise use the initial todos from state
			return currentTaskTodos
		}
		// Fall back to extracting from messages
		return getLatestTodo(messages)
	}, [messages, currentTaskTodos])

	const modifiedMessages = useMemo(() => combineApiRequests(combineCommandSequences(messages.slice(1))), [messages])

	// Has to be after api_req_finished are all reduced into api_req_started messages.
	const apiMetrics = useMemo(() => getApiMetrics(modifiedMessages), [modifiedMessages])

	const [inputValue, setInputValue] = useState("")
	const inputValueRef = useRef(inputValue)
	const textAreaRef = useRef<HTMLTextAreaElement>(null)
	const [sendingDisabled, setSendingDisabled] = useState(false)
	const [selectedImages, setSelectedImages] = useState<string[]>([])

	/** Files dragged onto the webview — displayed as tags, converted to @mentions on send. */
	const [droppedContextFiles, setDroppedContextFiles] = useState<Array<{ path: string; isFile: boolean }>>([])
	const [isDraggingFiles, setIsDraggingFiles] = useState(false)

	// We need to hold on to the ask because useEffect > lastMessage will always
	// let us know when an ask comes in and handle it, but by the time
	// handleMessage is called, the last message might not be the ask anymore
	// (it could be a say that followed).
	const [shoferAsk, setShoferAsk] = useState<ShoferAsk | undefined>(undefined)
	const [enableButtons, setEnableButtons] = useState<boolean>(false)
	const [primaryButtonText, setPrimaryButtonText] = useState<string | undefined>(undefined)
	const [secondaryButtonText, setSecondaryButtonText] = useState<string | undefined>(undefined)
	const [_didClickCancel, setDidClickCancel] = useState(false)
	const virtuosoRef = useRef<VirtuosoHandle>(null)
	const [expandedRows, setExpandedRows] = useState<Record<number, boolean>>({})
	const prevExpandedRowsRef = useRef<Record<number, boolean>>()
	const scrollContainerRef = useRef<HTMLDivElement>(null)
	const lastTtsRef = useRef<string>("")
	const [wasStreaming, setWasStreaming] = useState<boolean>(false)
	const [checkpointWarning, setCheckpointWarning] = useState<
		{ type: "WAIT_TIMEOUT" | "INIT_TIMEOUT"; timeout: number } | undefined
	>(undefined)
	const [isCondensing, setIsCondensing] = useState<boolean>(false)
	const [showAnnouncementModal, setShowAnnouncementModal] = useState(false)
	const everVisibleMessagesTsRef = useRef<LRUCache<number, boolean>>(
		new LRUCache({
			max: 100,
			ttl: 1000 * 60 * 5,
		}),
	)
	const autoApproveTimeoutRef = useRef<NodeJS.Timeout | null>(null)
	const userRespondedRef = useRef<boolean>(false)
	const [currentFollowUpTs, setCurrentFollowUpTs] = useState<number | null>(null)
	const [searchHighlightTs, setSearchHighlightTs] = useState<number | null>(null)
	const [isSessionSearchOpen, setIsSessionSearchOpen] = useState(false)
	const [aggregatedCostsMap, setAggregatedCostsMap] = useState<
		Map<
			string,
			{
				totalCost: number
				ownCost: number
				childrenCost: number
			}
		>
	>(new Map())

	const shoferAskRef = useRef(shoferAsk)
	useEffect(() => {
		shoferAskRef.current = shoferAsk
	}, [shoferAsk])


	// Keep inputValueRef in sync with inputValue state
	useEffect(() => {
		inputValueRef.current = inputValue
	}, [inputValue])

	/**
	 * Per-task draft preservation.
	 *
	 * The textarea's `inputValue` (and accompanying `selectedImages` /
	 * `droppedContextFiles`) live as React state in this single ChatView
	 * instance, which is reused across task switches. Without scoping, an
	 * unsent draft typed for task A would visibly "follow" the user when they
	 * switch to task B. We snapshot the draft per task id so each task keeps
	 * its own pending input until it is actually sent.
	 *
	 * The map deliberately lives in a `useRef` (not state) — we don't need to
	 * re-render when other tasks' drafts change, only when we restore on a
	 * focus switch.
	 */
	const taskDraftsRef = useRef<
		Map<
			string,
			{
				inputValue: string
				selectedImages: string[]
				droppedContextFiles: Array<{ path: string; isFile: boolean }>
			}
		>
	>(new Map())
	const previousTaskIdRef = useRef<string | undefined>(currentTaskItem?.id)
	useEffect(() => {
		const newTaskId = currentTaskItem?.id
		const prevTaskId = previousTaskIdRef.current

		if (newTaskId === prevTaskId) {
			return
		}

		// Save the draft of the task we're leaving (if any).
		if (prevTaskId) {
			taskDraftsRef.current.set(prevTaskId, {
				inputValue: inputValueRef.current,
				selectedImages,
				droppedContextFiles,
			})
		}

		// Restore the draft of the task we're switching into (or clear if none).
		const restored = newTaskId ? taskDraftsRef.current.get(newTaskId) : undefined
		setInputValue(restored?.inputValue ?? "")
		setSelectedImages(restored?.selectedImages ?? [])
		setDroppedContextFiles(restored?.droppedContextFiles ?? [])

		previousTaskIdRef.current = newTaskId
		// We intentionally exclude selectedImages / droppedContextFiles from deps:
		// they are read via closure at the moment of the switch (their latest
		// values are what we want to snapshot for the OUTGOING task), and we
		// only want this effect to fire on task-id changes — not on every
		// keystroke or image add.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [currentTaskItem?.id])

	// Compute whether auto-approval is paused (user is typing in a followup)
	const isFollowUpAutoApprovalPaused = useMemo(() => {
		return !!(inputValue && inputValue.trim().length > 0 && shoferAsk === "followup")
	}, [inputValue, shoferAsk])

	// Cancel auto-approval timeout when user starts typing
	useEffect(() => {
		// Only send cancel if there's actual input (user is typing)
		// and we have a pending follow-up question
		if (isFollowUpAutoApprovalPaused) {
			vscode.postMessage({ type: "cancelAutoApproval" })
		}
	}, [isFollowUpAutoApprovalPaused])

	const isProfileDisabled = useMemo(
		() => !!apiConfiguration && !ProfileValidator.isProfileAllowed(apiConfiguration, organizationAllowList),
		[apiConfiguration, organizationAllowList],
	)

	// UI layout depends on the last 2 messages (since it relies on the content
	// of these messages, we are deep comparing) i.e. the button state after
	// hitting button sets enableButtons to false,  and this effect otherwise
	// would have to true again even if messages didn't change.
	const lastMessage = useMemo(() => messages.at(-1), [messages])
	const secondLastMessage = useMemo(() => messages.at(-2), [messages])

	const volume = typeof soundVolume === "number" ? soundVolume : 0.5
	const [playNotification] = useSound(`${audioBaseUri}/notification.wav`, { volume, soundEnabled, interrupt: true })
	const [playCelebration] = useSound(`${audioBaseUri}/celebration.wav`, { volume, soundEnabled, interrupt: true })
	const [playProgressLoop] = useSound(`${audioBaseUri}/progress_loop.wav`, { volume, soundEnabled, interrupt: true })

	const lastPlayedRef = useRef<Record<string, number>>({})

	const playSound = useCallback(
		(audioType: AudioType) => {
			if (!soundEnabled) {
				return
			}

			const now = Date.now()
			const lastPlayed = lastPlayedRef.current[audioType] ?? 0
			if (now - lastPlayed < 100) {
				return
			} // debounce: skip if played within 100ms
			lastPlayedRef.current[audioType] = now

			switch (audioType) {
				case "notification":
					playNotification()
					break
				case "celebration":
					playCelebration()
					break
				case "progress_loop":
					playProgressLoop()
					break
				default:
					console.warn(`Unknown audio type: ${audioType}`)
			}
		},
		[soundEnabled, playNotification, playCelebration, playProgressLoop],
	)

	function playTts(text: string) {
		vscode.postMessage({ type: "playTts", text })
	}

	useDeepCompareEffect(() => {
		// if last message is an ask, show user ask UI
		// if user finished a task, then start a new task with a new conversation history since in this moment that the extension is waiting for user response, the user could close the extension and the conversation history would be lost.
		// basically as long as a task is active, the conversation history will be persisted
		if (lastMessage) {
			// Clear button state from any previous task before
			// processing the current message. Individual cases below
			// set the correct state for each message type. This
			// prevents the "Start New Task" button from flashing when
			// switching from a completed/paused task to a running one.
			setShoferAsk(undefined)
			setEnableButtons(false)
			setPrimaryButtonText(undefined)
			setSecondaryButtonText(undefined)

			switch (lastMessage.type) {
				case "ask":
					// Reset user response flag when a new ask arrives to allow auto-approval
					userRespondedRef.current = false
					const isPartial = lastMessage.partial === true
					// When the backend has already auto-approved (or auto-denied) this
					// ask, no user input is required. Suppress the action buttons and
					// re-enable sending so the chat doesn't appear blocked.
					if (lastMessage.autoApproved) {
						setSendingDisabled(false)
						setShoferAsk(undefined)
						setEnableButtons(false)
						setPrimaryButtonText(undefined)
						setSecondaryButtonText(undefined)
						break
					}
					switch (lastMessage.ask) {
						case "api_req_failed":
							playSound("progress_loop")
							setSendingDisabled(true)
							setShoferAsk("api_req_failed")
							setEnableButtons(true)
							setPrimaryButtonText(t("chat:retry.title"))
							setSecondaryButtonText(t("chat:startNewTask.title"))
							break
						case "mistake_limit_reached":
							playSound("progress_loop")
							setSendingDisabled(false)
							setShoferAsk("mistake_limit_reached")
							setEnableButtons(true)
							setPrimaryButtonText(t("chat:proceedAnyways.title"))
							setSecondaryButtonText(t("chat:startNewTask.title"))
							break
						case "budget_limit":
							// Pause-mode budget prompt. Three outcomes:
							//   * Primary button → continue without further enforcement
							//     for the rest of this task (yesButtonClicked).
							//   * Secondary button → abort the task tree
							//     (noButtonClicked).
							//   * Text input → user-specified new dollar limit
							//     (messageResponse with parsable number).
							setSendingDisabled(false)
							setShoferAsk("budget_limit")
							setEnableButtons(true)
							setPrimaryButtonText("Continue without limit")
							setSecondaryButtonText("Abort task")
							break
						case "followup":
							setSendingDisabled(isPartial)
							setShoferAsk("followup")
							// setting enable buttons to `false` would trigger a focus grab when
							// the text area is enabled which is undesirable.
							// We have no buttons for this tool, so no problem having them "enabled"
							// to workaround this issue.  See #1358.
							setEnableButtons(true)
							setPrimaryButtonText(undefined)
							setSecondaryButtonText(undefined)
							break
						case "tool":
							setSendingDisabled(isPartial)
							setShoferAsk("tool")
							setEnableButtons(!isPartial)
							const tool = JSON.parse(lastMessage.text || "{}") as ShoferSayTool
							switch (tool.tool) {
								case "editedExistingFile":
								case "appliedDiff":
								case "newFileCreated":
									if (tool.batchDiffs && Array.isArray(tool.batchDiffs)) {
										setPrimaryButtonText(t("chat:edit-batch.approve.title"))
										setSecondaryButtonText(t("chat:edit-batch.deny.title"))
									} else {
										setPrimaryButtonText(t("chat:save.title"))
										setSecondaryButtonText(t("chat:reject.title"))
									}
									break
								case "generateImage":
									setPrimaryButtonText(t("chat:save.title"))
									setSecondaryButtonText(t("chat:reject.title"))
									break
								case "finishTask":
									setPrimaryButtonText(t("chat:completeSubtaskAndReturn"))
									setSecondaryButtonText(undefined)
									break
								case "readFile":
									if (tool.batchFiles && Array.isArray(tool.batchFiles)) {
										setPrimaryButtonText(t("chat:read-batch.approve.title"))
										setSecondaryButtonText(t("chat:read-batch.deny.title"))
									} else {
										setPrimaryButtonText(t("chat:approve.title"))
										setSecondaryButtonText(t("chat:reject.title"))
									}
									break
								case "listFilesTopLevel":
								case "listFilesRecursive":
									if (tool.batchDirs && Array.isArray(tool.batchDirs)) {
										setPrimaryButtonText(t("chat:list-batch.approve.title"))
										setSecondaryButtonText(t("chat:list-batch.deny.title"))
									} else {
										setPrimaryButtonText(t("chat:approve.title"))
										setSecondaryButtonText(t("chat:reject.title"))
									}
									break
								default:
									setPrimaryButtonText(t("chat:approve.title"))
									setSecondaryButtonText(t("chat:reject.title"))
									break
							}
							break
						case "command":
							setSendingDisabled(isPartial)
							setShoferAsk("command")
							setEnableButtons(!isPartial)
							setPrimaryButtonText(t("chat:runCommand.title"))
							setSecondaryButtonText(t("chat:reject.title"))
							break
						case "command_output":
							setSendingDisabled(false)
							setShoferAsk("command_output")
							setEnableButtons(true)
							setPrimaryButtonText(t("chat:proceedWhileRunning.title"))
							setSecondaryButtonText(t("chat:killCommand.title"))
							break
						case "use_mcp_server":
							setSendingDisabled(isPartial)
							setShoferAsk("use_mcp_server")
							setEnableButtons(!isPartial)
							setPrimaryButtonText(t("chat:approve.title"))
							setSecondaryButtonText(t("chat:reject.title"))
							break
						case "completion_result":
							// Extension waiting for feedback, but we can just present a new task button.
							// Only play celebration sound if there are no queued messages.
							if (!isPartial && messageQueue.length === 0) {
								playSound("celebration")
							}
							setSendingDisabled(isPartial)
							setShoferAsk("completion_result")
							setEnableButtons(!isPartial)
							setPrimaryButtonText(t("chat:startNewTask.title"))
							setSecondaryButtonText(undefined)
							break
						case "resume_task":
							setSendingDisabled(false)
							setShoferAsk("resume_task")
							setEnableButtons(true)
							// For completed subtasks, show "Start New Task" instead of "Resume"
							// A subtask is considered completed if:
							// - It has a parentTaskId AND
							// - Its messages contain a completion_result (either ask or say)
							const isCompletedSubtask =
								currentTaskItem?.parentTaskId &&
								messages.some(
									(msg) => msg.ask === "completion_result" || msg.say === "completion_result",
								)
							if (isCompletedSubtask) {
								setPrimaryButtonText(t("chat:startNewTask.title"))
								setSecondaryButtonText(undefined)
							} else {
								setPrimaryButtonText(t("chat:resumeTask.title"))
								setSecondaryButtonText(t("chat:terminate.title"))
							}
							setDidClickCancel(false) // special case where we reset the cancel button state
							break
						case "resume_completed_task":
							setSendingDisabled(false)
							setShoferAsk("resume_completed_task")
							setEnableButtons(true)
							setPrimaryButtonText(t("chat:startNewTask.title"))
							setSecondaryButtonText(undefined)
							setDidClickCancel(false)
							break
						default:
							// Unhandled "ask" type — button state already
							// cleared by the top-level reset above.
							break
					}
					break
				case "say":
					// Don't want to reset since there could be a "say" after
					// an "ask" while ask is waiting for response.
					switch (lastMessage.say) {
						case "api_req_retry_delayed":
						case "api_req_rate_limit_wait":
							setSendingDisabled(true)
							break
						case "api_req_started":
							// Clear button state when a new API request starts
							// This fixes buttons persisting when the task continues
							setSendingDisabled(true)
							// Note: Do NOT clear selectedImages here. This handler fires
							// every time the backend starts an API call, which would wipe
							// images the user has pasted while the chat is in progress.
							// Images are already cleared in the appropriate user-action
							// handlers (handleSendMessage, handlePrimaryButtonClick, etc.).
							setShoferAsk(undefined)
							setEnableButtons(false)
							setPrimaryButtonText(undefined)
							setSecondaryButtonText(undefined)
							break
						// "say" types that don't set button state — the
						// top-level clear (above) already reset the state
						// to neutral, so these are no-ops.
						case "api_req_finished":
						case "error":
						case "text":
						case "command_output":
						case "mcp_server_request_started":
						case "mcp_server_response":
						case "completion_result":
							break
						default:
							// Unhandled "say" type — button state already
							// cleared by the top-level reset above.
							break
					}
					break
			}
		}
	}, [lastMessage, secondLastMessage])

	// Update button text when messages change (e.g., completion_result is added) for subtasks in resume_task state
	useEffect(() => {
		if (shoferAsk === "resume_task" && currentTaskItem?.parentTaskId) {
			const hasCompletionResult = messages.some(
				(msg) => msg.ask === "completion_result" || msg.say === "completion_result",
			)
			if (hasCompletionResult) {
				setPrimaryButtonText(t("chat:startNewTask.title"))
				setSecondaryButtonText(undefined)
			}
		}
	}, [shoferAsk, currentTaskItem?.parentTaskId, messages, t])

	useEffect(() => {
		if (messages.length === 0) {
			setSendingDisabled(false)
			setShoferAsk(undefined)
			setEnableButtons(false)
			setPrimaryButtonText(undefined)
			setSecondaryButtonText(undefined)
		}
	}, [messages.length])

	// Reset UI states when task changes. Scroll lifecycle is handled by
	// useScrollLifecycle which has its own effect keyed on taskTs.
	useEffect(() => {
		setExpandedRows({})
		everVisibleMessagesTsRef.current.clear()
		setCurrentFollowUpTs(null)
		setIsCondensing(false)

		if (autoApproveTimeoutRef.current) {
			clearTimeout(autoApproveTimeoutRef.current)
			autoApproveTimeoutRef.current = null
		}
		userRespondedRef.current = false
	}, [task?.ts])

	const taskTs = task?.ts

	// Request aggregated costs when task changes and has childIds
	useEffect(() => {
		if (taskTs && currentTaskItem?.childIds && currentTaskItem.childIds.length > 0) {
			vscode.postMessage({
				type: "getTaskWithAggregatedCosts",
				text: currentTaskItem.id,
			})
		}
	}, [taskTs, currentTaskItem?.id, currentTaskItem?.childIds])

	useEffect(() => {
		if (isHidden) {
			everVisibleMessagesTsRef.current.clear()
		}
	}, [isHidden])

	useEffect(() => {
		const cache = everVisibleMessagesTsRef.current
		return () => {
			cache.clear()
		}
	}, [])

	const isStreaming = useMemo(() => {
		// Checking shoferAsk isn't enough since messages effect may be called
		// again for a tool for example, set shoferAsk to its value, and if the
		// next message is not an ask then it doesn't reset. This is likely due
		// to how much more often we're updating messages as compared to before,
		// and should be resolved with optimizations as it's likely a rendering
		// bug. But as a final guard for now, the cancel button will show if the
		// last message is not an ask.
		const isLastAsk = !!modifiedMessages.at(-1)?.ask

		const isToolCurrentlyAsking =
			isLastAsk && shoferAsk !== undefined && enableButtons && primaryButtonText !== undefined

		if (isToolCurrentlyAsking) {
			return false
		}

		const isLastMessagePartial = modifiedMessages.at(-1)?.partial === true

		if (isLastMessagePartial) {
			return true
		} else {
			const lastApiReqStarted = findLast(
				modifiedMessages,
				(message: ShoferMessage) => message.say === "api_req_started",
			)

			if (
				lastApiReqStarted &&
				lastApiReqStarted.text !== null &&
				lastApiReqStarted.text !== undefined &&
				lastApiReqStarted.say === "api_req_started"
			) {
				const cost = JSON.parse(lastApiReqStarted.text).cost

				if (cost === undefined) {
					return true // API request has not finished yet.
				}
			}
		}

		return false
	}, [modifiedMessages, shoferAsk, enableButtons, primaryButtonText])

	// Runtime execution state of the current task as published by TaskManager
	// (running | waiting_input | paused | idle). Available even when there is no
	// active ask and no streaming, e.g. while an auto-approved tool call (an MCP
	// server tool, a long shell command) is executing inside the task loop.
	const currentTaskRuntimeState = useMemo(() => {
		if (!currentTaskItem) return undefined
		return parallelTasks?.find((p) => p.id === currentTaskItem.id)?.state
	}, [currentTaskItem, parallelTasks])

	/**
	 * `canStop` is the broader notion of "the user should be able to abort
	 * the current task right now". Unlike `isStreaming` (true only while
	 * the assistant is mid-stream and no approval ask is pending), this
	 * stays true through transient approval/in-progress states such as a
	 * pending command approval, a CLI command currently executing, or an
	 * auto-approved MCP tool call in flight.
	 *
	 * UX requirement: Stop must be possible at all times while a task is
	 * active. Excluded states are those where the task is effectively
	 * finished or already paused awaiting user direction:
	 *   - completion_result / resume_completed_task: task is done
	 *   - resume_task: task is paused; resume/terminate are the actions
	 */
	const canStop = useMemo(() => {
		if (isStreaming) return true
		if (task === undefined) return false
		if (shoferAsk === "completion_result" || shoferAsk === "resume_task" || shoferAsk === "resume_completed_task") {
			return false
		}
		// Task loop is actively executing (e.g. running an auto-approved tool
		// such as an MCP server call, or processing a tool result between API
		// turns). In this state there is no pending ask and no API streaming,
		// but the user must still be able to interrupt the operation.
		if (currentTaskRuntimeState === "running") return true
		// Any other active ask (command, command_output, tool, use_mcp_server,
		// followup, api_req_failed, mistake_limit_reached, budget_limit) is
		// considered stoppable: the user may want to abort the task instead
		// of answering the prompt.
		return shoferAsk !== undefined
	}, [isStreaming, task, shoferAsk, currentTaskRuntimeState])

	const markFollowUpAsAnswered = useCallback(() => {
		const lastFollowUpMessage = messagesRef.current.findLast((msg: ShoferMessage) => msg.ask === "followup")
		if (lastFollowUpMessage) {
			setCurrentFollowUpTs(lastFollowUpMessage.ts)
		}
	}, [])

	const handleChatReset = useCallback(() => {
		// Clear any pending auto-approval timeout
		if (autoApproveTimeoutRef.current) {
			clearTimeout(autoApproveTimeoutRef.current)
			autoApproveTimeoutRef.current = null
		}
		// Reset user response flag for new message
		userRespondedRef.current = false

		// IMPORTANT: do NOT clear inputValue / selectedImages / droppedContextFiles here.
		//
		// handleChatReset runs in two distinct scenarios:
		//   1. "newChat" invoke (toolbar Pencil / createParallelTask): the active
		//      task is being moved to background and currentTaskItem.id is about to
		//      flip. The task-id-change effect below is the single source of truth
		//      for snapshotting the outgoing task's draft into `taskDraftsRef` and
		//      restoring the incoming task's draft. If we cleared input here, the
		//      effect would later see an empty inputValueRef and persist an empty
		//      draft for the outgoing task, destroying the user's typed text.
		//   2. handleSendMessage (after a send): the task id does NOT change, so
		//      the effect won't fire. handleSendMessage clears the input fields
		//      itself so the textarea is ready for the next message.
		//
		// Likewise, do NOT touch sendingDisabled here — the welcome screen needs
		// sending enabled, and handleSendMessage sets sendingDisabled itself when
		// it needs to lock until backend ack.
		setShoferAsk(undefined)
		setEnableButtons(false)
		// Do not reset mode here as it should persist.
		// setPrimaryButtonText(undefined)
		// setSecondaryButtonText(undefined)
	}, [])

	/**
	 * Remove a single file from the dropped-context list.
	 */
	const handleRemoveContextFile = useCallback((filePath: string) => {
		setDroppedContextFiles((prev) => prev.filter((f) => f.path !== filePath))
	}, [])

	/**
	 * Clear all dropped context files.
	 */
	const handleClearContextFiles = useCallback(() => {
		setDroppedContextFiles([])
	}, [])

	/**
	 * Compute @mentions string from the current dropped files.
	 * Mirrors the logic previously in ContextDropZoneProvider.getAndClearMentions().
	 */
	const getDroppedMentions = useCallback((): string => {
		if (droppedContextFiles.length === 0) {
			return ""
		}
		return droppedContextFiles
			.map((f) => {
				const escapedPath = escapeSpaces(f.path)
				return `@${escapedPath}`
			})
			.join(" ")
	}, [droppedContextFiles])

	/**
	 * Handle file drops on the webview root.
	 *
	 * Parses any of `text/uri-list`, `text/plain`, or
	 * `application/vnd.code.uri-list` (whichever is present) into
	 * workspace-relative context-file entries and appends them to
	 * `droppedContextFiles`.  Image drops are ignored here so that the
	 * textarea-level handler in ChatTextArea can pick them up.
	 *
	 * Note: VSCode Desktop's cross-origin webview overlay swallows drag
	 * events at the iframe root, so on Desktop this handler effectively
	 * never fires — drops there are handled by ChatTextArea.handleDrop,
	 * which uses the same parser via `onContextFilesDropped`.
	 */
	const handleWebviewDrop = useCallback(
		async (e: React.DragEvent) => {
			e.preventDefault()
			setIsDraggingFiles(false)

			const payload = extractUriPayload(e.dataTransfer)
			vscode.postMessage({
				type: "webviewLog",
				text: `[drop:root] fired payload=${payload ? `${payload.length}ch` : "none"} files=${e.dataTransfer.files.length} types=[${Array.from(e.dataTransfer.types).join(",")}]`,
			})
			if (!payload) return

			const cwd = (typeof window !== "undefined" && (window as any).CWD) || ""
			const newFiles = parseDroppedUris(payload, cwd, droppedContextFiles)
			vscode.postMessage({
				type: "webviewLog",
				text: `[drop:root] parsed ${newFiles.length} new file(s)`,
			})
			if (newFiles.length > 0) {
				setDroppedContextFiles((prev) => [...prev, ...newFiles])
			}
		},
		[droppedContextFiles],
	)

	/**
	 * Handle drag-over on the webview root.
	 *
	 * Always accepts the drop so that VSCode Explorer drags work on all
	 * platforms.  On VSCode Desktop the webview lives in a cross-origin
	 * iframe which hides `dataTransfer.types` during dragover, so we
	 * cannot gate on the MIME type here — the real filtering happens in
	 * handleWebviewDrop.
	 */
	const handleWebviewDragOver = useCallback((e: React.DragEvent) => {
		e.preventDefault()
		e.dataTransfer.dropEffect = "copy"
		setIsDraggingFiles(true)
	}, [])

	/**
	 * Handle drag-leave on the webview root.
	 */
	const handleWebviewDragLeave = useCallback((e: React.DragEvent) => {
		const rect = e.currentTarget.getBoundingClientRect()
		if (e.clientX <= rect.left || e.clientX >= rect.right || e.clientY <= rect.top || e.clientY >= rect.bottom) {
			setIsDraggingFiles(false)
		}
	}, [])

	/**
	 * Handles sending messages to the extension
	 * @param text - The message text to send
	 * @param images - Array of image data URLs to send with the message
	 */
	const handleSendMessage = useCallback(
		(text: string, images: string[]) => {
			text = text.trim()

			// Prepend dropped context file @mentions to the message text.
			const droppedMentions = getDroppedMentions()
			if (droppedMentions) {
				text = text ? `${droppedMentions} ${text}` : droppedMentions
			}

			if (text || images.length > 0) {
				// Intercept when the active provider is retired — show a
				// WarningRow instead of sending anything to the backend.
				if (apiConfiguration?.apiProvider && isRetiredProvider(apiConfiguration.apiProvider)) {
					setShowRetiredProviderWarning(true)
					return
				}

				// Queue message if:
				// - Task is busy (sendingDisabled)
				// - API request in progress (isStreaming)
				// - Queue has items (preserve message order during drain)
				// - Command is running (command_output) - user's message should be queued for AI, not sent to terminal
				if (
					sendingDisabled ||
					isStreaming ||
					messageQueue.length > 0 ||
					shoferAskRef.current === "command_output"
				) {
					try {
						console.log("queueMessage", text, images)
						vscode.postMessage({ type: "queueMessage", text, images })
						setInputValue("")
						setSelectedImages([])
						setDroppedContextFiles([])
					} catch (error) {
						console.error(
							`Failed to queue message: ${error instanceof Error ? error.message : String(error)}`,
						)
					}

					return
				}

				// Mark that user has responded - this prevents any pending auto-approvals.
				userRespondedRef.current = true

				if (messagesRef.current.length === 0) {
					// On the home screen the user may have chosen a target worktree
					// via WorktreeIndicator. Forward it so the new task spawns
					// scoped to that worktree's directory; clear after consuming.
					vscode.postMessage({
						type: "newTask",
						text,
						images,
						worktreeDir: pendingWorktreeDir ?? undefined,
					})
					if (pendingWorktreeDir) setPendingWorktreeDir(null)
				} else if (shoferAskRef.current) {
					if (shoferAskRef.current === "followup") {
						markFollowUpAsAnswered()
					}

					// Use shoferAskRef.current
					switch (
						shoferAskRef.current // Use shoferAskRef.current
					) {
						case "followup":
						case "tool":
						case "command": // User can provide feedback to a tool or command use.
						case "use_mcp_server":
						case "completion_result": // If this happens then the user has feedback for the completion result.
						case "resume_task":
						case "resume_completed_task":
						case "budget_limit":
						case "mistake_limit_reached":
							vscode.postMessage({
								type: "askResponse",
								askResponse: "messageResponse",
								text,
								images,
							})
							break
						// There is no other case that a textfield should be enabled.
					}
				} else {
					// This is a new message in an ongoing task.
					vscode.postMessage({ type: "askResponse", askResponse: "messageResponse", text, images })
				}

				// Lock further sends until the backend acks (state effects above
				// will re-enable based on the resulting shoferAsk / streaming state).
				setSendingDisabled(true)
				handleChatReset()
				// The task id does not change on a send, so the task-id-change
				// effect won't fire to clear these for us — do it explicitly.
				setInputValue("")
				setSelectedImages([])
				setDroppedContextFiles([])
			}
		},
		[
			handleChatReset,
			getDroppedMentions,
			markFollowUpAsAnswered,
			sendingDisabled,
			isStreaming,
			messageQueue.length,
			apiConfiguration?.apiProvider,
			pendingWorktreeDir,
			setPendingWorktreeDir,
		], // messagesRef and shoferAskRef are stable
	)

	const handleSetChatBoxMessage = useCallback(
		(text: string, images: string[]) => {
			// Avoid nested template literals by breaking down the logic
			let newValue = text

			if (inputValue !== "") {
				newValue = inputValue + " " + text
			}

			setInputValue(newValue)
			setSelectedImages([...selectedImages, ...images])
		},
		[inputValue, selectedImages],
	)

	const startNewTask = useCallback(() => {
		setShowRetiredProviderWarning(false)
		// Use createParallelTask to preserve the current task in the background
		// instead of clearTask which aborts the current task
		vscode.postMessage({ type: "createParallelTask" })
	}, [])

	// Handle stop button click from textarea
	const handleStopTask = useCallback(() => {
		vscode.postMessage({ type: "cancelTask" })
		setDidClickCancel(true)
	}, [setDidClickCancel])

	// Handle enqueue button click from textarea
	const handleEnqueueCurrentMessage = useCallback(() => {
		const text = inputValue.trim()
		if (text || selectedImages.length > 0) {
			vscode.postMessage({
				type: "queueMessage",
				text,
				images: selectedImages,
			})
			setInputValue("")
			setSelectedImages([])
		}
	}, [inputValue, selectedImages])

	// This logic depends on the useEffect[messages] above to set shoferAsk,
	// after which buttons are shown and we then send an askResponse to the
	// extension.
	const handlePrimaryButtonClick = useCallback(
		(text?: string, images?: string[]) => {
			// Mark that user has responded
			userRespondedRef.current = true

			const trimmedInput = text?.trim()

			switch (shoferAsk) {
				case "api_req_failed":
				case "command":
				case "tool":
				case "use_mcp_server":
				case "budget_limit":
				case "mistake_limit_reached":
					// Only send text/images if they exist
					if (trimmedInput || (images && images.length > 0)) {
						vscode.postMessage({
							type: "askResponse",
							askResponse: "yesButtonClicked",
							text: trimmedInput,
							images: images,
						})
						// Clear input state after sending
						setInputValue("")
						setSelectedImages([])
					} else {
						vscode.postMessage({ type: "askResponse", askResponse: "yesButtonClicked" })
					}
					break
				case "resume_task":
					// For completed subtasks (tasks with a parentTaskId and a completion_result),
					// start a new task instead of resuming since the subtask is done
					const isCompletedSubtaskForClick =
						currentTaskItem?.parentTaskId &&
						messagesRef.current.some(
							(msg) => msg.ask === "completion_result" || msg.say === "completion_result",
						)
					if (isCompletedSubtaskForClick) {
						startNewTask()
					} else {
						// Only send text/images if they exist
						if (trimmedInput || (images && images.length > 0)) {
							vscode.postMessage({
								type: "askResponse",
								askResponse: "yesButtonClicked",
								text: trimmedInput,
								images: images,
							})
							// Clear input state after sending
							setInputValue("")
							setSelectedImages([])
						} else {
							vscode.postMessage({ type: "askResponse", askResponse: "yesButtonClicked" })
						}
					}
					break
				case "completion_result":
				case "resume_completed_task":
					// Waiting for feedback, but we can just present a new task button
					startNewTask()
					break
				case "command_output":
					vscode.postMessage({ type: "terminalOperation", terminalOperation: "continue" })
					break
			}

			setSendingDisabled(true)
			setShoferAsk(undefined)
			setEnableButtons(false)
			setPrimaryButtonText(undefined)
			setSecondaryButtonText(undefined)
		},
		[shoferAsk, startNewTask, currentTaskItem?.parentTaskId],
	)

	const handleSecondaryButtonClick = useCallback(
		(text?: string, images?: string[]) => {
			// Mark that user has responded
			userRespondedRef.current = true

			const trimmedInput = text?.trim()

			if (isStreaming) {
				vscode.postMessage({ type: "cancelTask" })
				setDidClickCancel(true)
				return
			}

			switch (shoferAsk) {
				case "api_req_failed":
				case "mistake_limit_reached":
				case "resume_task":
					startNewTask()
					break
				case "budget_limit":
					// "Abort task" — defer to the Task's askUserForBudgetDecision
					// handler so the abort flows through root.abortTask(false).
					vscode.postMessage({ type: "askResponse", askResponse: "noButtonClicked" })
					break
				case "command":
				case "tool":
				case "use_mcp_server":
					// Only send text/images if they exist
					if (trimmedInput || (images && images.length > 0)) {
						vscode.postMessage({
							type: "askResponse",
							askResponse: "noButtonClicked",
							text: trimmedInput,
							images: images,
						})
						// Clear input state after sending
						setInputValue("")
						setSelectedImages([])
					} else {
						// Responds to the API with a "This operation failed" and lets it try again
						vscode.postMessage({ type: "askResponse", askResponse: "noButtonClicked" })
					}
					break
				case "command_output":
					vscode.postMessage({ type: "terminalOperation", terminalOperation: "abort" })
					break
			}
			setSendingDisabled(true)
			setShoferAsk(undefined)
			setEnableButtons(false)
		},
		[shoferAsk, startNewTask, isStreaming, setDidClickCancel],
	)

	const { info: model } = useSelectedModel(apiConfiguration)

	const selectImages = useCallback(() => vscode.postMessage({ type: "selectImages" }), [])

	const shouldDisableImages = !model?.supportsImages || selectedImages.length >= MAX_IMAGES_PER_MESSAGE

	const handleMessage = useCallback(
		(e: MessageEvent) => {
			const message: ExtensionMessage = e.data

			switch (message.type) {
				case "action":
					switch (message.action!) {
						case "didBecomeVisible":
							if (!isHidden && !sendingDisabled && !enableButtons) {
								textAreaRef.current?.focus()
							}
							break
						case "focusInput":
							textAreaRef.current?.focus()
							break
					}
					break
				case "selectedImages":
					// Only handle selectedImages if it's not for editing context
					// When context is "edit", ChatRow will handle the images
					if (message.context !== "edit") {
						setSelectedImages((prevImages: string[]) =>
							appendImages(prevImages, message.images, MAX_IMAGES_PER_MESSAGE),
						)
					}
					break
				case "invoke":
					switch (message.invoke!) {
						case "newChat":
							handleChatReset()
							break
						case "sendMessage":
							handleSendMessage(message.text ?? "", message.images ?? [])
							break
						case "setChatBoxMessage":
							handleSetChatBoxMessage(message.text ?? "", message.images ?? [])
							break
						case "primaryButtonClick":
							handlePrimaryButtonClick(message.text ?? "", message.images ?? [])
							break
						case "secondaryButtonClick":
							handleSecondaryButtonClick(message.text ?? "", message.images ?? [])
							break
					}
					break
				case "condenseTaskContextStarted":
					// Handle both manual and automatic condensation start
					// We don't check the task ID because:
					// 1. There can only be one active task at a time
					// 2. Task switching resets isCondensing to false (see useEffect with task?.ts dependency)
					// 3. For new tasks, currentTaskItem may not be populated yet due to async state updates
					if (message.text) {
						setIsCondensing(true)
						// Note: sendingDisabled is only set for manual condensation via handleCondenseContext
						// Automatic condensation doesn't disable sending since the task is already running
					}
					break
				case "condenseTaskContextResponse":
					// Same reasoning as above - we trust this is for the current task
					if (message.text) {
						if (isCondensing && sendingDisabled) {
							setSendingDisabled(false)
						}
						setIsCondensing(false)
					}
					break
				case "checkpointInitWarning":
					setCheckpointWarning(message.checkpointWarning)
					break
				case "interactionRequired":
					playSound("notification")
					break
				case "taskWithAggregatedCosts":
					if (message.text && message.aggregatedCosts) {
						setAggregatedCostsMap((prev) => {
							const newMap = new Map(prev)
							newMap.set(message.text!, message.aggregatedCosts!)
							return newMap
						})
					}
					break
				case "addContextFiles":
					// Files dropped onto the native ContextDropZone TreeView in
					// the Shofer sidebar.  Merge into the existing tag list,
					// deduping by path so dragging the same file twice is a no-op.
					if (message.contextFiles && message.contextFiles.length > 0) {
						setDroppedContextFiles((prev) => {
							const seen = new Set(prev.map((f) => f.path))
							const merged = [...prev]
							for (const f of message.contextFiles!) {
								if (!seen.has(f.path)) {
									seen.add(f.path)
									merged.push(f)
								}
							}
							return merged
						})
					}
					break
			}
			// textAreaRef.current is not explicitly required here since React
			// guarantees that ref will be stable across re-renders, and we're
			// not using its value but its reference.
		},
		[
			isCondensing,
			isHidden,
			sendingDisabled,
			enableButtons,
			handleChatReset,
			handleSendMessage,
			handleSetChatBoxMessage,
			handlePrimaryButtonClick,
			handleSecondaryButtonClick,
			setCheckpointWarning,
			playSound,
		],
	)

	useEvent("message", handleMessage)

	const visibleMessages = useMemo(() => {
		// Pre-compute checkpoint hashes that have associated user messages for O(1) lookup
		const userMessageCheckpointHashes = new Set<string>()
		modifiedMessages.forEach((msg) => {
			if (
				msg.say === "user_feedback" &&
				msg.checkpoint &&
				msg.checkpoint["type"] === "user_message" &&
				msg.checkpoint["hash"]
			) {
				userMessageCheckpointHashes.add(msg.checkpoint["hash"] as string)
			}
		})

		// Remove the 500-message limit to prevent array index shifting
		// Virtuoso is designed to efficiently handle large lists through virtualization
		const newVisibleMessages = modifiedMessages.filter((message) => {
			// Filter out checkpoint_saved messages that should be suppressed
			if (message.say === "checkpoint_saved") {
				// Check if this checkpoint has the suppressMessage flag set
				if (
					message.checkpoint &&
					typeof message.checkpoint === "object" &&
					"suppressMessage" in message.checkpoint &&
					message.checkpoint.suppressMessage
				) {
					return false
				}
				// Also filter out checkpoint messages associated with user messages (legacy behavior)
				if (message.text && userMessageCheckpointHashes.has(message.text)) {
					return false
				}
			}

			if (everVisibleMessagesTsRef.current.has(message.ts)) {
				const alwaysHiddenOnceProcessedAsk: ShoferAsk[] = [
					"api_req_failed",
					"resume_task",
					"resume_completed_task",
				]
				const alwaysHiddenOnceProcessedSay = [
					"api_req_finished",
					"api_req_retried",
					"api_req_deleted",
					"mcp_server_request_started",
				]
				if (message.ask && alwaysHiddenOnceProcessedAsk.includes(message.ask)) return false
				if (message.say && alwaysHiddenOnceProcessedSay.includes(message.say)) return false
				if (message.say === "text" && (message.text ?? "") === "" && (message.images?.length ?? 0) === 0) {
					return false
				}
				return true
			}

			switch (message.ask) {
				case "completion_result":
					if (message.text === "") return false
					break
				case "api_req_failed":
				case "resume_task":
				case "resume_completed_task":
					return false
			}
			switch (message.say) {
				case "api_req_finished":
				case "api_req_retried":
				case "api_req_deleted":
					return false
				case "api_req_retry_delayed":
				case "api_req_rate_limit_wait":
					const last1 = modifiedMessages.at(-1)
					const last2 = modifiedMessages.at(-2)
					if (last1?.ask === "resume_task" && last2 === message) {
						return true
					} else if (message !== last1) {
						return false
					}
					break
				case "text":
					if ((message.text ?? "") === "" && (message.images?.length ?? 0) === 0) return false
					break
				case "mcp_server_request_started":
					return false
			}
			return true
		})

		const viewportStart = Math.max(0, newVisibleMessages.length - 100)
		newVisibleMessages
			.slice(viewportStart)
			.forEach((msg: ShoferMessage) => everVisibleMessagesTsRef.current.set(msg.ts, true))

		return newVisibleMessages
	}, [modifiedMessages])

	useEffect(() => {
		const cleanupInterval = setInterval(() => {
			const cache = everVisibleMessagesTsRef.current
			const currentMessageIds = new Set(modifiedMessages.map((m: ShoferMessage) => m.ts))
			const viewportMessages = visibleMessages.slice(Math.max(0, visibleMessages.length - 100))
			const viewportMessageIds = new Set(viewportMessages.map((m: ShoferMessage) => m.ts))

			cache.forEach((_value: boolean, key: number) => {
				if (!currentMessageIds.has(key) && !viewportMessageIds.has(key)) {
					cache.delete(key)
				}
			})
		}, 60000)

		return () => clearInterval(cleanupInterval)
	}, [modifiedMessages, visibleMessages])

	useDebounceEffect(
		() => {
			if (!isHidden && !sendingDisabled && !enableButtons) {
				textAreaRef.current?.focus()
			}
		},
		50,
		[isHidden, sendingDisabled, enableButtons],
	)

	useEffect(() => {
		// This ensures the first message is not read, future user messages are
		// labeled as `user_feedback`.
		if (lastMessage && messages.length > 1) {
			if (
				typeof lastMessage.text === "string" && // has text (must be string for startsWith)
				(lastMessage.say === "text" || lastMessage.say === "completion_result") && // is a text message
				!lastMessage.partial && // not a partial message
				!lastMessage.text.startsWith("{") // not a json object
			) {
				let text = lastMessage?.text || ""
				const mermaidRegex = /```mermaid[\s\S]*?```/g
				// remove mermaid diagrams from text
				text = text.replace(mermaidRegex, "")
				// remove markdown from text
				text = removeMd(text)

				// ensure message is not a duplicate of last read message
				if (text !== lastTtsRef.current) {
					try {
						playTts(text)
						lastTtsRef.current = text
					} catch (error) {
						console.error("Failed to execute text-to-speech:", error)
					}
				}
			}
		}

		// Update previous value.
		setWasStreaming(isStreaming)
	}, [isStreaming, lastMessage, wasStreaming, messages.length])

	const groupedMessages = useMemo(() => {
		const filtered: ShoferMessage[] = visibleMessages

		// Helper to check if a message is a read_file ask that should be batched
		const isReadFileAsk = (msg: ShoferMessage): boolean => {
			if (msg.type !== "ask" || msg.ask !== "tool") return false
			try {
				const tool = JSON.parse(msg.text || "{}")
				return tool.tool === "readFile" && !tool.batchFiles // Don't re-batch already batched
			} catch {
				return false
			}
		}

		// Helper to check if a message is a list_files ask that should be batched
		const isListFilesAsk = (msg: ShoferMessage): boolean => {
			if (msg.type !== "ask" || msg.ask !== "tool") return false
			try {
				const tool = JSON.parse(msg.text || "{}")
				return (
					(tool.tool === "listFilesTopLevel" || tool.tool === "listFilesRecursive") && !tool.batchDirs // Don't re-batch already batched
				)
			} catch {
				return false
			}
		}

		// Set of tool names that represent file-editing operations
		const editFileTools = new Set([
			"editedExistingFile",
			"appliedDiff",
			"newFileCreated",
			"insertContent",
			"searchAndReplace",
		])

		// Helper to check if a message is a file-edit ask that should be batched
		const isEditFileAsk = (msg: ShoferMessage): boolean => {
			if (msg.type !== "ask" || msg.ask !== "tool") return false
			try {
				const tool = JSON.parse(msg.text || "{}")
				return editFileTools.has(tool.tool) && !tool.batchDiffs // Don't re-batch already batched
			} catch {
				return false
			}
		}

		// Synthesize a batch of consecutive read_file asks into a single message
		const synthesizeReadFileBatch = (batch: ShoferMessage[]): ShoferMessage => {
			const batchFiles = batch.map((batchMsg) => {
				try {
					const tool = JSON.parse(batchMsg.text || "{}")
					return {
						path: tool.path || "",
						lineSnippet: tool.reason || "",
						isOutsideWorkspace: tool.isOutsideWorkspace || false,
						key: `${tool.path}${tool.reason ? ` (${tool.reason})` : ""}`,
						content: tool.content || "",
					}
				} catch {
					return { path: "", lineSnippet: "", key: "", content: "" }
				}
			})

			let firstTool
			try {
				firstTool = JSON.parse(batch[0].text || "{}")
			} catch {
				return batch[0]
			}
			return {
				...batch[0],
				text: JSON.stringify({ ...firstTool, batchFiles }),
			}
		}

		// Synthesize a batch of consecutive list_files asks into a single message
		const synthesizeListFilesBatch = (batch: ShoferMessage[]): ShoferMessage => {
			const batchDirs = batch.map((batchMsg) => {
				try {
					const tool = JSON.parse(batchMsg.text || "{}")
					return {
						path: tool.path || "",
						recursive: tool.tool === "listFilesRecursive",
						isOutsideWorkspace: tool.isOutsideWorkspace || false,
						key: tool.path || "",
					}
				} catch {
					return { path: "", recursive: false, key: "" }
				}
			})

			let firstTool
			try {
				firstTool = JSON.parse(batch[0].text || "{}")
			} catch {
				return batch[0]
			}
			return {
				...batch[0],
				text: JSON.stringify({ ...firstTool, batchDirs }),
			}
		}

		// Synthesize a batch of consecutive file-edit asks into a single message
		const synthesizeEditFileBatch = (batch: ShoferMessage[]): ShoferMessage => {
			const batchDiffs = batch.map((batchMsg) => {
				try {
					const tool = JSON.parse(batchMsg.text || "{}")
					return {
						path: tool.path || "",
						changeCount: 1,
						key: tool.path || "",
						content: tool.content || tool.diff || "",
						diffStats: tool.diffStats,
					}
				} catch {
					return { path: "", changeCount: 0, key: "", content: "" }
				}
			})

			let firstTool
			try {
				firstTool = JSON.parse(batch[0].text || "{}")
			} catch {
				return batch[0]
			}
			return {
				...batch[0],
				text: JSON.stringify({ ...firstTool, batchDiffs }),
			}
		}

		// Consolidate consecutive ask messages into batches
		const readFileBatched = batchConsecutive(filtered, isReadFileAsk, synthesizeReadFileBatch)
		const listFilesBatched = batchConsecutive(readFileBatched, isListFilesAsk, synthesizeListFilesBatch)
		const result = batchConsecutive(listFilesBatched, isEditFileAsk, synthesizeEditFileBatch)

		if (isCondensing) {
			result.push({
				type: "say",
				say: "condense_context",
				ts: Date.now(),
				partial: true,
			} as ShoferMessage)
		}
		return result
	}, [isCondensing, visibleMessages])

	// Scroll lifecycle is managed by a dedicated hook to keep ChatView focused
	// on message handling and UI orchestration.
	const {
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
	} = useScrollLifecycle({
		virtuosoRef,
		scrollContainerRef,
		taskTs: task?.ts,
		isStreaming,
		isHidden,
		hasTask: !!task,
	})

	// Expanding a row indicates the user is browsing; disable sticky follow.
	// Placed after the hook call so enterUserBrowsingHistory is defined.
	useEffect(() => {
		const prev = prevExpandedRowsRef.current
		let wasAnyRowExpandedByUser = false
		if (prev) {
			for (const [tsKey, isExpanded] of Object.entries(expandedRows)) {
				const ts = Number(tsKey)
				if (isExpanded && !(prev[ts] ?? false)) {
					wasAnyRowExpandedByUser = true
					break
				}
			}
		}

		if (wasAnyRowExpandedByUser) {
			enterUserBrowsingHistory("row-expansion")
		}

		prevExpandedRowsRef.current = expandedRows
	}, [enterUserBrowsingHistory, expandedRows])

	const handleSetExpandedRow = useCallback(
		(ts: number, expand?: boolean) => {
			setExpandedRows((prev: Record<number, boolean>) => ({
				...prev,
				[ts]: expand === undefined ? !prev[ts] : expand,
			}))
		},
		[setExpandedRows], // setExpandedRows is stable
	)

	// Scroll when user toggles certain rows.
	const toggleRowExpansion = useCallback(
		(ts: number) => {
			handleSetExpandedRow(ts)
			// The logic to set disableAutoScrollRef.current = true on expansion
			// is now handled by the useEffect hook that observes expandedRows.
		},
		[handleSetExpandedRow],
	)

	// Effect to clear checkpoint warning when messages appear or task changes
	useEffect(() => {
		if (isHidden || !task) {
			setCheckpointWarning(undefined)
		}
	}, [modifiedMessages.length, isStreaming, isHidden, task])

	const placeholderText = task ? t("chat:typeMessage") : t("chat:typeTask")

	const switchToMode = useCallback(
		(modeSlug: string): void => {
			// Update local state and notify extension to sync mode change.
			setMode(modeSlug)

			// Send the mode switch message.
			vscode.postMessage({ type: "mode", text: modeSlug })
		},
		[setMode],
	)

	const handleSuggestionClickInRow = useCallback(
		(suggestion: SuggestionItem, event?: React.MouseEvent) => {
			// Mark that user has responded if this is a manual click (not auto-approval)
			if (event) {
				userRespondedRef.current = true
			}

			// Mark the current follow-up question as answered when a suggestion is clicked
			if (shoferAsk === "followup" && !event?.shiftKey) {
				markFollowUpAsAnswered()
			}

			// Check if we need to switch modes
			if (suggestion.mode) {
				// Only switch modes if it's a manual click (event exists) or auto-approval is allowed
				const isManualClick = !!event
				if (isManualClick || alwaysAllowModeSwitch) {
					// Switch mode without waiting
					switchToMode(suggestion.mode)
				}
			}

			if (event?.shiftKey) {
				// Always append to existing text, don't overwrite
				setInputValue((currentValue: string) => {
					return currentValue !== "" ? `${currentValue} \n${suggestion.answer}` : suggestion.answer
				})
			} else {
				// Don't clear the input value when sending a follow-up choice
				// The message should be sent but the text area should preserve what the user typed
				const preservedInput = inputValueRef.current
				handleSendMessage(suggestion.answer, [])
				// Restore the input value after sending
				setInputValue(preservedInput)
			}
		},
		[handleSendMessage, setInputValue, switchToMode, alwaysAllowModeSwitch, shoferAsk, markFollowUpAsAnswered],
	)

	const handleBatchFileResponse = useCallback((response: { [key: string]: boolean }) => {
		// Handle batch file response, e.g., for file uploads
		vscode.postMessage({ type: "askResponse", askResponse: "objectResponse", text: JSON.stringify(response) })
	}, [])

	// Cancel backend auto-approval timeout when FollowUpSuggest's countdown effect cleans up.
	// This is called when auto-approve is toggled off, a suggestion is clicked, or the component unmounts.
	const handleFollowUpUnmount = useCallback(() => {
		vscode.postMessage({ type: "cancelAutoApproval" })
	}, [])

	const itemContent = useCallback(
		(index: number, messageOrGroup: ShoferMessage) => {
			const hasCheckpoint = modifiedMessages.some((message) => message.say === "checkpoint_saved")

			// regular message
			return (
				<ChatRow
					key={messageOrGroup.ts}
					message={messageOrGroup}
					isExpanded={expandedRows[messageOrGroup.ts] || false}
					onToggleExpand={toggleRowExpansion} // This was already stabilized
					lastModifiedMessage={modifiedMessages.at(-1)} // Original direct access
					isLast={index === groupedMessages.length - 1} // Original direct access
					onHeightChange={handleRowHeightChange}
					isStreaming={isStreaming}
					onSuggestionClick={handleSuggestionClickInRow} // This was already stabilized
					onBatchFileResponse={handleBatchFileResponse}
					onFollowUpUnmount={handleFollowUpUnmount}
					isFollowUpAnswered={messageOrGroup.isAnswered === true || messageOrGroup.ts === currentFollowUpTs}
					isFollowUpAutoApprovalPaused={isFollowUpAutoApprovalPaused}
					isSearchHighlighted={searchHighlightTs === messageOrGroup.ts}
					editable={
						messageOrGroup.type === "ask" &&
						messageOrGroup.ask === "tool" &&
						(() => {
							let tool: any = {}
							try {
								tool = JSON.parse(messageOrGroup.text || "{}")
							} catch (_) {
								if (messageOrGroup.text?.includes("updateTodoList")) {
									tool = { tool: "updateTodoList" }
								}
							}
							return tool.tool === "updateTodoList" && enableButtons && !!primaryButtonText
						})()
					}
					hasCheckpoint={hasCheckpoint}
				/>
			)
		},
		[
			expandedRows,
			toggleRowExpansion,
			modifiedMessages,
			groupedMessages.length,
			handleRowHeightChange,
			isStreaming,
			handleSuggestionClickInRow,
			handleBatchFileResponse,
			handleFollowUpUnmount,
			currentFollowUpTs,
			isFollowUpAutoApprovalPaused,
			enableButtons,
			primaryButtonText,
			searchHighlightTs,
		],
	)

	// Function to handle mode switching
	const switchToNextMode = useCallback(() => {
		const allModes = getAllModes(customModes)
		const currentModeIndex = allModes.findIndex((m) => m.slug === mode)
		const nextModeIndex = (currentModeIndex + 1) % allModes.length
		// Update local state and notify extension to sync mode change
		switchToMode(allModes[nextModeIndex].slug)
	}, [mode, customModes, switchToMode])

	// Function to handle switching to previous mode
	const switchToPreviousMode = useCallback(() => {
		const allModes = getAllModes(customModes)
		const currentModeIndex = allModes.findIndex((m) => m.slug === mode)
		const previousModeIndex = (currentModeIndex - 1 + allModes.length) % allModes.length
		// Update local state and notify extension to sync mode change
		switchToMode(allModes[previousModeIndex].slug)
	}, [mode, customModes, switchToMode])

	// Mode switching keyboard handler. Scroll-intent keyboard detection
	// (PageUp, Home, ArrowUp) is handled by useScrollLifecycle.
	const handleKeyDown = useCallback(
		(event: KeyboardEvent) => {
			if ((event.metaKey || event.ctrlKey) && event.key === ".") {
				event.preventDefault()
				if (event.shiftKey) {
					switchToPreviousMode()
				} else {
					switchToNextMode()
				}
			} else if (
				(event.metaKey || event.ctrlKey) &&
				!event.shiftKey &&
				!event.altKey &&
				event.key.toLowerCase() === "f"
			) {
				// Ctrl/Cmd+F opens the in-session search overlay. Only intercept
				// while a task is loaded (otherwise let the platform default win).
				// Modifier combos like Ctrl+Shift+F (workspace search) and
				// Ctrl+Alt+F must fall through to VS Code so they keep working
				// when the Shofer webview happens to hold focus.
				if (!task) return
				// CRITICAL: VS Code's webview iframe wrapper installs its own
				// bubble-phase keydown listener (`handleInnerKeydown` in
				// `pre/index.html`) that posts a `did-keydown` message to the
				// host for every keystroke, including Ctrl+F. The host then
				// re-dispatches the keystroke into the workbench keybinding
				// service, which opens the editor's find widget *in addition*
				// to our overlay. We run in capture phase and call
				// stopImmediatePropagation so the wrapper's listener never
				// runs and the keystroke is not forwarded to the host.
				event.preventDefault()
				event.stopImmediatePropagation()
				setIsSessionSearchOpen(true)
			} else if (event.key === "Escape" && isSessionSearchOpen) {
				// Close from anywhere; the overlay also closes via its own input handler.
				event.preventDefault()
				setIsSessionSearchOpen(false)
			}
		},
		[switchToNextMode, switchToPreviousMode, task, isSessionSearchOpen],
	)

	useEffect(() => {
		// Capture phase so we run BEFORE the VS Code webview iframe
		// wrapper's own keydown listener, allowing stopImmediatePropagation
		// to suppress the wrapper's `did-keydown` forwarding for shortcuts
		// we claim (e.g. Ctrl+F).
		window.addEventListener("keydown", handleKeyDown, true)

		return () => {
			window.removeEventListener("keydown", handleKeyDown, true)
		}
	}, [handleKeyDown])

	useImperativeHandle(ref, () => ({
		acceptInput: () => {
			const hasInput = inputValue.trim() || selectedImages.length > 0

			// Special case: during command_output, queue the message instead of
			// triggering the primary button action (which would lose the message)
			if (shoferAskRef.current === "command_output" && hasInput) {
				vscode.postMessage({ type: "queueMessage", text: inputValue.trim(), images: selectedImages })
				setInputValue("")
				setSelectedImages([])
				return
			}

			if (enableButtons && primaryButtonText) {
				handlePrimaryButtonClick(inputValue, selectedImages)
			} else if (!sendingDisabled && !isProfileDisabled && hasInput) {
				handleSendMessage(inputValue, selectedImages)
			}
		},
	}))

	const handleCondenseContext = (taskId: string) => {
		if (isCondensing || sendingDisabled) {
			return
		}
		setIsCondensing(true)
		setSendingDisabled(true)
		vscode.postMessage({ type: "condenseTaskContextRequest", text: taskId })
	}

	const areButtonsVisible = showScrollToBottom || primaryButtonText || secondaryButtonText

	return (
		<div
			data-testid="chat-view"
			className={isHidden ? "hidden" : "fixed top-0 left-0 right-0 bottom-0 flex flex-col overflow-hidden"}
			onDragOver={handleWebviewDragOver}
			onDragLeave={handleWebviewDragLeave}
			onDrop={handleWebviewDrop}>
			{/* Drag overlay — shown when files are being dragged over the webview */}
			{isDraggingFiles && (
				<div
					className="absolute inset-0 z-50 flex items-center justify-center pointer-events-none"
					style={{
						backgroundColor: "color-mix(in srgb, var(--vscode-focusBorder) 10%, transparent)",
						border: "2px dashed var(--vscode-focusBorder)",
						margin: "8px",
						borderRadius: "8px",
					}}>
					<div
						className="px-6 py-4 rounded-lg text-center"
						style={{
							backgroundColor: "var(--vscode-editor-background)",
							border: "1px solid var(--vscode-focusBorder)",
							boxShadow: "0 4px 16px rgba(0,0,0,0.3)",
						}}>
						<span
							className="codicon codicon-cloud-download text-2xl block mb-2"
							style={{ color: "var(--vscode-focusBorder)" }}
						/>
						<p className="text-sm font-medium m-0" style={{ color: "var(--vscode-foreground)" }}>
							Drop files to add to context
						</p>
					</div>
				</div>
			)}
			{(showAnnouncement || showAnnouncementModal) && (
				<Announcement
					hideAnnouncement={() => {
						if (showAnnouncementModal) {
							setShowAnnouncementModal(false)
						}
						if (showAnnouncement) {
							hideAnnouncement()
						}
					}}
				/>
			)}
			{task ? (
				<>
					<TaskHeader
						task={task}
						tokensIn={apiMetrics.totalTokensIn}
						tokensOut={apiMetrics.totalTokensOut}
						cacheWrites={apiMetrics.totalCacheWrites}
						cacheReads={apiMetrics.totalCacheReads}
						totalCost={apiMetrics.totalCost}
						aggregatedCost={
							currentTaskItem?.id && aggregatedCostsMap.has(currentTaskItem.id)
								? aggregatedCostsMap.get(currentTaskItem.id)!.totalCost
								: undefined
						}
						hasSubtasks={
							!!(
								currentTaskItem?.id &&
								aggregatedCostsMap.has(currentTaskItem.id) &&
								aggregatedCostsMap.get(currentTaskItem.id)!.childrenCost > 0
							)
						}
						costLimit={currentTaskItem?.costLimit}
						onUpdateCostLimit={(newLimit) => {
							if (currentTaskItem?.id) {
								vscode.postMessage({
									type: "updateCostLimit",
									taskId: currentTaskItem.id,
									costLimit: newLimit,
								})
							}
						}}
						parentTaskId={currentTaskItem?.parentTaskId}
						costBreakdown={
							currentTaskItem?.id && aggregatedCostsMap.has(currentTaskItem.id)
								? getCostBreakdownIfNeeded(aggregatedCostsMap.get(currentTaskItem.id)!, {
										own: t("common:costs.own"),
										subtasks: t("common:costs.subtasks"),
									})
								: undefined
						}
						contextTokens={apiMetrics.contextTokens}
						buttonsDisabled={sendingDisabled}
						handleCondenseContext={handleCondenseContext}
						todos={latestTodos}
					/>

					{checkpointWarning && (
						<div className="px-3">
							<CheckpointWarning warning={checkpointWarning} />
						</div>
					)}
				</>
			) : (
				<>
					<div className="flex flex-col h-full justify-center p-6 min-h-0 overflow-y-auto gap-4 relative">
						<div className="flex flex-col items-start gap-2 justify-center h-full min-[400px]:px-6">
							<VersionIndicator
								onClick={() => setShowAnnouncementModal(true)}
								className="absolute top-2 right-3 z-10"
							/>
							<div className="flex flex-col gap-4 w-full">
								<ShoferHero />
								{/* Show ShoferTips when authenticated or when user is new */}
								{taskHistory.length < 6 && <ShoferTips />}
								{/* Everyone should see their task history if any */}
								{taskHistory.length > 0 && <HistoryPreview />}
							</div>
						</div>
					</div>
					<TaskSelector
						taskHistory={taskHistory || []}
						parallelTasks={parallelTasks || []}
						currentTaskId={currentTaskItem?.id}
					/>
				</>
			)}

			{task && (
				<>
					<div className="grow flex relative" ref={scrollContainerRef}>
						<Virtuoso
							ref={virtuosoRef}
							key={task.ts}
							className="scrollable grow overflow-y-scroll mb-1"
							increaseViewportBy={{ top: 3_000, bottom: 1000 }}
							data={groupedMessages}
							{...(initialScrollIndex !== undefined &&
							initialScrollIndex > 0 &&
							initialScrollIndex < groupedMessages.length
								? { initialTopMostItemIndex: initialScrollIndex }
								: {})}
							itemContent={itemContent}
							followOutput={followOutputCallback}
							atBottomStateChange={atBottomStateChangeCallback}
							rangeChanged={rangeChangedCallback}
							atBottomThreshold={10}
						/>
						<SessionSearch
							messages={messages}
							isOpen={isSessionSearchOpen}
							onClose={() => setIsSessionSearchOpen(false)}
							onNavigate={(ts) => {
								setSearchHighlightTs(ts)
								if (ts === null) return
								const index = groupedMessages.findIndex((msg) => msg.ts === ts)
								if (index >= 0 && virtuosoRef.current) {
									virtuosoRef.current.scrollToIndex({ index, align: "center" })
								}
							}}
						/>
						{!isSessionSearchOpen && (
							<StandardTooltip content="Find in session (Ctrl+F)">
								<button
									type="button"
									onClick={() => setIsSessionSearchOpen(true)}
									aria-label="Find in session"
									className="absolute top-2 right-3 z-20 flex items-center justify-center w-7 h-7 rounded-md border border-vscode-panel-border bg-vscode-editor-background/80 hover:bg-vscode-toolbar-hoverBackground text-vscode-foreground shadow-sm">
									<span className="codicon codicon-search text-xs" />
								</button>
							</StandardTooltip>
						)}
					</div>
					<FileChangesPanel taskId={currentTaskItem?.id} />
					{areButtonsVisible && (
						<div
							className={`flex h-9 items-center mb-1 px-[15px] ${
								showScrollToBottom ? "opacity-100" : enableButtons ? "opacity-100" : "opacity-50"
							}`}>
							{showScrollToBottom ? (
								<StandardTooltip content={t("chat:scrollToBottom")}>
									<Button
										variant="secondary"
										className="flex-[2]"
										onClick={handleScrollToBottomClick}>
										<span className="codicon codicon-chevron-down"></span>
									</Button>
								</StandardTooltip>
							) : (
								<>
									{primaryButtonText && (
										<StandardTooltip
											content={
												primaryButtonText === t("chat:retry.title")
													? t("chat:retry.tooltip")
													: primaryButtonText === t("chat:save.title")
														? t("chat:save.tooltip")
														: primaryButtonText === t("chat:approve.title")
															? t("chat:approve.tooltip")
															: primaryButtonText === t("chat:runCommand.title")
																? t("chat:runCommand.tooltip")
																: primaryButtonText === t("chat:startNewTask.title")
																	? t("chat:startNewTask.tooltip")
																	: primaryButtonText === t("chat:resumeTask.title")
																		? t("chat:resumeTask.tooltip")
																		: primaryButtonText ===
																			  t("chat:proceedAnyways.title")
																			? t("chat:proceedAnyways.tooltip")
																			: primaryButtonText ===
																				  t("chat:proceedWhileRunning.title")
																				? t("chat:proceedWhileRunning.tooltip")
																				: undefined
											}>
											<Button
												variant="primary"
												disabled={!enableButtons}
												className={secondaryButtonText ? "flex-1 mr-[6px]" : "flex-[2] mr-0"}
												onClick={() => handlePrimaryButtonClick(inputValue, selectedImages)}>
												{primaryButtonText}
											</Button>
										</StandardTooltip>
									)}
									{secondaryButtonText && (
										<StandardTooltip
											content={
												secondaryButtonText === t("chat:startNewTask.title")
													? t("chat:startNewTask.tooltip")
													: secondaryButtonText === t("chat:reject.title")
														? t("chat:reject.tooltip")
														: secondaryButtonText === t("chat:terminate.title")
															? t("chat:terminate.tooltip")
															: secondaryButtonText === t("chat:killCommand.title")
																? t("chat:killCommand.tooltip")
																: undefined
											}>
											<Button
												variant="secondary"
												disabled={!enableButtons}
												className="flex-1 ml-[6px]"
												onClick={() => handleSecondaryButtonClick(inputValue, selectedImages)}>
												{secondaryButtonText}
											</Button>
										</StandardTooltip>
									)}
								</>
							)}
						</div>
					)}
				</>
			)}

			<QueuedMessages
				queue={messageQueue}
				onRemove={(index) => {
					if (messageQueue[index]) {
						vscode.postMessage({ type: "removeQueuedMessage", text: messageQueue[index].id })
					}
				}}
				onUpdate={(index, newText) => {
					if (messageQueue[index]) {
						vscode.postMessage({
							type: "editQueuedMessage",
							payload: { id: messageQueue[index].id, text: newText, images: messageQueue[index].images },
						})
					}
				}}
				onForceSend={() => {
					vscode.postMessage({ type: "cancelAndSendQueuedMessages" })
				}}
			/>
			{showRetiredProviderWarning && (
				<div className="px-[15px] py-1">
					<WarningRow
						title={t("chat:retiredProvider.title")}
						message={t("chat:retiredProvider.message")}
						actionText={t("chat:retiredProvider.openSettings")}
						onAction={() => vscode.postMessage({ type: "switchTab", tab: "settings" })}
					/>
				</div>
			)}
			{/* Dropped context file tags — displayed as removable chips above the text area */}
			{droppedContextFiles.length > 0 && (
				<div className="flex flex-wrap items-center gap-1.5 px-[15px] py-1.5">
					{droppedContextFiles.map((f) => (
						<span
							key={f.path}
							className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium"
							style={{
								backgroundColor: "var(--vscode-badge-background)",
								color: "var(--vscode-badge-foreground)",
							}}
							title={f.path}>
							<span className={`codicon ${f.isFile ? "codicon-file" : "codicon-folder"} text-xs`} />
							<span>{f.path.split("/").pop() || f.path}</span>
							<button
								aria-label={`Remove ${f.path}`}
								className="inline-flex items-center justify-center w-4 h-4 ml-0.5 rounded-sm opacity-60 hover:opacity-100 transition-opacity bg-transparent border-none cursor-pointer"
								style={{ color: "var(--vscode-badge-foreground)" }}
								onClick={() => handleRemoveContextFile(f.path)}>
								<span className="codicon codicon-close text-xs" />
							</button>
						</span>
					))}
					<button
						aria-label="Clear all context files"
						className="inline-flex items-center justify-center w-5 h-5 rounded-sm opacity-50 hover:opacity-100 transition-opacity bg-transparent border-none cursor-pointer ml-1"
						style={{ color: "var(--vscode-descriptionForeground)" }}
						onClick={handleClearContextFiles}
						title="Clear all">
						<span className="codicon codicon-clear-all text-xs" />
					</button>
				</div>
			)}
			<ChatTextArea
				ref={textAreaRef}
				inputValue={inputValue}
				setInputValue={setInputValue}
				sendingDisabled={sendingDisabled || isProfileDisabled}
				selectApiConfigDisabled={sendingDisabled && shoferAsk !== "api_req_failed"}
				placeholderText={placeholderText}
				selectedImages={selectedImages}
				setSelectedImages={setSelectedImages}
				onSend={() => handleSendMessage(inputValue, selectedImages)}
				onSelectImages={selectImages}
				shouldDisableImages={shouldDisableImages}
				onHeightChange={() => {
					if (isAtBottomRef.current && scrollPhaseRef.current !== "USER_BROWSING_HISTORY") {
						scrollToBottomAuto()
					}
				}}
				mode={mode}
				setMode={setMode}
				modeShortcutText={modeShortcutText}
				isStreaming={isStreaming}
				canStop={canStop}
				onStop={handleStopTask}
				onEnqueueMessage={handleEnqueueCurrentMessage}
				onContextFilesDropped={(files: DroppedContextFile[]) =>
					setDroppedContextFiles((prev) => {
						const seen = new Set(prev.map((f) => f.path))
						const merged = [...prev]
						for (const f of files) {
							if (!seen.has(f.path)) {
								seen.add(f.path)
								merged.push(f)
							}
						}
						return merged
					})
				}
			/>

			{isProfileDisabled && (
				<div className="px-3">
					<ProfileViolationWarning />
				</div>
			)}

			<div id="shofer-portal" />
			{/* CloudUpsellDialog removed */}
			{/* Task notifications for background tasks */}
			<TaskNotificationContainer
				notifications={taskNotifications || []}
				managedTasks={(parallelTasks || []).map((s) => ({ id: s.id, name: s.name }))}
				onDismiss={(taskId) => vscode.postMessage({ type: "clearTaskNotification", taskId })}
				onFocus={(taskId) => vscode.postMessage({ type: "focusParallelTask", taskId })}
			/>
		</div>
	)
}

const ChatView = forwardRef(ChatViewComponent)

export default ChatView
