import { NodeRuntime } from "@effect/platform-node";
import { Config, Duration, Effect } from "effect";
import { SandboxService } from "./services/sandbox.js";

const formatDuration = (duration: Duration.Duration): string => {
  const millis = Duration.toMillis(duration);
  return `${millis.toFixed(0)}ms`;
};

// Linear SDK code to list all issues
const LINEAR_CODE = `
import { LinearClient } from "@linear/sdk";

const client = new LinearClient({
  apiKey: Deno.env.get("LINEAR_API_KEY")
});

const me = await client.viewer;
console.log("Logged in as:", me.displayName);

const myIssues = await me.assignedIssues();

if (myIssues.nodes.length) {
  console.log("\\n=== Your Issues ===");
  for (const issue of myIssues.nodes) {
    console.log(\`- [\${issue.identifier}] \${issue.title}\`);
  }
  console.log(\`\\nTotal: \${myIssues.nodes.length} issues\`);
} else {
  console.log("You have no assigned issues");
}

// Return a summary
({ user: me.displayName, issueCount: myIssues.nodes.length });
`;

// Linear example program
const program = Effect.gen(function* () {
  const { makeSandbox } = yield* SandboxService;
  const linearApiKey = yield* Config.redacted("LINEAR_API_KEY");

  yield* Effect.scoped(
    Effect.gen(function* () {
      yield* Effect.logInfo("=== Linear Issues Example ===");

      const [sandboxCreationTime, sandbox] = yield* Effect.timed(
        makeSandbox({
          name: "linear-sandbox",
          secrets: {
            LINEAR_API_KEY: {
              hosts: ["api.linear.app"],
              value: linearApiKey,
            },
          },
          dependencies: ["@linear/sdk"],
        })
      );
      yield* Effect.logInfo(
        `Sandbox created in ${formatDuration(sandboxCreationTime)}`
      );

      // Run the Linear code
      yield* Effect.logInfo("Fetching Linear issues...");
      const [evalTime, result] = yield* Effect.timed(sandbox.eval(LINEAR_CODE));
      yield* Effect.logInfo(`Completed in ${formatDuration(evalTime)}`);
      yield* Effect.logInfo(`Result: ${JSON.stringify(result)}`);

      yield* Effect.logInfo("=== Done ===");
    })
  );
});

program.pipe(Effect.provide(SandboxService.Default), NodeRuntime.runMain);
