import { describe, it, expect, vi, beforeEach } from "vitest"

import type { ClineProvider } from "../../webview/ClineProvider"
import { buildNativeToolsArrayWithRestrictions } from "../build-tools"
import { hasOrchestrationIntents } from "../../prompts/sections/intent-handshake"

vi.mock("../../prompts/sections/intent-handshake", () => ({
	hasOrchestrationIntents: vi.fn(),
}))

vi.mock("../../../services/code-index/manager", () => ({
	CodeIndexManager: {
		getInstance: vi.fn().mockReturnValue({
			isFeatureEnabled: false,
			isFeatureConfigured: false,
			isInitialized: false,
		}),
	},
}))

function getToolNames(tools: { function?: { name: string } }[]): string[] {
	return tools.map((t) => ("function" in t && t.function ? t.function.name : "")).filter(Boolean)
}

describe("buildNativeToolsArrayWithRestrictions orchestration", () => {
	const mockProvider = {
		getMcpHub: vi.fn().mockReturnValue({ getServers: () => [] }),
		context: {},
	} as unknown as ClineProvider

	const baseOptions = {
		provider: mockProvider,
		cwd: "/some/workspace",
		mode: "code",
		customModes: undefined,
		experiments: {},
		apiConfiguration: { todoListEnabled: true },
		disabledTools: undefined,
		modelInfo: undefined,
	}

	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("includes select_active_intent when workspace has orchestration intents", async () => {
		vi.mocked(hasOrchestrationIntents).mockResolvedValue(true)

		const result = await buildNativeToolsArrayWithRestrictions(baseOptions)
		const names = getToolNames(result.tools as { function?: { name: string } }[])

		expect(names).toContain("select_active_intent")
	})

	it("does not include select_active_intent when workspace has no orchestration intents", async () => {
		vi.mocked(hasOrchestrationIntents).mockResolvedValue(false)

		const result = await buildNativeToolsArrayWithRestrictions(baseOptions)
		const names = getToolNames(result.tools as { function?: { name: string } }[])

		expect(names).not.toContain("select_active_intent")
	})

	it("includes select_active_intent in allowedFunctionNames when orchestration active and includeAllToolsWithRestrictions", async () => {
		vi.mocked(hasOrchestrationIntents).mockResolvedValue(true)

		const result = await buildNativeToolsArrayWithRestrictions({
			...baseOptions,
			includeAllToolsWithRestrictions: true,
		})

		expect(result.allowedFunctionNames).toBeDefined()
		expect(result.allowedFunctionNames).toContain("select_active_intent")
	})
})
