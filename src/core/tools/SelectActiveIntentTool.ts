import * as fs from "fs/promises"
import * as path from "path"
import * as yaml from "yaml"

import { Task } from "../task/Task"
import { formatResponse } from "../prompts/responses"
import { BaseTool, ToolCallbacks } from "./BaseTool"
import type { ToolUse } from "../../shared/tools"

interface SelectActiveIntentParams {
	intent_id: string
}

interface ActiveIntent {
	id: string
	name: string
	status: string
	owned_scope?: string[]
	constraints?: string[]
	acceptance_criteria?: string[]
}

export class SelectActiveIntentTool extends BaseTool<"select_active_intent"> {
	readonly name = "select_active_intent" as const

	async execute(params: SelectActiveIntentParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { intent_id } = params
		const { handleError, pushToolResult } = callbacks

		try {
			if (!intent_id) {
				task.consecutiveMistakeCount++
				task.recordToolError("select_active_intent")
				pushToolResult(await task.sayAndCreateMissingParamError("select_active_intent", "intent_id"))
				return
			}

			task.consecutiveMistakeCount = 0

			// Read active_intents.yaml
			const orchestrationDir = path.join(task.cwd, ".orchestration")
			const intentsFilePath = path.join(orchestrationDir, "active_intents.yaml")

			let intentsData: { active_intents?: ActiveIntent[] }
			try {
				const fileContent = await fs.readFile(intentsFilePath, "utf-8")
				intentsData = yaml.parse(fileContent) as { active_intents?: ActiveIntent[] }
			} catch (error) {
				const errorMsg = `Failed to read active_intents.yaml: ${error instanceof Error ? error.message : String(error)}`
				task.recordToolError("select_active_intent")
				pushToolResult(formatResponse.toolError(errorMsg))
				return
			}

			// Find the intent by ID
			const activeIntents = intentsData?.active_intents || []
			const intent = activeIntents.find((i) => i.id === intent_id)

			if (!intent) {
				task.recordToolError("select_active_intent")
				task.didToolFailInCurrentTurn = true
				const availableIds = activeIntents.map((i) => i.id).join(", ") || "(none)"
				pushToolResult(
					formatResponse.toolError(
						`Intent "${intent_id}" not found in active_intents.yaml. Available intents: ${availableIds}`,
					),
				)
				return
			}

			// Store the active intent on the task for later use by hooks
			// This allows hooks to check if an intent has been selected
			;(task as any).activeIntentId = intent_id
			;(task as any).activeIntent = intent

			// Construct the intent context XML block
			// According to Phase 1: "Construct an XML block <intent_context> containing *only* the constraints and scope for the selected ID"
			const intentContext = this.buildIntentContext(intent)

			// Return the context as the tool result
			// This will be injected into the conversation for the LLM to use
			pushToolResult(intentContext)
		} catch (error) {
			await handleError("selecting active intent", error as Error)
		}
	}

	/**
	 * Builds the intent context XML block containing constraints and scope.
	 * According to Phase 1 requirements, this should contain *only* the constraints and scope.
	 */
	private buildIntentContext(intent: ActiveIntent): string {
		const ownedScope = intent.owned_scope || []
		const constraints = intent.constraints || []

		// Build XML block with constraints and scope as specified in Phase 1
		const scopeSection =
			ownedScope.length > 0
				? `<owned_scope>
${ownedScope.map((scope) => `  - ${scope}`).join("\n")}
</owned_scope>`
				: `<owned_scope>
  (no scope defined)
</owned_scope>`

		const constraintsSection =
			constraints.length > 0
				? `<constraints>
${constraints.map((constraint) => `  - ${constraint}`).join("\n")}
</constraints>`
				: `<constraints>
  (no constraints defined)
</constraints>`

		return `<intent_context>
<intent_id>${intent.id}</intent_id>
<name>${intent.name}</name>

${scopeSection}

${constraintsSection}
</intent_context>`
	}
}

export const selectActiveIntentTool = new SelectActiveIntentTool()
