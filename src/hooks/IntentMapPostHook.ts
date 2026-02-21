import * as fs from "fs/promises"
import * as path from "path"
import * as yaml from "yaml"

import type { Task } from "../core/task/Task"

const ORCHESTRATION_DIR = ".orchestration"
const INTENT_MAP_FILENAME = "intent_map.md"
const ACTIVE_INTENTS_FILENAME = "active_intents.yaml"

interface ActiveIntent {
	id: string
	name?: string
}

interface ActiveIntentsData {
	active_intents?: ActiveIntent[]
}

export interface IntentMapPostHookParams {
	intent_id: string
	path: string
}

/**
 * Resolves the section title for an intent (e.g. "INT-001: JWT Auth" or "INT-001").
 */
async function resolveIntentTitle(cwd: string, intentId: string): Promise<string> {
	try {
		const intentsPath = path.join(cwd, ORCHESTRATION_DIR, ACTIVE_INTENTS_FILENAME)
		const content = await fs.readFile(intentsPath, "utf-8")
		const data = yaml.parse(content) as ActiveIntentsData
		const intents = data?.active_intents ?? []
		const intent = intents.find((i) => i.id === intentId)
		if (intent?.name?.trim()) {
			return `${intent.id}: ${intent.name.trim()}`
		}
	} catch {
		// Use intent_id only if file missing or parse fails
	}
	return intentId
}

const SECTION_HEADER_RE = /^##\s+(.+)$/
const LIST_ITEM_RE = /^-\s+`([^`]+)`\s*$/

/**
 * Parses intent_map.md content into ordered sections and path sets.
 * Returns { order: section titles in order, sections: title -> Set of paths }.
 */
function parseIntentMap(content: string): { order: string[]; sections: Map<string, Set<string>> } {
	const order: string[] = []
	const sections = new Map<string, Set<string>>()
	const lines = content.split(/\r?\n/)
	let currentTitle: string | null = null
	let currentPaths: Set<string> | null = null

	for (const line of lines) {
		const sectionMatch = line.match(SECTION_HEADER_RE)
		if (sectionMatch) {
			if (currentTitle !== null && currentPaths !== null) {
				order.push(currentTitle)
				sections.set(currentTitle, currentPaths)
			}
			currentTitle = sectionMatch[1].trim()
			currentPaths = new Set()
			continue
		}
		const listMatch = line.match(LIST_ITEM_RE)
		if (listMatch && currentTitle !== null && currentPaths !== null) {
			currentPaths.add(listMatch[1])
		}
	}
	if (currentTitle !== null && currentPaths !== null) {
		order.push(currentTitle)
		sections.set(currentTitle, currentPaths)
	}
	return { order, sections }
}

/**
 * Serializes order + sections back to Markdown.
 */
function serializeIntentMap(order: string[], sections: Map<string, Set<string>>): string {
	const lines: string[] = [
		"# Intent Map",
		"",
		"Maps business intents to files. Updated when INTENT_EVOLUTION occurs.",
		"",
	]
	for (const title of order) {
		lines.push(`## ${title}`, "")
		const paths = sections.get(title)
		if (paths) {
			const sorted = Array.from(paths).sort()
			for (const p of sorted) {
				lines.push(`- \`${p}\``)
			}
			lines.push("")
		}
	}
	return (
		lines
			.join("\n")
			.replace(/\n{3,}/g, "\n\n")
			.trimEnd() + "\n"
	)
}

/**
 * Post-Hook for write_to_file when mutation_class is INTENT_EVOLUTION.
 * Updates .orchestration/intent_map.md: adds the file path to the intent's section,
 * creating the section if missing. Does not throw; logs errors.
 */
export async function runIntentMapPostHook(task: Task, params: IntentMapPostHookParams): Promise<void> {
	const { intent_id, path: filePath } = params
	const cwd = task.cwd
	const orchestrationDir = path.join(cwd, ORCHESTRATION_DIR)
	const intentMapPath = path.join(orchestrationDir, INTENT_MAP_FILENAME)

	try {
		const sectionTitle = await resolveIntentTitle(cwd, intent_id)

		let order: string[]
		let sections: Map<string, Set<string>>

		try {
			const content = await fs.readFile(intentMapPath, "utf-8")
			const parsed = parseIntentMap(content)
			order = parsed.order
			sections = new Map(parsed.sections)
		} catch {
			// Missing or malformed: start fresh
			order = []
			sections = new Map()
		}

		// Find existing section whose title starts with intent_id (e.g. "INT-001" or "INT-001: Name")
		const existingTitle = order.find((t) => t === intent_id || t.startsWith(intent_id + ": "))
		if (existingTitle) {
			const paths = sections.get(existingTitle) ?? new Set()
			paths.add(filePath)
			sections.set(existingTitle, paths)
		} else {
			// New section: use resolved title and add at end
			order.push(sectionTitle)
			const paths = new Set<string>([filePath])
			sections.set(sectionTitle, paths)
		}

		const out = serializeIntentMap(order, sections)
		await fs.mkdir(orchestrationDir, { recursive: true })
		await fs.writeFile(intentMapPath, out, "utf-8")
	} catch (err) {
		console.error("[IntentMapPostHook] Failed to update intent map:", err)
	}
}
