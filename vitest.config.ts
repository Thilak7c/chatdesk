import { defineConfig } from "vitest/config";

// Two projects:
//   unit — pure logic, runs in parallel, needs nothing external.
//   db   — `*.db.test.ts`, runs against a real Postgres given by
//          TEST_DATABASE_URL (migrated fresh once, truncated between
//          tests). Files run one at a time since they share the
//          database. Without TEST_DATABASE_URL these suites are skipped.
export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    environment: "node",
    // Dummy secrets — encryption.ts / webhook-signature.ts read these
    // at module load. Tests never hit a real Meta service, so any
    // 32-byte hex / non-empty string will do; keep them lexically
    // identical to the CI build env so behaviour matches.
    env: {
      ENCRYPTION_KEY:
        "0000000000000000000000000000000000000000000000000000000000000000",
      META_APP_SECRET: "test-meta-app-secret",
    },
    clearMocks: true,
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
          exclude: ["src/**/*.db.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "db",
          include: ["src/**/*.db.test.ts"],
          globalSetup: ["src/test/db-global-setup.ts"],
          setupFiles: ["src/test/db-setup.ts"],
          fileParallelism: false,
        },
      },
    ],
  },
});
