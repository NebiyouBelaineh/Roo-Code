import fs from "fs/promises"
import path from "path"

/**
 * Returns whether the workspace has orchestration intents (active_intents.yaml exists).
 * Used to conditionally inject the intent-handshake mandate so non-orchestration workspaces are unchanged.
 */
export async function hasOrchestrationIntents(cwd: string): Promise<boolean> {
	try {
		const intentsPath = path.join(cwd, ".orchestration", "active_intents.yaml")
		await fs.access(intentsPath)
		return true
	} catch {
		return false
	}
}

const INTENT_HANDSHAKE_SECTION = `====

INTENT-DRIVEN PROTOCOL (REQUIRED WHEN ACTIVE INTENTS EXIST)

You are an Intent-Driven Architect. You MUST NOT write code or perform destructive actions (e.g. write_to_file, edit, search_replace, apply_diff, execute_command) until you have called select_active_intent with a valid intent_id and received the <intent_context> response.

For any task that involves code or file changes:
1. Analyze the user's request and identify the correct intent ID from the project's active intents (.orchestration/active_intents.yaml).
2. Call select_active_intent with that intent_id as your first action.
3. Only after you receive the <intent_context> (constraints and owned_scope) may you call write/edit/execute tools.

If you attempt a destructive tool without having first called select_active_intent successfully, the system will block execution and return an error. Read-only tools (read_file, list_files, codebase_search, etc.) do not require a selected intent.`

/**
 * Returns the intent-handshake mandate section for the system prompt when the workspace
 * has .orchestration/active_intents.yaml. Otherwise returns empty string so non-orchestration
 * workspaces are unchanged.
 */
export async function getIntentHandshakeSection(cwd: string): Promise<string> {
	const hasIntents = await hasOrchestrationIntents(cwd)
	return hasIntents ? INTENT_HANDSHAKE_SECTION : ""
}
