import * as path from "path"
import { vi, describe, it, expect, beforeEach } from "vitest"

import { contentHashSha256 } from "../../utils/contentHash"

const mockReadFile = vi.fn()
const appendSpy = vi.fn()
const mkdirSpy = vi.fn()
vi.mock("fs/promises", () => ({
	readFile: (...args: unknown[]) => mockReadFile(...args),
	mkdir: (...args: unknown[]) => mkdirSpy(...args),
	appendFile: (...args: unknown[]) => appendSpy(...args),
}))
vi.mock("../../utils/git", () => ({
	getCurrentRevision: vi.fn().mockResolvedValue("abc123sha"),
}))

import { runAgentTracePostHook } from "../AgentTracePostHook"

describe("AgentTracePostHook", () => {
	const mockCwd = "/test/workspace"

	beforeEach(() => {
		vi.clearAllMocks()
		mockReadFile.mockResolvedValue("line1\nline2\n")
		appendSpy.mockResolvedValue(undefined)
		mkdirSpy.mockResolvedValue(undefined)
	})

	it("appends one JSON line to .orchestration/agent_trace.jsonl with intent_id in related", async () => {
		const mockTask = {
			cwd: mockCwd,
			taskId: "task-uuid-1",
			api: { getModel: () => ({ id: "claude-3-5-sonnet" }) },
		} as any

		await runAgentTracePostHook(mockTask, {
			path: "src/foo.ts",
			content: "line1\nline2\n",
			intent_id: "INT-001",
		})

		expect(mkdirSpy).toHaveBeenCalledWith(path.join(mockCwd, ".orchestration"), {
			recursive: true,
		})
		expect(appendSpy).toHaveBeenCalledTimes(1)
		// appendFile(tracePath, data, encoding) -> args[1] is the JSON line
		const appended = appendSpy.mock.calls[0][1] as string
		expect(appended).toMatch(/\n$/)
		const entry = JSON.parse(appended.trim()) as Record<string, unknown>
		expect(entry.id).toBeDefined()
		expect(entry.timestamp).toBeDefined()
		expect(entry.vcs).toEqual({ revision_id: "abc123sha" })
		expect(entry.files).toHaveLength(1)
		const file = (entry.files as any[])[0]
		expect(file.relative_path).toBe("src/foo.ts")
		expect(file.conversations).toHaveLength(1)
		const conv = file.conversations[0]
		expect(conv.url).toBe("task-uuid-1")
		expect(conv.contributor).toEqual({ entity_type: "AI", model_identifier: "claude-3-5-sonnet" })
		expect(conv.related).toEqual([{ type: "specification", value: "INT-001" }])
		expect(conv.ranges).toHaveLength(1)
		expect(conv.ranges[0].content_hash).toMatch(/^sha256:[a-f0-9]{64}$/)
		expect(conv.ranges[0].start_line).toBe(1)
		// "line1\nline2\n" -> 3 lines (trailing newline gives empty third line)
		expect(conv.ranges[0].end_line).toBe(3)
	})

	it("does nothing when intent_id is missing", async () => {
		const mockTask = { cwd: mockCwd, taskId: "t1", api: {} } as any
		await runAgentTracePostHook(mockTask, {
			path: "src/foo.ts",
			intent_id: "",
		})
		expect(appendSpy).not.toHaveBeenCalled()
	})

	it("uses fallback content when file read fails", async () => {
		mockReadFile.mockRejectedValue(new Error("ENOENT"))
		const mockTask = {
			cwd: mockCwd,
			taskId: "t2",
			api: { getModel: () => ({ id: "model-x" }) },
		} as any
		await runAgentTracePostHook(mockTask, {
			path: "new.ts",
			content: "fallback content",
			intent_id: "INT-002",
		})
		expect(appendSpy).toHaveBeenCalledTimes(1)
		const entry = JSON.parse((appendSpy.mock.calls[0][1] as string).trim())
		const hash = entry.files[0].conversations[0].ranges[0].content_hash
		expect(hash).toBe(contentHashSha256("fallback content"))
	})
})
