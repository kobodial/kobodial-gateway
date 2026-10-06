import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 10_000,
    // The first test in each worker pays for booting PGlite — Postgres
    // compiled to WebAssembly — which takes 6 to 8 seconds. Subsequent
    // tests reuse that instance and truncate between them (tests/testDb.ts),
    // so only the first hook is slow. 10s was not enough for it.
    hookTimeout: 40_000,
    // Workers are reused across files, which matters more now than it did:
    // each worker boots one PGlite instance and every test in it truncates
    // rather than rebooting. Spawning a worker per file would pay the boot
    // cost once per file instead of once per worker.
    isolate: false,
  },
});
