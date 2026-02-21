import type { ToolName } from "@roo-code/types"
import type { Task } from "../core/task/Task"
import type { ToolUse } from "../shared/tools"

export type ToolClassification = "safe" | "destructive"
export type HookErrorType =
	| "MISSING_OR_INVALID_INTENT"
	| "SCOPE_VIOLATION"
	| "INTENT_IGNORED"
	| "INTENTIGNORE_PATH_BLOCKED"
	| "HOOK_BLOCKED"
	| "STALE_FILE"

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
	/**
	 * Safe vs destructive command classification
	 */
	classification?: ToolClassification
	/**
	 * Machine-readable error category for blocked operations
	 */
	errorType?: HookErrorType
	/**
	 * Whether the model can recover by self-correcting
	 */
	recoverable?: boolean
	/**
	 * A hint for the model's next action
	 */
	actionHint?: string
}

/**
 * Context passed to hooks
 */
export interface HookContext {
	task: Task
	toolName: ToolName
	toolUse: ToolUse<ToolName>
	/**
	 * Optional HITL callback for destructive denials.
	 * When provided, the hook uses this instead of vscode.window.showWarningMessage.
	 * Used in tests to avoid showing a real modal; in production omit to use VS Code UI.
	 */
	askForAuthorization?: (message: string) => Promise<boolean>
}

/** Phase 3: Agent Trace schema for .orchestration/agent_trace.jsonl (append-only ledger). */
export interface AgentTraceContributor {
	entity_type: "AI"
	model_identifier: string
}

export interface AgentTraceRange {
	start_line: number
	end_line: number
	content_hash: string
}

export interface AgentTraceRelated {
	type: "specification"
	value: string
}

export interface AgentTraceConversation {
	url: string
	contributor: AgentTraceContributor
	ranges: AgentTraceRange[]
	related: AgentTraceRelated[]
}

export interface AgentTraceFile {
	relative_path: string
	conversations: AgentTraceConversation[]
}

export interface AgentTraceEntry {
	id: string
	timestamp: string
	vcs: { revision_id: string | null }
	files: AgentTraceFile[]
}
