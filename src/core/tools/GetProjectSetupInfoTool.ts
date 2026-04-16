/**
 * GetProjectSetupInfoTool - Analyzes the workspace to detect project configuration.
 *
 * Detects languages, frameworks, build systems, and package managers by examining
 * configuration files in the workspace root. Ported from workspace-tools `workspace_getProjectSetupInfo`.
 */

import * as path from "path"
import * as fs from "fs/promises"

import { Task } from "../task/Task"

import { BaseTool, ToolCallbacks } from "./BaseTool"

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
interface GetProjectSetupInfoParams {}

const PROJECT_INDICATORS = {
	languages: {
		typescript: ["tsconfig.json"],
		javascript: ["package.json"],
		go: ["go.mod", "go.sum"],
		python: ["requirements.txt", "setup.py", "pyproject.toml", "Pipfile"],
		rust: ["Cargo.toml"],
		java: ["pom.xml", "build.gradle"],
		cpp: ["CMakeLists.txt"],
		ruby: ["Gemfile"],
		php: ["composer.json"],
		csharp: ["*.csproj", "*.sln"],
	} as Record<string, string[]>,
	frameworks: {
		react: ["react", "react-dom"],
		vue: ["vue"],
		angular: ["@angular/core"],
		nextjs: ["next"],
		express: ["express"],
		django: ["django"],
		flask: ["flask"],
		rails: ["rails"],
		gin: ["github.com/gin-gonic/gin"],
		echo: ["github.com/labstack/echo"],
	} as Record<string, string[]>,
	buildSystems: {
		npm: ["package.json", "package-lock.json"],
		yarn: ["yarn.lock"],
		pnpm: ["pnpm-lock.yaml"],
		bazel: ["BUILD.bazel", "WORKSPACE", "WORKSPACE.bazel", "MODULE.bazel"],
		make: ["Makefile"],
		cmake: ["CMakeLists.txt"],
		gradle: ["build.gradle", "build.gradle.kts"],
		maven: ["pom.xml"],
		cargo: ["Cargo.toml"],
		pip: ["requirements.txt", "setup.py"],
		poetry: ["pyproject.toml"],
	} as Record<string, string[]>,
	packageManagers: {
		npm: ["package-lock.json"],
		yarn: ["yarn.lock"],
		pnpm: ["pnpm-lock.yaml"],
		pip: ["requirements.txt"],
		poetry: ["poetry.lock"],
		cargo: ["Cargo.lock"],
		go: ["go.sum"],
		bundler: ["Gemfile.lock"],
		composer: ["composer.lock"],
	} as Record<string, string[]>,
}

export class GetProjectSetupInfoTool extends BaseTool<"get_project_setup_info"> {
	readonly name = "get_project_setup_info" as const

	async execute(_params: GetProjectSetupInfoParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { handleError, pushToolResult } = callbacks

		try {
			task.consecutiveMistakeCount = 0

			const rootPath = task.cwd
			const entries = await fs.readdir(rootPath)
			const fileNames = new Set(entries)

			const languages: string[] = []
			const frameworks: string[] = []
			const buildSystems: string[] = []
			const packageManagers: string[] = []
			const configFiles: string[] = []

			// Detect languages
			for (const [lang, patterns] of Object.entries(PROJECT_INDICATORS.languages)) {
				for (const pattern of patterns) {
					if (!pattern.startsWith("*") && fileNames.has(pattern)) {
						if (!languages.includes(lang)) {
							languages.push(lang)
							configFiles.push(pattern)
						}
					}
				}
			}

			// Detect build systems
			for (const [system, patterns] of Object.entries(PROJECT_INDICATORS.buildSystems)) {
				for (const pattern of patterns) {
					if (!pattern.startsWith("*") && fileNames.has(pattern)) {
						if (!buildSystems.includes(system)) {
							buildSystems.push(system)
							if (!configFiles.includes(pattern)) configFiles.push(pattern)
						}
					}
				}
			}

			// Detect package managers
			for (const [pm, patterns] of Object.entries(PROJECT_INDICATORS.packageManagers)) {
				for (const pattern of patterns) {
					if (!pattern.startsWith("*") && fileNames.has(pattern)) {
						if (!packageManagers.includes(pm)) {
							packageManagers.push(pm)
							if (!configFiles.includes(pattern)) configFiles.push(pattern)
						}
					}
				}
			}

			// Detect frameworks from package.json
			if (fileNames.has("package.json")) {
				try {
					const pkgContent = await fs.readFile(path.join(rootPath, "package.json"), "utf-8")
					const pkg = JSON.parse(pkgContent)
					const deps = { ...pkg.dependencies, ...pkg.devDependencies }
					for (const [framework, pkgNames] of Object.entries(PROJECT_INDICATORS.frameworks)) {
						for (const pkgName of pkgNames) {
							if (pkgName in deps && !frameworks.includes(framework)) {
								frameworks.push(framework)
							}
						}
					}
				} catch {
					// Ignore parse errors
				}
			}

			// Detect frameworks from go.mod
			if (fileNames.has("go.mod")) {
				try {
					const goModContent = await fs.readFile(path.join(rootPath, "go.mod"), "utf-8")
					for (const [framework, paths] of Object.entries(PROJECT_INDICATORS.frameworks)) {
						for (const p of paths) {
							if (
								p.startsWith("github.com/") &&
								goModContent.includes(p) &&
								!frameworks.includes(framework)
							) {
								frameworks.push(framework)
							}
						}
					}
				} catch {
					// Ignore errors
				}
			}

			const sections: string[] = [`Workspace Root: ${rootPath}`]
			if (languages.length > 0) sections.push(`Languages: ${languages.join(", ")}`)
			if (frameworks.length > 0) sections.push(`Frameworks: ${frameworks.join(", ")}`)
			if (buildSystems.length > 0) sections.push(`Build Systems: ${buildSystems.join(", ")}`)
			if (packageManagers.length > 0) sections.push(`Package Managers: ${packageManagers.join(", ")}`)
			if (configFiles.length > 0) sections.push(`Config Files: ${configFiles.join(", ")}`)

			pushToolResult(sections.join("\n"))
		} catch (error) {
			await handleError("getting project setup info", error instanceof Error ? error : new Error(String(error)))
		}
	}
}

export const getProjectSetupInfoTool = new GetProjectSetupInfoTool()
