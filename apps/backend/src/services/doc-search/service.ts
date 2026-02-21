import { Effect, Option, pipe } from "effect";
import { embed } from "ai";
import type { EmbeddingModel } from "ai";
import type { ProviderOptions } from "@ai-sdk/provider-utils";
import { EmbeddingModelProvider } from "@betalyra/generative-ui-common/server";
import { loadAppConfig, type SandboxDependencyConfig } from "../app-config.js";
import { StoreService } from "../memory/store.js";
import { ChunkingService, type DocChunkInput } from "./chunking.js";

// ============================================================
// Types
// ============================================================

export type DocSearchResult = {
  readonly type: "doc" | "module";
  readonly heading: string;
  readonly content: string;
  readonly package: string;
  readonly url?: string;
};

// ============================================================
// Hashing — Web Crypto SHA-256
// ============================================================

const sha256 = async (input: string): Promise<string> => {
  const data = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
};

const makeChunkId = (pkg: string, heading: string) =>
  sha256(`${pkg}::${heading}`).then((h) => h.slice(0, 16));

// ============================================================
// Embedding helper
// ============================================================

const embedText = (
  text: string,
  model: EmbeddingModel,
  providerOptions?: ProviderOptions,
) =>
  Effect.promise(() =>
    embed({ model, value: text, providerOptions }).then((r) => r.embedding),
  );

// ============================================================
// Fetch a doc URL → markdown string
// ============================================================

const fetchMarkdown = (url: string) =>
  Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: () => fetch(url),
      catch: (e) => new Error(`Failed to fetch ${url}: ${e}`),
    });

    if (!response.ok) {
      yield* Effect.logWarning(`DocSearch: ${url} returned ${response.status}`);
      return null;
    }

    return yield* Effect.promise(() => response.text());
  });

// ============================================================
// Upsert a single chunk (skip if content unchanged)
// ============================================================

const upsertChunk = (
  chunk: DocChunkInput,
  store: StoreService,
  model: EmbeddingModel,
  providerOptions?: ProviderOptions,
) =>
  Effect.gen(function* () {
    const hash = yield* Effect.promise(() => sha256(chunk.content));
    const id = yield* Effect.promise(() =>
      makeChunkId(chunk.package, chunk.heading),
    );

    const existingHash = yield* store.getDocChunkHash(id);
    if (existingHash === hash) return; // unchanged

    const embedding = yield* embedText(
      `${chunk.heading}: ${chunk.content}`,
      model,
      providerOptions,
    );

    yield* store.upsertDocChunk({
      id,
      package: chunk.package,
      heading: chunk.heading,
      content: chunk.content,
      url: chunk.url,
      contentHash: hash,
      embedding,
      createdAt: Date.now(),
    });
  });

// ============================================================
// Index all doc URLs for a single dependency
// ============================================================

const indexDependency = (
  dep: SandboxDependencyConfig,
  store: StoreService,
  chunking: ChunkingService,
  model: EmbeddingModel,
  providerOptions?: ProviderOptions,
) =>
  pipe(
    dep.docs,
    Effect.forEach(
      (url) =>
        Effect.gen(function* () {
          const markdown = yield* fetchMarkdown(url);
          if (!markdown) return;

          const chunks = chunking.chunk(markdown, dep.package, url);
          yield* Effect.log("DocSearch: chunked", {
            url,
            count: chunks.length,
          });

          yield* pipe(
            chunks,
            Effect.forEach(
              (chunk) => upsertChunk(chunk, store, model, providerOptions),
              { concurrency: 5 },
            ),
          );
        }),
      { concurrency: 2 },
    ),
  );

// ============================================================
// DocSearchService
// ============================================================

export class DocSearchService extends Effect.Service<DocSearchService>()(
  "DocSearchService",
  {
    accessors: true,
    effect: Effect.gen(function* () {
      const { sandbox: sandboxOption } = yield* loadAppConfig;
      const sandboxConfig = Option.getOrUndefined(sandboxOption);
      const store = yield* StoreService;
      const chunking = yield* ChunkingService;
      const { model: embeddingModel, providerOptions } =
        yield* EmbeddingModelProvider;

      // Startup: index all configured doc URLs (only when sandbox is enabled)
      if (sandboxConfig?.enabled) {
        yield* Effect.log("DocSearch: indexing", {
          packages: sandboxConfig.dependencies.map((d) => d.package),
        });

        yield* pipe(
          sandboxConfig.dependencies,
          Effect.forEach(
            (dep) =>
              indexDependency(
                dep,
                store,
                chunking,
                embeddingModel,
                providerOptions,
              ),
            { concurrency: 1 },
          ),
        );

        yield* Effect.log("DocSearch: indexing complete");
      }

      // ----------------------------------------------------------
      // search
      // ----------------------------------------------------------

      const search = (
        query: string,
        options?: {
          package?: string;
          sessionId?: string;
          volumeSlug?: string;
          limit?: number;
        },
      ) =>
        Effect.gen(function* () {
          const limit = options?.limit ?? 5;
          const embedding = yield* embedText(
            query,
            embeddingModel,
            providerOptions,
          );
          const vectorJson = JSON.stringify(embedding);

          // Always search SDK docs
          const docRows = yield* store.searchDocChunksByVector(
            vectorJson,
            limit,
            options?.package,
          );

          const results: DocSearchResult[] = docRows.map((row) => ({
            type: "doc" as const,
            heading: row.heading,
            content: row.content,
            package: row.package,
            url: row.url,
          }));

          // If session has a live volume, also search code modules
          if (options?.sessionId && options?.volumeSlug) {
            const moduleRows = yield* store.searchCodeModulesByVector(
              vectorJson,
              options.sessionId,
              3,
            );

            const moduleResults: DocSearchResult[] = moduleRows.map((row) => ({
              type: "module" as const,
              heading: row.path,
              content: row.usage,
              package: "session",
            }));

            return [...results, ...moduleResults];
          }

          return results;
        });

      // ----------------------------------------------------------
      // listPackages
      // ----------------------------------------------------------

      const listPackages = () =>
        sandboxConfig?.enabled
          ? sandboxConfig.dependencies.map((d) => d.package)
          : [];

      const listPackageInfo = () =>
        sandboxConfig?.enabled
          ? sandboxConfig.dependencies.map((d) => ({
              package: d.package,
              envVar: d.secretEnv,
            }))
          : [];

      // ----------------------------------------------------------
      // upsertCodeModule — called from stream finalizer
      // ----------------------------------------------------------

      const upsertCodeModule = (module: {
        sessionId: string;
        volumeSlug: string;
        path: string;
        description: string;
        exports: string[];
        usage: string;
      }) =>
        Effect.gen(function* () {
          const embedding = yield* embedText(
            `${module.path}: ${module.description}`,
            embeddingModel,
            providerOptions,
          );

          const id = yield* Effect.promise(() =>
            makeChunkId(module.sessionId, module.path),
          );

          yield* store.upsertCodeModule({
            id,
            sessionId: module.sessionId,
            volumeSlug: module.volumeSlug,
            path: module.path,
            description: module.description,
            exports: module.exports,
            usage: module.usage,
            embedding,
            createdAt: Date.now(),
          });
        });

      yield* Effect.log("DocSearchService initialized");

      return {
        search,
        listPackages,
        listPackageInfo,
        upsertCodeModule,
      };
    }),
  },
) {}
