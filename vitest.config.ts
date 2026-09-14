import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 10_000,
    // Every test file builds its own fresh :memory: database and mock
    // contract client, with no shared or global state between files —
    // safe to reuse workers across files instead of spawning one per
    // file.
    isolate: false,
  },
});
