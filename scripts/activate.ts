/** Run only after deploying the adapter registry. Reuses camelRun's signed identity auth; no custom lead key. */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { leadMcpSource } from "./plan.ts";
const [project] = process.argv.slice(2);
if (!project || !/^[A-Za-z0-9_-]{1,80}$/.test(project))
  throw new Error("Usage: activate.ts PROJECT");
const apiKey = process.env.CAMELAI_API_KEY;
if (!apiKey) throw new Error("CAMELAI_API_KEY required");
const activation = JSON.parse(
  readFileSync(`.secrets/${project}/activation.json`, "utf8"),
);
const source = leadMcpSource(project, new URL(activation.source.url).origin);
const base = (
  process.env.CAMELAI_BASE_URL || "https://run-pilot.camelai.dev"
).replace(/\/$/, "");
async function call(path: string, body?: unknown) {
  const response = await fetch(base + path, {
    method: body === undefined ? "GET" : "PATCH",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok)
    throw new Error(
      `Activation HTTP ${response.status}; no credential values logged`,
    );
  return response.json() as Promise<any>;
}
const me = await call("/v1/me");
if (me.tenant !== activation.tenantId)
  throw new Error("API key belongs to another tenant");
const requestId = `lead_attach_${createHash("sha256")
  .update(JSON.stringify({ agent: activation.agentId, source }))
  .digest("hex")
  .slice(0, 40)}`;
await call(`/v1/agents/${activation.agentId}/configuration`, {
  requestId,
  mcpServers: [source],
});
for (let i = 0; i < 60; i++) {
  const record = await call(
    `/v1/agents/${activation.agentId}/requests/${requestId}`,
  );
  if (record.state === "completed") {
    if (record.outcome?.error || record.outcome?.result?.error)
      throw new Error(
        "Runtime refused activation; inspect the configuration request",
      );
    console.log(
      `MCP source configured for ${project} with runtime-signed identity auth. Verify a real tool call before claiming end-to-end readiness.`,
    );
    process.exit(0);
  }
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
throw new Error(
  "Activation still pending; inspect the same requestId before retrying",
);
