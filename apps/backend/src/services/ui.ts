import { Effect, Stream, Match, Ref, pipe, Option } from "effect";
import { GenerateService, type UnifiedResponse } from "./generate/index.js";
import { MemoryService, type MemoryChange } from "./memory/index.js";
import { SessionService } from "./session.js";
import { VdomService, type Patch } from "./vdom/index.js";
import type { Action } from "./durable/types.js";
import type { UserAction } from "../types/messages.js";
import type { SandboxContext } from "./sandbox/manager.js";

export type UIRequest = {
  sessionId?: string;
  actions: readonly Action[];
  modelId?: string;
  sandboxCtx?: SandboxContext;
};

export class UIService extends Effect.Service<UIService>()("UIService", {
  accessors: true,
  effect: Effect.gen(function* () {
    const generateService = yield* GenerateService;
    const memoryService = yield* MemoryService;
    const sessionService = yield* SessionService;
    const vdomService = yield* VdomService;

    const resolveSession = (request: UIRequest) =>
      Effect.gen(function* () {
        const session = yield* sessionService.getOrCreateSession(
          request.sessionId,
        );
        const sessionId = session.id;

        // Server is the sole source of truth for VDOM state
        const serverHtml = yield* vdomService.getHtml(sessionId);

        if (!serverHtml) {
          // Server restart recovery — restore from DB snapshot
          const snapshot = yield* sessionService.getSnapshot(sessionId);
          if (Option.isSome(snapshot)) {
            const { registry, html } = snapshot.value;
            if (registry.length > 0) {
              yield* vdomService.restoreRegistry(sessionId, registry);
            }
            if (html) {
              yield* vdomService.setHtml(sessionId, html);
              yield* vdomService.renderTree(sessionId);
            }
          } else {
            // Brand new session — initialize VDOM with initial HTML
            yield* vdomService.createSession(sessionId);
          }
        }

        const currentHtml = yield* vdomService.getHtml(sessionId);
        return { sessionId, currentHtml: Option.fromNullable(currentHtml) };
      });

    // Streaming event types
    type StreamEvent =
      | { type: "session"; sessionId: string }
      | { type: "define"; tag: string; props: string[]; template: string }
      | { type: "patch"; patch: Patch }
      | { type: "html"; html: string }
      | {
          type: "stats";
          cacheRate: number;
          tokensPerSecond: number;
          mode: "patches" | "full";
          patchCount: number;
          ttft: number;
          ttc: number;
        }
      | { type: "done"; html: string };

    const generateStream = (request: UIRequest) =>
      Effect.gen(function* () {
        const { sessionId, currentHtml } = yield* resolveSession(request);

        yield* Effect.log("UIService.generateStream", {
          actionCount: request.actions.length,
          hasCurrentHtml: Option.isSome(currentHtml),
        });

        // Handle "reset" action - clear VDOM before generation
        const isResetAction = request.actions.some(
          (a) => a.type === "action" && a.action === "reset",
        );
        if (isResetAction) {
          yield* vdomService.deleteSession(sessionId);
          yield* Effect.log("Session reset, generating fresh UI");
        }

        // Get component catalog for prompt
        const catalog = isResetAction
          ? Option.none<string>()
          : Option.fromNullable(
              yield* vdomService.getCatalog(sessionId),
            );

        // Get compact HTML (CE templates stripped) for prompt context
        const promptHtml = isResetAction
          ? Option.none<string>()
          : Option.fromNullable(
              yield* vdomService.getCompactHtml(sessionId),
            );

        // Get registry specs for validation context CE rendering
        const registry = yield* vdomService.getRegistry(sessionId);
        const registrySpecs = isResetAction ? undefined : [...registry.values()];

        // Pass the full actions array to the generate service
        const unifiedStream = yield* generateService.streamUnified({
          sessionId,
          currentHtml: isResetAction ? Option.none() : currentHtml,
          promptHtml,
          catalog,
          actions: request.actions,
          modelId: request.modelId,
          sandboxCtx: request.sandboxCtx,
          registrySpecs,
        });

        // Start with session event
        const sessionEvent = Stream.make({
          type: "session" as const,
          sessionId,
        } as StreamEvent);

        // Track changes for memory saving
        const memoryChangeRef = yield* Ref.make<MemoryChange | null>(null);

        // Transform unified responses to stream events, applying to VDOM
        let lastHtml = Option.getOrElse(currentHtml, () => "");

        const handlePatchResponse = (patches: Patch[]) =>
          Effect.gen(function* () {
            const events = yield* Effect.forEach(patches, (patch) =>
              Effect.gen(function* () {
                const result = yield* vdomService.applyPatches(sessionId, [
                  patch,
                ]);
                if (result.errors.length > 0) {
                  yield* Effect.log("Patch error", { error: result.errors[0] });
                }
                lastHtml = result.html;
                return { type: "patch" as const, patch } as StreamEvent;
              }),
            );
            // Track patches for memory (accumulate if multiple patch responses)
            yield* Ref.update(
              memoryChangeRef,
              (current): MemoryChange =>
                current?.type === "patches"
                  ? {
                      type: "patches",
                      patches: [...current.patches, ...patches],
                    }
                  : { type: "patches", patches },
            );
            return events;
          });

        const handleFullResponse = (
          html: string,
        ): Effect.Effect<StreamEvent[], never, never> =>
          Effect.gen(function* () {
            yield* vdomService.setHtml(sessionId, html);
            // Render CEs so elements inside templates are available for subsequent patches
            yield* vdomService.renderTree(sessionId);
            lastHtml = html;
            // Track full HTML for memory
            yield* Ref.set(memoryChangeRef, { type: "full", html });
            return [{ type: "html" as const, html } as StreamEvent];
          });

        const handleDefineResponse = (r: {
          tag: string;
          props: string[];
          template: string;
        }) =>
          Effect.gen(function* () {
            yield* vdomService.define(sessionId, r);
            return [
              {
                type: "define" as const,
                tag: r.tag,
                props: r.props,
                template: r.template,
              } as StreamEvent,
            ];
          });

        const handleResponse = (response: UnifiedResponse) =>
          pipe(
            Match.value(response),
            Match.when({ op: "patches" }, (r) =>
              handlePatchResponse(r.patches),
            ),
            Match.when({ op: "full" }, (r) => handleFullResponse(r.html)),
            Match.when({ op: "define" }, (r) => handleDefineResponse(r)),
            Match.when({ op: "stats" }, (r) =>
              Effect.succeed([
                {
                  type: "stats" as const,
                  cacheRate: r.cacheRate,
                  tokensPerSecond: r.tokensPerSecond,
                  mode: r.mode,
                  patchCount: r.patchCount,
                  ttft: r.ttft,
                  ttc: r.ttc,
                } as StreamEvent,
              ]),
            ),
            Match.exhaustive,
          );

        const contentEvents = unifiedStream.pipe(
          Stream.mapEffect(handleResponse),
          Stream.flatMap((events) => Stream.fromIterable(events)),
        );

        // End with done event - saves memory and persists snapshot
        const doneEvent = Stream.fromEffect(
          Effect.gen(function* () {
            const finalHtml = yield* vdomService.getHtml(sessionId);
            lastHtml = finalHtml || lastHtml;

            const registry = yield* vdomService.getRegistry(sessionId);

            // Persist snapshot for server-restart recovery
            yield* sessionService.saveSnapshot(sessionId, {
              html: lastHtml,
              registry: [...registry.values()],
            });

            // Save memory asynchronously (non-blocking via queue)
            const memoryChange = yield* Ref.get(memoryChangeRef);
            if (memoryChange) {
              const prompts = request.actions
                .filter((a) => a.type === "prompt" && a.prompt)
                .map((a) => a.prompt!);
              const userActions: UserAction[] = request.actions
                .filter((a) => a.type === "action" && a.action)
                .map((a) => ({ action: a.action!, data: a.actionData }));

              yield* memoryService.saveMemory({
                sessionId,
                prompts: prompts.length > 0 ? prompts : undefined,
                actions: userActions.length > 0 ? userActions : undefined,
                change: memoryChange,
              });
            }

            return { type: "done" as const, html: lastHtml } as StreamEvent;
          }),
        );

        return Stream.concat(
          sessionEvent,
          Stream.concat(contentEvents, doneEvent),
        );
      }).pipe(
        Effect.withSpan("ui.generateStream", {
          attributes: {
            sessionId: request.sessionId ?? "new",
            actionCount: request.actions.length,
          },
        }),
      );

    return { generateStream, resolveSession };
  }),
}) {}

export type { Patch };
