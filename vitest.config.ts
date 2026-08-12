import { defineConfig } from "vitest/config";

if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL =
    "postgresql://multiorm:multiorm@localhost:5432/multiorch?sslmode=disable";
}

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/__tests__/**/*.test.ts"],
    typecheck: {
      enabled: false,
    },
  },
});
