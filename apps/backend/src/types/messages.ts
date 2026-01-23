import { Schema } from "effect";

// ============================================================
// Memory Types
// ============================================================

export const UserPrompt = Schema.String;
export type UserPrompt = typeof UserPrompt.Type;

export const UserAction = Schema.Struct({
  action: Schema.String,
  data: Schema.optional(Schema.Unknown),
});
export type UserAction = typeof UserAction.Type;

// ============================================================
// Request Types
// ============================================================
export const GenerateRequest = Schema.Struct({
  type: Schema.Literal("generate"),
  prompt: Schema.optional(Schema.String),
  sessionId: Schema.optional(Schema.String),
  // Server-side action support
  action: Schema.optional(Schema.String),
  actionData: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
  // Client can send current HTML to preserve state across server restarts
  currentHtml: Schema.optional(Schema.String),
});

export const UpdateRequest = Schema.Struct({
  type: Schema.Literal("update"),
  prompt: Schema.String,
  target: Schema.optional(Schema.String),
  sessionId: Schema.optional(Schema.String),
});

export const ChatRequest = Schema.Struct({
  type: Schema.Literal("chat"),
  message: Schema.String,
  sessionId: Schema.optional(Schema.String),
});

export const Request = Schema.Union(
  GenerateRequest,
  UpdateRequest,
  ChatRequest
);

export type Request = typeof Request.Type;

// Response Types
export const Operation = Schema.Struct({
  action: Schema.Literal("replace", "append", "remove"),
  selector: Schema.String,
  html: Schema.optional(Schema.String),
});

export const FullPageResponse = Schema.Struct({
  type: Schema.Literal("full-page"),
  html: Schema.String,
  sessionId: Schema.String,
});

export const PartialUpdateResponse = Schema.Struct({
  type: Schema.Literal("partial-update"),
  operations: Schema.Array(Operation),
  sessionId: Schema.String,
});

export const MessageResponse = Schema.Struct({
  type: Schema.Literal("message"),
  message: Schema.String,
  sessionId: Schema.String,
});

export const Response = Schema.Union(
  FullPageResponse,
  PartialUpdateResponse,
  MessageResponse
);

export type Response = typeof Response.Type;
