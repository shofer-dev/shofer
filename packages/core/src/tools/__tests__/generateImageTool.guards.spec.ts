import os from "os"
import path from "path"
import fsp from "fs/promises"

import { EXPERIMENT_IDS } from "@shofer/types"

const generateImage = vi.fn()
vi.mock("../../api/providers/openrouter.js", () => ({
	OpenRouterHandler: class {
		generateImage = generateImage
	},
}))

import { GenerateImageTool } from "../GenerateImageTool.js"

/**
 * `generate_image`'s GUARDS — everything the tool refuses before it spends a
 * provider call, and how it lands the bytes when it does not.
 *
 * The refusals are ordered deliberately, and the order is the design: the
 * experiment gate first (the feature may not exist for this user at all), then
 * missing parameters, then the ignore controller, then the input image, then
 * the credential. Each returns a tool result the model can act on rather than
 * throwing, because the turn continues either way.
 *
 * Two of them are access-control rather than validation. `.shoferignore` is
 * checked on BOTH paths — the file being written AND the image being read —
 * because an ignored file is invisible in both directions; checking only the
 * output would let a prompt exfiltrate an ignored image into a generated one.
 *
 * Writing is the File Change Tracking Pattern's obligation: the tool writes
 * directly rather than through `DiffViewProvider`, so it must publish the edit
 * itself (`trackFileContext`) or the file is missing from the changes panel.
 */

const tool = new GenerateImageTool()

let cwd: string

function callbacks() {
	const results: unknown[] = []
	const errors: unknown[] = []
	return {
		results,
		errors,
		pushToolResult: vi.fn((r: unknown) => results.push(r)),
		handleError: vi.fn(async (_ctx: string, e: unknown) => {
			errors.push(e)
		}),
		askApproval: vi.fn(async (..._a: unknown[]) => true),
		removeClosingTag: vi.fn(),
	}
}

function makeTask(over: Record<string, unknown> = {}, state: Record<string, unknown> = {}) {
	const said: Array<[string, string]> = []
	const task = {
		cwd,
		taskId: "t1",
		consecutiveMistakeCount: 0,
		didToolFailInCurrentTurn: false,
		didEditFile: false,
		recordToolError: vi.fn(),
		recordToolUsage: vi.fn(),
		sayAndCreateMissingParamError: vi.fn(async (_t: string, p: string) => `missing:${p}`),
		say: vi.fn(async (type: string, text: string) => {
			said.push([type, text])
		}),
		shoferIgnoreController: { validateAccess: () => true },
		shoferProtectedController: { isWriteProtected: () => false },
		fileContextTracker: { trackFileContext: vi.fn().mockResolvedValue(undefined) },
		providerRef: {
			deref: () => ({
				getState: async () => ({
					experiments: { [EXPERIMENT_IDS.IMAGE_GENERATION]: true },
					openRouterImageApiKey: "sk-or-test",
					...state,
				}),
			}),
		},
		...over,
	}
	return { task, said }
}

const DATA_URL = `data:image/png;base64,${Buffer.from("PNGBYTES").toString("base64")}`

beforeEach(async () => {
	vi.clearAllMocks()
	cwd = await fsp.mkdtemp(path.join(os.tmpdir(), "genimg-"))
	generateImage.mockResolvedValue({ success: true, imageData: DATA_URL })
})

afterEach(async () => {
	await fsp.rm(cwd, { recursive: true, force: true })
})

describe("the refusals, in order", () => {
	it("refuses before anything else when the experiment is off", async () => {
		const { task } = makeTask({}, { experiments: {} })
		const cb = callbacks()

		await tool.execute({ prompt: "a cat", path: "out.png" } as never, task as never, cb as never)

		expect(cb.results[0]).toContain("experimental feature")
		expect(generateImage).not.toHaveBeenCalled()
	})

	it.each(["prompt", "path"])("names a missing %s and counts a mistake", async (missing) => {
		const params: Record<string, string> = { prompt: "a cat", path: "out.png" }
		delete params[missing]
		const { task } = makeTask()
		const cb = callbacks()

		await tool.execute(params as never, task as never, cb as never)

		expect(cb.results[0]).toBe(`missing:${missing}`)
		expect(task.consecutiveMistakeCount).toBe(1)
		expect(task.recordToolError).toHaveBeenCalledWith("generate_image")
	})

	it("refuses to write to a path .shoferignore covers", async () => {
		const { task, said } = makeTask({ shoferIgnoreController: { validateAccess: () => false } })
		const cb = callbacks()

		await tool.execute({ prompt: "a cat", path: "secret/out.png" } as never, task as never, cb as never)

		expect(said[0]![0]).toBe("shoferignore_error")
		expect(generateImage).not.toHaveBeenCalled()
	})

	it("refuses to READ an input image .shoferignore covers", async () => {
		// Checking only the output path would let a prompt exfiltrate an ignored
		// image into a generated one.
		const input = path.join(cwd, "secret.png")
		await fsp.writeFile(input, "x")
		const { task, said } = makeTask({
			shoferIgnoreController: { validateAccess: (p: string) => p !== "secret.png" },
		})
		const cb = callbacks()

		await tool.execute(
			{ prompt: "edit it", path: "out.png", image: "secret.png" } as never,
			task as never,
			cb as never,
		)

		expect(said.map(([t]) => t)).toContain("shoferignore_error")
		expect(generateImage).not.toHaveBeenCalled()
	})

	it("refuses an input image that is not there", async () => {
		const { task } = makeTask()
		const cb = callbacks()

		await tool.execute(
			{ prompt: "edit", path: "out.png", image: "missing.png" } as never,
			task as never,
			cb as never,
		)

		expect(String(cb.results[0])).toContain("Input image not found")
		expect(task.didToolFailInCurrentTurn).toBe(true)
	})

	it("refuses an input image in a format no provider takes", async () => {
		await fsp.writeFile(path.join(cwd, "chart.bmp"), "x")
		const { task } = makeTask()
		const cb = callbacks()

		await tool.execute({ prompt: "edit", path: "out.png", image: "chart.bmp" } as never, task as never, cb as never)

		expect(String(cb.results[0])).toContain("Unsupported image format: bmp")
	})

	it("refuses when no OpenRouter key is configured", async () => {
		const { task } = makeTask({}, { openRouterImageApiKey: undefined })
		const cb = callbacks()

		await tool.execute({ prompt: "a cat", path: "out.png" } as never, task as never, cb as never)

		expect(cb.results).toHaveLength(1)
		expect(generateImage).not.toHaveBeenCalled()
	})

	it("stops when the approval is refused, writing nothing", async () => {
		const { task } = makeTask()
		const cb = callbacks()
		cb.askApproval.mockResolvedValue(false)

		await tool.execute({ prompt: "a cat", path: "out.png" } as never, task as never, cb as never)

		expect(generateImage).not.toHaveBeenCalled()
		expect(cb.results).toEqual([])
	})
})

describe("an input image that IS usable", () => {
	it.each([
		["png", "image/png"],
		["jpg", "image/jpeg"],
		["webp", "image/webp"],
	])("passes a .%s through as a data URL", async (ext, mime) => {
		await fsp.writeFile(path.join(cwd, `in.${ext}`), Buffer.from("BYTES"))
		const { task } = makeTask()

		await tool.execute(
			{ prompt: "edit", path: "out.png", image: `in.${ext}` } as never,
			task as never,
			callbacks() as never,
		)

		const [, , , inputData] = generateImage.mock.calls[0]!
		expect(inputData).toBe(`data:${mime};base64,${Buffer.from("BYTES").toString("base64")}`)
	})

	it("names the input image in what the user is asked to approve", async () => {
		await fsp.writeFile(path.join(cwd, "in.png"), "x")
		const { task } = makeTask()
		const cb = callbacks()

		await tool.execute({ prompt: "edit", path: "out.png", image: "in.png" } as never, task as never, cb as never)

		expect(JSON.parse(cb.askApproval.mock.calls[0]![1] as string)).toMatchObject({
			tool: "generateImage",
			inputImage: "in.png",
		})
	})
})

describe("what the provider answered", () => {
	it.each([
		["a refusal", { success: false, error: "content policy" }, "content policy"],
		["a success with no image", { success: true }, "No image data received"],
		["an unusable data URL", { success: true, imageData: "https://cdn/x.webp" }, "Invalid image format received"],
	])("reports %s as a tool error and marks the turn failed", async (_case, answer, expected) => {
		generateImage.mockResolvedValue(answer)
		const { task } = makeTask()
		const cb = callbacks()

		await tool.execute({ prompt: "a cat", path: "out.png" } as never, task as never, cb as never)

		expect(String(cb.results[0])).toContain(expected)
		expect(task.didToolFailInCurrentTurn).toBe(true)
	})

	it("reports a thrown provider error through handleError rather than failing the turn", async () => {
		generateImage.mockRejectedValue(new Error("network down"))
		const { task } = makeTask()
		const cb = callbacks()

		await tool.execute({ prompt: "a cat", path: "out.png" } as never, task as never, cb as never)

		expect(cb.errors).toHaveLength(1)
	})
})

describe("landing the bytes", () => {
	it("writes the decoded image and reports the path", async () => {
		const { task } = makeTask()
		const cb = callbacks()

		await tool.execute({ prompt: "a cat", path: "art/out.png" } as never, task as never, cb as never)

		// The directory is created, not assumed.
		expect(await fsp.readFile(path.join(cwd, "art/out.png"), "utf8")).toBe("PNGBYTES")
		expect(String(cb.results[0])).toContain("art/out.png")
	})

	it("appends the extension the provider actually returned", async () => {
		generateImage.mockResolvedValue({
			success: true,
			imageData: `data:image/jpeg;base64,${Buffer.from("JPG").toString("base64")}`,
		})
		const { task } = makeTask()

		await tool.execute({ prompt: "a cat", path: "portrait" } as never, task as never, callbacks() as never)

		// A file whose bytes and name disagree is one nothing can open.
		expect(await fsp.readFile(path.join(cwd, "portrait.jpg"), "utf8")).toBe("JPG")
	})

	it("PUBLISHES the edit, so the change appears in the file-changes panel", async () => {
		// A direct write bypasses DiffViewProvider, so the tool owes this itself.
		const { task } = makeTask()

		await tool.execute({ prompt: "a cat", path: "out.png" } as never, task as never, callbacks() as never)

		expect(task.fileContextTracker.trackFileContext).toHaveBeenCalledWith("out.png", "shofer_edited")
		expect(task.didEditFile).toBe(true)
		expect(task.recordToolUsage).toHaveBeenCalledWith("generate_image")
	})

	it("renders the image with a cache-busting uri so a re-generation is visible", async () => {
		// Same path twice is the ordinary case; without the buster the webview
		// shows the previous picture.
		const { task, said } = makeTask()

		await tool.execute({ prompt: "a cat", path: "out.png" } as never, task as never, callbacks() as never)

		const payload = JSON.parse(said.find(([type]) => type === "image")![1])
		expect(payload.imageUri).toMatch(/[?&]t=\d+/)
		expect(payload.imagePath).toBe(path.join(cwd, "out.png"))
	})

	it("prefers a webview uri the host can render over a file:// url", async () => {
		const { task, said } = makeTask({
			providerRef: {
				deref: () => ({
					getState: async () => ({
						experiments: { [EXPERIMENT_IDS.IMAGE_GENERATION]: true },
						openRouterImageApiKey: "sk-or-test",
					}),
					convertToWebviewUri: (p: string) => `vscode-webview://host${p}`,
				}),
			},
		})

		await tool.execute({ prompt: "a cat", path: "out.png" } as never, task as never, callbacks() as never)

		expect(JSON.parse(said.find(([type]) => type === "image")![1]).imageUri).toContain("vscode-webview://host")
	})
})

describe("the streaming row", () => {
	it("renders nothing: the prompt is not worth a partial row", async () => {
		const { task } = makeTask()

		await expect(tool.handlePartial(task as never, { params: {}, partial: true } as never)).resolves.toBeUndefined()
	})
})
