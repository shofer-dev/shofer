import { parametersSchema as z } from "@shofer/types"

import { defineNativeTool } from "../../../tools/defineNativeTool.js"

const GET_CHANGED_FILES_DESCRIPTION = `Request the list of files that Shofer has changed during the current task, along with the number of inserted and deleted lines per file.

Source of truth is Shofer's internal tracking for the current session:
- The task's per-file base/final snapshots, which give line-level insertion/deletion counts versus the state each file was in before Shofer first edited it.
- The internal file context tracker, which records every file Shofer has edited.

Files known only to the tracker are reported with unknown line counts. The tool takes no parameters.

Example:
{ }`

export default defineNativeTool({
	name: "get_changed_files",
	description: GET_CHANGED_FILES_DESCRIPTION,
	schema: z.object({}),
})
