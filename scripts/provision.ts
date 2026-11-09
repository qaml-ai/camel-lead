/** Operator-run bootstrap only: no deployment and no custom lead credential. */
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { randomBytes, createHash } from "node:crypto";
import { leadDefinition, leadMcpSource, memoryConfig } from "./plan.ts";
const [project, adapter, ...clients] = process.argv.slice(2);
if (
  !project ||
  !adapter ||
  !clients.length ||
  clients.some((c) => !/^[-A-Za-z0-9_]{1,80}$/.test(c))
)
  throw new Error(
    "Usage: provision.ts PROJECT https://adapter.example CLIENT_ID...",
  );
const configuration = leadDefinition(project),
  source = leadMcpSource(project, adapter);
const apiKey = process.env.CAMELAI_API_KEY;
if (!apiKey) throw new Error("CAMELAI_API_KEY required in environment");
const budget = Number(process.env.DREAM_BUDGET_USD);
memoryConfig("validate", budget);
const dir = `.secrets/${project}`;
if (existsSync(dir))
  throw new Error(
    "Private setup directory already exists. Inspect journal; do not reprovision blindly.",
  );
mkdirSync(dir, { recursive: true, mode: 0o700 });
const receipts: unknown[] = [];
const save = (name: string, value: unknown) =>
  writeFileSync(
    `${dir}/${name}`,
    typeof value === "string" ? value : JSON.stringify(value, null, 2) + "\n",
    { mode: 0o600 },
  );
async function call(
  path: string,
  body?: unknown,
  method = "POST",
  id?: string,
) {
  const response = await fetch(
    (process.env.CAMELAI_BASE_URL || "https://run-pilot.camelai.dev").replace(
      /\/$/,
      "",
    ) + path,
    {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        ...(id ? { "Idempotency-Key": id } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!response.ok)
    throw new Error(
      `Provisioning HTTP ${response.status} at ${path}; private journal retained`,
    );
  return response.json() as Promise<any>;
}
try {
  const me = await call("/v1/me", undefined, "GET");
  if (typeof me.tenant !== "string" || !me.tenant)
    throw new Error("Runtime did not identify the tenant");
  receipts.push({ tenant: me.tenant });
  save("journal.json", receipts);
  const v = await call("/v1/volumes", {
    name: `${project} shared memory`,
    key: `camel-lead:${project}:memory`,
  });
  receipts.push({ memoryVolume: v.id });
  save("journal.json", receipts);
  // Do not attach MCP until the adapter registry knows this exact agent and tenant. That avoids a discovery/auth bootstrap cycle.
  const a = await call(
    "/v1/agents",
    {
      ...configuration,
      context: { project },
      ttlSeconds: null,
      mounts: [{ volumeId: v.id, path: "/memory", mode: "ro" }],
    },
    "POST",
    `camel-lead-${project}`,
  );
  receipts.push({ agent: a.id });
  save("journal.json", receipts);
  await call(`/v1/agents/${a.id}/dreaming`, memoryConfig(v.id, budget), "PUT");
  const identities: Record<string, { name: string; tokenHash: string }> = {};
  for (const client of new Set(clients)) {
    const token = randomBytes(32).toString("base64url");
    identities[client] = {
      name: client,
      tokenHash: createHash("sha256").update(token).digest("hex"),
    };
    save(`${client}.token`, token);
  }
  save("projects.json", {
    [project]: { agentId: a.id, tenantId: me.tenant, clients: identities },
  });
  save("activation.json", {
    project,
    agentId: a.id,
    tenantId: me.tenant,
    source,
  });
  console.log(
    `Prepared ${project}; private config is in ${dir}. Install Worker secrets, deploy, then run scripts/activate.ts ${project}. No lead credential was created. Keep the journal if interrupted.`,
  );
} catch (error) {
  console.error(
    error instanceof Error
      ? error.message
      : "Setup failed; inspect private journal",
  );
  process.exitCode = 1;
}
