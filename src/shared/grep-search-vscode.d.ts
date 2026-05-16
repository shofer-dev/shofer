/**
 * Type augmentation for VS Code's `findTextInFiles` workspace search API.
 *
 * This API is available at runtime in code-server (VS Code >= 1.77) but the
 * bundled `@types/vscode` (1.100.0) does not include it. This declaration
 * supplies the missing types for type-checking only.
 */

declare module "vscode" {
	export interface TextSearchComplete {
		results: TextSearchResult[]
		limitHit?: boolean
	}

	export interface TextSearchResult {
		uri: Uri
		ranges: Range[]
		preview: TextSearchMatch
	}

	export interface TextSearchMatch {
		text: string
		matches: Range[]
	}

	export interface TextSearchQuery {
		pattern: string
		isRegExp?: boolean
		isCaseSensitive?: boolean
		isWordMatch?: boolean
	}

	export interface FindTextInFilesOptions {
		maxResults?: number
		beforeContext?: number
		afterContext?: number
		include?: GlobPattern | Uri
		exclude?: GlobPattern
		previewOptions?: TextSearchPreviewOptions
		useIgnoreFiles?: boolean
		useGlobalIgnoreFiles?: boolean
		followSymlinks?: boolean
		useParentIgnoreFiles?: boolean
	}

	export interface TextSearchPreviewOptions {
		matchLines: number
		charsPerLine: number
	}

	export namespace workspace {
		export function findTextInFiles(
			query: TextSearchQuery,
			options: FindTextInFilesOptions | Uri,
			callback: (result: TextSearchResult) => void,
			token?: CancellationToken,
		): Thenable<TextSearchComplete>
	}
}
