import * as path from "path"

import { CheckpointServiceOptions } from "./types"
import { ShadowCheckpointService } from "./ShadowCheckpointService"
import { outputLog } from "../../utils/outputChannelLogger"

export class RepoPerTaskCheckpointService extends ShadowCheckpointService {
	public static create({
		taskId,
		workspaceDir,
		shadowDir,
		scopedWorktreeDir,
		log = outputLog,
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
