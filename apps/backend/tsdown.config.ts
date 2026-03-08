import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  format: "esm",
  // By default tsdown externalizes all node_modules deps.
  // Force-bundle workspace packages and their transitive pure-JS deps
  // so the output is self-contained for Docker deployment.
  noExternal: [/@cuttlekit\//, "effect", /^@effect\//, "drizzle-orm"],
});
