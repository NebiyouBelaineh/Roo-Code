import * as fs from "fs/promises"
import * as path from "path"
import * as yaml from "yaml"

import type { ToolName } from "@roo-code/types"
import { formatResponse } from "../core/prompts/responses"
import type { ToolUse } from "../shared/tools"
import type { HookContext, HookResult } from "./types"

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

/**
 * Intent Gatekeeper Hook
 *
 * Verifies that the agent has declared a valid intent_id
 * before allowing destructive operations. Blocks execution if no valid intent
 * is selected.
 */
export class IntentGatekeeperHook {
	/**
	 * Check if a tool execution should be allowed based on intent requirements.
	 *
	 * @param context - Hook context with task, tool name, and tool use block
	 * @returns HookResult indicating whether execution should proceed
	 */
	async check(context: HookContext): Promise<HookResult> {
		const { task, toolName } = context

		// Exempt tools don't require intent
		if (EXEMPT_TOOLS.has(toolName)) {
			return { allow: true }
		}

		// Only enforce intent requirement for destructive tools
		if (!TOOLS_REQUIRING_INTENT.has(toolName)) {
			return { allow: true }
		}

		// Check if an active intent has been selected
		const activeIntentId = (task as any).activeIntentId as string | undefined

		if (!activeIntentId) {
			return {
				allow: false,
				error: "You must cite a valid active Intent ID.",
			}
		}

		// Validate that the intent exists in active_intents.yaml
		const isValid = await this.validateIntentExists(activeIntentId, task.cwd)

		if (!isValid) {
			return {
				allow: false,
				error: "You must cite a valid active Intent ID.",
			}
		}

		return { allow: true }
	}

	/**
	 * Validates that an intent ID exists in active_intents.yaml
	 */
	private async validateIntentExists(intentId: string, cwd: string): Promise<boolean> {
		try {
			const orchestrationDir = path.join(cwd, ".orchestration")
			const intentsFilePath = path.join(orchestrationDir, "active_intents.yaml")

			const fileContent = await fs.readFile(intentsFilePath, "utf-8")
			const intentsData = yaml.parse(fileContent) as { active_intents?: Array<{ id: string }> }

			const activeIntents = intentsData?.active_intents || []
			return activeIntents.some((intent) => intent.id === intentId)
		} catch (error) {
			// If file doesn't exist or can't be read, consider intent invalid
			console.error(`Failed to validate intent ${intentId}:`, error)
			return false
		}
	}

	/**
	 * Format error response for blocked execution
	 */
	static formatError(error: string): string {
		return formatResponse.toolError(error)
	}
}
