# Architecture Notes: Tool Loop, Prompt Builder & Data Boundaries

This document describes the architecture of several critical systems in Roo Code:

1. **The Tool Loop** - How tool calls are processed and executed
2. **The Prompt Builder** - How system prompts are constructed
3. **The Three-Layer Model & Data Boundaries** - How the Webview, Extension Host, and LLM backend interact; security, secrets, and XSS considerations

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
Pre-Hook: Intent Gatekeeper (IntentGatekeeperHook.check) — blocks destructive tools if no valid intent
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

4. **Intent Gatekeeper (Pre-Hook)** (presentAssistantMessage.ts, before tool switch):

    - For each complete tool block, `IntentGatekeeperHook.check()` runs before dispatch.
    - Destructive tools (`write_to_file`, `edit`, `execute_command`, etc.) require a valid `task.activeIntentId` and that the ID exists in `.orchestration/active_intents.yaml`. Otherwise execution is blocked and a tool error is returned: _"You must cite a valid active Intent ID."_
    - Read-only and exempt tools (including `select_active_intent`) are not gated. See `src/hooks/IntentGatekeeperHook.ts` and `.orchestration/README.md` for the full handshake wiring.

5. **Tool Routing** (lines 678-850):
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
    ├─→ getIntentHandshakeSection(cwd) (when .orchestration/active_intents.yaml exists)
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

11. **`getIntentHandshakeSection()`** (`intent-handshake.ts`)

    - When `.orchestration/active_intents.yaml` exists, injects the **INTENT-DRIVEN PROTOCOL** mandate: the model must call `select_active_intent` before any destructive tool use. Ensures the reasoning loop (handshake) is an explicit contract in the system prompt. See `.orchestration/README.md` for end-to-end handshake wiring.

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

## 3. Three-Layer Model & Data Boundaries

### Overview

VS Code extensions that provide rich UI (like Roo Code) follow a **three-layer architecture**:

1. **Webview (UI layer)** – Renders the UI in an isolated browser-like context; no direct access to the file system, secrets, or Node.js APIs.
2. **Extension Host (logic layer)** – Runs in a Node.js process; has access to the VS Code API, file system, and credentials; orchestrates tasks and talks to external services.
3. **External services (e.g. LLM backend)** – API providers (OpenAI, Anthropic, OpenRouter, etc.); contacted only from the Extension Host over HTTPS.

Understanding these boundaries is essential for security, correct message flow, and where to implement features (e.g. hooks, prompt building, tool execution).

### How VS Code Extensions Work: The Three Layers

| Layer              | Process / context                   | Runs                                              | Has access to                                                                               |
| ------------------ | ----------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| **Webview**        | Separate renderer (browser context) | React app in `webview-ui/`                        | `acquireVsCodeApi()` → `postMessage` / `getState` / `setState` only; no Node, no fs, no env |
| **Extension Host** | Main extension process (Node.js)    | `src/` (ClineProvider, Task, tools, API handlers) | Full VS Code API, `vscode.ExtensionContext`, secrets store, file system, network            |
| **LLM backend**    | Remote servers                      | N/A                                               | Receives HTTPS requests from Extension Host with API keys in headers                        |

The **only** sanctioned bridge between Webview and Extension Host is the **message channel**:

- **Webview → Extension Host:** The webview calls `acquireVsCodeApi().postMessage(message)`. VS Code delivers it to the extension via `webview.onDidReceiveMessage(listener)`.
- **Extension Host → Webview:** The extension calls `webview.postMessage(message)`. VS Code delivers it to the webview as a `MessageEvent`; the webview listens with `window.addEventListener("message", handler)` (or equivalent).

No shared memory, no direct function calls. All cross-boundary data must be **JSON-serializable**.

### Data Boundaries in Roo Code

#### Boundary 1: Webview ↔ Extension Host

**Message types (from `@roo-code/types`):**

- **`WebviewMessage`** – Sent **from** the webview **to** the extension. Examples: `newTask`, `askResponse`, `saveApiConfiguration`, `getListApiConfiguration`, `sendMessage`-style invokes, `searchFiles`, `condenseTaskContextRequest`, etc. Handled by `webviewMessageHandler()` in the Extension Host.
- **`ExtensionMessage`** – Sent **from** the extension **to** the webview. Examples: `state`, `action`, `invoke`, `messageUpdated`, `taskHistoryUpdated`, `selectedImages`, `theme`, `mcpServers`, etc. The webview receives these in `App.tsx` / `ChatView.tsx` via `useEvent("message", onMessage)` and similar.

**Key locations:**

- **Extension Host → Webview:** `ClineProvider.postMessageToWebview(message: ExtensionMessage)` (line ~1127) → `this.view?.webview.postMessage(message)`. Used to push state updates, actions, and UI directives.
- **Webview → Extension Host:** In the webview, `vscode.postMessage(msg)` (see `webview-ui/src/utils/vscode.ts`, which wraps `acquireVsCodeApi().postMessage`). In the extension, `ClineProvider.setWebviewMessageListener()` (line ~1322) registers `webview.onDidReceiveMessage(onReceiveMessage)`; the handler delegates to `webviewMessageHandler(provider, message, marketplaceManager)` in `src/core/webview/webviewMessageHandler.ts`.

**Flow summary:**

```
Webview (React)                    Extension Host (Node)
─────────────────                  ─────────────────────
vscode.postMessage(WebviewMessage)  →  webview.onDidReceiveMessage
                                        → webviewMessageHandler(provider, message)
                                           → Task creation, API config, tools, etc.

view.webview.postMessage(ExtensionMessage)  ←  ClineProvider.postMessageToWebview(msg)
                                    ←  window "message" event
                                       → React state updates, actions, invokes
```

The webview **never** receives API keys, file contents, or raw system prompts unless the extension explicitly includes them in an `ExtensionMessage`. The extension decides what to send (e.g. partial state, task history without secrets).

#### Boundary 2: Extension Host ↔ LLM Backend

All LLM communication happens **only** in the Extension Host:

- **Entry:** `Task` drives the loop; it obtains the system prompt via `getSystemPrompt()` and calls `this.api.createMessage(systemPrompt, conversationHistory, metadata)` (see Tool Loop and Prompt Builder sections).
- **API layer:** `src/api/` – `buildApiHandler()` returns an `ApiHandler` (e.g. OpenAI, Anthropic, OpenRouter, LiteLLM). Each provider uses its own HTTP client/SDK and **holds API keys** from `ProviderSettings` (stored in the extension’s secret storage or config, not in the webview).
- **Outgoing:** HTTPS requests to provider endpoints (e.g. `api.openai.com`, `api.anthropic.com`, OpenRouter, LM Studio local). Request bodies include system prompt, messages, and tool definitions; headers include `Authorization: Bearer <key>` or equivalent.
- **Incoming:** Streaming or non-streaming responses; tool calls are parsed in the Extension Host by `NativeToolCallParser` and then processed by `presentAssistantMessage()` and the tool loop.

The webview **never** talks to the LLM directly. It only sends user intent (e.g. “new task”, “send message”) via `WebviewMessage`; the Extension Host builds the prompt, calls the API, and streams back results via `ExtensionMessage` (e.g. state updates, message deltas).

### Why the Three-Layer Model Matters

#### Security and isolation

- **Webview is untrusted.** It renders HTML/JS that can be influenced by content (e.g. chat messages, markdown). Treat it as a display and input surface, not as a place to make security decisions or hold secrets.
- **Extension Host is trusted.** Only the extension code runs here; it has access to secrets and sensitive APIs. All decisions about “is this request allowed?” and “what do we send to the API?” belong here.
- **LLM backend is external.** The extension authenticates via keys; the backend is outside VS Code’s process model. The three-layer split keeps keys and sensitive logic out of the webview and centralizes them in the Extension Host.

#### Protection of secrets

- **API keys, OAuth tokens, and passwords** are stored in the Extension Host (e.g. `context.secrets`, provider config). They are never sent to the webview as part of normal state; only non-secret metadata (e.g. config names, model lists) is.
- **State pushed to the webview** (`ExtensionMessage` with `state` or similar) is designed to exclude secrets. If new state fields are added, they must be vetted so that credentials and other sensitive data are not serialized into the webview.
- **User input from the webview** (e.g. pasted API key in settings) is sent as a `WebviewMessage`; the Extension Host writes it to secret storage and does not echo it back in full in subsequent state updates.

#### XSS and content injection

- **Risk:** The webview is a browser context. If the extension sent raw HTML or unsanitized LLM output into the webview and rendered it with `dangerouslySetInnerHTML` or equivalent, an attacker could inject scripts (XSS) or abuse injected content.
- **Mitigations in place:**
    - **Structured messages:** Data to the webview is sent as typed `ExtensionMessage` payloads (e.g. state, message content), not as raw HTML. The React UI renders text/markdown in a controlled way.
    - **Content Security Policy (CSP):** The webview HTML is generated in the Extension Host with a strict CSP meta tag (see `ClineProvider.getHtmlContent()` and `getHMRHtmlContent()`). Scripts are allowed only via a **nonce** (`getNonce()` in `src/core/webview/getNonce.ts`); inline scripts without the nonce are blocked. This limits XSS to nonce-guessing (practically infeasible when the nonce is random per load).
    - **CSP in production:** e.g. `script-src ${webview.cspSource} 'wasm-unsafe-eval' 'nonce-${nonce}' ...; connect-src ...` so that only expected origins and nonce-bearing scripts run.
- **Best practice:** When adding new UI that displays LLM or user-generated content, keep rendering in the webview structured (e.g. markdown with a safe renderer) and avoid injecting HTML from untrusted strings. Keep secrets and sensitive logic in the Extension Host.

#### Summary table

| Concern                       | Webview                   | Extension Host               | LLM backend                    |
| ----------------------------- | ------------------------- | ---------------------------- | ------------------------------ |
| Holds API keys / secrets      | No                        | Yes (secret storage, config) | Receives keys in requests only |
| Makes LLM API calls           | No                        | Yes                          | Serves requests                |
| Renders user/LLM content      | Yes (must sanitize / CSP) | N/A                          | N/A                            |
| Parses tool calls             | No                        | Yes                          | Sends tool_use in stream       |
| File system / terminal access | No                        | Yes (via tools)              | No                             |

### File Reference: Data Boundaries

- **Webview entry (message out):** `webview-ui/src/utils/vscode.ts` – `VSCodeAPIWrapper.postMessage(WebviewMessage)`
- **Webview listeners (message in):** `webview-ui/src/App.tsx`, `webview-ui/src/components/chat/ChatView.tsx` – `useEvent("message", …)` / `handleMessage`
- **Extension Host listener:** `src/core/webview/ClineProvider.ts` – `setWebviewMessageListener()` → `webview.onDidReceiveMessage` → `webviewMessageHandler`
- **Extension Host sender:** `src/core/webview/ClineProvider.ts` – `postMessageToWebview(ExtensionMessage)` → `view.webview.postMessage(message)`
- **Message types:** `packages/types/src/vscode-extension-host.ts` – `WebviewMessage`, `ExtensionMessage`
- **LLM API (Extension Host only):** `src/api/` (e.g. `buildApiHandler`, provider-specific handlers), `src/core/task/Task.ts` – `getSystemPrompt()`, `api.createMessage()`
- **CSP / nonce:** `src/core/webview/ClineProvider.ts` – `getHtmlContent()`, `getHMRHtmlContent()`; `src/core/webview/getNonce.ts`

---

## 4. Integration Points

### How Tool Loop and Prompt Builder Work Together

1. **Prompt Builder** creates system prompt that instructs LLM on available tools. When `.orchestration/active_intents.yaml` exists, it also injects the **Intent-Driven Protocol** mandate (`getIntentHandshakeSection`), requiring the model to call `select_active_intent` before destructive actions.
2. **LLM** generates tool calls based on prompt instructions (e.g. `select_active_intent` first, then write/edit tools).
3. **Tool Loop** processes tool calls; the **Intent Gatekeeper** pre-hook in `presentAssistantMessage` blocks destructive tools until a valid intent is selected.
4. **Results** feed back into conversation history.
5. **Next API call** uses updated prompt (if mode/rules changed). See `.orchestration/README.md` for full end-to-end handshake wiring.

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

## 5. File Reference Summary

### Tool Loop Files

- `src/core/assistant-message/presentAssistantMessage.ts` - Main router (includes Intent Gatekeeper pre-hook)
- `src/hooks/IntentGatekeeperHook.ts` - Pre-hook: enforces valid intent for destructive tools
- `src/hooks/types.ts` - Hook context and result types
- `src/core/tools/BaseTool.ts` - Base infrastructure
- `src/core/tools/WriteToFileTool.ts` - File writing tool
- `src/core/tools/ExecuteCommandTool.ts` - Command execution tool
- `src/core/assistant-message/NativeToolCallParser.ts` - Tool call parser
- `src/core/task/Task.ts` - Task class (contains `recursivelyMakeClineRequests`)

### Prompt Builder Files

- `src/core/prompts/system.ts` - Main prompt builder
- `src/core/prompts/sections/*.ts` - Prompt sections (including `intent-handshake.ts` for the Intent-Driven Protocol mandate)
- `src/core/task/Task.ts` - Task class (contains `getSystemPrompt()`)

---

## 6. Key Takeaways

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
