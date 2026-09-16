import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: [fileURLToPath(new URL("./setup.ts", import.meta.url))],
  },
});
