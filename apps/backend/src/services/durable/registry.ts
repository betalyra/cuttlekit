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
import { StoreService } from "../memory/store.js";
import type { ManagedSandbox } from "../sandbox/manager.js";
import type { Action, SessionProcessor, StreamEventWithOffset } from "./types.js";

export class ProcessorRegistry extends Effect.Service<ProcessorRegistry>()(
  "ProcessorRegistry",
  {
    accessors: true,
    effect: Effect.gen(function* () {
      // Capture dependencies at construction time so methods don't leak them
      const uiService = yield* UIService;
      const eventLog = yield* DurableEventLog;
      const sandboxService = yield* SandboxService;
      const store = yield* StoreService;

      const processors = yield* Ref.make(
        HashMap.empty<string, SessionProcessor>()
      );
      const creationLock = yield* Effect.makeSemaphore(1);

      const warmupSandbox = (
        sessionId: string,
        sandboxRef: Ref.Ref<Option.Option<ManagedSandbox>>,
      ) =>
        Effect.gen(function* () {
          if (Option.isNone(sandboxService.manager)) return;
          const manager = sandboxService.manager.value;
          if (manager.config.mode !== "warm") return;

          const startTime = yield* DateTime.now;
          yield* Effect.log("Warm start: creating sandbox", { sessionId });

          // Ensure volume exists
          let volumeEntry = yield* store.getSessionVolume(sessionId);
          if (!volumeEntry) {
            yield* Effect.logDebug("Warm start: creating volume", { sessionId });
            const slug = yield* manager.createVolume(sessionId);
            yield* store.registerVolume(sessionId, slug, manager.config.region);
            volumeEntry = yield* store.getSessionVolume(sessionId);
            const volumeTime = yield* DateTime.now;
            yield* Effect.logDebug("Warm start: volume created", {
              sessionId,
              elapsed: `${Duration.toMillis(DateTime.distanceDuration(startTime, volumeTime))}ms`,
            });
          }

          const volumeSlug = volumeEntry?.volumeSlug;
          yield* manager.getOrCreateSandbox(sessionId, sandboxRef, volumeSlug);
          const endTime = yield* DateTime.now;
          yield* Effect.log("Warm start: sandbox ready", {
            sessionId,
            elapsed: `${Duration.toMillis(DateTime.distanceDuration(startTime, endTime))}ms`,
          });
        });

      const createProcessor = (sessionId: string) =>
        Effect.gen(function* () {
          const scope = yield* Scope.make();
          const actionQueue = yield* Queue.unbounded<Action>();
          const eventPubSub = yield* PubSub.unbounded<StreamEventWithOffset>();
          const lastActivity = yield* Ref.make(Date.now());
          const sandboxRef = yield* Ref.make<Option.Option<ManagedSandbox>>(
            Option.none(),
          );

          // Fork warm-up as non-fatal background fiber
          yield* pipe(
            warmupSandbox(sessionId, sandboxRef),
            Effect.catchAll((error) =>
              Effect.logWarning("Warm start failed (non-fatal)", {
                sessionId,
                error: String(error),
              }),
            ),
            Effect.forkIn(scope),
          );

          const fiber = yield* pipe(
            runProcessingLoop(sessionId, actionQueue, eventPubSub, sandboxRef),
            Effect.provideService(UIService, uiService),
            Effect.provideService(DurableEventLog, eventLog),
            Effect.forkIn(scope)
          );

          yield* Effect.log("Processor created", { sessionId });

          return {
            sessionId,
            actionQueue,
            eventPubSub,
            lastActivity,
            sandboxRef,
            fiber,
            scope,
          } satisfies SessionProcessor;
        });

      const getOrCreate = (sessionId: string) =>
        creationLock.withPermits(1)(
          Effect.gen(function* () {
            const current = yield* Ref.get(processors);
            const existing = HashMap.get(current, sessionId);

            if (Option.isSome(existing)) {
              yield* Ref.set(existing.value.lastActivity, Date.now());
              return existing.value;
            }

            const processor = yield* createProcessor(sessionId);
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

          if (Option.isSome(existing)) {
            yield* Scope.close(existing.value.scope, Exit.void);
            yield* Ref.update(processors, HashMap.remove(sessionId));
            yield* Effect.log("Processor released", { sessionId });
          }
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
