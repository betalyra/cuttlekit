import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./apps/backend/src/services/memory/schema.ts",
  out: "./drizzle",
  dialect: "turso",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "file:./memory.db",
  },
});
