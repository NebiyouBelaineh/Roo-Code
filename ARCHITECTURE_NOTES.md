# Architecture Notes: Tool Loop & Prompt Builder

This document describes the architecture of two critical systems in Roo Code:

1. **The Tool Loop** - How tool calls are processed and executed
2. **The Prompt Builder** - How system prompts are constructed

---

## 1. Tool Loop Architecture

### Overview

The tool loop is responsible for processing tool calls from the LLM, routing them to appropriate handlers, executing them with user approval, and returning results. It operates as a sequential, blocking system that processes one tool call at a time.

### Location

**Primary Entry Point:** `src/core/assistant-message/presentAssistantMessage.ts`

**Core Components:**

- `src/core/assistant-message/presentAssistantMessage.ts` - Main routing/dispatching function
- `src/core/tools/BaseTool.ts` - Abstract base class for all tools
- `src/core/tools/*.ts` - Individual tool implementations (e.g., `WriteToFileTool.ts`, `ExecuteCommandTool.ts`)
- `src/core/assistant-message/NativeToolCallParser.ts` - Parses tool calls from API streams

### Flow Diagram

```
LLM API Stream
    ↓
Task.recursivelyMakeClineRequests() (Task.ts:2511)
    ↓
Stream chunks processed → "tool_call" chunks detected
    ↓
NativeToolCallParser.parseToolCall() (NativeToolCallParser.ts:670)
    ↓
ToolUse object created → Added to assistantMessageContent[]
    ↓
presentAssistantMessage() called (presentAssistantMessage.ts:61)
    ↓
Tool validation (validateToolUse)
    ↓
Tool repetition check
    ↓
Switch statement routes to specific tool handler
    ↓
BaseTool.handle() (BaseTool.ts:113)
    ↓
    ├─→ handlePartial() if partial/streaming
    └─→ execute() if complete
        ↓
    Tool-specific logic runs
    ↓
    Results pushed back via pushToolResult()
    ↓
    Tool result added to conversation history
```

### Detailed Component Breakdown

#### 1.1 Tool Call Parsing (`NativeToolCallParser.ts`)

**Location:** `src/core/assistant-message/NativeToolCallParser.ts`

**Key Method:** `parseToolCall()` (line 670)

**Responsibilities:**

- Converts native API tool call chunks into `ToolUse` objects
- Handles MCP tool name normalization (hyphens vs underscores)
- Resolves tool aliases to canonical names
- Validates tool names against registered tools
- Parses JSON arguments into typed parameters

**Example:**

```typescript
const toolUse = NativeToolCallParser.parseToolCall({
	id: "toolu_abc123",
	name: "write_to_file",
	arguments: '{"path": "test.ts", "content": "..."}',
})
// Returns: ToolUse<"write_to_file"> with nativeArgs populated
```

#### 1.2 Message Presentation (`presentAssistantMessage.ts`)

**Location:** `src/core/assistant-message/presentAssistantMessage.ts`

**Key Function:** `presentAssistantMessage(cline: Task)` (line 61)

**Responsibilities:**

- Processes assistant message content blocks sequentially
- Handles both text and tool_use blocks
- Implements locking mechanism to prevent concurrent execution
- Routes tool calls to appropriate handlers via switch statement
- Manages checkpointing for file modifications
- Handles tool validation and repetition detection

**Key Features:**

1. **Locking Mechanism** (lines 66-72):

    ```typescript
    if (cline.presentAssistantMessageLocked) {
    	cline.presentAssistantMessageHasPendingUpdates = true
    	return
    }
    cline.presentAssistantMessageLocked = true
    ```

    Prevents concurrent execution while processing a block.

2. **Tool Validation** (lines 590-623):

    - Validates tool name exists
    - Checks if tool is allowed for current mode
    - Verifies tool requirements (file patterns, etc.)
    - Throws errors that are converted to tool_result responses

3. **Tool Repetition Detection** (lines 626-676):

    - Uses `toolRepetitionDetector` to prevent identical consecutive calls
    - Can prompt user or block execution based on configuration

4. **Tool Routing** (lines 678-850):
    - Large switch statement routes to specific tool handlers
    - Each case calls `tool.handle()` with callbacks
    - Destructive operations trigger checkpointing first

**Example Routing:**

```typescript
case "write_to_file":
    await checkpointSaveAndMark(cline)
    await writeToFileTool.handle(cline, block as ToolUse<"write_to_file">, {
        askApproval,
        handleError,
        pushToolResult,
    })
    break
```

#### 1.3 Base Tool Infrastructure (`BaseTool.ts`)

**Location:** `src/core/tools/BaseTool.ts`

**Key Class:** `BaseTool<TName extends ToolName>` (line 29)

**Key Method:** `handle()` (line 113)

**Responsibilities:**

- Provides unified entry point for all tool execution
- Handles partial/streaming tool calls
- Extracts typed parameters from `nativeArgs`
- Delegates to tool-specific `execute()` method
- Manages error handling and parameter validation

**Execution Flow:**

1. **Partial Message Handling** (lines 115-126):

    ```typescript
    if (block.partial) {
    	await this.handlePartial(task, block)
    	return
    }
    ```

    Tools can override `handlePartial()` to show streaming UI updates.

2. **Parameter Extraction** (lines 128-157):

    ```typescript
    if (block.nativeArgs !== undefined) {
    	params = block.nativeArgs as ToolParams<TName>
    } else {
    	throw new Error("Tool call is missing native arguments")
    }
    ```

    Uses typed `nativeArgs` from `NativeToolCallParser`.

3. **Tool Execution** (line 160):
    ```typescript
    await this.execute(params, task, callbacks)
    ```
    Calls tool-specific implementation.

**Tool Callbacks Interface:**

```typescript
interface ToolCallbacks {
	askApproval: AskApproval // Request user approval
	handleError: HandleError // Handle errors
	pushToolResult: PushToolResult // Send results back
	toolCallId?: string // Optional tool call ID
}
```

#### 1.4 Individual Tool Implementations

**Location:** `src/core/tools/*.ts`

**Pattern:** All tools extend `BaseTool<TName>` and implement:

- `readonly name: TName` - Tool identifier
- `execute(params, task, callbacks)` - Core execution logic
- `handlePartial(task, block)` (optional) - Streaming UI updates

**Example: `WriteToFileTool`**

**Location:** `src/core/tools/WriteToFileTool.ts`

**Key Method:** `execute()` (line 29)

**Flow:**

1. Validates parameters (path, content)
2. Checks `rooIgnoreController` for access restrictions
3. Determines if file exists (create vs modify)
4. Creates parent directories if needed
5. Normalizes content (removes markdown code fences, unescapes HTML)
6. Requests user approval via `askApproval()`
7. Writes file via `diffViewProvider.saveDirectly()` or `saveChanges()`
8. Tracks file context for code indexing
9. Pushes result via `pushToolResult()`

**Example: `ExecuteCommandTool`**

**Location:** `src/core/tools/ExecuteCommandTool.ts`

**Key Method:** `execute()` (line 34)

**Flow:**

1. Validates command parameter
2. Checks `rooIgnoreController` for command restrictions
3. Requests user approval
4. Configures execution options (timeout, working directory)
5. Calls `executeCommandInTerminal()` (line 97)
6. Handles shell integration errors with fallback
7. Pushes result with command output

### Tool Execution Lifecycle

```
1. LLM generates tool_use block
   ↓
2. Stream chunk arrives → NativeToolCallParser.parseToolCall()
   ↓
3. ToolUse added to assistantMessageContent[]
   ↓
4. presentAssistantMessage() called
   ↓
5. Validation checks (name, mode, requirements)
   ↓
6. Repetition check
   ↓
7. Switch routes to tool.handle()
   ↓
8. BaseTool.handle() extracts params
   ↓
9. Tool.execute() runs:
   - askApproval() → User approves/rejects
   - Tool performs action
   - pushToolResult() → Result sent back
   ↓
10. Tool result added to conversation history
   ↓
11. LLM receives result and continues
```

### Key Design Patterns

1. **Sequential Processing**: Tools execute one at a time, blocking until completion
2. **User Approval**: Destructive operations require explicit approval
3. **Error Handling**: Errors are converted to tool_result responses, not exceptions
4. **Streaming Support**: Tools can show partial UI updates during streaming
5. **Type Safety**: Strong typing via generics (`BaseTool<TName>`)
6. **Separation of Concerns**: Routing (presentAssistantMessage) vs Execution (BaseTool/Tools)

---

## 2. Prompt Builder Architecture

### Overview

The prompt builder constructs the system prompt that guides the LLM's behavior. It assembles multiple sections (role definition, capabilities, rules, custom instructions) into a cohesive prompt that is sent with every API request.

### Location

**Primary Entry Point:** `src/core/prompts/system.ts`

**Core Components:**

- `src/core/prompts/system.ts` - Main prompt construction (`SYSTEM_PROMPT`, `generatePrompt`)
- `src/core/prompts/sections/*.ts` - Individual prompt sections
- `src/core/task/Task.ts` - Calls prompt builder (`getSystemPrompt()` method)

### Flow Diagram

```
Task.getSystemPrompt() (Task.ts:3745)
    ↓
Wait for MCP servers to connect
    ↓
Gather state (mode, custom instructions, experiments, etc.)
    ↓
SYSTEM_PROMPT() called (system.ts:112)
    ↓
generatePrompt() assembles sections (system.ts:41)
    ↓
    ├─→ roleDefinition (from mode)
    ├─→ markdownFormattingSection()
    ├─→ getSharedToolUseSection()
    ├─→ getToolUseGuidelinesSection()
    ├─→ getCapabilitiesSection()
    ├─→ getModesSection()
    ├─→ getSkillsSection()
    ├─→ getRulesSection()
    ├─→ getSystemInfoSection()
    ├─→ getObjectiveSection()
    └─→ addCustomInstructions()
    ↓
Complete system prompt string returned
    ↓
Used in API calls (Task.ts:4279) and context condensing (Task.ts:1640)
```

### Detailed Component Breakdown

#### 2.1 Main Prompt Builder (`system.ts`)

**Location:** `src/core/prompts/system.ts`

**Key Functions:**

1. **`SYSTEM_PROMPT()`** (line 112-158)

    - Public API for generating system prompts
    - Validates extension context
    - Resolves custom mode prompts
    - Delegates to `generatePrompt()`

2. **`generatePrompt()`** (line 41-110)
    - Internal function that assembles the prompt
    - Determines which sections to include
    - Combines all sections into final string

**Key Parameters:**

```typescript
SYSTEM_PROMPT(
    context: vscode.ExtensionContext,
    cwd: string,
    supportsComputerUse: boolean,
    mcpHub?: McpHub,
    diffStrategy?: DiffStrategy,
    mode: Mode = defaultModeSlug,
    customModePrompts?: CustomModePrompts,
    customModes?: ModeConfig[],
    globalCustomInstructions?: string,
    experiments?: Record<string, boolean>,
    language?: string,
    rooIgnoreInstructions?: string,
    settings?: SystemPromptSettings,
    todoList?: TodoItem[],
    modelId?: string,
    skillsManager?: SkillsManager,
): Promise<string>
```

**Prompt Assembly** (lines 85-107):

```typescript
const basePrompt = `${roleDefinition}

${markdownFormattingSection()}

${getSharedToolUseSection()}${toolsCatalog}

${getToolUseGuidelinesSection()}

${getCapabilitiesSection(cwd, shouldIncludeMcp ? mcpHub : undefined)}

${modesSection}
${skillsSection ? `\n${skillsSection}` : ""}
${getRulesSection(cwd, settings)}

${getSystemInfoSection(cwd)}

${getObjectiveSection()}

${await addCustomInstructions(baseInstructions, globalCustomInstructions || "", cwd, mode, {
	language: language ?? formatLanguage(vscode.env.language),
	rooIgnoreInstructions,
	settings,
})}`
```

#### 2.2 Prompt Sections (`sections/`)

**Location:** `src/core/prompts/sections/`

**Exported Sections** (from `sections/index.ts`):

1. **`getRulesSection()`** (`rules.ts`)

    - Reads `.cursorrules` and `AGENTS.md` files
    - Includes subfolder-specific rules if enabled
    - Respects `useAgentRules` setting

2. **`getSystemInfoSection()`** (`system-info.ts`)

    - Current working directory
    - Time and timezone (if enabled)
    - API usage cost (if enabled)

3. **`getObjectiveSection()`** (`objective.ts`)

    - High-level objectives for the AI assistant

4. **`addCustomInstructions()`** (`custom-instructions.ts`)

    - Mode-specific custom instructions
    - Global custom instructions
    - RooIgnore instructions
    - Language-specific formatting

5. **`getSharedToolUseSection()`** (`tool-use.ts`)

    - General guidelines for tool usage

6. **`getToolUseGuidelinesSection()`** (`tool-use-guidelines.ts`)

    - Specific rules for using tools correctly

7. **`getCapabilitiesSection()`** (`capabilities.ts`)

    - Available capabilities (MCP tools, codebase search, etc.)

8. **`getModesSection()`** (`modes.ts`)

    - Available modes and their purposes

9. **`getSkillsSection()`** (`skills.ts`)

    - Available skills from SkillsManager

10. **`markdownFormattingSection()`** (`markdown-formatting.ts`)
    - Formatting guidelines for markdown

#### 2.3 Task Integration (`Task.ts`)

**Location:** `src/core/task/Task.ts`

**Key Method:** `getSystemPrompt()` (line 3745-3820)

**Responsibilities:**

- Waits for MCP servers to connect (if enabled)
- Gathers current state from provider
- Calls `SYSTEM_PROMPT()` with all parameters
- Returns complete prompt string

**Usage Points:**

1. **API Calls** (line 4020):

    ```typescript
    const systemPrompt = await this.getSystemPrompt()
    // ... later ...
    const stream = this.api.createMessage(systemPrompt, cleanConversationHistory, metadata)
    ```

2. **Context Condensing** (line 1640):
    ```typescript
    const systemPrompt = await this.getSystemPrompt()
    // ... passed to summarizeConversation()
    ```

### Prompt Construction Details

#### Section Order

The prompt is assembled in a specific order to ensure logical flow:

1. **Role Definition** - Who the AI is and its primary role
2. **Markdown Formatting** - How to format responses
3. **Tool Use Guidelines** - General tool usage rules
4. **Capabilities** - What the AI can do
5. **Modes** - Available modes and their purposes
6. **Skills** - Available skills
7. **Rules** - Project-specific rules from files
8. **System Info** - Context about the environment
9. **Objective** - High-level goals
10. **Custom Instructions** - User-defined instructions

#### Dynamic Content

The prompt includes dynamic content based on:

- **Current Mode**: Different role definitions and instructions
- **MCP Servers**: Capabilities section includes available MCP tools
- **Custom Modes**: User-defined modes with custom prompts
- **Workspace Rules**: `.cursorrules` and `AGENTS.md` files
- **Experiments**: Feature flags that modify behavior
- **Language**: Localized formatting instructions

#### Custom Instructions Processing

**Location:** `src/core/prompts/sections/custom-instructions.ts`

**Function:** `addCustomInstructions()` (line 382)

**Flow:**

1. Combines mode-specific and global custom instructions
2. Processes RooIgnore instructions (file access restrictions)
3. Formats instructions based on language
4. Appends to base instructions from mode

### Key Design Patterns

1. **Composition**: Prompt built from modular sections
2. **Async Assembly**: Some sections require async operations (reading files, MCP queries)
3. **Conditional Inclusion**: Sections included based on configuration
4. **Caching**: Prompt generated once per API call, reused for condensing
5. **Separation of Concerns**: Each section is independent and testable

---

## 3. Integration Points

### How Tool Loop and Prompt Builder Work Together

1. **Prompt Builder** creates system prompt that instructs LLM on available tools
2. **LLM** generates tool calls based on prompt instructions
3. **Tool Loop** processes and executes those tool calls
4. **Results** feed back into conversation history
5. **Next API call** uses updated prompt (if mode/rules changed)

### Hook Injection Points

For implementing the hook engine (Phase 1+), key interception points:

1. **Pre-Tool Execution Hook:**

    - Location: `BaseTool.handle()` before `execute()` call
    - Or: `presentAssistantMessage()` before routing to tool

2. **Post-Tool Execution Hook:**

    - Location: `BaseTool.handle()` after `execute()` completes
    - Or: Individual tool `execute()` methods after core logic

3. **System Prompt Modification:**

    - Location: `generatePrompt()` in `system.ts`
    - Add new section or modify existing sections
    - Inject intent-driven instructions

4. **Tool Call Interception:**
    - Location: `presentAssistantMessage()` switch statement
    - Can wrap tool.handle() calls with pre/post hooks

---

## 4. File Reference Summary

### Tool Loop Files

- `src/core/assistant-message/presentAssistantMessage.ts` - Main router
- `src/core/tools/BaseTool.ts` - Base infrastructure
- `src/core/tools/WriteToFileTool.ts` - File writing tool
- `src/core/tools/ExecuteCommandTool.ts` - Command execution tool
- `src/core/assistant-message/NativeToolCallParser.ts` - Tool call parser
- `src/core/task/Task.ts` - Task class (contains `recursivelyMakeClineRequests`)

### Prompt Builder Files

- `src/core/prompts/system.ts` - Main prompt builder
- `src/core/prompts/sections/*.ts` - Prompt sections
- `src/core/task/Task.ts` - Task class (contains `getSystemPrompt()`)

---

## 5. Key Takeaways

### Tool Loop

- **Sequential Processing**: One tool at a time, blocking execution
- **User Approval Required**: Destructive operations need explicit approval
- **Type-Safe Routing**: Switch statement routes to strongly-typed handlers
- **Error Handling**: Errors become tool_result responses, not exceptions
- **Streaming Support**: Tools can show partial UI during streaming

### Prompt Builder

- **Modular Assembly**: Prompt built from independent sections
- **Dynamic Content**: Includes workspace-specific rules and custom instructions
- **Mode-Aware**: Different prompts for different modes
- **Async Construction**: Some sections require async operations
- **Single Source of Truth**: Generated once per API call, reused for condensing

---
