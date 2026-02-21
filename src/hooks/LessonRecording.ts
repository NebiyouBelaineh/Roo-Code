import * as fs from "fs/promises"
import * as path from "path"

const AGENT_MD_FILENAME = "AGENT.md"
const ORCHESTRATION_DIR = ".orchestration"

/**
 * Phase 4: Appends a "Lesson Learned" entry to the shared brain file (.orchestration/AGENT.md)
 * when a verification step (e.g. linter) fails after a save. Used by write tools when
 * newProblemsMessage is non-empty.
 *
 * Does not throw; logs errors so a failing disk write does not break the tool.
 */
export async function appendLessonLearned(cwd: string, filePath: string, problemsMessage: string): Promise<void> {
	if (!filePath || !problemsMessage?.trim()) {
		return
	}
	const dir = path.join(cwd, ORCHESTRATION_DIR)
	const targetPath = path.join(dir, AGENT_MD_FILENAME)
	const now = new Date().toISOString().slice(0, 10)
	const section = `## Lesson Learned (${now})\n**File:** ${filePath}\n**Problems:**\n${problemsMessage.trim()}\n\n`
	try {
		await fs.mkdir(dir, { recursive: true })
		await fs.appendFile(targetPath, section, "utf-8")
	} catch (err) {
		console.error("[LessonRecording] appendLessonLearned failed:", err)
	}
}
