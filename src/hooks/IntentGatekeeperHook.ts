import * as fs from "fs/promises"
import * as path from "path"
import * as vscode from "vscode"
import * as yaml from "yaml"

import type { ToolName } from "@roo-code/types"
import type { ToolUse } from "../shared/tools"
import { contentHashSha256 } from "../utils/contentHash"
import { fileExistsAtPath } from "../utils/fs"
import type { HookContext, HookErrorType, HookResult, ToolClassification } from "./types"

/**
 * Tools that require an active intent to be selected before execution.
 * These are destructive operations that modify code or execute commands.
 */
const TOOLS_REQUIRING_INTENT: Set<ToolName> = new Set([
	"write_to_file",
	"edit",
	"edit_file",
	"search_replace",
	"apply_diff",
	"apply_patch",
	"execute_command",
])

/**
 * Tools that are exempt from intent requirement.
 * These are read-only or meta operations.
 */
const EXEMPT_TOOLS: Set<ToolName> = new Set([
	"select_active_intent", // The tool itself
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
])

interface ActiveIntent {
	id: string
	owned_scope?: string[]
}

interface ActiveIntentsData {
	active_intents?: ActiveIntent[]
}

interface IntentIgnorePolicy {
	ignoredIntents: Set<string>
	ignoredPathPatterns: string[]
}

/**
 * Intent Gatekeeper Hook
 *
 * Verifies that the agent has declared a valid intent_id
 * before allowing destructive operations. Blocks execution if no valid intent
 * is selected.
 */
export class IntentGatekeeperHook {
	private static readonly INTENT_REQUIRED_ERROR = "You must cite a valid active Intent ID."

	/**
	 * Check if a tool execution should be allowed based on intent requirements.
	 *
	 * @param context - Hook context with task, tool name, and tool use block
	 * @returns HookResult indicating whether execution should proceed
	 */
	async check(context: HookContext): Promise<HookResult> {
		const { task, toolName, toolUse } = context
		const classification = this.classifyTool(toolName)

		if (classification === "safe") {
			return { allow: true, classification }
		}

		const activeIntentId = (task as any).activeIntentId as string | undefined
		if (!activeIntentId) {
			const proceed = await this.requestHitlForDestructiveDenial(
				context,
				IntentGatekeeperHook.INTENT_REQUIRED_ERROR,
				classification,
			)
			if (proceed) return { allow: true, classification }
			return this.denied(
				IntentGatekeeperHook.INTENT_REQUIRED_ERROR,
				classification,
				"MISSING_OR_INVALID_INTENT",
				"select_active_intent",
			)
		}

		const intentsData = await this.loadIntents(task.cwd)
		const activeIntents = intentsData?.active_intents || []
		const activeIntent = activeIntents.find((intent) => intent.id === activeIntentId)
		if (!activeIntent) {
			const proceed = await this.requestHitlForDestructiveDenial(
				context,
				IntentGatekeeperHook.INTENT_REQUIRED_ERROR,
				classification,
			)
			if (proceed) return { allow: true, classification }
			return this.denied(
				IntentGatekeeperHook.INTENT_REQUIRED_ERROR,
				classification,
				"MISSING_OR_INVALID_INTENT",
				"select_active_intent",
			)
		}

		const intentIgnorePolicy = await this.readIntentIgnorePolicy(task.cwd)
		if (intentIgnorePolicy.ignoredIntents.has(activeIntentId)) {
			const proceed = await this.requestHitlForDestructiveDenial(
				context,
				`Intent ${activeIntentId} is excluded by .intentignore.`,
				classification,
			)
			if (proceed) return { allow: true, classification }
			return this.denied(
				`Intent ${activeIntentId} is excluded by .intentignore.`,
				classification,
				"INTENT_IGNORED",
				"select_active_intent",
			)
		}

		// For write_to_file, require tool call's intent_id to match the selected active intent (Phase 3).
		if (toolName === "write_to_file") {
			const callIntentId = (context.toolUse as { nativeArgs?: { intent_id?: string } }).nativeArgs?.intent_id
			if (callIntentId !== undefined && callIntentId !== activeIntentId) {
				return this.denied(
					`write_to_file intent_id (${callIntentId}) does not match selected active intent (${activeIntentId}). Call select_active_intent first or use the same intent_id.`,
					classification,
					"HOOK_BLOCKED",
					"select_active_intent",
				)
			}
		}

		// Enforce .intentignore path exclusions and owned_scope for all path-based destructive tools.
		const targetPaths = this.getTargetPathsForTool(toolName, toolUse)
		if (targetPaths.length > 0) {
			const scopePatterns = activeIntent.owned_scope || []
			for (const targetPath of targetPaths) {
				if (this.matchesAnyPattern(targetPath, intentIgnorePolicy.ignoredPathPatterns)) {
					const proceed = await this.requestHitlForDestructiveDenial(
						context,
						`Path ${targetPath} is blocked by .intentignore.`,
						classification,
					)
					if (proceed) return { allow: true, classification }
					return this.denied(
						`Path ${targetPath} is blocked by .intentignore.`,
						classification,
						"INTENTIGNORE_PATH_BLOCKED",
						"update_intentignore_or_choose_different_file",
					)
				}
				if (scopePatterns.length > 0 && !this.matchesAnyPattern(targetPath, scopePatterns)) {
					const proceed = await this.requestHitlForDestructiveDenial(
						context,
						`Scope Violation: ${activeIntentId} is not authorized to edit [${targetPath}]. Request scope expansion.`,
						classification,
					)
					if (proceed) return { allow: true, classification }
					return this.denied(
						`Scope Violation: ${activeIntentId} is not authorized to edit [${targetPath}]. Request scope expansion.`,
						classification,
						"SCOPE_VIOLATION",
						"request_scope_expansion",
					)
				}
			}
		}

		// Phase 4: Concurrency control — optimistic locking. If agent sent expected_content_hash
		// and the file on disk has a different hash, block the write (parallel edit).
		const staleCheck = await this.checkStaleFile(context)
		if (!staleCheck.allow) {
			return staleCheck
		}

		return { allow: true, classification }
	}

	/**
	 * Loads active intents file.
	 */
	private async loadIntents(cwd: string): Promise<ActiveIntentsData | undefined> {
		try {
			const orchestrationDir = path.join(cwd, ".orchestration")
			const intentsFilePath = path.join(orchestrationDir, "active_intents.yaml")

			const fileContent = await fs.readFile(intentsFilePath, "utf-8")
			return yaml.parse(fileContent) as ActiveIntentsData
		} catch (error) {
			// If file doesn't exist or can't be read, consider all intents invalid
			console.error(`Failed to load active intents:`, error)
			return undefined
		}
	}

	/**
	 * Format error response for blocked execution
	 */
	static formatError(
		error: string,
		metadata?: {
			errorType?: HookErrorType
			recoverable?: boolean
			actionHint?: string
			classification?: ToolClassification
		},
	): string {
		return JSON.stringify({
			status: "error",
			message: "The tool execution failed",
			error,
			error_type: metadata?.errorType ?? "MISSING_OR_INVALID_INTENT",
			recoverable: metadata?.recoverable ?? true,
			action_hint: metadata?.actionHint ?? "select_active_intent",
			classification: metadata?.classification,
		})
	}

	private classifyTool(toolName: ToolName): ToolClassification {
		if (EXEMPT_TOOLS.has(toolName)) {
			return "safe"
		}
		if (TOOLS_REQUIRING_INTENT.has(toolName)) {
			return "destructive"
		}
		return "safe"
	}

	private denied(
		error: string,
		classification: ToolClassification,
		errorType: HookErrorType,
		actionHint: string,
	): HookResult {
		return {
			allow: false,
			error,
			classification,
			errorType,
			recoverable: true,
			actionHint,
		}
	}

	/**
	 * UI-Blocking Authorization per TRP1 Phase 2.2: when a destructive action would be
	 * denied (intent missing, scope violation, etc.), show Approve/Reject so the user can
	 * assert boundaries and optionally proceed knowing the situation. Runs even when
	 * "auto write approved" is on.
	 */
	private async requestHitlForDestructiveDenial(
		context: HookContext,
		errorMessage: string,
		classification: ToolClassification,
	): Promise<boolean> {
		const message = `${errorMessage} This action may be destructive. Proceed anyway?`
		if (context.askForAuthorization) {
			return context.askForAuthorization(message)
		}
		const choice = await vscode.window.showWarningMessage(message, { modal: true }, "Approve", "Reject")
		return choice === "Approve"
	}

	private static readonly PATCH_FILE_MARKERS = ["*** Add File: ", "*** Delete File: ", "*** Update File: "] as const

	/** Tools that support optional expected_content_hash for Phase 4 optimistic locking. */
	private static readonly TOOLS_WITH_CONTENT_HASH_CHECK: Set<ToolName> = new Set([
		"write_to_file",
		"apply_diff",
		"edit_file",
		"edit",
		"search_replace",
	])

	/**
	 * Phase 4: If the agent sent expected_content_hash and the file on disk has a different hash,
	 * block the write (stale file — parallel agent or user edited it).
	 */
	private async checkStaleFile(context: HookContext): Promise<HookResult> {
		const { task, toolName, toolUse } = context
		if (!IntentGatekeeperHook.TOOLS_WITH_CONTENT_HASH_CHECK.has(toolName)) {
			return { allow: true }
		}
		const targetPaths = this.getTargetPathsForTool(toolName, toolUse)
		if (targetPaths.length === 0) {
			return { allow: true }
		}
		const nativeArgs = toolUse.nativeArgs as Record<string, unknown> | undefined
		const expectedHash = nativeArgs?.expected_content_hash
		if (typeof expectedHash !== "string" || expectedHash.trim() === "") {
			return { allow: true }
		}
		const normalizedExpected = expectedHash.trim()
		for (const targetPath of targetPaths) {
			const absolutePath = path.resolve(task.cwd, targetPath)
			const exists = await fileExistsAtPath(absolutePath)
			if (!exists) {
				continue
			}
			try {
				const content = await fs.readFile(absolutePath, "utf-8")
				const currentHash = contentHashSha256(content)
				if (currentHash !== normalizedExpected) {
					return this.denied(
						`Stale File: ${targetPath} was modified since you read it. Re-read the file with read_file and try again.`,
						"destructive",
						"STALE_FILE",
						"read_file",
					)
				}
			} catch {
				// If we can't read the file, allow the tool to run (it may fail with its own error)
				continue
			}
		}
		return { allow: true }
	}

	/**
	 * Returns all target file paths for a destructive tool (for scope and .intentignore checks).
	 * Returns empty array for tools with no path (e.g. execute_command) or when path cannot be determined.
	 */
	private getTargetPathsForTool(toolName: ToolName, toolUse: ToolUse<ToolName>): string[] {
		const nativeArgs = toolUse.nativeArgs as Record<string, unknown> | undefined
		const params = toolUse.params as Record<string, unknown> | undefined
		const getPath = (key: string): string | undefined => {
			const value = nativeArgs?.[key] ?? params?.[key]
			if (typeof value !== "string" || value.trim().length === 0) return undefined
			return this.normalizePath(value)
		}

		switch (toolName) {
			case "write_to_file":
			case "apply_diff": {
				const p = getPath("path")
				return p ? [p] : []
			}
			case "edit":
			case "edit_file":
			case "search_replace": {
				const p = getPath("file_path")
				return p ? [p] : []
			}
			case "apply_patch": {
				const patch = nativeArgs?.patch ?? params?.patch
				if (typeof patch !== "string") return []
				return this.extractPathsFromPatch(patch)
			}
			default:
				return []
		}
	}

	private extractPathsFromPatch(patchContent: string): string[] {
		const paths: string[] = []
		for (const line of patchContent.split(/\r?\n/)) {
			for (const marker of IntentGatekeeperHook.PATCH_FILE_MARKERS) {
				if (line.startsWith(marker)) {
					const filePath = line.slice(marker.length).trim()
					if (filePath) {
						paths.push(this.normalizePath(filePath))
					}
					break
				}
			}
		}
		return paths
	}

	private normalizePath(filePath: string): string {
		return filePath.replace(/\\/g, "/").replace(/^\.\//, "")
	}

	/**
	 * Reads .intentignore from both .orchestration/.intentignore and workspace root .intentignore,
	 * merging exclusions so that either location works (e.g. Phase 2 Script C with .orchestration/.intentignore).
	 */
	private async readIntentIgnorePolicy(cwd: string): Promise<IntentIgnorePolicy> {
		const policy: IntentIgnorePolicy = {
			ignoredIntents: new Set<string>(),
			ignoredPathPatterns: [],
		}

		const locations = [path.join(cwd, ".orchestration", ".intentignore"), path.join(cwd, ".intentignore")]
		for (const intentIgnorePath of locations) {
			try {
				const content = await fs.readFile(intentIgnorePath, "utf-8")
				this.parseIntentIgnoreContent(content, policy)
			} catch {
				// Missing file at this location is valid; try next or leave policy as-is.
			}
		}

		return policy
	}

	private parseIntentIgnoreContent(content: string, policy: IntentIgnorePolicy): void {
		for (const rawLine of content.split(/\r?\n/)) {
			const line = rawLine.trim()
			if (!line || line.startsWith("#")) {
				continue
			}
			if (line.startsWith("intent:")) {
				const intentId = line.slice("intent:".length).trim()
				if (intentId) {
					policy.ignoredIntents.add(intentId)
				}
				continue
			}
			policy.ignoredPathPatterns.push(this.normalizePath(line))
		}
	}

	private matchesAnyPattern(targetPath: string, patterns: string[]): boolean {
		return patterns.some((pattern) => this.matchesPattern(targetPath, pattern))
	}

	private matchesPattern(targetPath: string, pattern: string): boolean {
		const normalizedTarget = this.normalizePath(targetPath)
		const normalizedPattern = this.normalizePath(pattern)

		if (!normalizedPattern.includes("*")) {
			return normalizedTarget === normalizedPattern
		}

		const escaped = normalizedPattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&")
		const doubleStarToken = "__DOUBLE_STAR__"
		const regexPattern = escaped
			.replace(/\*\*/g, doubleStarToken)
			.replace(/\*/g, "[^/]*")
			.replace(new RegExp(doubleStarToken, "g"), ".*")
		const regex = new RegExp(`^${regexPattern}$`)
		return regex.test(normalizedTarget)
	}
}
