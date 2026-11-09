import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/setup/no-real-google.ts"],
    testTimeout: 15000,
    hookTimeout: 30000,
  },
});
