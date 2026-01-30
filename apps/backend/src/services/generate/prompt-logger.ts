import { Effect, Config, DateTime, pipe } from "effect";
import { FileSystem, Path } from "@effect/platform";
import type { Message } from "./types.js";

const DATA_DIR = ".data";

export class PromptLogger extends Effect.Service<PromptLogger>()(
  "PromptLogger",
  {
    accessors: true,
    effect: Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const logPrompts = yield* Config.boolean("LOG_PROMPTS").pipe(
        Config.withDefault(false),
      );

      const logMessages = (messages: readonly Message[]) =>
        Effect.gen(function* () {
          if (!logPrompts) return;

          const now = yield* DateTime.now;
          // Format: 2024-01-27T14-30-45-123Z (sortable, filesystem-safe)
          const timestamp = DateTime.formatIso(now).replace(/:/g, "-");
          const filename = `${timestamp}.md`;
          const filepath = path.join(DATA_DIR, filename);

          // Ensure directory exists
          yield* pipe(
            fs.makeDirectory(DATA_DIR, { recursive: true }),
            Effect.catchAll(() => Effect.void),
          );

          // Format messages as markdown
          const content = messages
            .map((m) => `## ${m.role.toUpperCase()}\n\n${m.content}`)
            .join("\n\n---\n\n");
          yield* fs.writeFileString(filepath, content);

          yield* Effect.log(`Prompt logged to ${filepath}`);
        });

      return { logMessages };
    }),
  },
) {}
