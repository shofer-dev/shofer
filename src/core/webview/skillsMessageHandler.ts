import * as vscode from "vscode"

import type { SkillMetadata, WebviewMessage } from "@shofer/types"

import type { ShoferProvider } from "./ShoferProvider"
import { openFile } from "../../integrations/misc/open-file"
import { t } from "../../i18n"

type SkillSource = SkillMetadata["source"]

/**
 * Handles the requestSkills message - returns all skills metadata
 */
export async function handleRequestSkills(provider: ShoferProvider): Promise<SkillMetadata[]> {
	try {
		const skillsManager = provider.getSkillsManager()
		const currentTask = provider.getCurrentTask()
		// Convert Map to plain object for JSON serialization
		const loadedSkills: Record<string, string> = {}
		if (currentTask?.loadedSkills) {
			for (const [name, path] of currentTask.loadedSkills) {
				loadedSkills[name] = path
			}
		}
		console.log(`[handleRequestSkills] currentTask=${!!currentTask} loadedSkills:`, loadedSkills)
		if (skillsManager) {
			// Re-discover skills from disk so the UI picks up newly added/removed skills
			await skillsManager.discoverSkills()
			const skills = skillsManager.getSkillsMetadata()
			console.log(
				`[handleRequestSkills] sending skills count=${skills.length} loadedSkills keys=`,
				Object.keys(loadedSkills),
			)
			await provider.postMessageToWebview({ type: "skills", skills, loadedSkills })
			return skills
		} else {
			await provider.postMessageToWebview({ type: "skills", skills: [], loadedSkills })
			return []
		}
	} catch (error) {
		provider.log(`Error fetching skills: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`)
		await provider.postMessageToWebview({ type: "skills", skills: [], loadedSkills: {} })
		return []
	}
}

/**
 * Handles the createSkill message - creates a new skill
 */
export async function handleCreateSkill(
	provider: ShoferProvider,
	message: WebviewMessage,
): Promise<SkillMetadata[] | undefined> {
	try {
		const skillName = message.skillName
		const source = message.source as SkillSource
		const skillDescription = message.skillDescription
		// Support new modeSlugs array or fall back to legacy skillMode
		const modeSlugs = message.skillModeSlugs ?? (message.skillMode ? [message.skillMode] : undefined)

		if (!skillName || !source || !skillDescription) {
			throw new Error(t("skills:errors.missing_create_fields"))
		}

		const skillsManager = provider.getSkillsManager()
		if (!skillsManager) {
			throw new Error(t("skills:errors.manager_unavailable"))
		}

		const createdPath = await skillsManager.createSkill(skillName, source, skillDescription, modeSlugs)

		// Open the created file in the editor
		openFile(createdPath)

		// Send updated skills list
		const skills = skillsManager.getSkillsMetadata()
		await provider.postMessageToWebview({ type: "skills", skills })
		return skills
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error)
		provider.log(`Error creating skill: ${errorMessage}`)
		vscode.window.showErrorMessage(`Failed to create skill: ${errorMessage}`)
		return undefined
	}
}

/**
 * Handles the deleteSkill message - deletes a skill
 */
export async function handleDeleteSkill(
	provider: ShoferProvider,
	message: WebviewMessage,
): Promise<SkillMetadata[] | undefined> {
	try {
		const skillName = message.skillName
		const source = message.source as SkillSource
		// Support new skillModeSlugs array or fall back to legacy skillMode
		const skillMode = message.skillModeSlugs?.[0] ?? message.skillMode

		if (!skillName || !source) {
			throw new Error(t("skills:errors.missing_delete_fields"))
		}

		const skillsManager = provider.getSkillsManager()
		if (!skillsManager) {
			throw new Error(t("skills:errors.manager_unavailable"))
		}

		await skillsManager.deleteSkill(skillName, source, skillMode)

		// Send updated skills list
		const skills = skillsManager.getSkillsMetadata()
		await provider.postMessageToWebview({ type: "skills", skills })
		return skills
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error)
		provider.log(`Error deleting skill: ${errorMessage}`)
		vscode.window.showErrorMessage(`Failed to delete skill: ${errorMessage}`)
		return undefined
	}
}

/**
 * Handles the moveSkill message - moves a skill to a different mode
 */
export async function handleMoveSkill(
	provider: ShoferProvider,
	message: WebviewMessage,
): Promise<SkillMetadata[] | undefined> {
	try {
		const skillName = message.skillName
		const source = message.source as SkillSource
		const currentMode = message.skillMode
		const newMode = message.newSkillMode

		if (!skillName || !source) {
			throw new Error(t("skills:errors.missing_move_fields"))
		}

		const skillsManager = provider.getSkillsManager()
		if (!skillsManager) {
			throw new Error(t("skills:errors.manager_unavailable"))
		}

		await skillsManager.moveSkill(skillName, source, currentMode, newMode)

		// Send updated skills list
		const skills = skillsManager.getSkillsMetadata()
		await provider.postMessageToWebview({ type: "skills", skills })
		return skills
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error)
		provider.log(`Error moving skill: ${errorMessage}`)
		vscode.window.showErrorMessage(`Failed to move skill: ${errorMessage}`)
		return undefined
	}
}

/**
 * Handles the updateSkillModes message - updates the mode associations for a skill
 */
export async function handleUpdateSkillModes(
	provider: ShoferProvider,
	message: WebviewMessage,
): Promise<SkillMetadata[] | undefined> {
	try {
		const skillName = message.skillName
		const source = message.source as SkillSource
		const newModeSlugs = message.newSkillModeSlugs

		if (!skillName || !source) {
			throw new Error(t("skills:errors.missing_update_modes_fields"))
		}

		const skillsManager = provider.getSkillsManager()
		if (!skillsManager) {
			throw new Error(t("skills:errors.manager_unavailable"))
		}

		await skillsManager.updateSkillModes(skillName, source, newModeSlugs)

		// Send updated skills list
		const skills = skillsManager.getSkillsMetadata()
		await provider.postMessageToWebview({ type: "skills", skills })
		return skills
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error)
		provider.log(`Error updating skill modes: ${errorMessage}`)
		vscode.window.showErrorMessage(`Failed to update skill modes: ${errorMessage}`)
		return undefined
	}
}

/**
 * Handles the openSkillFile message - opens a skill file in the editor
 */
export async function handleOpenSkillFile(provider: ShoferProvider, message: WebviewMessage): Promise<void> {
	try {
		const skillName = message.skillName
		const source = message.source as SkillSource

		if (!skillName || !source) {
			throw new Error(t("skills:errors.missing_delete_fields"))
		}

		const skillsManager = provider.getSkillsManager()
		if (!skillsManager) {
			throw new Error(t("skills:errors.manager_unavailable"))
		}

		// Find skill by name and source (skills may have modeSlugs arrays now)
		const skill = skillsManager.findSkillByNameAndSource(skillName, source)
		if (!skill) {
			throw new Error(t("skills:errors.skill_not_found", { name: skillName }))
		}

		openFile(skill.path)
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error)
		provider.log(`Error opening skill file: ${errorMessage}`)
		vscode.window.showErrorMessage(`Failed to open skill file: ${errorMessage}`)
	}
}
