import path from "node:path";
import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const migrations = await readD1Migrations(path.join(rootDir, "migrations"));

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: migrations,
          MATRIX_HOMESERVER_URL: "https://matrix.test",
          MATRIX_BOT_USER_ID: "@linear:matrix.test",
          MATRIX_ALLOWED_ROOMS: "",
          COMMAND_PREFIX: "!linear",
          LINEAR_TEAM_ID: "team-uuid",
          GEMINI_API_KEY: "test-gemini-key",
          LINEAR_AUTH_MODE: "api_key",
          MATRIX_AS_TOKEN: "as-token",
          MATRIX_HS_TOKEN: "hs-token",
          LINEAR_TOKEN: "linear-token",
          LINEAR_WEBHOOK_SECRET: "webhook-secret",
        },
      },
    }),
  ],
  test: {
    setupFiles: ["./test/setup.ts"],
  },
});
