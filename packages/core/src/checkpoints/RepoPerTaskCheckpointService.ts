import * as path from "path"

import { CheckpointServiceOptions } from "./types.js"
import { ShadowCheckpointService } from "./ShadowCheckpointService.js"
import { checkpointLog } from "../logging/subsystems.js"

export class RepoPerTaskCheckpointService extends ShadowCheckpointService {
	public static create({
		taskId,
		workspaceDir,
		shadowDir,
		scopedWorktreeDir,
		log = checkpointLog.info,
	}: CheckpointServiceOptions) {
		return new RepoPerTaskCheckpointService(
			taskId,
			path.join(shadowDir, "tasks", taskId, "checkpoints"),
			workspaceDir,
			log,
			scopedWorktreeDir,
		)
	}
}
