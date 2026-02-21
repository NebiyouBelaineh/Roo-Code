import * as path from "path"
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest"

const mockReadFile = vi.fn()
const mockMkdir = vi.fn()
const mockWriteFile = vi.fn()

vi.mock("fs/promises", () => ({
	readFile: (...args: unknown[]) => mockReadFile(...args),
	mkdir: (...args: unknown[]) => mockMkdir(...args),
	writeFile: (...args: unknown[]) => mockWriteFile(...args),
}))

import { runIntentMapPostHook } from "../IntentMapPostHook"

const ORCHESTRATION_DIR = ".orchestration"
const INTENT_MAP_FILENAME = "intent_map.md"
const ACTIVE_INTENTS_FILENAME = "active_intents.yaml"

describe("IntentMapPostHook", () => {
	const mockCwd = "/test/workspace"
	const activeIntentsPath = path.join(mockCwd, ORCHESTRATION_DIR, ACTIVE_INTENTS_FILENAME)
	const intentMapPath = path.join(mockCwd, ORCHESTRATION_DIR, INTENT_MAP_FILENAME)
	const orchestrationDir = path.join(mockCwd, ORCHESTRATION_DIR)

	const mockTask = { cwd: mockCwd } as any
	let consoleErrorSpy: ReturnType<typeof vi.spyOn>

	beforeEach(() => {
		vi.clearAllMocks()
		consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		// Default: no active_intents.yaml (use intent_id only); intent_map missing
		mockReadFile.mockRejectedValue(new Error("ENOENT"))
		mockMkdir.mockResolvedValue(undefined)
		mockWriteFile.mockResolvedValue(undefined)
	})

	afterEach(() => {
		consoleErrorSpy.mockRestore()
	})

	it("when intent_map.md is missing, creates file with one section and the given path", async () => {
		await runIntentMapPostHook(mockTask, { intent_id: "INT-WEATHER", path: "src/weather.ts" })

		expect(mockMkdir).toHaveBeenCalledWith(orchestrationDir, { recursive: true })
		expect(mockWriteFile).toHaveBeenCalledTimes(1)
		const written = mockWriteFile.mock.calls[0][1] as string
		expect(written).toContain("# Intent Map")
		expect(written).toContain("## INT-WEATHER")
		expect(written).toContain("- `src/weather.ts`")
	})

	it("when section for intent exists, appends path and dedupes (same path twice → still one entry)", async () => {
		const existingContent = ["# Intent Map", "", "## INT-001", "", "- `src/foo.ts`", ""].join("\n")
		mockReadFile.mockImplementation((p: string) => {
			if (p === intentMapPath) return Promise.resolve(existingContent)
			return Promise.reject(new Error("ENOENT"))
		})

		await runIntentMapPostHook(mockTask, { intent_id: "INT-001", path: "src/foo.ts" })
		await runIntentMapPostHook(mockTask, { intent_id: "INT-001", path: "src/foo.ts" })

		expect(mockWriteFile).toHaveBeenCalledTimes(2)
		const written = mockWriteFile.mock.calls[1][1] as string
		const pathLines = written.split("\n").filter((l) => l.startsWith("- `"))
		expect(pathLines).toHaveLength(1)
		expect(pathLines[0]).toBe("- `src/foo.ts`")
	})

	it("when section for intent exists, appends a new path", async () => {
		const existingContent = ["# Intent Map", "", "## INT-001", "", "- `src/foo.ts`", ""].join("\n")
		mockReadFile.mockImplementation((p: string) => {
			if (p === intentMapPath) return Promise.resolve(existingContent)
			return Promise.reject(new Error("ENOENT"))
		})

		await runIntentMapPostHook(mockTask, { intent_id: "INT-001", path: "src/bar.ts" })

		const written = mockWriteFile.mock.calls[0][1] as string
		expect(written).toContain("- `src/bar.ts`")
		expect(written).toContain("- `src/foo.ts`")
	})

	it("when section does not exist, adds new section at end with the path", async () => {
		const existingContent = ["# Intent Map", "", "## INT-OTHER", "", "- `other.ts`", ""].join("\n")
		mockReadFile.mockImplementation((p: string) => {
			if (p === intentMapPath) return Promise.resolve(existingContent)
			return Promise.reject(new Error("ENOENT"))
		})

		await runIntentMapPostHook(mockTask, { intent_id: "INT-NEW", path: "src/new.ts" })

		const written = mockWriteFile.mock.calls[0][1] as string
		const sectionHeaders = written.split("\n").filter((l) => l.startsWith("## "))
		expect(sectionHeaders[0]).toBe("## INT-OTHER")
		expect(sectionHeaders[1]).toBe("## INT-NEW")
		expect(written).toContain("- `src/new.ts`")
	})

	it("resolves intent name from active_intents.yaml: section header is ## ID: Name", async () => {
		const activeIntentsYaml = `
active_intents:
  - id: INT-WEATHER
    name: Build Weather API
`
		mockReadFile.mockImplementation((p: string) => {
			if (p === activeIntentsPath) return Promise.resolve(activeIntentsYaml)
			if (p === intentMapPath) return Promise.reject(new Error("ENOENT"))
			return Promise.reject(new Error("ENOENT"))
		})

		await runIntentMapPostHook(mockTask, { intent_id: "INT-WEATHER", path: "src/weather.ts" })

		const written = mockWriteFile.mock.calls[0][1] as string
		expect(written).toContain("## INT-WEATHER: Build Weather API")
		expect(written).toContain("- `src/weather.ts`")
	})

	it("when intent not in active_intents.yaml, section uses id only", async () => {
		const activeIntentsYaml = `
active_intents:
  - id: INT-OTHER
    name: Other Intent
`
		mockReadFile.mockImplementation((p: string) => {
			if (p === activeIntentsPath) return Promise.resolve(activeIntentsYaml)
			if (p === intentMapPath) return Promise.reject(new Error("ENOENT"))
			return Promise.reject(new Error("ENOENT"))
		})

		await runIntentMapPostHook(mockTask, { intent_id: "INT-MISSING", path: "src/missing.ts" })

		const written = mockWriteFile.mock.calls[0][1] as string
		expect(written).toContain("## INT-MISSING")
		expect(written).not.toMatch(/## INT-MISSING:/)
	})

	it("on error (e.g. write failure), hook does not throw and logs", async () => {
		mockWriteFile.mockRejectedValue(new Error("EACCES"))

		await expect(
			runIntentMapPostHook(mockTask, { intent_id: "INT-001", path: "src/foo.ts" }),
		).resolves.toBeUndefined()

		expect(consoleErrorSpy).toHaveBeenCalledWith(
			"[IntentMapPostHook] Failed to update intent map:",
			expect.any(Error),
		)
	})
})
