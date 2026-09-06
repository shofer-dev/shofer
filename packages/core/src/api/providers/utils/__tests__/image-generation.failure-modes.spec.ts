vi.mock("../../_deps.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../_deps.js")>()),
	t: (key: string, options?: Record<string, unknown>) =>
		options?.message ? String(options.message) : options ? `${key}:${JSON.stringify(options)}` : key,
}))

import { generateImageWithImagesApi, generateImageWithProvider } from "../image-generation.js"

/**
 * Image generation's REFUSALS, and the wire shape each request takes.
 *
 * The contract that matters is that neither entry point ever throws: both
 * return `{ success: false, error }`. The caller is a tool inside a turn — a
 * rejection would abort the agent's loop over a picture, where a refusal it can
 * report back to the model is recoverable (the model retries with a different
 * prompt, or moves on).
 *
 * The second thing pinned here is that the error the model reads is the
 * PROVIDER's own message when there is one. "Image generation failed" tells a
 * model nothing it can act on; "content policy violation" tells it to rewrite
 * the prompt, and "model not found" tells the user to change a setting.
 *
 * The two functions speak DIFFERENT endpoints on purpose — chat/completions
 * with a `modalities` hint for multimodal chat models, images/generations for
 * the dedicated image models — and an edit is expressed in-band in both, never
 * as a multipart `/images/edits` upload.
 */

const fetchMock = vi.fn()

const ok = (payload: unknown) => ({ ok: true, json: async () => payload })
const httpError = (status: number, statusText: string, body: string) => ({
	ok: false,
	status,
	statusText,
	text: async () => body,
})

const CHAT_ARGS = {
	baseURL: "https://api.example.com/v1",
	authToken: "test-token",
	model: "gemini-2.5-flash-image",
	prompt: "a cat",
}

const IMAGES_ARGS = {
	baseURL: "https://api.example.com/v1",
	authToken: "test-token",
	model: "gpt-image-1",
	prompt: "a cat",
}

const imageMessage = (url: string) => ({ choices: [{ message: { images: [{ image_url: { url } }] } }] })

const bodyOf = (call: number = 0) => JSON.parse(fetchMock.mock.calls[call]![1].body as string)

beforeEach(() => {
	fetchMock.mockReset()
	vi.stubGlobal("fetch", fetchMock)
})

afterEach(() => {
	vi.unstubAllGlobals()
})

describe("the chat-completions request", () => {
	it("asks the chat endpoint for both modalities and identifies the caller", async () => {
		fetchMock.mockResolvedValue(ok(imageMessage("data:image/png;base64,AAA")))

		await generateImageWithProvider(CHAT_ARGS)

		const [url, init] = fetchMock.mock.calls[0]!
		expect(url).toBe("https://api.example.com/v1/chat/completions")
		expect(init.headers).toMatchObject({
			Authorization: "Bearer test-token",
			"Content-Type": "application/json",
			"X-Title": "Shofer",
		})
		expect(bodyOf()).toMatchObject({ model: "gemini-2.5-flash-image", modalities: ["image", "text"] })
	})

	it("sends a plain prompt as the message content when generating from scratch", async () => {
		fetchMock.mockResolvedValue(ok(imageMessage("data:image/png;base64,AAA")))

		await generateImageWithProvider(CHAT_ARGS)

		expect(bodyOf().messages[0].content).toBe("a cat")
	})

	it("sends prompt AND image as content blocks when editing", async () => {
		// An edit is expressed in-band rather than as a multipart upload, which
		// is what lets one code path serve both.
		fetchMock.mockResolvedValue(ok(imageMessage("data:image/png;base64,AAA")))

		await generateImageWithProvider({ ...CHAT_ARGS, inputImage: "data:image/png;base64,INPUT" })

		expect(bodyOf().messages[0].content).toEqual([
			{ type: "text", text: "a cat" },
			{ type: "image_url", image_url: { url: "data:image/png;base64,INPUT" } },
		])
	})
})

describe("what the chat path returns", () => {
	it("hands back the data URL and the format it declares", async () => {
		fetchMock.mockResolvedValue(ok(imageMessage("data:image/jpeg;base64,AAA")))

		expect(await generateImageWithProvider(CHAT_ARGS)).toEqual({
			success: true,
			imageData: "data:image/jpeg;base64,AAA",
			imageFormat: "jpeg",
		})
	})

	it("prefers the PROVIDER's message over a generic status line", async () => {
		fetchMock.mockResolvedValue(
			httpError(400, "Bad Request", JSON.stringify({ error: { message: "content policy violation" } })),
		)

		const result = await generateImageWithProvider(CHAT_ARGS)

		expect(result).toEqual({ success: false, error: "content policy violation" })
	})

	it("falls back to the status when the error body is not JSON", async () => {
		fetchMock.mockResolvedValue(httpError(502, "Bad Gateway", "<html>nginx</html>"))

		const result = await generateImageWithProvider(CHAT_ARGS)

		expect(result.success).toBe(false)
		expect(result.error).toContain("502")
	})

	it("falls back to the status when the JSON body names no message", async () => {
		fetchMock.mockResolvedValue(httpError(500, "Server Error", JSON.stringify({ detail: "oops" })))

		const result = await generateImageWithProvider(CHAT_ARGS)

		expect(result.error).toContain("500")
	})

	it("reports an error the provider embedded in a 200 response", async () => {
		// A 200 carrying an error object is common enough that treating it as
		// success would hand the tool an undefined image.
		fetchMock.mockResolvedValue(ok({ error: { message: "quota exhausted" } }))

		expect(await generateImageWithProvider(CHAT_ARGS)).toEqual({ success: false, error: "quota exhausted" })
	})

	it.each([
		["no choices at all", {}],
		["a choice with no images", { choices: [{ message: {} }] }],
		["an empty images array", { choices: [{ message: { images: [] } }] }],
	])("refuses a 200 carrying %s", async (_case, payload) => {
		fetchMock.mockResolvedValue(ok(payload))

		expect((await generateImageWithProvider(CHAT_ARGS)).success).toBe(false)
	})

	it("refuses an image entry carrying no url", async () => {
		fetchMock.mockResolvedValue(ok({ choices: [{ message: { images: [{ image_url: {} }] } }] }))

		expect((await generateImageWithProvider(CHAT_ARGS)).success).toBe(false)
	})

	it("refuses a url that is not a supported data image", async () => {
		// The tool writes the bytes to disk with the declared extension, so an
		// unrecognized format would produce a file nothing can open.
		fetchMock.mockResolvedValue(ok(imageMessage("https://cdn.example.com/image.webp")))

		expect((await generateImageWithProvider(CHAT_ARGS)).success).toBe(false)
	})

	it("reports a transport failure as a refusal, not a throw", async () => {
		fetchMock.mockRejectedValue(new Error("ECONNRESET"))

		expect(await generateImageWithProvider(CHAT_ARGS)).toEqual({ success: false, error: "ECONNRESET" })
	})

	it("reports a non-Error rejection without leaking [object Object]", async () => {
		fetchMock.mockRejectedValue({ weird: true })

		const result = await generateImageWithProvider(CHAT_ARGS)

		expect(result.success).toBe(false)
		expect(result.error).not.toContain("[object Object]")
	})
})

describe("the images-API path", () => {
	it("asks the images endpoint and carries an edit in the request body", async () => {
		fetchMock.mockResolvedValue(ok({ data: [{ b64_json: "AAA" }] }))

		await generateImageWithImagesApi({ ...IMAGES_ARGS, inputImage: "data:image/png;base64,INPUT" })

		expect(fetchMock.mock.calls[0]![0]).toBe("https://api.example.com/v1/images/generations")
		// NOT /images/edits: one endpoint serves both, so there is no multipart
		// path to keep working.
		expect(fetchMock.mock.calls[0]![0]).not.toContain("/images/edits")
	})

	it("returns a base64 payload as a data URL in the requested format", async () => {
		fetchMock.mockResolvedValue(ok({ data: [{ b64_json: "AAA" }] }))

		expect(await generateImageWithImagesApi({ ...IMAGES_ARGS, outputFormat: "jpeg" })).toEqual({
			success: true,
			imageData: "data:image/jpeg;base64,AAA",
			imageFormat: "jpeg",
		})
	})

	it("passes an external URL straight through", async () => {
		fetchMock.mockResolvedValue(ok({ data: [{ url: "https://cdn.example.com/out.png" }] }))

		const result = await generateImageWithImagesApi(IMAGES_ARGS)

		expect(result).toMatchObject({ success: true, imageData: "https://cdn.example.com/out.png" })
	})

	it("reports a transport failure as a refusal", async () => {
		fetchMock.mockRejectedValue(new Error("ETIMEDOUT"))

		const result = await generateImageWithImagesApi(IMAGES_ARGS)

		expect(result.success).toBe(false)
		expect(result.error).toContain("ETIMEDOUT")
	})
})
