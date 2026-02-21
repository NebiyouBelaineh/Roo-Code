import { createHash } from "crypto"

/**
 * Computes a SHA-256 hash of string content for spatial independence in agent trace.
 * Same content yields the same hash regardless of line position (e.g. after refactors).
 * Format per Phase 3 spec: "sha256:" + hex digest.
 */
export function contentHashSha256(content: string): string {
	const digest = createHash("sha256").update(content, "utf8").digest("hex")
	return `sha256:${digest}`
}
