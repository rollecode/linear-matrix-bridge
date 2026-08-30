import { applyD1Migrations, env } from "cloudflare:test";
import type { D1Migration } from "@cloudflare/vitest-plugin";

declare module "cloudflare:test" {
  interface ProvidedEnv {
    TEST_MIGRATIONS: D1Migration[];
  }
}

await applyD1Migrations(env.DB, (env as unknown as { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS);
