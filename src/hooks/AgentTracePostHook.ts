import * as fs from "fs/promises"
import * as path from "path"
import { randomUUID } from "crypto"

import type { Task } from "../core/task/Task"
import { getCurrentRevision } from "../utils/git"
import { contentHashSha256 } from "../utils/contentHash"
import type { AgentTraceEntry } from "./types"

const ORCHESTRATION_DIR = ".orchestration"
const AGENT_TRACE_FILENAME = "agent_trace.jsonl"

/** Params from a successful write_to_file call (path and intent required for trace). */
export interface WriteToFileTraceParams {
	path: string
	content?: string
	intent_id: string
}

/**
 * Post-Hook for write_to_file: appends one Agent Trace entry to .orchestration/agent_trace.jsonl
 * after a successful write. Links intent (REQ-ID) to content hash for full traceability.
 * Does not throw; logs errors so trace failures do not break the tool.
 * Call from WriteToFileTool after the file has been written and approved.
 */
export async function runAgentTracePostHook(task: Task, params: WriteToFileTraceParams): Promise<void> {
	const relPath = params.path
	const intentId = params.intent_id ?? (task as { activeIntentId?: string }).activeIntentId ?? null
	if (!intentId) return

	const absolutePath = path.resolve(task.cwd, relPath)
	let content: string
	try {
		content = await fs.readFile(absolutePath, "utf-8")
	} catch (err) {
		// Fallback to tool-provided content if file read fails (e.g. race)
		content = typeof params.content === "string" ? params.content : ""
	}

	const contentHash = contentHashSha256(content)
	const lines = content.split("\n")
	const endLine = lines.length > 0 ? lines.length : 1

	const revisionId = await getCurrentRevision(task.cwd)
	const modelId = task.api?.getModel?.()?.id ?? "unknown"

	const entry: AgentTraceEntry = {
		id: randomUUID(),
		timestamp: new Date().toISOString(),
		vcs: { revision_id: revisionId },
		files: [
			{
				relative_path: relPath,
				conversations: [
					{
						url: task.taskId,
						contributor: { entity_type: "AI", model_identifier: modelId },
						ranges: [{ start_line: 1, end_line: endLine, content_hash: contentHash }],
						related: [{ type: "specification", value: intentId }],
					},
				],
			},
		],
	}

	const orchestrationDir = path.join(task.cwd, ORCHESTRATION_DIR)
	const tracePath = path.join(orchestrationDir, AGENT_TRACE_FILENAME)
	try {
		await fs.mkdir(orchestrationDir, { recursive: true })
		await fs.appendFile(tracePath, JSON.stringify(entry) + "\n", "utf-8")
	} catch (err) {
		console.error("[AgentTracePostHook] Failed to append trace:", err)
	}
}
