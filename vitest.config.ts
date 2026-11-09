import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { createHash } from "node:crypto";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const project = {
  agentId: "client_" + "a".repeat(40),
  leadTokenHash: hash("lead-test-only"),
  clients: {
    alice: { name: "Alice", tokenHash: hash("alice-test-only") },
    bob: { name: "Bob", tokenHash: hash("bob-test-only") },
  },
};
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          CAMELRUN_API_KEY: "runtime-test-only",
          PROJECTS_JSON: JSON.stringify({ demo: project, other: project }),
        },
      },
    }),
  ],
  test: { include: ["test/worker.spec.ts"], fileParallelism: false },
});
