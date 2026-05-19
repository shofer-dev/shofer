import * as vscode from "vscode"
import { PointStruct } from "./vector-store"

/**
 * Interface for code file parser
 */
export interface ICodeParser {
	/**
	 * Parses a code file into code blocks
	 * @param filePath Path to the file to parse
	 * @param options Optional parsing options
	 * @returns Promise resolving to array of code blocks
	 */
	parseFile(
		filePath: string,
		options?: {
			minBlockLines?: number
			maxBlockLines?: number
			content?: string
			fileHash?: string
		},
	): Promise<CodeBlock[]>
}

/**
 * Interface for directory scanner
 */
export interface IDirectoryScanner {
	/**
	 * Scans a directory for code blocks
	 * @param directoryPath Path to the directory to scan
	 * @param options Optional scanning options
	 * @returns Promise resolving to scan results
	 */
	scanDirectory(
		directory: string,
		onError?: (error: Error) => void,
		onBlocksIndexed?: (indexedCount: number) => void,
		onFileParsed?: (fileBlockCount: number) => void,
		signal?: AbortSignal,
	): Promise<{
		stats: {
			processed: number
			skipped: number
		}
		totalBlockCount: number
	}>

	/**
	 * Scans specific files (Phase 2 — git-aware narrowing).
	 * Reuses the same per-file pipeline but operates on an explicit list.
	 */
	scanSpecificFiles(
		workspacePath: string,
		paths: string[],
		onError?: (error: Error) => void,
		onBlocksIndexed?: (indexedCount: number) => void,
		onFileParsed?: (fileBlockCount: number) => void,
		signal?: AbortSignal,
	): Promise<{
		stats: { processed: number; skipped: number }
		totalBlockCount: number
	}>

	/**
	 * Deletes points and cache entries for specific deleted files
	 * (Phase 2 — git-aware narrowing).
	 */
	deleteSpecificFiles(paths: string[]): Promise<void>
}

/**
 * Interface for file watcher
 */
export interface IFileWatcher extends vscode.Disposable {
	/**
	 * Initializes the file watcher
	 */
	initialize(): Promise<void>

	/**
	 * Event emitted when a batch of files begins processing.
	 * The event payload is an array of file paths included in the batch.
	 */
	readonly onDidStartBatchProcessing: vscode.Event<string[]>

	/**
	 * Event emitted to report progress during batch processing.
	 */
	readonly onBatchProgressUpdate: vscode.Event<{
		processedInBatch: number
		totalInBatch: number
		currentFile?: string
	}>

	/**
	 * Event emitted when a batch of files has finished processing.
	 * The event payload contains a summary of the batch operation.
	 */
	readonly onDidFinishBatchProcessing: vscode.Event<BatchProcessingSummary>

	/**
	 * Processes a file
	 * @param filePath Path to the file to process
	 * @returns Promise resolving to processing result
	 */
	processFile(filePath: string): Promise<FileProcessingResult>
}

export interface BatchProcessingSummary {
	/** All files attempted in the batch, including their final status. */
	processedFiles: FileProcessingResult[]
	/** Optional error if the entire batch operation failed (e.g., database connection issue). */
	batchError?: Error
}

export interface FileProcessingResult {
	path: string
	status: "success" | "skipped" | "error" | "processed_for_batching" | "local_error"
	error?: Error
	reason?: string
	newHash?: string
	newMtimeMs?: number
	newSize?: number
	/** New segment hashes after parsing (used for per-segment dedup cache). */
	newSegmentHashes?: string[]
	/** Qdrant point IDs of stale segments to delete (previous hashes not in new set). */
	staleSegmentIds?: string[]
	pointsToUpsert?: PointStruct[]
}

/**
 * Common types used across the code-index service
 */

export interface CodeBlock {
	file_path: string
	identifier: string | null
	type: string
	start_line: number
	end_line: number
	content: string
	fileHash: string
	segmentHash: string
}
