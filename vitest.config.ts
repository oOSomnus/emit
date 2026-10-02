import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    root: ".",
    include: ["test/**/*.test.ts"],
    environment: "node",
    // The server modules import Node builtins and pi-durable; one process is
    // enough and keeps startup cost off the critical path.
    pool: "threads",
  },
});
