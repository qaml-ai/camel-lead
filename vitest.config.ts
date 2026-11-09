import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { createHash } from "node:crypto";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const project = {
  agentId: "client_" + "a".repeat(40),
  tenantId: "test",
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
        kvNamespaces: ["OAUTH_KV"],
        bindings: {
          CAMELRUN_API_KEY: "runtime-test-only",
          CAMEL_LEAD_URL: "https://lead.test",
          PROJECTS_JSON: JSON.stringify({ demo: project, other: project,
            auto: { ...project, clients: {}, githubAutoEnroll: { enabled: true, maxClientsPerUser: 3 } },
            "auto-other": { ...project, clients: {}, githubAutoEnroll: { enabled: true, maxClientsPerUser: 3 } },
          }),
        },
      },
    }),
  ],
  test: { include: ["test/worker.spec.ts", "test/wait.spec.ts", "test/oauth.spec.ts", "test/cimd.spec.ts", "test/enrollment.spec.ts", "test/sessions.spec.ts"], fileParallelism: false },
});
