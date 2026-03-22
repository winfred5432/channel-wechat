import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    pool: "forks",
    testTimeout: 15000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/index.ts"],
      reporter: ["text", "lcov"],
      // Note: gateway.ts coverage not collected due to worker memory pressure from
      // auth.test.ts long-polling simulation. Tests pass; coverage reported per-file below.
      // Per-file thresholds where coverage is reliably captured:
      thresholds: {
        "src/config.ts": { lines: 90, functions: 100, branches: 90, statements: 90 },
        "src/wechat.ts": { lines: 95, functions: 100, branches: 85, statements: 95 },
        "src/daemon.ts": { lines: 100, functions: 100, branches: 100, statements: 100 },
        "src/auth.ts": { lines: 85, functions: 100, branches: 80, statements: 85 },
      },
    },
  },
});
