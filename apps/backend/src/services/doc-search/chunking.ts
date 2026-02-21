import { Effect, pipe, Array as Arr } from "effect";

// ============================================================
// Types
// ============================================================

export type DocChunkInput = {
  readonly package: string;
  readonly heading: string;
  readonly content: string;
  readonly url: string;
};

export type ChunkingStrategy = "heading";
// Future: "semantic" | "contextual"

// ============================================================
// ChunkingService — pluggable text → chunks pipeline
// ============================================================

export class ChunkingService extends Effect.Service<ChunkingService>()(
  "ChunkingService",
  {
    accessors: true,
    effect: Effect.gen(function* () {
      // ----------------------------------------------------------
      // Heading-based chunking: split on ## headers
      // ----------------------------------------------------------

      const chunkByHeading = (
        markdown: string,
        pkg: string,
        url: string,
      ): DocChunkInput[] => {
        const lines = markdown.split("\n");

        // Group lines into sections by ## headings
        // Each section is [heading, ...contentLines]
        const { sections, currentHeading, currentLines } = pipe(
          lines,
          Arr.reduce(
            {
              sections: [] as { heading: string; lines: string[] }[],
              currentHeading: pkg,
              currentLines: [] as string[],
            },
            (acc, line) => {
              if (line.startsWith("## ")) {
                const content = acc.currentLines.join("\n").trim();
                const nextSections =
                  content.length > 0
                    ? [
                        ...acc.sections,
                        { heading: acc.currentHeading, lines: acc.currentLines },
                      ]
                    : acc.sections;
                return {
                  sections: nextSections,
                  currentHeading: line.slice(3).trim(),
                  currentLines: [],
                };
              }
              return {
                ...acc,
                currentLines: [...acc.currentLines, line],
              };
            },
          ),
        );

        // Flush the last section
        const allSections = pipe(
          currentLines.join("\n").trim(),
          (content) =>
            content.length > 0
              ? [...sections, { heading: currentHeading, lines: currentLines }]
              : sections,
        );

        return pipe(
          allSections,
          Arr.map(
            (section): DocChunkInput => ({
              package: pkg,
              heading: section.heading,
              content: section.lines.join("\n").trim(),
              url,
            }),
          ),
        );
      };

      // ----------------------------------------------------------
      // Public API — dispatch by strategy
      // ----------------------------------------------------------

      const chunk = (
        markdown: string,
        pkg: string,
        url: string,
        _strategy: ChunkingStrategy = "heading",
      ): DocChunkInput[] => {
        // Future: switch on strategy for semantic/contextual chunking
        return chunkByHeading(markdown, pkg, url);
      };

      yield* Effect.log("ChunkingService initialized");

      return { chunk };
    }),
  },
) {}
