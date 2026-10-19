import os from "node:os";
import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    env: {
      DATA_DIR: path.join(os.tmpdir(), `linkmein-test-${process.pid}`),
      APP_SECRET: "test-secret",
      SCHEDULER_INTERVAL_MS: "3600000",
      ALLOW_DEV_LOGIN: "true",
    },
  },
});
