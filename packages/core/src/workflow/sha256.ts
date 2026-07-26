/**
 * SHA-256, in pure TypeScript.
 *
 * # Why not `node:crypto`
 *
 * This runs inside a Temporal workflow. The workflow bundle admits no external
 * import — not as a style rule but because the sandbox is a determinism sandbox,
 * and the sync guard that builds the bundle fails the build on one. So the hash
 * that names a capability queue has to be computed from arithmetic the bundle
 * already has.
 *
 * The choice of SHA-256 is not ours to revisit: `shared/tagexpr` (Go) is the
 * canonical implementation and hashes the canonical serialization this way. This
 * file exists to reproduce that byte-for-byte, so a queue named by the Go
 * registrar is the queue the TypeScript interpreter dispatches to.
 *
 * Not a security primitive and not used as one — it names a queue.
 */

/** Round constants: the cube-root fractional bits of the first 64 primes. */
const K = new Uint32Array([
	0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
	0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
	0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
	0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
	0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
	0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
	0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
	0xc67178f2,
])

/** Rotate a 32-bit word right. */
function rotr(x: number, n: number): number {
	return ((x >>> n) | (x << (32 - n))) >>> 0
}

/**
 * UTF-8 encode without `TextEncoder`.
 *
 * Tag atoms are ASCII by the charset rule, but the input is a serialization and
 * encoding it correctly is cheaper than assuming — a non-ASCII byte must hash
 * the same here as in Go's `[]byte(s)`, not silently truncate.
 */
function utf8Bytes(s: string): number[] {
	const out: number[] = []
	for (let i = 0; i < s.length; i++) {
		let c = s.charCodeAt(i)
		if (c < 0x80) {
			out.push(c)
		} else if (c < 0x800) {
			out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f))
		} else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
			// Surrogate pair → one code point.
			const lo = s.charCodeAt(++i)
			c = 0x10000 + ((c - 0xd800) << 10) + (lo - 0xdc00)
			out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f))
		} else {
			out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f))
		}
	}
	return out
}

/** Lowercase hex SHA-256 of a string. */
export function sha256Hex(input: string): string {
	const bytes = utf8Bytes(input)
	const bitLen = bytes.length * 8

	// Pad: 0x80, then zeros to 56 mod 64, then the length as a 64-bit big-endian.
	bytes.push(0x80)
	while (bytes.length % 64 !== 56) bytes.push(0)
	// The high word is always 0 here: a canonical serialization is never 512MB.
	bytes.push(0, 0, 0, 0, (bitLen >>> 24) & 0xff, (bitLen >>> 16) & 0xff, (bitLen >>> 8) & 0xff, bitLen & 0xff)

	const h = new Uint32Array([
		0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
	])
	const w = new Uint32Array(64)

	for (let off = 0; off < bytes.length; off += 64) {
		for (let i = 0; i < 16; i++) {
			w[i] =
				((bytes[off + i * 4]! << 24) |
					(bytes[off + i * 4 + 1]! << 16) |
					(bytes[off + i * 4 + 2]! << 8) |
					bytes[off + i * 4 + 3]!) >>>
				0
		}
		for (let i = 16; i < 64; i++) {
			const s0 = rotr(w[i - 15]!, 7) ^ rotr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3)
			const s1 = rotr(w[i - 2]!, 17) ^ rotr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10)
			w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0
		}

		let [a, b, c, d, e, f, g, hh] = [h[0]!, h[1]!, h[2]!, h[3]!, h[4]!, h[5]!, h[6]!, h[7]!]
		for (let i = 0; i < 64; i++) {
			const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
			const ch = (e & f) ^ (~e & g)
			const t1 = (hh + S1 + ch + K[i]! + w[i]!) >>> 0
			const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
			const maj = (a & b) ^ (a & c) ^ (b & c)
			const t2 = (S0 + maj) >>> 0
			hh = g
			g = f
			f = e
			e = (d + t1) >>> 0
			d = c
			c = b
			b = a
			a = (t1 + t2) >>> 0
		}
		h[0] = (h[0]! + a) >>> 0
		h[1] = (h[1]! + b) >>> 0
		h[2] = (h[2]! + c) >>> 0
		h[3] = (h[3]! + d) >>> 0
		h[4] = (h[4]! + e) >>> 0
		h[5] = (h[5]! + f) >>> 0
		h[6] = (h[6]! + g) >>> 0
		h[7] = (h[7]! + hh) >>> 0
	}

	let out = ""
	for (let i = 0; i < 8; i++) out += h[i]!.toString(16).padStart(8, "0")
	return out
}
