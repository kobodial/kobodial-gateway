import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 10_000,
    // Insurance for slow hardware, not a workaround for an inherent cost.
    // The first test in each worker boots PGlite — Postgres compiled to
    // WebAssembly — which CI does in well under a second but which took 6 to
    // 8 seconds on the machine this was written on, overrunning the 10s
    // default. Subsequent tests reuse that instance and truncate between
    // them (tests/testDb.ts), so only the first hook is ever slow.
    hookTimeout: 40_000,
    // Workers are reused across files, which matters more now than it did:
    // each worker boots one PGlite instance and every test in it truncates
    // rather than rebooting. Spawning a worker per file would pay the boot
    // cost once per file instead of once per worker.
    isolate: false,
  },
});
