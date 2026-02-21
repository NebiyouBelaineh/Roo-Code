/**
 * Demo: Intent Map post-hook behavior.
 * Run from repo root: pnpm exec tsx src/scripts/demo-intent-map.ts
 * Requires .orchestration/active_intents.yaml (uses INT-WEATHER, INT-CI, etc. from there).
 */
import path from "path"
import { runIntentMapPostHook } from "../hooks/IntentMapPostHook"

const repoRoot = process.cwd()
const task = { cwd: repoRoot } as any

async function main() {
	console.log("CWD:", repoRoot)
	console.log("Orchestration dir:", path.join(repoRoot, ".orchestration"))
	console.log("")

	// 1) First write: creates intent_map.md with one section
	console.log("1) INT-WEATHER + src/weather.ts (creates file or section)")
	await runIntentMapPostHook(task, { intent_id: "INT-WEATHER", path: "src/weather.ts" })

	// 2) Same intent, new file: appends to existing section
	console.log("2) INT-WEATHER + src/weather/client.ts")
	await runIntentMapPostHook(task, { intent_id: "INT-WEATHER", path: "src/weather/client.ts" })

	// 3) Another intent: new section (name from active_intents.yaml)
	console.log("3) INT-CI + .github/workflows/ci.yml")
	await runIntentMapPostHook(task, { intent_id: "INT-CI", path: ".github/workflows/ci.yml" })

	// 4) Dedupe: same path again → still one entry
	console.log("4) INT-WEATHER + src/weather.ts again (dedupe)")
	await runIntentMapPostHook(task, { intent_id: "INT-WEATHER", path: "src/weather.ts" })

	console.log("")
	console.log("Done. Check .orchestration/intent_map.md")
}

main().catch((e) => {
	console.error(e)
	process.exit(1)
})
