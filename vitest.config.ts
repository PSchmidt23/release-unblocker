import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    env: {
      MOCK_STREAM_DELAY_MS: "0",
    },
  },
});
