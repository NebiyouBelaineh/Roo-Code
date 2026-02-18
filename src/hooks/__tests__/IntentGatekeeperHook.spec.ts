import { describe, it, expect, vi, beforeEach } from "vitest"
import * as fs from "fs/promises"
import * as yaml from "yaml"
import { IntentGatekeeperHook } from "../IntentGatekeeperHook"
import type { HookContext } from "../types"
import type { Task } from "../../core/task/Task"
import type { ToolUse } from "../../shared/tools"

// Mock dependencies
vi.mock("fs/promises", () => ({
	readFile: vi.fn(),
}))

vi.mock("yaml", () => ({
	parse: vi.fn(),
}))

describe("IntentGatekeeperHook", () => {
	let hook: IntentGatekeeperHook
	let mockTask: Partial<Task> & { activeIntentId?: string; activeIntent?: any }
	let mockToolUse: ToolUse<"write_to_file">

	beforeEach(() => {
		vi.clearAllMocks()
		hook = new IntentGatekeeperHook()

		// Create mock task
		mockTask = {
			cwd: "/test/workspace",
			activeIntentId: undefined,
			activeIntent: undefined,
		} as Partial<Task> & { activeIntentId?: string; activeIntent?: any }

		// Create mock tool use block
		mockToolUse = {
			type: "tool_use",
			name: "write_to_file",
			id: "toolu_abc123",
			params: {
				path: "test.ts",
				content: "test content",
			},
			nativeArgs: {
				path: "test.ts",
				content: "test content",
			},
			partial: false,
		}
	})

	describe("Destructive tools without intent", () => {
		const destructiveTools = [
			"write_to_file",
			"edit",
			"edit_file",
			"search_replace",
			"apply_diff",
			"apply_patch",
			"execute_command",
		] as const

		it.each(destructiveTools)("should block %s when no intent is selected", async (toolName) => {
			mockToolUse.name = toolName as any
			mockToolUse.nativeArgs = {} as any

			const context: HookContext = {
				task: mockTask as Task,
				toolName: toolName as any,
				toolUse: mockToolUse as any,
			}

			const result = await hook.check(context)

			expect(result.allow).toBe(false)
			expect(result.error).toBe("You must cite a valid active Intent ID.")
		})

		it("should block write_to_file when activeIntentId is undefined", async () => {
			mockTask.activeIntentId = undefined

			const context: HookContext = {
				task: mockTask as Task,
				toolName: "write_to_file",
				toolUse: mockToolUse as any,
			}

			const result = await hook.check(context)

			expect(result.allow).toBe(false)
			expect(result.error).toBe("You must cite a valid active Intent ID.")
		})

		it("should block write_to_file when activeIntentId is empty string", async () => {
			mockTask.activeIntentId = ""

			const context: HookContext = {
				task: mockTask as Task,
				toolName: "write_to_file",
				toolUse: mockToolUse as any,
			}

			const result = await hook.check(context)

			expect(result.allow).toBe(false)
			expect(result.error).toBe("You must cite a valid active Intent ID.")
		})
	})

	describe("Destructive tools with invalid intent", () => {
		beforeEach(() => {
			mockTask.activeIntentId = "INVALID-INTENT"
		})

		it("should block when intent file does not exist", async () => {
			vi.mocked(fs.readFile).mockRejectedValue(new Error("ENOENT: no such file"))

			const context: HookContext = {
				task: mockTask as Task,
				toolName: "write_to_file",
				toolUse: mockToolUse as any,
			}

			const result = await hook.check(context)

			expect(result.allow).toBe(false)
			expect(result.error).toBe("You must cite a valid active Intent ID.")
		})

		it("should block when intent ID is not found in active_intents.yaml", async () => {
			const mockYamlContent = `active_intents:
  - id: "INT-001"
    name: "Test Intent"
    status: "IN_PROGRESS"
  - id: "INT-002"
    name: "Another Intent"
    status: "COMPLETED"`

			vi.mocked(fs.readFile).mockResolvedValue(mockYamlContent)
			vi.mocked(yaml.parse).mockReturnValue({
				active_intents: [
					{ id: "INT-001", name: "Test Intent", status: "IN_PROGRESS" },
					{ id: "INT-002", name: "Another Intent", status: "COMPLETED" },
				],
			})

			mockTask.activeIntentId = "INT-999" // Non-existent intent

			const context: HookContext = {
				task: mockTask as Task,
				toolName: "write_to_file",
				toolUse: mockToolUse as any,
			}

			const result = await hook.check(context)

			expect(result.allow).toBe(false)
			expect(result.error).toBe("You must cite a valid active Intent ID.")
		})

		it("should block when active_intents.yaml is empty", async () => {
			vi.mocked(fs.readFile).mockResolvedValue("active_intents: []")
			vi.mocked(yaml.parse).mockReturnValue({ active_intents: [] })

			const context: HookContext = {
				task: mockTask as Task,
				toolName: "write_to_file",
				toolUse: mockToolUse as any,
			}

			const result = await hook.check(context)

			expect(result.allow).toBe(false)
			expect(result.error).toBe("You must cite a valid active Intent ID.")
		})

		it("should block when active_intents.yaml has no active_intents key", async () => {
			vi.mocked(fs.readFile).mockResolvedValue("{}")
			vi.mocked(yaml.parse).mockReturnValue({})

			const context: HookContext = {
				task: mockTask as Task,
				toolName: "write_to_file",
				toolUse: mockToolUse as any,
			}

			const result = await hook.check(context)

			expect(result.allow).toBe(false)
			expect(result.error).toBe("You must cite a valid active Intent ID.")
		})
	})

	describe("Destructive tools with valid intent", () => {
		beforeEach(() => {
			mockTask.activeIntentId = "INT-001"
		})

		it("should allow write_to_file when valid intent exists", async () => {
			const mockYamlContent = `active_intents:
  - id: "INT-001"
    name: "Test Intent"
    status: "IN_PROGRESS"
  - id: "INT-002"
    name: "Another Intent"
    status: "COMPLETED"`

			vi.mocked(fs.readFile).mockResolvedValue(mockYamlContent)
			vi.mocked(yaml.parse).mockReturnValue({
				active_intents: [
					{ id: "INT-001", name: "Test Intent", status: "IN_PROGRESS" },
					{ id: "INT-002", name: "Another Intent", status: "COMPLETED" },
				],
			})

			const context: HookContext = {
				task: mockTask as Task,
				toolName: "write_to_file",
				toolUse: mockToolUse as any,
			}

			const result = await hook.check(context)

			expect(result.allow).toBe(true)
			expect(result.error).toBeUndefined()
		})

		it.each([
			"write_to_file",
			"edit",
			"edit_file",
			"search_replace",
			"apply_diff",
			"apply_patch",
			"execute_command",
		] as const)("should allow %s when valid intent exists", async (toolName) => {
			vi.mocked(fs.readFile).mockResolvedValue(`active_intents:
  - id: "INT-001"
    name: "Test Intent"
    status: "IN_PROGRESS"`)
			vi.mocked(yaml.parse).mockReturnValue({
				active_intents: [{ id: "INT-001", name: "Test Intent", status: "IN_PROGRESS" }],
			})

			mockToolUse.name = toolName as any

			const context: HookContext = {
				task: mockTask as Task,
				toolName: toolName as any,
				toolUse: mockToolUse as any,
			}

			const result = await hook.check(context)

			expect(result.allow).toBe(true)
		})
	})

	describe("Exempt tools (read-only and meta)", () => {
		const exemptTools = [
			"select_active_intent",
			"read_file",
			"list_files",
			"search_files",
			"codebase_search",
			"read_command_output",
			"ask_followup_question",
			"switch_mode",
			"new_task",
			"update_todo_list",
			"attempt_completion",
			"use_mcp_tool",
			"access_mcp_resource",
			"run_slash_command",
			"skill",
			"generate_image",
		] as const

		it.each(exemptTools)("should allow %s without intent", async (toolName) => {
			mockTask.activeIntentId = undefined

			const context: HookContext = {
				task: mockTask as Task,
				toolName: toolName as any,
				toolUse: {
					type: "tool_use",
					name: toolName as any,
					params: {},
					nativeArgs: {},
					partial: false,
				} as any,
			}

			const result = await hook.check(context)

			expect(result.allow).toBe(true)
			expect(result.error).toBeUndefined()
		})

		it("should allow read_file even when no intent is selected", async () => {
			mockTask.activeIntentId = undefined

			const context: HookContext = {
				task: mockTask as Task,
				toolName: "read_file",
				toolUse: {
					type: "tool_use",
					name: "read_file",
					params: { path: "test.ts" },
					nativeArgs: { path: "test.ts" },
					partial: false,
				} as any,
			}

			const result = await hook.check(context)

			expect(result.allow).toBe(true)
		})

		it("should allow select_active_intent even when no intent is selected", async () => {
			mockTask.activeIntentId = undefined

			const context: HookContext = {
				task: mockTask as Task,
				toolName: "select_active_intent",
				toolUse: {
					type: "tool_use",
					name: "select_active_intent",
					params: { intent_id: "INT-001" },
					nativeArgs: { intent_id: "INT-001" },
					partial: false,
				} as any,
			}

			const result = await hook.check(context)

			expect(result.allow).toBe(true)
		})
	})

	describe("File system errors", () => {
		beforeEach(() => {
			mockTask.activeIntentId = "INT-001"
		})

		it("should block when file read fails with permission error", async () => {
			vi.mocked(fs.readFile).mockRejectedValue(new Error("EACCES: permission denied"))

			const context: HookContext = {
				task: mockTask as Task,
				toolName: "write_to_file",
				toolUse: mockToolUse as any,
			}

			const result = await hook.check(context)

			expect(result.allow).toBe(false)
			expect(result.error).toBe("You must cite a valid active Intent ID.")
		})

		it("should block when YAML parsing fails", async () => {
			vi.mocked(fs.readFile).mockResolvedValue("invalid yaml: [")
			vi.mocked(yaml.parse).mockImplementation(() => {
				throw new Error("YAML parse error")
			})

			const context: HookContext = {
				task: mockTask as Task,
				toolName: "write_to_file",
				toolUse: mockToolUse as any,
			}

			const result = await hook.check(context)

			expect(result.allow).toBe(false)
			expect(result.error).toBe("You must cite a valid active Intent ID.")
		})
	})

	describe("Intent validation", () => {
		it("should validate intent exists by checking active_intents.yaml", async () => {
			mockTask.activeIntentId = "INT-001"

			const mockYamlContent = `active_intents:
  - id: "INT-001"
    name: "Test Intent"
    status: "IN_PROGRESS"
  - id: "INT-002"
    name: "Another Intent"
    status: "COMPLETED"`

			vi.mocked(fs.readFile).mockResolvedValue(mockYamlContent)
			vi.mocked(yaml.parse).mockReturnValue({
				active_intents: [
					{ id: "INT-001", name: "Test Intent", status: "IN_PROGRESS" },
					{ id: "INT-002", name: "Another Intent", status: "COMPLETED" },
				],
			})

			const context: HookContext = {
				task: mockTask as Task,
				toolName: "write_to_file",
				toolUse: mockToolUse as any,
			}

			const result = await hook.check(context)

			expect(result.allow).toBe(true)
			expect(fs.readFile).toHaveBeenCalledWith(
				expect.stringContaining(".orchestration/active_intents.yaml"),
				"utf-8",
			)
		})

		it("should read from correct path based on task.cwd", async () => {
			Object.assign(mockTask, { cwd: "/custom/workspace", activeIntentId: "INT-001" })

			vi.mocked(fs.readFile).mockResolvedValue(`active_intents:
  - id: "INT-001"
    name: "Test Intent"`)
			vi.mocked(yaml.parse).mockReturnValue({
				active_intents: [{ id: "INT-001", name: "Test Intent" }],
			})

			const context: HookContext = {
				task: mockTask as Task,
				toolName: "write_to_file",
				toolUse: mockToolUse as any,
			}

			await hook.check(context)

			expect(fs.readFile).toHaveBeenCalledWith("/custom/workspace/.orchestration/active_intents.yaml", "utf-8")
		})
	})

	describe("formatError", () => {
		it("should format error message correctly", () => {
			const errorMessage = "You must cite a valid active Intent ID."
			const formatted = IntentGatekeeperHook.formatError(errorMessage)

			expect(formatted).toBeDefined()
			expect(typeof formatted).toBe("string")
		})
	})

	describe("Edge cases", () => {
		it("should handle tools not in either list (default allow)", async () => {
			// Simulate a tool that's not explicitly listed
			mockTask.activeIntentId = undefined

			const context: HookContext = {
				task: mockTask as Task,
				toolName: "unknown_tool" as any,
				toolUse: {
					type: "tool_use",
					name: "unknown_tool" as any,
					params: {},
					nativeArgs: {},
					partial: false,
				} as any,
			}

			const result = await hook.check(context)

			// Unknown tools that aren't destructive should be allowed
			expect(result.allow).toBe(true)
		})

		it("should handle case sensitivity in intent IDs", async () => {
			mockTask.activeIntentId = "int-001" // lowercase

			vi.mocked(fs.readFile).mockResolvedValue(`active_intents:
  - id: "INT-001"
    name: "Test Intent"`)
			vi.mocked(yaml.parse).mockReturnValue({
				active_intents: [{ id: "INT-001", name: "Test Intent" }],
			})

			const context: HookContext = {
				task: mockTask as Task,
				toolName: "write_to_file",
				toolUse: mockToolUse as any,
			}

			const result = await hook.check(context)

			// Should be case-sensitive, so lowercase won't match uppercase
			expect(result.allow).toBe(false)
		})
	})
})
