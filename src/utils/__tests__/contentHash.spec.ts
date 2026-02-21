import { contentHashSha256 } from "../contentHash"

describe("contentHashSha256", () => {
	it("returns same hash for same content", () => {
		const content = "const x = 1\n"
		expect(contentHashSha256(content)).toBe(contentHashSha256(content))
	})

	it("returns different hash for different content", () => {
		expect(contentHashSha256("a")).not.toBe(contentHashSha256("b"))
		expect(contentHashSha256("line1")).not.toBe(contentHashSha256("line1\nline2"))
	})

	it("prefixes with sha256:", () => {
		expect(contentHashSha256("x")).toMatch(/^sha256:[a-f0-9]{64}$/)
	})

	it("handles empty string", () => {
		const hash = contentHashSha256("")
		expect(hash).toMatch(/^sha256:[a-f0-9]{64}$/)
		expect(contentHashSha256("")).toBe(hash)
	})
})
