import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "@effect/platform";
import { NodeHttpClient, NodeRuntime } from "@effect/platform-node";
import {
  Array,
  Effect,
  Console,
  Match,
  Option,
  pipe,
  Stream,
  Layer,
  Logger,
  LogLevel,
} from "effect";

// Request type matching the backend
type GenerateRequest = {
  type: "generate";
  prompt?: string;
  sessionId?: string;
  action?: string;
  actionData?: Record<string, unknown>;
  currentHtml?: string;
};

// Stream event types
type StreamEvent =
  | { type: "session"; sessionId: string }
  | { type: "patch"; patch: unknown }
  | { type: "html"; html: string }
  | { type: "done"; html: string };

type SSEParseState = {
  events: StreamEvent[];
  currentData: string;
};

const parseJsonSafe = (json: string) =>
  Effect.try({
    try: () => JSON.parse(json) as StreamEvent,
    catch: () => new Error(`Failed to parse JSON: ${json}`),
  });

const processSSELine = (state: SSEParseState, line: string) =>
  Effect.gen(function* () {
    if (line.startsWith("data: ")) {
      return { ...state, currentData: line.slice(6) };
    }

    if (line === "" && state.currentData) {
      const event = yield* pipe(
        parseJsonSafe(state.currentData),
        Effect.option
      );

      return pipe(
        event,
        Option.match({
          onNone: () => ({ events: state.events, currentData: "" }),
          onSome: (e) => ({ events: [...state.events, e], currentData: "" }),
        })
      );
    }

    return state;
  });

const parseSSEStream = (text: string) =>
  pipe(
    text.split("\n"),
    Array.reduce(
      Effect.succeed({ events: [], currentData: "" } as SSEParseState),
      (stateEffect, line) =>
        Effect.flatMap(stateEffect, (state) => processSSELine(state, line))
    ),
    Effect.map((state) => state.events)
  );

const formatHtmlPreview = (html: string) => {
  const preview = html.slice(0, 100).replace(/\n/g, " ");
  return `${preview}${html.length > 100 ? "..." : ""}`;
};

const logEvent = (event: StreamEvent) =>
  Effect.gen(function* () {
    yield* Console.log(`\n  [${event.type}]`);

    yield* pipe(
      Match.value(event),
      Match.when({ type: "session" }, (e) =>
        Console.log(`    sessionId: ${e.sessionId}`)
      ),
      Match.when({ type: "patch" }, (e) =>
        Console.log(
          `    patch: ${JSON.stringify(e.patch, null, 6)
            .split("\n")
            .join("\n    ")}`
        )
      ),
      Match.when({ type: "html" }, (e) =>
        Console.log(`    html: ${formatHtmlPreview(e.html)}`)
      ),
      Match.when({ type: "done" }, (e) =>
        Console.log(`    html: ${formatHtmlPreview(e.html)}`)
      ),
      Match.exhaustive
    );
  });

// Sample todo list HTML for testing multiple patches
const SAMPLE_TODO_HTML = `<div class="max-w-md mx-auto p-6">
  <h1 id="title" class="text-2xl font-bold mb-4">Todo List</h1>
  <div class="flex gap-2 mb-4">
    <input id="new-todo-input" type="text" placeholder="Add a task..." class="flex-1 px-3 py-2 border rounded" value="Buy groceries">
    <button id="add-btn" data-action="add-todo" class="px-4 py-2 bg-blue-500 text-white rounded">Add</button>
  </div>
  <div id="stats" class="text-sm text-gray-500 mb-2">3 items, 1 completed</div>
  <ul id="todo-list" class="space-y-2">
    <li id="todo-1" class="flex items-center gap-2 p-2 bg-white rounded shadow">
      <input type="checkbox" id="todo-1-checkbox" checked data-action="toggle" data-action-data="{&quot;id&quot;:&quot;1&quot;}">
      <span id="todo-1-text" class="line-through text-gray-400">Learn Effect</span>
      <button id="delete-1" data-action="delete" data-action-data="{&quot;id&quot;:&quot;1&quot;}" class="ml-auto text-red-500">×</button>
    </li>
    <li id="todo-2" class="flex items-center gap-2 p-2 bg-white rounded shadow">
      <input type="checkbox" id="todo-2-checkbox" data-action="toggle" data-action-data="{&quot;id&quot;:&quot;2&quot;}">
      <span id="todo-2-text">Build streaming patches</span>
      <button id="delete-2" data-action="delete" data-action-data="{&quot;id&quot;:&quot;2&quot;}" class="ml-auto text-red-500">×</button>
    </li>
    <li id="todo-3" class="flex items-center gap-2 p-2 bg-white rounded shadow">
      <input type="checkbox" id="todo-3-checkbox" data-action="toggle" data-action-data="{&quot;id&quot;:&quot;3&quot;}">
      <span id="todo-3-text">Test benchmark</span>
      <button id="delete-3" data-action="delete" data-action-data="{&quot;id&quot;:&quot;3&quot;}" class="ml-auto text-red-500">×</button>
    </li>
  </ul>
</div>`;

const testStreamEndpoint = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;

  // Test patch generation - adding a new todo (triggers multiple patches)
  const request: GenerateRequest = {
    type: "generate",
    action: "add-todo",
    actionData: { text: "Buy groceries" },
    currentHtml: SAMPLE_TODO_HTML,
  };

  yield* Console.log("🚀 Starting stream request...");
  yield* Console.log(`📤 Request: ${JSON.stringify(request, null, 2)}`);

  const startTime = performance.now();

  const response = pipe(
    HttpClientRequest.post("http://localhost:34512/generate/stream"),
    HttpClientRequest.bodyJson(request),
    Effect.flatMap(client.execute),
    Effect.scoped
  );

  const responseTime = performance.now() - startTime;
  yield* Console.log(`\n⏱️  Time to first byte: ${responseTime.toFixed(2)}ms`);
  //   yield* Console.log(`📥 Status: ${response.status}`);

  const stream = HttpClientResponse.stream(response);
  const totalTime = performance.now() - startTime;

  const textDecoder = new TextDecoder();
  const events = yield* pipe(
    stream,
    Stream.map((input) => textDecoder.decode(input)),
    Stream.tap((line) => Effect.logDebug(line)),
    Stream.runCollect
  );

  //   yield* Console.log(`\n📨 Received ${events.length} events:`);

  //   yield* pipe(events, Effect.forEach(logEvent));

  yield* Console.log(`\n⏱️  Total time: ${totalTime.toFixed(2)}ms`);
});

const program = pipe(
  testStreamEndpoint,
  Effect.catchAll((error) => Console.error(`❌ Error: ${error}`)),
  Effect.provide(
    Layer.mergeAll(
      NodeHttpClient.layer,
      Logger.pretty,
      Logger.minimumLogLevel(LogLevel.Debug)
    )
  )
);

NodeRuntime.runMain(program);
