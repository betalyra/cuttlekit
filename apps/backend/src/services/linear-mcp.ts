import { Config, Context, Effect, Layer, Redacted } from "effect";
import { experimental_createMCPClient as createMCPClient } from "@ai-sdk/mcp";

// Use the return type of client.tools() directly
type McpToolSet = Awaited<
  ReturnType<Awaited<ReturnType<typeof createMCPClient>>["tools"]>
>;

export type ILinearMcpService = {
  tools: McpToolSet;
  close: () => Promise<void>;
};

export class LinearMcpService extends Context.Tag("LinearMcpService")<
  LinearMcpService,
  ILinearMcpService
>() {}

export const LinearMcpServiceLive = Layer.scoped(
  LinearMcpService,
  Effect.gen(function* () {
    const apiKey = yield* Config.redacted("LINEAR_API_KEY");

    yield* Effect.log("Connecting to Linear MCP server...");

    const client = yield* Effect.tryPromise({
      try: () =>
        createMCPClient({
          transport: {
            type: "http",
            url: "https://mcp.linear.app/mcp",
            headers: {
              Authorization: `Bearer ${Redacted.value(apiKey)}`,
            },
          },
        }),
      catch: (error) => {
        const message = error instanceof Error ? error.message : String(error);
        return new Error(`Failed to connect to Linear MCP: ${message}`);
      },
    });

    yield* Effect.log("Connected to Linear MCP server");

    const tools = yield* Effect.tryPromise({
      try: () => client.tools(),
      catch: (error) => {
        const message = error instanceof Error ? error.message : String(error);
        return new Error(`Failed to get Linear MCP tools: ${message}`);
      },
    });

    yield* Effect.log("Loaded Linear MCP tools", {
      toolCount: Object.keys(tools).length,
      toolNames: Object.keys(tools),
    });

    // Register cleanup when scope closes
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        yield* Effect.log("Closing Linear MCP connection...");
        yield* Effect.promise(() => client.close());
        yield* Effect.log("Linear MCP connection closed");
      })
    );

    return {
      tools,
      close: () => client.close(),
    };
  })
);
