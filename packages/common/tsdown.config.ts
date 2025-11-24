import { defineConfig } from "tsdown";

export default defineConfig({
  exports: true,
  entry: {
    server: "src/server.ts",
    client: "src/client.ts",
  },
});
