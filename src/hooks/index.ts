/**
 * Hook Engine - Middleware boundary for tool execution
 *
 * Provides pre-execution and post-execution hooks for:
 * - Intent validation and enforcement
 * - Scope checking
 * - Trace logging
 * - Context injection
 */

export { IntentGatekeeperHook } from "./IntentGatekeeperHook"
export type { HookResult } from "./types"
