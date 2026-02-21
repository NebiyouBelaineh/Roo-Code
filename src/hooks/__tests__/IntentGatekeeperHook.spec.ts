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

const fileExistsAtPathMock = vi.fn()
vi.mock("../../utils/fs", () => ({
	fileExistsAtPath: (p: string) => fileExistsAtPathMock(p),
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

		// Create mock tool use block (Phase 3: intent_id must match activeIntentId for write_to_file)
		mockToolUse = {
			type: "tool_use",
			name: "write_to_file",
			id: "toolu_abc123",
			params: {
				path: "test.ts",
				content: "test content",
				intent_id: "INT-001",
				mutation_class: "INTENT_EVOLUTION",
			},
			nativeArgs: {
				path: "test.ts",
				content: "test content",
				intent_id: "INT-001",
				mutation_class: "INTENT_EVOLUTION",
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

		it("should allow when askForAuthorization returns true (HITL Approve)", async () => {
			mockTask.activeIntentId = undefined
			const context: HookContext = {
				task: mockTask as Task,
				toolName: "write_to_file",
				toolUse: mockToolUse as any,
				askForAuthorization: vi.fn().mockResolvedValue(true),
			}
			const result = await hook.check(context)
			expect(result.allow).toBe(true)
			expect(context.askForAuthorization).toHaveBeenCalledWith(
				expect.stringContaining("You must cite a valid active Intent ID."),
			)
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

		it("should block write_to_file when intent_id in call does not match activeIntentId", async () => {
			vi.mocked(fs.readFile).mockResolvedValue(`active_intents:
  - id: "INT-001"
    name: "Test Intent"
    status: "IN_PROGRESS"
    owned_scope: ["src/**"]`)
			vi.mocked(yaml.parse).mockReturnValue({
				active_intents: [
					{ id: "INT-001", name: "Test Intent", status: "IN_PROGRESS", owned_scope: ["src/**"] },
				],
			})
			mockTask.activeIntentId = "INT-001"
			const wrongIntentToolUse = {
				...mockToolUse,
				nativeArgs: {
					path: "src/foo.ts",
					content: "x",
					intent_id: "INT-002",
					mutation_class: "INTENT_EVOLUTION",
				},
			}

			const result = await hook.check({
				task: mockTask as Task,
				toolName: "write_to_file",
				toolUse: wrongIntentToolUse as any,
			})

			expect(result.allow).toBe(false)
			expect(result.error).toContain("INT-002")
			expect(result.error).toContain("INT-001")
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

	describe("Phase 2 middleware behaviors", () => {
		beforeEach(() => {
			mockTask.activeIntentId = "INT-001"
		})

		it("should allow write_to_file when path is inside active intent owned_scope", async () => {
			vi.mocked(fs.readFile).mockResolvedValue(`active_intents:
  - id: "INT-001"
    name: "Auth Refactor"
    status: "IN_PROGRESS"
    owned_scope:
      - "src/auth/**"
      - "src/middleware/jwt.ts"`)
			vi.mocked(yaml.parse).mockReturnValue({
				active_intents: [
					{
						id: "INT-001",
						name: "Auth Refactor",
						status: "IN_PROGRESS",
						owned_scope: ["src/auth/**", "src/middleware/jwt.ts"],
					},
				],
			})

			const inScopeToolUse = {
				...mockToolUse,
				nativeArgs: {
					path: "src/auth/jwt/service.ts",
					content: "export const ok = true",
					intent_id: "INT-001",
					mutation_class: "INTENT_EVOLUTION",
				},
			}

			const result = await hook.check({
				task: mockTask as Task,
				toolName: "write_to_file",
				toolUse: inScopeToolUse as any,
			})

			expect(result.allow).toBe(true)
			expect(result.classification).toBe("destructive")
		})

		it("should block write_to_file when path is outside active intent owned_scope", async () => {
			vi.mocked(fs.readFile).mockResolvedValue(`active_intents:
  - id: "INT-001"
    name: "Auth Refactor"
    status: "IN_PROGRESS"
    owned_scope:
      - "src/auth/**"
      - "src/middleware/jwt.ts"`)
			vi.mocked(yaml.parse).mockReturnValue({
				active_intents: [
					{
						id: "INT-001",
						name: "Auth Refactor",
						status: "IN_PROGRESS",
						owned_scope: ["src/auth/**", "src/middleware/jwt.ts"],
					},
				],
			})

			const outOfScopeToolUse = {
				...mockToolUse,
				nativeArgs: {
					path: "src/billing/invoice.ts",
					content: "export const invoice = true",
					intent_id: "INT-001",
					mutation_class: "INTENT_EVOLUTION",
				},
			}

			const context: HookContext = {
				task: mockTask as Task,
				toolName: "write_to_file",
				toolUse: outOfScopeToolUse as any,
			}

			const result = await hook.check(context)

			expect(result.allow).toBe(false)
			expect(result.error).toContain("Scope Violation")
			expect(result.error).toContain("INT-001")
			expect(result.error).toContain("src/billing/invoice.ts")
		})

		it("should provide structured recoverable error metadata for blocked operations", () => {
			const formatted = IntentGatekeeperHook.formatError("You must cite a valid active Intent ID.")
			const payload = JSON.parse(formatted) as Record<string, unknown>

			// Phase 2 requires standardized machine-readable recovery payloads.
			expect(payload.status).toBe("error")
			expect(payload.recoverable).toBe(true)
			expect(payload.error_type).toBe("MISSING_OR_INVALID_INTENT")
			expect(payload.action_hint).toBe("select_active_intent")
		})

		it("should block execution when active intent is excluded by .intentignore", async () => {
			vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
				if (String(filePath).endsWith("/.orchestration/active_intents.yaml")) {
					return `active_intents:
  - id: "INT-001"
    name: "Auth Refactor"
    status: "IN_PROGRESS"
    owned_scope:
      - "src/auth/**"`
				}
				if (String(filePath).endsWith("/.intentignore")) {
					return "intent:INT-001"
				}
				throw new Error(`Unexpected path ${String(filePath)}`)
			})
			vi.mocked(yaml.parse).mockReturnValue({
				active_intents: [
					{ id: "INT-001", name: "Auth Refactor", status: "IN_PROGRESS", owned_scope: ["src/auth/**"] },
				],
			})

			const result = await hook.check({
				task: mockTask as Task,
				toolName: "write_to_file",
				toolUse: mockToolUse as any,
			})

			expect(result.allow).toBe(false)
			expect(result.errorType).toBe("INTENT_IGNORED")
			expect(result.actionHint).toBe("select_active_intent")
		})

		it("should block write_to_file when target path is blocked by .intentignore pattern", async () => {
			vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
				if (String(filePath).endsWith("/.orchestration/active_intents.yaml")) {
					return `active_intents:
  - id: "INT-001"
    name: "Auth Refactor"
    status: "IN_PROGRESS"
    owned_scope:
      - "src/auth/**"
      - "src/middleware/**"`
				}
				if (String(filePath).endsWith("/.intentignore")) {
					return "src/auth/secrets/**"
				}
				throw new Error(`Unexpected path ${String(filePath)}`)
			})
			vi.mocked(yaml.parse).mockReturnValue({
				active_intents: [
					{
						id: "INT-001",
						name: "Auth Refactor",
						status: "IN_PROGRESS",
						owned_scope: ["src/auth/**", "src/middleware/**"],
					},
				],
			})

			const blockedPathToolUse = {
				...mockToolUse,
				nativeArgs: {
					path: "src/auth/secrets/tokens.ts",
					content: "export const token = 'x'",
					intent_id: "INT-001",
					mutation_class: "INTENT_EVOLUTION",
				},
			}

			const result = await hook.check({
				task: mockTask as Task,
				toolName: "write_to_file",
				toolUse: blockedPathToolUse as any,
			})

			expect(result.allow).toBe(false)
			expect(result.errorType).toBe("INTENTIGNORE_PATH_BLOCKED")
			expect(result.error).toContain(".intentignore")
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

	describe("Phase 4 concurrency (stale-file check)", () => {
		beforeEach(() => {
			mockTask.activeIntentId = "INT-001"
			fileExistsAtPathMock.mockReset()
		})

		it("should allow write when expected_content_hash matches current file on disk", async () => {
			const filePath = "src/foo.ts"
			const currentContent = "const x = 1\n"
			const { contentHashSha256 } = await import("../../utils/contentHash")
			const expectedHash = contentHashSha256(currentContent)

			vi.mocked(fs.readFile).mockImplementation((pathArg: unknown) => {
				const pathStr = typeof pathArg === "string" ? pathArg : String(pathArg)
				if (pathStr.includes("active_intents.yaml")) {
					return Promise.resolve(`active_intents:\n  - id: "INT-001"\n    owned_scope: ["src/**"]`)
				}
				return Promise.resolve(currentContent)
			})
			vi.mocked(yaml.parse).mockReturnValue({
				active_intents: [{ id: "INT-001", owned_scope: ["src/**"] }],
			})
			fileExistsAtPathMock.mockResolvedValue(true)

			const toolUse = {
				...mockToolUse,
				nativeArgs: {
					path: filePath,
					content: "const x = 2\n",
					intent_id: "INT-001",
					mutation_class: "AST_REFACTOR",
					expected_content_hash: expectedHash,
				},
			}

			const result = await hook.check({
				task: mockTask as Task,
				toolName: "write_to_file",
				toolUse: toolUse as any,
			})

			expect(result.allow).toBe(true)
		})

		it("should block write with STALE_FILE when expected_content_hash does not match current file on disk", async () => {
			const filePath = "src/foo.ts"
			const oldContent = "const x = 1\n"
			const currentContent = "const x = 99\n" // parallel edit
			const { contentHashSha256 } = await import("../../utils/contentHash")
			const expectedHash = contentHashSha256(oldContent)

			vi.mocked(fs.readFile).mockImplementation((pathArg: unknown) => {
				const pathStr = typeof pathArg === "string" ? pathArg : String(pathArg)
				if (pathStr.includes("active_intents.yaml")) {
					return Promise.resolve(`active_intents:\n  - id: "INT-001"\n    owned_scope: ["src/**"]`)
				}
				return Promise.resolve(currentContent)
			})
			vi.mocked(yaml.parse).mockReturnValue({
				active_intents: [{ id: "INT-001", owned_scope: ["src/**"] }],
			})
			fileExistsAtPathMock.mockResolvedValue(true)

			const toolUse = {
				...mockToolUse,
				nativeArgs: {
					path: filePath,
					content: "const x = 2\n",
					intent_id: "INT-001",
					mutation_class: "AST_REFACTOR",
					expected_content_hash: expectedHash,
				},
			}

			const result = await hook.check({
				task: mockTask as Task,
				toolName: "write_to_file",
				toolUse: toolUse as any,
			})

			expect(result.allow).toBe(false)
			expect(result.errorType).toBe("STALE_FILE")
			expect(result.error).toContain("Stale File")
			expect(result.error).toContain(filePath)
			expect(result.actionHint).toBe("read_file")
		})
	})
})
