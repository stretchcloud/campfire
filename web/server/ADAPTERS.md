# Adapter Contribution Guide

This document explains how to add a new agent backend adapter to Campfire.

## Architecture

Campfire uses a unified `AgentAdapter` interface (`adapter-types.ts`) that translates between any agent backend's protocol and the browser's message format. The browser UI is completely unaware of which backend is running.

```
Browser <-> WsBridge <-> AgentAdapter <-> Backend Process (stdio/websocket)
```

## The `AgentAdapter` Interface

Every adapter must implement `AgentAdapter` from `adapter-types.ts`:

```typescript
interface AgentAdapter {
  sendBrowserMessage(msg: BrowserOutgoingMessage): boolean;
  onBrowserMessage(cb: (msg: BrowserIncomingMessage) => void): void;
  onSessionMeta(cb: (meta: AdapterSessionMeta) => void): void;
  onDisconnect(cb: () => void): void;
  onInitError(cb: (error: string) => void): void;
  isConnected(): boolean;
  disconnect(): Promise<void>;
  getBackendSessionId(): string | null;
}
```

## Step-by-Step: Adding a New Adapter

### 1. Create the adapter file

Create `web/server/{name}-adapter.ts`. Your adapter class should:

- Accept a `Subprocess` (from `Bun.spawn()`) and session ID in the constructor
- Parse the backend's protocol (JSON-RPC, stdout text, REST, etc.)
- Translate incoming messages to `BrowserIncomingMessage` types
- Translate outgoing `BrowserOutgoingMessage` to the backend's protocol
- Emit `session_init` with a `SessionState` during initialization

Key message types to emit:
- `session_init` — on startup, with session state
- `stream_event` — for streaming text (`message_start`, `content_block_delta`, etc.)
- `assistant` — for complete assistant messages with `content` blocks
- `result` — when a turn completes
- `permission_request` — when the agent needs tool approval
- `tool_progress` — for long-running tool calls
- `error` — for error conditions

### 2. Add to `cli-launcher.ts`

- Import your adapter class
- Add a `spawn{Name}()` method that:
  - Resolves the binary path via `resolveBinary()`
  - Spawns the process with `Bun.spawn()`
  - Creates your adapter instance
  - Calls `this.onAdapter(sessionId, adapter, backendType)`
- Add your backend to the `launch()` and `relaunch()` dispatch

### 3. Update `session-types.ts`

Add your backend to the `BackendType` union:

```typescript
export type BackendType = "claude" | "codex" | "goose" | "aider" | "openhands" | "your-backend";
```

### 4. Update `routes.ts`

- Add your backend to the `validBackends` array in session creation
- Add to the `/backends` endpoint with `resolveBinary()` check

### 5. Update frontend utilities

**`src/utils/backends.ts`**:
- Add `YOUR_MODELS` and `YOUR_MODES` arrays
- Update `getModelsForBackend()`, `getModesForBackend()`, `getDefaultModel()`, `getDefaultMode()`

**`src/api.ts`**:
- Add your backend to the `CreateSessionOpts.backend` union
- Add to `CronJobInfo.backendType`

**`src/utils/project-grouping.ts`**:
- Add to the `backendType` union in `SessionItem`

**`src/components/CronManager.tsx`**:
- Add to the backend cycle array

### 6. Write tests

Create `web/server/{name}-adapter.test.ts` with tests for:
- Message parsing/translation
- Protocol handling
- Edge cases (malformed input, disconnection)

## Examples

### ACP/JSON-RPC (structured protocol)

See `goose-adapter.ts` and `openhands-adapter.ts`. Both use the `JsonRpcTransport` class for stdin/stdout NDJSON communication with the ACP protocol (`initialize` -> `session/new` -> `session/prompt`).

### Raw stdout (unstructured)

See `aider-adapter.ts`. Parses unstructured text output, detecting SEARCH/REPLACE edit blocks and prompt markers to determine turn boundaries.

## Tool Name Mapping

Map your backend's tool names to Campfire-standard names so the UI renders them correctly:

```typescript
const toolMap: Record<string, string> = {
  "your_bash_tool": "Bash",
  "your_editor": "Edit",
  "your_reader": "Read",
  "your_writer": "Write",
  "your_search": "Grep",
};
```

Standard tool names: `Bash`, `Edit`, `Read`, `Write`, `Glob`, `Grep`, `WebFetch`, `WebSearch`.
