import { createLocalJWKSet, createRemoteJWKSet, jwtVerify, type JSONWebKeySet, type JWTVerifyGetKey } from "jose"

/**
 * Who the AgentApi believes its caller is.
 *
 * A served node has always had exactly one answer to that question — a shared
 * bearer, exact-matched, identical for every caller — which is a NETWORK gate
 * rather than authentication: it says a request came from inside the perimeter
 * and nothing about whom it came from. Every node driven by more than one
 * user's controller therefore has to trust that controller to be the only thing
 * standing between two of its users, because the node itself cannot tell them
 * apart.
 *
 * This module is the second answer: an ordinary OIDC-shaped bearer JWT,
 * verified per request against a configured issuer, audience and key set. It is
 * deliberately GENERIC — an issuer URL, an audience, a JWKS location and the
 * name of a claim — because a served node is a FOSS agent runtime and must not
 * learn the shape of any particular deployment's identity plane. Everything
 * deployment-specific (who mints, what the audience is called, which claim
 * carries the confinement) is configuration.
 *
 * Two properties come out of it, and they are different in kind:
 *
 *   - **Authentication.** The credential names a subject and expires on its
 *     own, so a leaked one is a bounded, attributable loss rather than a
 *     standing master key.
 *   - **Confinement.** When the credential carries a task claim, it may address
 *     exactly that task and no other, and it may not open the node-wide event
 *     stream at all. That check is STATELESS — the binding is in the token, not
 *     in a table here — which is what makes it survive a node being restarted,
 *     rescheduled, or handed a task that was created on a peer. A node that
 *     kept the binding in memory would silently stop enforcing it for every
 *     task it rehydrated, which is the worst possible failure for a control.
 *
 * Nothing here decides what a caller may DO. That is the controller's job and
 * stays there; this module only refuses a caller that cannot prove who it is,
 * and a credential used somewhere it does not reach.
 */

/** The two credentials a node accepts, and which one a request presented. */
export type CredentialKind = "jwt" | "node-token"

/**
 * How a node treats the two credentials while a deployment migrates from one to
 * the other. The names are the ratchet's positions and it only ever turns one
 * way:
 *
 *   - `observe` — a JWT is preferred and a node token is still accepted. A
 *     request that falls back is REPORTED (see {@link NodeAuthOptions.onAuthEvent}),
 *     so the migration's progress is a number an operator can watch rather than
 *     a thing to hope about. This is the only position in which a caller that
 *     has not been taught to mint a JWT keeps working.
 *   - `require` — the JWT is the only accepted credential; a node token is
 *     refused even when one is configured. The configuration deliberately
 *     survives the flip rather than being deleted with it, so the position can
 *     be walked back within one restart if the mint side turns out to be
 *     broken.
 *
 * There is no `off`: not configuring `jwt` at all is that position, and a flag
 * value that disables a control is a control one config edit away from being
 * absent.
 */
export type NodeAuthPosture = "observe" | "require"

/** Signature algorithms accepted when a deployment names none. */
export const DEFAULT_JWT_ALGORITHMS = ["RS256", "ES256"] as const

/** Clock skew tolerated on `exp`/`nbf`, in seconds, when none is configured. */
export const DEFAULT_JWT_CLOCK_TOLERANCE_SEC = 30

/**
 * Per-request JWT verification, as a deployment states it.
 *
 * `issuer` and `audience` are both REQUIRED and both are checked. An audience
 * is what stops a token minted for some other service being replayed here, and
 * an issuer is what stops one minted by a different issuer in the same estate;
 * either left open turns verification into "this is a well-formed JWT signed by
 * somebody", which is not a statement about anything.
 */
export interface JwtAuthConfig {
	/** Required `iss`. */
	issuer: string
	/** Required `aud` — the node's own name in the deployment's token estate. */
	audience: string
	/**
	 * Where the issuer's public keys are fetched from. `jose` caches the set,
	 * re-fetches on an unknown `kid` (rate-limited by its own cooldown) and
	 * therefore follows a key rotation without a restart.
	 */
	jwksUri?: string
	/**
	 * A key set stated inline instead of fetched. For an issuer with no HTTP
	 * endpoint, and for tests. Exactly one of `jwksUri`/`jwks` must be given.
	 */
	jwks?: JSONWebKeySet
	/** Accepted signature algorithms. Defaults to {@link DEFAULT_JWT_ALGORITHMS}. */
	algorithms?: string[]
	/** Clock skew tolerance in seconds. Defaults to {@link DEFAULT_JWT_CLOCK_TOLERANCE_SEC}. */
	clockToleranceSec?: number
	/**
	 * The claim carrying the ONE task this credential may address. Unset means
	 * the credential is unconfined: it authenticates its caller and reaches
	 * every task on the node, which is the honest state for a deployment whose
	 * mint cannot yet scope a token to a task.
	 *
	 * When set, the claim is REQUIRED — a token without it is refused rather
	 * than treated as unconfined. A confinement that silently degrades to "no
	 * confinement" the day the mint stops populating a field is not one.
	 */
	taskClaim?: string
	/** The ratchet position. */
	posture: NodeAuthPosture
}

/** The caller a verified credential names. */
export interface AuthenticatedCaller {
	/** Which credential was presented. */
	credential: CredentialKind
	/** The token's `sub`, for a JWT. A node token names nobody, by construction. */
	subject?: string
	/** The one task this credential may address; `undefined` = unconfined. */
	taskId?: string
}

/** What the node reports about a request's authentication, for an operator. */
export interface AuthEvent {
	/**
	 * `jwt` — a JWT verified.
	 * `node-token` — the shared bearer was accepted; under `observe` this is
	 *   the number that must reach zero before the posture can be flipped.
	 * `rejected` — neither credential was accepted.
	 */
	outcome: "jwt" | "node-token" | "rejected"
	/** The posture in force. */
	posture: NodeAuthPosture
	/** Why verification failed, when it did. Never contains the token. */
	reason?: string
	/** The verified subject, when there is one. */
	subject?: string
}

/** Options for {@link createNodeAuthenticator}. */
export interface NodeAuthOptions {
	/** The shared bearer. Unset = the node accepts no node token at all. */
	token?: string
	/** Per-request JWT verification. Unset = the node verifies no JWTs. */
	jwt?: JwtAuthConfig
	/**
	 * Called once per authenticated (or refused) `/api/v1/*` request. The
	 * transport itself logs nothing — a core module that wrote to a console
	 * would be a second logging convention every host then has to silence — so
	 * this is how a host surfaces the ratchet's progress.
	 */
	onAuthEvent?: (event: AuthEvent) => void
}

/** A refusal: the status to answer with, and a reason safe to put on the wire. */
export interface AuthRefusal {
	status: 401 | 403
	error: string
}

/** The result of authenticating one request. */
export type AuthOutcome = { ok: true; caller: AuthenticatedCaller } | ({ ok: false } & AuthRefusal)

/**
 * The node's authentication surface: one call per request, plus the two scope
 * checks a route makes once it knows which task (if any) it addresses.
 */
export interface NodeAuthenticator {
	/** Whether anything is gated at all. `false` = the open, loopback/dev node. */
	readonly enabled: boolean
	/** The posture in force, for a startup banner. `undefined` = no JWT configured. */
	readonly posture?: NodeAuthPosture
	/** Verify a request's `Authorization` header. */
	authenticate(authorization: string | undefined): Promise<AuthOutcome>
	/**
	 * May this caller address `taskId`? A confined credential may address only
	 * the task it names; an unconfined one may address any.
	 */
	checkTaskScope(caller: AuthenticatedCaller, taskId: string): AuthRefusal | undefined
	/**
	 * May this caller open a NODE-WIDE surface — the firehose event stream,
	 * which carries every task's content for every user on this node?
	 *
	 * A task-confined credential may not, and that refusal is the whole point
	 * of confinement: without it, a credential scoped to one task could read
	 * every other task's transcript by asking a different route for it.
	 */
	checkNodeScope(caller: AuthenticatedCaller): AuthRefusal | undefined
}

/** The bearer value of an `Authorization` header, or `undefined`. */
function bearer(authorization: string | undefined): string | undefined {
	if (!authorization) return undefined
	const [scheme, ...rest] = authorization.split(" ")
	if (scheme?.toLowerCase() !== "bearer") return undefined
	const value = rest.join(" ").trim()
	return value || undefined
}

/**
 * Constant-time-ish comparison for the shared bearer. Node's own
 * `crypto.timingSafeEqual` throws on a length mismatch, which leaks the length
 * through the exception path, so the lengths are folded into the result instead
 * of being branched on.
 */
function tokenMatches(presented: string, expected: string): boolean {
	let diff = presented.length ^ expected.length
	for (let i = 0; i < presented.length; i++) {
		diff |= presented.charCodeAt(i) ^ expected.charCodeAt(i % expected.length)
	}
	return diff === 0
}

function keyResolver(cfg: JwtAuthConfig): JWTVerifyGetKey {
	if (cfg.jwks) return createLocalJWKSet(cfg.jwks)
	if (cfg.jwksUri) return createRemoteJWKSet(new URL(cfg.jwksUri))
	// Unreachable via createNodeAuthenticator, which refuses the configuration.
	throw new Error("jwt auth: neither jwksUri nor jwks was configured")
}

/**
 * Build the node's authenticator from what a deployment configured.
 *
 * Configuration errors THROW, at construction, rather than being carried into
 * the request path. A node that started with a misconfigured verifier and
 * failed every request identically to one under attack is the failure mode this
 * exists to avoid: a gate that is broken must not be indistinguishable from a
 * gate that is working.
 */
export function createNodeAuthenticator(opts: NodeAuthOptions = {}): NodeAuthenticator {
	const { token, jwt: cfg, onAuthEvent } = opts

	if (cfg) {
		if (!cfg.issuer) throw new Error("jwt auth: issuer is required")
		if (!cfg.audience) throw new Error("jwt auth: audience is required")
		if (!cfg.jwksUri === !cfg.jwks) {
			throw new Error("jwt auth: exactly one of jwksUri or jwks must be configured")
		}
		if (cfg.posture !== "observe" && cfg.posture !== "require") {
			throw new Error(`jwt auth: posture must be "observe" or "require", got ${String(cfg.posture)}`)
		}
		if (cfg.posture === "observe" && !token) {
			// `observe` exists to keep a not-yet-migrated caller working. With no
			// node token to fall back to it is `require` wearing a name that says
			// otherwise — and the name is what an operator reads when deciding
			// whether it is safe to flip.
			throw new Error('jwt auth: posture "observe" needs a node token to fall back to; use "require"')
		}
	}

	const getKey = cfg ? keyResolver(cfg) : undefined
	const algorithms = cfg?.algorithms?.length ? [...cfg.algorithms] : [...DEFAULT_JWT_ALGORITHMS]
	const clockTolerance = cfg?.clockToleranceSec ?? DEFAULT_JWT_CLOCK_TOLERANCE_SEC
	const report = (event: AuthEvent) => onAuthEvent?.(event)

	async function verifyJwt(raw: string): Promise<{ caller: AuthenticatedCaller } | { reason: string }> {
		if (!cfg || !getKey) return { reason: "no jwt verifier configured" }
		try {
			const { payload } = await jwtVerify(raw, getKey, {
				issuer: cfg.issuer,
				audience: cfg.audience,
				algorithms,
				clockTolerance,
				// `sub` is not optional here: it is the whole reason to prefer a
				// JWT over the shared bearer, so a token without one is a
				// credential that names nobody and buys nothing.
				requiredClaims: cfg.taskClaim ? ["sub", cfg.taskClaim] : ["sub"],
			})
			const subject = typeof payload.sub === "string" ? payload.sub : undefined
			if (!subject) return { reason: "token has no subject" }
			let taskId: string | undefined
			if (cfg.taskClaim) {
				const claimed = payload[cfg.taskClaim]
				if (typeof claimed !== "string" || !claimed) {
					return { reason: `token claim ${cfg.taskClaim} is not a task id` }
				}
				taskId = claimed
			}
			return { caller: { credential: "jwt", subject, taskId } }
		} catch (error) {
			return { reason: error instanceof Error ? error.message : String(error) }
		}
	}

	return {
		enabled: Boolean(token || cfg),
		posture: cfg?.posture,

		async authenticate(authorization) {
			if (!token && !cfg) return { ok: true, caller: { credential: "node-token" } }

			const presented = bearer(authorization)
			if (!presented) {
				report({ outcome: "rejected", posture: cfg?.posture ?? "require", reason: "no bearer token" })
				return { ok: false, status: 401, error: "unauthorized" }
			}

			if (cfg) {
				const verified = await verifyJwt(presented)
				if ("caller" in verified) {
					report({ outcome: "jwt", posture: cfg.posture, subject: verified.caller.subject })
					return { ok: true, caller: verified.caller }
				}
				if (cfg.posture === "require") {
					report({ outcome: "rejected", posture: cfg.posture, reason: verified.reason })
					return { ok: false, status: 401, error: "unauthorized" }
				}
				// `observe`: the node token is still good, and the fallback is
				// counted. The verification failure is reported either way — a
				// caller that IS presenting a JWT and getting it rejected looks
				// exactly like one that never learned to mint one, and telling
				// those apart is the only way to know the flip is safe.
				if (token && tokenMatches(presented, token)) {
					report({ outcome: "node-token", posture: cfg.posture, reason: verified.reason })
					return { ok: true, caller: { credential: "node-token" } }
				}
				report({ outcome: "rejected", posture: cfg.posture, reason: verified.reason })
				return { ok: false, status: 401, error: "unauthorized" }
			}

			if (token && tokenMatches(presented, token)) {
				return { ok: true, caller: { credential: "node-token" } }
			}
			report({ outcome: "rejected", posture: "require", reason: "node token mismatch" })
			return { ok: false, status: 401, error: "unauthorized" }
		},

		checkTaskScope(caller, taskId) {
			if (!caller.taskId || caller.taskId === taskId) return undefined
			return { status: 403, error: "credential is scoped to a different task" }
		},

		checkNodeScope(caller) {
			if (!caller.taskId) return undefined
			return { status: 403, error: "credential is scoped to a single task" }
		},
	}
}
