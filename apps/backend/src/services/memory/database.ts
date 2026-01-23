import { createClient, type Client } from "@libsql/client";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { Config, Context, Effect, Layer } from "effect";
import * as schema from "./schema.js";

export type DatabaseClient = {
  readonly db: LibSQLDatabase<typeof schema>;
  readonly client: Client;
};

export class Database extends Context.Tag("Database")<Database, DatabaseClient>() {}

const DEFAULT_DATABASE_PATH = "file:./memory.db";

export const DatabaseLayer = Layer.effect(
  Database,
  Effect.gen(function* () {
    const url = yield* Config.string("DATABASE_URL").pipe(
      Config.withDefault(DEFAULT_DATABASE_PATH)
    );

    const client = createClient({ url });
    const db = drizzle(client, { schema });

    // Run migrations on startup
    yield* Effect.promise(() =>
      migrate(db, { migrationsFolder: "./drizzle" })
    );
    yield* Effect.log("Database migrations applied");

    yield* Effect.log("Database connected", { url });

    return { db, client };
  })
).pipe(Layer.orDie);
