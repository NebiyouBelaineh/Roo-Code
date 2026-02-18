import type { ToolName } from "@roo-code/types"
import type { Task } from "../core/task/Task"
import type { ToolUse } from "../shared/tools"

/**
 * Result of a pre-execution hook check
 */
export interface HookResult {
	/**
	 * Whether execution should proceed
	 */
	allow: boolean
	/**
	 * Error message if execution is blocked
	 */
	error?: string
}

/**
 * Context passed to hooks
 */
export interface HookContext {
	task: Task
	toolName: ToolName
	toolUse: ToolUse<ToolName>
}
