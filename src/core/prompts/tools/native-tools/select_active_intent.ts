import type OpenAI from "openai"

const SELECT_ACTIVE_INTENT_DESCRIPTION = `Select an active intent to work on. This tool MUST be called before writing any code or making changes. It loads the necessary context, constraints, and scope for the selected intent.

**CRITICAL:** You are an Intent-Driven Architect. You CANNOT write code immediately. Your first action MUST be to analyze the user request and call select_active_intent to load the necessary context.

After calling this tool, you will receive an <intent_context> block containing:
- The intent's constraints and requirements
- The owned_scope (files you're authorized to modify)
- Related files and recent history
- Acceptance criteria

Only after receiving this context can you proceed with code changes.`

const INTENT_ID_PARAMETER_DESCRIPTION = `The ID of the active intent to select (e.g., "INT-001", "INT-002"). Must match an ID from active_intents.yaml.`

export default {
	type: "function",
	function: {
		name: "select_active_intent",
		description: SELECT_ACTIVE_INTENT_DESCRIPTION,
		strict: true,
		parameters: {
			type: "object",
			properties: {
				intent_id: {
					type: "string",
					description: INTENT_ID_PARAMETER_DESCRIPTION,
				},
			},
			required: ["intent_id"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
