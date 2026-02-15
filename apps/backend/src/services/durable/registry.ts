import {
  Effect,
  HashMap,
  Option,
  Queue,
  PubSub,
  Ref,
  Scope,
  Exit,
  pipe,
} from "effect";
import { runProcessingLoop } from "./processor.js";
import { UIService } from "../ui.js";
import { DurableEventLog } from "./event-log.js";
import type { Action, SessionProcessor, StreamEventWithOffset } from "./types.js";

export class ProcessorRegistry extends Effect.Service<ProcessorRegistry>()(
  "ProcessorRegistry",
  {
    accessors: true,
    effect: Effect.gen(function* () {
      // Capture dependencies at construction time so methods don't leak them
      const uiService = yield* UIService;
      const eventLog = yield* DurableEventLog;

      const processors = yield* Ref.make(
        HashMap.empty<string, SessionProcessor>()
      );
      const creationLock = yield* Effect.makeSemaphore(1);

      const createProcessor = (sessionId: string) =>
        Effect.gen(function* () {
          const scope = yield* Scope.make();
          const actionQueue = yield* Queue.unbounded<Action>();
          const eventPubSub = yield* PubSub.unbounded<StreamEventWithOffset>();
          const lastActivity = yield* Ref.make(Date.now());

          const fiber = yield* pipe(
            runProcessingLoop(sessionId, actionQueue, eventPubSub),
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
