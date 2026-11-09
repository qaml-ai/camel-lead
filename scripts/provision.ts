/** Operator-run only. This creates camelRun resources; it never deploys the Worker. No keys go to stdout. */
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { randomBytes, createHash } from "node:crypto";
import { leadDefinition, memoryConfig } from "./plan.ts";
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
const apiKey = process.env.CAMELAI_API_KEY;
if (!apiKey) throw new Error("CAMELAI_API_KEY required in environment");
const budget = Number(process.env.DREAM_BUDGET_USD);
memoryConfig("validate", budget);
const token = () => randomBytes(32).toString("base64url"),
  digest = (s: string) => createHash("sha256").update(s).digest("hex");
const lead = token();
const definition = leadDefinition(project, adapter, lead);
const dir = `.secrets/${project}`;
if (existsSync(dir))
  throw new Error(
    "Private setup directory already exists. Inspect its journal; do not reprovision blindly.",
  );
mkdirSync(dir, { recursive: true, mode: 0o700 });
const receipts: unknown[] = [];
const save = (name: string, value: unknown) =>
  writeFileSync(
    `${dir}/${name}`,
    typeof value === "string" ? value : JSON.stringify(value, null, 2) + "\n",
    { mode: 0o600 },
  );
save("lead.token", lead);
async function call(path: string, body: unknown, method = "POST", id?: string) {
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
      body: JSON.stringify(body),
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
  const d = await call(
    "/v1/definitions",
    definition,
    "POST",
    `camel-lead-${project}`,
  );
  receipts.push({ definition: d.id });
  save("journal.json", receipts);
  const v = await call("/v1/volumes", {
    name: `${project} shared memory`,
    key: `camel-lead:${project}:memory`,
  });
  receipts.push({ memoryVolume: v.id });
  save("journal.json", receipts);
  const a = await call(
    "/v1/agents",
    {
      definition: d.id,
      name: `Project lead: ${project}`,
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
    const key = token();
    identities[client] = { name: client, tokenHash: digest(key) };
    save(`${client}.token`, key);
  }
  save("projects.json", {
    [project]: {
      agentId: a.id,
      leadTokenHash: digest(lead),
      clients: identities,
    },
  });
  console.log(
    `Prepared ${project}. Private credentials/config are in ${dir}; no secrets printed. Set Worker secrets and deploy separately. Keep the journal if interrupted.`,
  );
} catch (error) {
  console.error(
    error instanceof Error
      ? error.message
      : "Setup failed; inspect private journal",
  );
  process.exitCode = 1;
}
