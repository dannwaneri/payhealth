import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Tests run inside the Workers runtime with a local D1 database and our migrations.
// Test-only bindings: no real PayPal or AI keys, so nothing leaves the machine.
export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            DEMO_PASSWORD: "test-password",
            PP_ID: "test-client-id",
            PP_SECRET: "test-secret",
            PAYPAL_WEBHOOK_ID: "WH-TEST",
            ANTHROPIC_API_KEY: "",
          },
        },
      }),
    ],
    test: { setupFiles: ["./test/setup.ts"] },
  };
});
