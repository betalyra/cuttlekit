import { defineConfig } from "tsdown";

export default defineConfig({
  exports: true,
  entry: {
    server: "src/server.ts",
    client: "src/client.ts",
  },
  // Don't bundle effect types - let consumers use their own effect dependency
  // Prevents nominal type mismatch (LayerTypeId, EffectTypeId symbols differ when bundled)
  external: ["effect", /^@effect\//],
});
