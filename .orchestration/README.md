# .orchestration/ Directory

This directory contains machine-managed orchestration files that enable Intent-Code Traceability and AI-Native Git functionality.

## Files

### `active_intents.yaml`

Tracks the lifecycle of business requirements and formalized intents. Each intent defines:

- **ID**: Unique identifier (e.g., "INT-001")
- **Status**: IN_PROGRESS, COMPLETED, PENDING
- **Owned Scope**: Files and directories the intent is authorized to modify
- **Constraints**: Rules that must be followed
- **Acceptance Criteria**: Definition of done

**Update Pattern:** Updated via Pre-Hooks (when an agent picks a task) and Post-Hooks (when a task is complete).

### `agent_trace.jsonl`

An append-only, machine-readable ledger of every mutating action. Links abstract Intent IDs to concrete code changes via content hashing.

**Schema:**

- `id`: UUID v4
- `timestamp`: ISO 8601 timestamp
- `vcs`: Git revision information
- `files`: Array of file changes with:
    - `relative_path`: File path
    - `conversations`: Session information
    - `ranges`: Code ranges with content hashes (spatial independence)
    - `related`: Links to intent IDs

**Update Pattern:** Updated via Post-Hook after file writes.

### `intent_map.md`

Maps high-level business intents to physical files and AST nodes. Provides spatial mapping for answering questions like "Where is the billing logic?"

**Update Pattern:** Incrementally updated when INTENT_EVOLUTION occurs.

### `AGENT.md` (or `CLAUDE.md`)

A persistent knowledge base shared across parallel sessions. Contains:

- Lessons Learned
- Project-specific stylistic rules
- Common pitfalls to avoid
- Architectural decisions
- Verification failures & solutions

**Update Pattern:** Incrementally appended when verification loops fail or architectural decisions are made.

## Usage

These files are automatically managed by the hook engine. Manual edits are possible but should be done carefully to maintain consistency.

## Data Model

Based on the TRP1 Challenge Week 1 specification:

- Inspired by Spec-Driven Development and AISpec
- Uses content hashing for spatial independence
- Links Intent → Code AST → Agent Action
- Enables AI-Native Git functionality

## Phase 1 Implementation: Reasoning Loop & Pre-Hook System

### Overview

Phase 1 implements the "Handshake" - a two-stage state machine that solves the Context Paradox by requiring agents to declare an intent before performing destructive operations. This enforces Intent-Driven Development and prevents "vibe coding."

### The Reasoning Loop

**Flow:**

1. **State 1: User Request** - User prompts: "Refactor the auth middleware"
2. **State 2: Reasoning Intercept** - Agent must call `select_active_intent(intent_id)` first
3. **State 3: Contextualized Action** - Agent receives intent context and can proceed with code changes

**Implementation:**

- **Tool:** `SelectActiveIntentTool` (`src/core/tools/SelectActiveIntentTool.ts`)
- **Purpose:** Loads intent context (constraints, scope) from `active_intents.yaml`
- **Output:** Returns XML `<intent_context>` block with constraints and owned_scope
- **State Storage:** Stores `activeIntentId` and `activeIntent` on Task object for hook access

### Pre-Hook Logic: Intent Gatekeeper

**Location:** `src/hooks/IntentGatekeeperHook.ts`

**Purpose:** Enforces that agents declare a valid intent before destructive operations.

**How It Works:**

1. **Tool Classification:**

    - **Requires Intent:** `write_to_file`, `edit`, `edit_file`, `search_replace`, `apply_diff`, `apply_patch`, `execute_command`
    - **Exempt:** `select_active_intent`, `read_file`, `list_files`, `search_files`, `codebase_search`, and other read-only/meta tools

2. **Validation Flow:**

    ```
    Tool Execution Request
    ↓
    Check if tool requires intent
    ↓
    Check if activeIntentId exists on Task
    ↓
    Validate intent exists in active_intents.yaml
    ↓
    Allow/Block execution
    ```

3. **Integration Point:** `src/core/assistant-message/presentAssistantMessage.ts` (lines 680-698)
    - Intercepts before tool execution
    - Checks hook result
    - Blocks execution if intent not validated
    - Returns error: "You must cite a valid active Intent ID."

**Error Handling:**

- Missing intent → Blocks with error message
- Invalid intent ID → Blocks with error message
- File read errors → Blocks (considers intent invalid)
- YAML parse errors → Blocks (considers intent invalid)

### Select Active Intent Tool

**Location:** `src/core/tools/SelectActiveIntentTool.ts`

**Functionality:**

- Reads `active_intents.yaml` from `.orchestration/` directory
- Validates intent ID exists
- Stores intent state on Task object
- Returns XML context block with:
    - Intent ID and name
    - Owned scope (files authorized to modify)
    - Constraints (rules to follow)

**Error Cases:**

- Missing `intent_id` parameter → Returns missing param error
- File not found → Returns file read error
- Intent not found → Returns error with available intent IDs

### Testing

**Test File:** `src/hooks/__tests__/IntentGatekeeperHook.spec.ts`

**Coverage:** 46 tests covering:

1. **Destructive Tools Without Intent** (7 tests)

    - Blocks all destructive tools when no intent selected
    - Tests undefined and empty string cases

2. **Destructive Tools With Invalid Intent** (4 tests)

    - Blocks when file doesn't exist
    - Blocks when intent ID not found
    - Blocks when YAML is empty or malformed

3. **Destructive Tools With Valid Intent** (8 tests)

    - Allows all 7 destructive tools when valid intent exists
    - Verifies intent validation works correctly

4. **Exempt Tools** (3 tests)

    - Allows 16 read-only/meta tools without intent
    - Verifies `select_active_intent` itself is exempt

5. **File System Errors** (2 tests)

    - Handles permission errors
    - Handles YAML parse failures

6. **Intent Validation** (2 tests)

    - Verifies correct file path reading
    - Verifies YAML parsing and intent matching

7. **Edge Cases** (2 tests)
    - Unknown tools default to allowed
    - Case sensitivity in intent IDs

**Run Tests:**

```bash
cd src && pnpm exec vitest run hooks/__tests__/IntentGatekeeperHook.spec.ts
```

### Architecture

**Hook System Structure:**

```
src/hooks/
├── index.ts                    # Hook engine exports
├── types.ts                    # Hook type definitions
├── IntentGatekeeperHook.ts     # Pre-execution hook
└── __tests__/
    └── IntentGatekeeperHook.spec.ts
```

**Integration Flow:**

```
presentAssistantMessage()
  ↓
Tool validation (mode, requirements)
  ↓
Tool repetition check
  ↓
IntentGatekeeperHook.check() ← Pre-Hook Intercept
  ↓
  ├─→ Block if no valid intent
  └─→ Allow if intent validated
  ↓
Tool.handle() → Tool.execute()
```

**Key Design Decisions:**

- **Middleware Pattern:** Hooks are isolated, composable, and fail-safe
- **Type Safety:** Uses TypeScript generics for tool name typing
- **Separation of Concerns:** Hook logic separate from tool execution
- **Fail-Safe:** Errors block execution rather than allowing unsafe operations

## Future Enhancements

### Intent History Context Injection

**What it adds:** Automatically injects recent work history when an intent is selected, providing continuity across sessions and showing what's already been done.

**Benefits:**

- Prevents duplicate work by showing previous changes
- Provides context about files already modified for the intent
- Enables continuity across multiple agent sessions
- Helps agents understand the current state of an intent

**Implementation Steps:**

1. **Enhance `SelectActiveIntentTool`**: Add method to query `agent_trace.jsonl` for entries where `related[].value` matches the selected intent ID.

2. **Load Recent History**: Parse JSONL file, extract file paths, timestamps, and content hashes for related entries.

3. **Inject Context**: Add recent history to conversation via one of:

    - Pre-hook before API calls (recommended) - intercepts before `Task.api.createMessage()`
    - Conversation history message - add after `select_active_intent` completes
    - Dynamic system prompt - include in system prompt when intent is active

4. **Format Context**: Structure as XML or markdown showing:
    - Files previously modified for this intent
    - Timestamps of changes
    - Summary of recent work

**Key Integration Points:**

- `SelectActiveIntentTool.execute()` - Load history when intent selected
- `Task.recursivelyMakeClineRequests()` - Pre-hook before API calls
- `Task.getSystemPrompt()` - Optional system prompt enhancement
