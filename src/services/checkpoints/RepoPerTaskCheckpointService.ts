import * as path from "path"

import { CheckpointServiceOptions } from "./types"
import { ShadowCheckpointService } from "./ShadowCheckpointService"
import { checkpointLog } from "../../utils/logging/subsystems"

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
