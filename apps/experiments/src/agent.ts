import { NodeRuntime } from "@effect/platform-node";
import { Config, Effect, pipe, Redacted, Runtime } from "effect";
import { generateText, stepCountIs, tool } from "ai";
import { createGroq } from "@ai-sdk/groq";
import { z } from "zod";
import { SandboxService } from "./services/sandbox.js";

// Simulated SDK documentation registry
// In the future, this would be a searchable index with AI-optimized summaries
const SDK_DOCS: Record<string, string> = {
  linear: `
# Linear SDK (@linear/sdk)

## Quick Start
\`\`\`typescript
import { LinearClient } from "@linear/sdk";

const client = new LinearClient({
  apiKey: Deno.env.get("LINEAR_API_KEY")
});
\`\`\`

## Common Operations

### Get current user
\`\`\`typescript
const me = await client.viewer;
console.log(me.displayName, me.email);
\`\`\`

### List assigned issues
\`\`\`typescript
const myIssues = await me.assignedIssues();
for (const issue of myIssues.nodes) {
  console.log(\`[\${issue.identifier}] \${issue.title}\`);
}
\`\`\`

### Create an issue
\`\`\`typescript
const team = await client.team("TEAM_KEY");
const issue = await client.createIssue({
  teamId: team.id,
  title: "Issue title",
  description: "Issue description"
});
\`\`\`

### Search issues
\`\`\`typescript
const issues = await client.issues({
  filter: { title: { contains: "search term" } }
});
\`\`\`

## Available Secrets
- LINEAR_API_KEY: Access token for Linear API (hosts: api.linear.app)
`,

  slack: `
# Slack SDK (@slack/web-api)

## Quick Start
\`\`\`typescript
import { WebClient } from "@slack/web-api";

const client = new WebClient(Deno.env.get("SLACK_TOKEN"));
\`\`\`

## Common Operations

### Send a message
\`\`\`typescript
await client.chat.postMessage({
  channel: "#general",
  text: "Hello from the sandbox!"
});
\`\`\`

### List channels
\`\`\`typescript
const result = await client.conversations.list();
for (const channel of result.channels) {
  console.log(channel.name);
}
\`\`\`

## Available Secrets
- SLACK_TOKEN: Bot token for Slack API (hosts: slack.com)
`,
};

// Available SDKs configuration
const AVAILABLE_SDKS = [
  { name: "linear", package: "@linear/sdk", description: "Linear issue tracking" },
  { name: "slack", package: "@slack/web-api", description: "Slack messaging" },
];

// System prompt for the agent
const SYSTEM_PROMPT = `You are an AI assistant with access to a secure code sandbox.

## Available Capabilities

You have access to a Deno sandbox where you can execute JavaScript/TypeScript code.
The sandbox has network access and can use npm packages.

## Available SDKs

The following SDKs are available for use:
${AVAILABLE_SDKS.map((sdk) => `- ${sdk.name}: ${sdk.description} (package: ${sdk.package})`).join("\n")}

## Tools

1. **search_sdk_docs**: Search for documentation on how to use a specific SDK.
   Use this BEFORE writing code to understand the API.

2. **run_code**: Execute code in the sandbox.
   The code should be valid TypeScript/JavaScript.
   Return a value by having it as the last expression.

## Workflow

When asked to perform a task that requires an SDK:
1. First use search_sdk_docs to understand how to use the SDK
2. Write the code based on the documentation
3. Use run_code to execute it
4. Report the results to the user

IMPORTANT: Always search the docs first before writing code. Do not assume you know the API.`;


const program = Effect.gen(function* () {
  const groqApiKey = yield* Config.redacted("GROQ_API_KEY");
  const linearApiKey = yield* Config.redacted("LINEAR_API_KEY");
  const { makeSandbox } = yield* SandboxService;

  // Create Groq provider
  const groq = createGroq({
    apiKey: Redacted.value(groqApiKey),
  });

  yield* Effect.scoped(
    Effect.gen(function* () {
      yield* Effect.logInfo("=== AI Agent with Code Sandbox ===");

      // Create sandbox with Linear SDK pre-installed
      yield* Effect.logInfo("Creating sandbox...");
      const sandbox = yield* makeSandbox({
        name: "agent-sandbox",
        secrets: {
          LINEAR_API_KEY: {
            hosts: ["api.linear.app"],
            value: linearApiKey,
          },
        },
        dependencies: ["@linear/sdk"],
      });
      yield* Effect.logInfo("Sandbox ready");

      // Get runtime for running effects inside async callbacks
      const runtime = yield* Effect.runtime<never>();

      // Define tools for the agent
      const tools = {
        search_sdk_docs: tool({
          description:
            "Search for documentation on how to use a specific SDK. Returns API documentation and code examples.",
          inputSchema: z.object({
            sdk_name: z
              .string()
              .describe("Name of the SDK to search for (e.g., 'linear', 'slack')"),
          }),
          execute: async ({ sdk_name }) => {
            const docs = SDK_DOCS[sdk_name.toLowerCase()];
            if (docs) {
              return { found: true, sdk: sdk_name, documentation: docs };
            }
            return { found: false, sdk: sdk_name };
          },
        }),

        run_code: tool({
          description:
            "Execute TypeScript/JavaScript code in the sandbox. The last expression is returned as the result.",
          inputSchema: z.object({
            code: z.string().describe("The code to execute"),
            description: z
              .string()
              .describe("Brief description of what the code does"),
          }),
          execute: async ({ code, description }) => {

            const program = Effect.gen(function* () {
              yield* Effect.logDebug(`[Executing: ${description}]`);
              yield* Effect.logDebug("Code:", code.substring(0, 200) + (code.length > 200 ? "..." : ""));
              const result = yield* sandbox.eval(code);
              yield* Effect.logDebug(`Result: ${result}`);
              return result;
            });


            return Runtime.runPromise(runtime)(program);
          },
        }),
      };

      // User prompt - ask the agent to do something
      const userPrompt = "List all my Linear issues and tell me how many I have assigned.";

      yield* Effect.logInfo(`User: ${userPrompt}`);
      yield* Effect.logInfo("Agent thinking...");

      // Run the agent
      const response = yield* Effect.tryPromise({
        try: () =>
          generateText({
            model: groq("openai/gpt-oss-120b"),
            system: SYSTEM_PROMPT,
            prompt: userPrompt,
            tools,
            stopWhen:stepCountIs(5), // Allow multiple tool calls
          }),
        catch: (e) => new Error(`Agent error: ${e}`),
      });

      yield* Effect.logInfo("\n=== Agent Response ===");
      yield* Effect.logInfo(response.text);

      // Log tool usage
      if (response.steps.length > 0) {
        yield* Effect.logInfo("\n=== Tool Calls ===");
        yield* pipe(
          response.steps,
          Effect.forEach((step, stepIndex) =>
            Effect.gen(function* () {
              yield* Effect.logInfo(`Step ${stepIndex + 1}:`);
              if (step.toolCalls) {
                yield* pipe(
                  step.toolCalls,
                  Effect.forEach((call) =>
                    Effect.gen(function* () {
                      yield* Effect.logInfo(`  Tool: ${call.toolName}`);
                      yield* Effect.logInfo(`  Input: ${JSON.stringify("input" in call ? call.input : call)}`);
                    })
                  )
                );
              }
              if (step.toolResults) {
                yield* pipe(
                  step.toolResults,
                  Effect.forEach((toolResult) =>
                    Effect.logInfo(`  Result: ${JSON.stringify(toolResult)}`)
                  )
                );
              }
            })
          )
        );
      }

      yield* Effect.logInfo("\n=== Done ===");
    })
  );
});

program.pipe(Effect.provide(SandboxService.Default), NodeRuntime.runMain);
