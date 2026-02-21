import * as path from "path"
import { vi, describe, it, expect, beforeEach } from "vitest"

const appendSpy = vi.fn()
const mkdirSpy = vi.fn()
vi.mock("fs/promises", () => ({
	appendFile: (...args: unknown[]) => appendSpy(...args),
	mkdir: (...args: unknown[]) => mkdirSpy(...args),
}))

import { appendLessonLearned } from "../LessonRecording"

describe("LessonRecording", () => {
	const mockCwd = "/test/workspace"

	beforeEach(() => {
		vi.clearAllMocks()
		appendSpy.mockResolvedValue(undefined)
		mkdirSpy.mockResolvedValue(undefined)
	})

	it("creates .orchestration and appends a Lesson Learned section to AGENT.md", async () => {
		await appendLessonLearned(
			mockCwd,
			"src/foo.ts",
			"error TS2322: Type 'string' is not assignable to type 'number'.",
		)

		expect(mkdirSpy).toHaveBeenCalledWith(path.join(mockCwd, ".orchestration"), {
			recursive: true,
		})
		expect(appendSpy).toHaveBeenCalledTimes(1)
		const [targetPath, content] = appendSpy.mock.calls[0] as [string, string]
		expect(targetPath).toBe(path.join(mockCwd, ".orchestration", "AGENT.md"))
		expect(content).toContain("## Lesson Learned (")
		expect(content).toContain("**File:** src/foo.ts")
		expect(content).toContain("**Problems:**")
		expect(content).toContain("error TS2322")
		expect(content).toMatch(/\n\n$/)
	})

	it("does nothing when problemsMessage is empty", async () => {
		await appendLessonLearned(mockCwd, "src/foo.ts", "")
		await appendLessonLearned(mockCwd, "src/bar.ts", "   \n  ")

		expect(mkdirSpy).not.toHaveBeenCalled()
		expect(appendSpy).not.toHaveBeenCalled()
	})

	it("does not throw when appendFile fails (logs only)", async () => {
		appendSpy.mockRejectedValueOnce(new Error("disk full"))
		await expect(appendLessonLearned(mockCwd, "src/foo.ts", "some error")).resolves.toBeUndefined()
	})
})
