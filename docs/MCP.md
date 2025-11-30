# MCP Integration Analysis

Exploring whether the generative UI system could expose itself as an MCP (Model Context Protocol) server using the new Streamable HTTP transport.

## Background: MCP Streamable HTTP

As of the [2025-03-26 specification](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports), MCP deprecated the dual-endpoint SSE transport in favor of **Streamable HTTP**:

**Old (SSE transport):**
- `GET /sse` - Open SSE stream for server→client messages
- `POST /messages` - Send client→server requests

**New (Streamable HTTP):**
- `POST /mcp` - Single endpoint for all communication
- Response is either `application/json` (single response) or `text/event-stream` (streaming)

### Why the Change?

Per [this analysis](https://blog.fka.dev/blog/2025-06-06-why-mcp-deprecated-sse-and-go-with-streamable-http/):
1. **Simpler architecture** - One endpoint instead of two
2. **Adaptive streaming** - Server decides whether to stream based on the request
3. **Better scaling** - No persistent connections for simple requests
4. **Unified error handling** - All errors through one channel

### Protocol Basics

All MCP messages use JSON-RPC 2.0:

```json
// Request
{"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {...}}

// Response (success)
{"jsonrpc": "2.0", "id": 1, "result": {...}}

// Response (error)
{"jsonrpc": "2.0", "id": 1, "error": {"code": -32600, "message": "..."}}
```

Session management via `Mcp-Session-Id` header.

---

## How Generative UI Could Become an MCP Server

### Mapping Our Endpoints to MCP

Current structure:
```
POST /generate        → Full page generation (JSON response)
POST /generate/stream → Streaming patches/HTML (SSE response)
```

MCP structure:
```
POST /mcp → JSON-RPC dispatch to tools
          → Response: application/json OR text/event-stream
```

### Exposing UI Generation as MCP Tools

```json
{
  "tools": [
    {
      "name": "generate_ui",
      "description": "Generate or update a web UI from natural language",
      "inputSchema": {
        "type": "object",
        "properties": {
          "prompt": {"type": "string", "description": "What to create or change"},
          "currentHtml": {"type": "string", "description": "Current UI state (optional)"},
          "action": {"type": "string", "description": "Action triggered by user interaction"},
          "actionData": {"type": "object", "description": "Data from the triggered action"}
        }
      }
    },
    {
      "name": "get_ui_state",
      "description": "Get the current UI HTML for a session",
      "inputSchema": {
        "type": "object",
        "properties": {
          "sessionId": {"type": "string"}
        },
        "required": ["sessionId"]
      }
    }
  ]
}
```

### Streaming in MCP Context

When `tools/call` is invoked for `generate_ui`, the server could:
1. Return `Content-Type: text/event-stream`
2. Stream patches as SSE events with JSON-RPC notifications:

```
event: message
data: {"jsonrpc":"2.0","method":"ui/patch","params":{"selector":"#counter","text":"6"}}

event: message
data: {"jsonrpc":"2.0","method":"ui/patch","params":{"selector":"#status","text":"Updated"}}

event: message
data: {"jsonrpc":"2.0","id":1,"result":{"html":"<div>...</div>","sessionId":"session-123"}}
```

---

## What Would Work

### 1. Unified Endpoint
Our current dual-endpoint (`/generate` + `/generate/stream`) maps naturally to the MCP pattern of one endpoint with adaptive response types.

### 2. Tool Discovery
MCP clients could discover our `generate_ui` tool via `tools/list`, making the generative UI usable from:
- Claude Code / Claude Desktop
- Cursor
- Any MCP-compatible agent

### 3. Session Management
MCP's `Mcp-Session-Id` header aligns with our session concept. We could map MCP sessions to UI sessions.

### 4. Streaming Responses
Our SSE patch streaming fits within MCP's streaming model. The server can emit intermediate notifications before the final response.

---

## What Might Not Work (Challenges)

### 1. HTML Output vs Structured Data
MCP tools typically return structured JSON that AI assistants interpret. Our output is raw HTML.

**Problem:** An MCP client receiving `{"html": "<div>...</div>"}` doesn't know how to render it.

**Mitigation:**
- Return HTML as a string field - client displays in a webview
- Also return structured metadata (title, actions available, state summary)

```json
{
  "result": {
    "html": "<div>...",
    "meta": {
      "title": "Counter App",
      "currentState": {"count": 5},
      "availableActions": ["increment", "decrement", "reset"]
    }
  }
}
```

### 2. Bidirectional Communication
MCP supports server→client requests (not just notifications). Our current model is request/response only.

**Impact:** We can't leverage MCP's `sampling/createMessage` for the server to ask the LLM for clarification mid-generation.

**Mitigation:** Start with simple request/response, add bidirectional later if needed.

### 3. Client Rendering
MCP clients (Claude Code, etc.) would need to render our HTML somewhere.

**Problem:** Most MCP clients expect tools to return data they can reason about, not full UIs.

**Mitigation:**
- For AI clients: Return state as JSON, let them reconstruct
- For UI clients: Provide an embedded webview component or iframe target

### 4. Action Handling
Our `data-action` buttons trigger server round-trips. In MCP, this means the client needs to:
1. Render our HTML
2. Intercept clicks on `data-action` elements
3. Call `generate_ui` tool with the action

**Problem:** This requires MCP client cooperation - they'd need to understand our action protocol.

**Mitigation:**
- Document the action protocol as part of tool description
- Or: use MCP resources to expose available actions, let AI decide

### 5. Two Different Use Cases

| Use Case | Current UI | MCP Client |
|----------|-----------|------------|
| End user interacts directly | ✅ Browser renders HTML | ❌ No HTML rendering |
| AI agent builds UI | ❌ No AI in loop | ✅ AI calls tools |
| AI agent uses UI state | ❌ State is HTML | ✅ Could expose as resource |

The MCP model assumes an AI is orchestrating tool use. Our model assumes a human is directly interacting with generated HTML.

---

## Recommendation

### Phase 1: Add MCP Endpoint (Low Effort)
Add `/mcp` endpoint alongside existing endpoints:
- Expose `generate_ui` and `get_ui_state` as tools
- Use existing generation logic
- Return HTML + structured metadata

This makes the system discoverable by MCP clients without breaking the existing UI.

### Phase 2: Resources for State (Medium Effort)
Expose UI state as MCP resources:
```
resources://session/{id}/html     → Current HTML
resources://session/{id}/state    → Extracted state as JSON
resources://session/{id}/actions  → Available actions
```

This lets AI agents inspect and reason about UI state.

### Phase 3: Bidirectional (Future)
If needed, implement server→client requests for:
- Asking user for clarification during generation
- Confirming destructive actions
- Multi-step wizards

---

## Implementation Sketch

```typescript
// New endpoint handler
app.post("/mcp", async (req, res) => {
  const message = req.body as JsonRpcRequest;

  switch (message.method) {
    case "initialize":
      return res.json(initializeResponse(message.id));

    case "tools/list":
      return res.json(toolsListResponse(message.id));

    case "tools/call":
      if (message.params.name === "generate_ui") {
        // Decide: stream or not?
        if (shouldStream(message.params.arguments)) {
          res.setHeader("Content-Type", "text/event-stream");
          return streamGenerateUI(message, res);
        } else {
          return res.json(await generateUI(message));
        }
      }
      break;

    case "resources/list":
      return res.json(resourcesListResponse(message.id));

    case "resources/read":
      return res.json(await readResource(message));
  }
});
```

---

## Open Questions

1. **Should we maintain backward compatibility?** Keep `/generate` and `/generate/stream` or migrate fully to `/mcp`?

2. **How do MCP clients render HTML?** Need to research how Claude Desktop, Cursor, etc. handle tool outputs that are meant to be displayed.

3. **State extraction:** Should we parse the generated HTML to extract structured state, or require the AI to output state separately?

4. **Authentication:** MCP has no built-in auth. Our sessions would need to integrate with whatever auth MCP clients provide.

---

## Sources

- [MCP Transports Specification (2025-03-26)](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports)
- [Why MCP Deprecated SSE](https://blog.fka.dev/blog/2025-06-06-why-mcp-deprecated-sse-and-go-with-streamable-http/)
- [MCP Protocol Overview](https://www.philschmid.de/mcp-introduction)
- [MCP Server Development Guide](https://github.com/cyanheads/model-context-protocol-resources/blob/main/guides/mcp-server-development-guide.md)
