import http from "http"
import { randomBytes } from "crypto"
import net from "net"
import { exec } from "child_process"

import { AUTH_BASE_URL } from "@/types/index.js"
import { saveToken } from "@/lib/storage/index.js"

export interface LoginOptions {
	timeout?: number
	verbose?: boolean
}

export type LoginResult =
	| {
			success: true
			token: string
	  }
	| {
			success: false
			error: string
	  }

const LOCALHOST = "127.0.0.1"

export async function login({ timeout = 5 * 60 * 1000, verbose = false }: LoginOptions = {}): Promise<LoginResult> {
	const state = randomBytes(16).toString("hex")
	const port = await getAvailablePort()
	const host = `http://${LOCALHOST}:${port}`

	if (verbose) {
		console.log(`[Auth] Starting local callback server on port ${port}`)
	}

	const corsHeaders = {
		"Access-Control-Allow-Origin": AUTH_BASE_URL,
		"Access-Control-Allow-Methods": "POST, OPTIONS",
		"Access-Control-Allow-Headers": "Content-Type",
	}

	// Create promise that will be resolved when we receive the callback.
	const tokenPromise = new Promise<{ token: string; state: string }>((resolve, reject) => {
		const server = http.createServer((req, res) => {
			const url = new URL(req.url!, host)

			// Handle CORS preflight request.
			if (req.method === "OPTIONS") {
				res.writeHead(204, corsHeaders)
				res.end()
				return
			}

			if (url.pathname === "/callback" && req.method === "POST") {
				const receivedState = url.searchParams.get("state")
				const token = url.searchParams.get("token")
				const error = url.searchParams.get("error")

				const sendJsonResponse = (status: number, body: object) => {
					res.writeHead(status, {
						...corsHeaders,
						"Content-Type": "application/json",
					})
					res.end(JSON.stringify(body))
				}

				if (error) {
					sendJsonResponse(400, { success: false, error })
					res.on("close", () => {
						server.close()
						reject(new Error(error))
					})
				} else if (!token) {
					sendJsonResponse(400, { success: false, error: "Missing token in callback" })
					res.on("close", () => {
						server.close()
						reject(new Error("Missing token in callback"))
					})
				} else if (receivedState !== state) {
					sendJsonResponse(400, { success: false, error: "Invalid state parameter" })
					res.on("close", () => {
						server.close()
						reject(new Error("Invalid state parameter"))
					})
				} else {
					sendJsonResponse(200, { success: true })
					res.on("close", () => {
						server.close()
						resolve({ token, state: receivedState })
					})
				}
			} else {
				res.writeHead(404, { "Content-Type": "text/plain" })
				res.end("Not found")
			}
		})

		server.listen(port, LOCALHOST)

		const timeoutId = setTimeout(() => {
			server.close()
			reject(new Error("Authentication timed out"))
		}, timeout)

		server.on("close", () => {
			clearTimeout(timeoutId)
		})
	})

	const authUrl = new URL(`${AUTH_BASE_URL}/cli/sign-in`)
	authUrl.searchParams.set("state", state)
	authUrl.searchParams.set("callback", `${host}/callback`)

	console.log("Opening browser for authentication...")
	console.log(`If the browser doesn't open, visit: ${authUrl.toString()}`)

	try {
		await openBrowser(authUrl.toString())
	} catch (error) {
		if (verbose) {
			console.warn("[Auth] Failed to open browser automatically:", error)
		}

		console.log("Please open the URL above in your browser manually.")
	}

	try {
		const { token } = await tokenPromise
		await saveToken(token)
		console.log("✓ Successfully authenticated!")
		return { success: true, token }
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		console.error(`✗ Authentication failed: ${message}`)
		return { success: false, error: message }
	}
}

async function getAvailablePort(startPort = 49152, endPort = 65535): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = net.createServer()
		let port = startPort

		const tryPort = () => {
			server.once("error", (err: NodeJS.ErrnoException) => {
				if (err.code === "EADDRINUSE" && port < endPort) {
					port++
					tryPort()
				} else {
					reject(err)
				}
			})

			server.once("listening", () => {
				server.close(() => {
					resolve(port)
				})
			})

			server.listen(port, LOCALHOST)
		}

		tryPort()
	})
}

function openBrowser(url: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const platform = process.platform
		let command: string

		switch (platform) {
			case "darwin":
				command = `open "${url}"`
				break
			case "win32":
				command = `start "" "${url}"`
				break
			default:
				// Linux and other Unix-like systems.
				command = `xdg-open "${url}"`
				break
		}

		exec(command, (error) => {
			if (error) {
				reject(error)
			} else {
				resolve()
			}
		})
	})
}
