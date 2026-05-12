// npx vitest run src/__tests__/index.test.ts

import { generatePackageJson } from "../index.js"

describe("generatePackageJson", () => {
	it("should be a test", () => {
		const generatedPackageJson = generatePackageJson({
			packageJson: {
				name: "shofer",
				displayName: "%extension.displayName%",
				description: "%extension.description%",
				publisher: "Arkware",
				version: "3.17.2",
				icon: "assets/icons/icon.png",
				contributes: {
					viewsContainers: {
						activitybar: [
							{
								id: "shofer-ActivityBar",
								title: "%views.activitybar.title%",
								icon: "assets/icons/icon.svg",
							},
						],
					},
					views: {
						"shofer-ActivityBar": [
							{
								type: "webview",
								id: "shofer.SidebarProvider",
								name: "",
							},
						],
					},
					commands: [
						{
							command: "shofer.plusButtonClicked",
							title: "%command.newTask.title%",
							icon: "$(edit)",
						},
						{
							command: "shofer.openInNewTab",
							title: "%command.openInNewTab.title%",
							category: "%configuration.title%",
						},
					],
					menus: {
						"editor/context": [
							{
								submenu: "shofer.contextMenu",
								group: "navigation",
							},
						],
						"shofer.contextMenu": [
							{
								command: "shofer.addToContext",
								group: "1_actions@1",
							},
						],
						"editor/title": [
							{
								command: "shofer.plusButtonClicked",
								group: "navigation@1",
								when: "activeWebviewPanelId == shofer.TabPanelProvider",
							},
							{
								command: "shofer.settingsButtonClicked",
								group: "navigation@6",
								when: "activeWebviewPanelId == shofer.TabPanelProvider",
							},
							{
								command: "shofer.accountButtonClicked",
								group: "navigation@6",
								when: "activeWebviewPanelId == shofer.TabPanelProvider",
							},
						],
					},
					submenus: [
						{
							id: "shofer.contextMenu",
							label: "%views.contextMenu.label%",
						},
						{
							id: "shofer.terminalMenu",
							label: "%views.terminalMenu.label%",
						},
					],
					configuration: {
						title: "%configuration.title%",
						properties: {
							"shofer.allowedCommands": {
								type: "array",
								items: {
									type: "string",
								},
								default: ["npm test", "npm install", "tsc", "git log", "git diff", "git show"],
								description: "%commands.allowedCommands.description%",
							},
							"shofer.customStoragePath": {
								type: "string",
								default: "",
								description: "%settings.customStoragePath.description%",
							},
						},
					},
				},
				scripts: {
					lint: "eslint **/*.ts",
				},
			},
			overrideJson: {
				name: "shofer-nightly",
				displayName: "Shofer Nightly",
				publisher: "Arkware",
				version: "0.0.1",
				icon: "assets/icons/icon-nightly.png",
				scripts: {},
			},
			substitution: ["shofer", "shofer-nightly"],
		})

		expect(generatedPackageJson).toStrictEqual({
			name: "shofer-nightly",
			displayName: "Shofer Nightly",
			description: "%extension.description%",
			publisher: "Arkware",
			version: "0.0.1",
			icon: "assets/icons/icon-nightly.png",
			contributes: {
				viewsContainers: {
					activitybar: [
						{
							id: "shofer-nightly-ActivityBar",
							title: "%views.activitybar.title%",
							icon: "assets/icons/icon.svg",
						},
					],
				},
				views: {
					"shofer-nightly-ActivityBar": [
						{
							type: "webview",
							id: "shofer-nightly.SidebarProvider",
							name: "",
						},
					],
				},
				commands: [
					{
						command: "shofer-nightly.plusButtonClicked",
						title: "%command.newTask.title%",
						icon: "$(edit)",
					},
					{
						command: "shofer-nightly.openInNewTab",
						title: "%command.openInNewTab.title%",
						category: "%configuration.title%",
					},
				],
				menus: {
					"editor/context": [
						{
							submenu: "shofer-nightly.contextMenu",
							group: "navigation",
						},
					],
					"shofer-nightly.contextMenu": [
						{
							command: "shofer-nightly.addToContext",
							group: "1_actions@1",
						},
					],
					"editor/title": [
						{
							command: "shofer-nightly.plusButtonClicked",
							group: "navigation@1",
							when: "activeWebviewPanelId == shofer-nightly.TabPanelProvider",
						},
						{
							command: "shofer-nightly.settingsButtonClicked",
							group: "navigation@6",
							when: "activeWebviewPanelId == shofer-nightly.TabPanelProvider",
						},
						{
							command: "shofer-nightly.accountButtonClicked",
							group: "navigation@6",
							when: "activeWebviewPanelId == shofer-nightly.TabPanelProvider",
						},
					],
				},
				submenus: [
					{
						id: "shofer-nightly.contextMenu",
						label: "%views.contextMenu.label%",
					},
					{
						id: "shofer-nightly.terminalMenu",
						label: "%views.terminalMenu.label%",
					},
				],
				configuration: {
					title: "%configuration.title%",
					properties: {
						"shofer-nightly.allowedCommands": {
							type: "array",
							items: {
								type: "string",
							},
							default: ["npm test", "npm install", "tsc", "git log", "git diff", "git show"],
							description: "%commands.allowedCommands.description%",
						},
						"shofer-nightly.customStoragePath": {
							type: "string",
							default: "",
							description: "%settings.customStoragePath.description%",
						},
					},
				},
			},
			scripts: {},
		})
	})
})
