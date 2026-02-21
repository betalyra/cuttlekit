import {
  Effect,
  HashMap,
  Option,
  Queue,
  PubSub,
  Ref,
  Scope,
  Exit,
  DateTime,
  Duration,
  pipe,
} from "effect";
import { runProcessingLoop } from "./processor.js";
import { UIService } from "../ui.js";
import { DurableEventLog } from "./event-log.js";
import { SandboxService } from "../sandbox/service.js";
import type { ManagedSandbox, SandboxContext } from "../sandbox/manager.js";
import type { Action, SessionProcessor, StreamEventWithOffset } from "./types.js";

// ============================================================
// User-scoped sandbox context tracking
// ============================================================

type UserSandboxEntry = {
  readonly ctx: SandboxContext;
  readonly sessionCount: Ref.Ref<number>;
};

export class ProcessorRegistry extends Effect.Service<ProcessorRegistry>()(
  "ProcessorRegistry",
  {
    accessors: true,
    effect: Effect.gen(function* () {
      // Capture dependencies at construction time so methods don't leak them
      const uiService = yield* UIService;
      const eventLog = yield* DurableEventLog;
      const sandboxService = yield* SandboxService;

      const processors = yield* Ref.make(
        HashMap.empty<string, SessionProcessor>()
      );
      const userSandboxContexts = yield* Ref.make(
        HashMap.empty<string, UserSandboxEntry>()
      );
      const creationLock = yield* Effect.makeSemaphore(1);

      const getSandboxScope = (): "session" | "user" => {
        if (Option.isNone(sandboxService.manager)) return "session";
        return sandboxService.manager.value.config.sandboxScope;
      };

      const warmupSandbox = (
        sessionId: string,
        sandboxCtx: SandboxContext,
      ) =>
        Effect.gen(function* () {
          if (Option.isNone(sandboxService.manager)) return;
          const manager = sandboxService.manager.value;
          if (manager.config.initMode !== "eager") return;

          const startTime = yield* DateTime.now;
          yield* Effect.log("Eager start: creating sandbox", { sessionId });

          yield* manager.getOrCreateSandbox(sessionId, sandboxCtx);
          const endTime = yield* DateTime.now;
          yield* Effect.log("Eager start: sandbox ready", {
            sessionId,
            elapsed: `${Duration.toMillis(DateTime.distanceDuration(startTime, endTime))}ms`,
          });
        });

      // Get or create a shared sandbox context for a user
      const getOrCreateUserSandboxCtx = (userId: string) =>
        Effect.gen(function* () {
          const current = yield* Ref.get(userSandboxContexts);
          const existing = HashMap.get(current, userId);

          if (Option.isSome(existing)) {
            yield* Ref.update(existing.value.sessionCount, (n) => n + 1);
            return existing.value.ctx;
          }

          const sandboxRef = yield* Ref.make<Option.Option<ManagedSandbox>>(
            Option.none(),
          );
          const sandboxLock = yield* Effect.makeSemaphore(1);
          const ctx: SandboxContext = { ref: sandboxRef, lock: sandboxLock };
          const sessionCount = yield* Ref.make(1);

          yield* Ref.update(
            userSandboxContexts,
            HashMap.set(userId, { ctx, sessionCount } satisfies UserSandboxEntry),
          );
          yield* Effect.log("Created user sandbox context", { userId });

          return ctx;
        });

      const createProcessor = (sessionId: string, userId: string) =>
        Effect.gen(function* () {
          const scope = yield* Scope.make();
          const actionQueue = yield* Queue.unbounded<Action>();
          const eventPubSub = yield* PubSub.unbounded<StreamEventWithOffset>();
          const lastActivity = yield* Ref.make(Date.now());

          const sandboxCtx: SandboxContext =
            getSandboxScope() === "user"
              ? yield* getOrCreateUserSandboxCtx(userId)
              : yield* Effect.gen(function* () {
                  const sandboxRef = yield* Ref.make<Option.Option<ManagedSandbox>>(
                    Option.none(),
                  );
                  const sandboxLock = yield* Effect.makeSemaphore(1);
                  return { ref: sandboxRef, lock: sandboxLock } satisfies SandboxContext;
                });

          // Fork warm-up as non-fatal background fiber
          yield* pipe(
            warmupSandbox(sessionId, sandboxCtx),
            Effect.catchAll((error) =>
              Effect.logWarning("Warm start failed (non-fatal)", {
                sessionId,
                error: String(error),
              }),
            ),
            Effect.forkIn(scope),
          );

          const fiber = yield* pipe(
            runProcessingLoop(sessionId, actionQueue, eventPubSub, sandboxCtx),
            Effect.provideService(UIService, uiService),
            Effect.provideService(DurableEventLog, eventLog),
            Effect.forkIn(scope)
          );

          yield* Effect.log("Processor created", { sessionId, userId });

          return {
            sessionId,
            userId,
            actionQueue,
            eventPubSub,
            lastActivity,
            sandboxCtx,
            fiber,
            scope,
          } satisfies SessionProcessor;
        });

      const getOrCreate = (sessionId: string, userId: string) =>
        creationLock.withPermits(1)(
          Effect.gen(function* () {
            const current = yield* Ref.get(processors);
            const existing = HashMap.get(current, sessionId);

            if (Option.isSome(existing)) {
              yield* Ref.set(existing.value.lastActivity, Date.now());
              return existing.value;
            }

            const processor = yield* createProcessor(sessionId, userId);
            yield* Ref.update(processors, HashMap.set(sessionId, processor));
            return processor;
          })
        );

      const touch = (sessionId: string) =>
        Effect.gen(function* () {
          const current = yield* Ref.get(processors);
          const existing = HashMap.get(current, sessionId);
          if (Option.isSome(existing)) {
            yield* Ref.set(existing.value.lastActivity, Date.now());
          }
        });

      const release = (sessionId: string) =>
        Effect.gen(function* () {
          const current = yield* Ref.get(processors);
          const existing = HashMap.get(current, sessionId);
          if (Option.isNone(existing)) return;

          const processor = existing.value;

          if (getSandboxScope() === "user") {
            // Decrement user refcount, release sandbox if last session
            const userContexts = yield* Ref.get(userSandboxContexts);
            const userEntry = HashMap.get(userContexts, processor.userId);
            if (Option.isSome(userEntry)) {
              const newCount = yield* Ref.updateAndGet(
                userEntry.value.sessionCount,
                (n) => n - 1,
              );
              if (newCount <= 0 && Option.isSome(sandboxService.manager)) {
                yield* sandboxService.manager.value.releaseSandbox(userEntry.value.ctx);
                yield* Ref.update(userSandboxContexts, HashMap.remove(processor.userId));
                yield* Effect.log("User sandbox context released", { userId: processor.userId });
              }
            }
          } else {
            // Session scope: release sandbox directly
            if (Option.isSome(sandboxService.manager)) {
              yield* sandboxService.manager.value.releaseSandbox(processor.sandboxCtx);
            }
          }

          yield* Scope.close(processor.scope, Exit.void);
          yield* Ref.update(processors, HashMap.remove(sessionId));
          yield* Effect.log("Processor released", { sessionId });
        });

      const getAllSessionIds = Effect.gen(function* () {
        const current = yield* Ref.get(processors);
        return HashMap.keys(current);
      });

      const getLastActivity = (sessionId: string) =>
        Effect.gen(function* () {
          const current = yield* Ref.get(processors);
          const existing = HashMap.get(current, sessionId);
          return Option.isSome(existing)
            ? Option.some(yield* Ref.get(existing.value.lastActivity))
            : Option.none<number>();
        });

      yield* Effect.log("ProcessorRegistry initialized");

      return {
        getOrCreate,
        touch,
        release,
        getAllSessionIds,
        getLastActivity,
      } as const;
    }),
  }
) {}
