import { setTimeout as sleep } from "node:timers/promises";
import { LeadClient, deliverPending } from "./api.ts";
import { deliverCodex, deliverOpenCode } from "./bridges.ts";
import { CodexRpc } from "./codex-rpc.ts";
const [project, target, session] = process.argv.slice(2);
if (!project || !session || !["codex", "opencode"].includes(target))
  throw new Error("Usage: bridge.ts PROJECT codex|opencode LOCAL_SESSION_ID");
const client = new LeadClient(
  process.env.CAMEL_LEAD_URL || "http://127.0.0.1:8787",
  project,
  process.env.CAMEL_LEAD_TOKEN || "",
);
const stop = new AbortController();
process.once("SIGINT", () => stop.abort());
process.once("SIGTERM", () => stop.abort());
const codex = target === "codex" ? new CodexRpc() : undefined;
try {
  if (codex) await codex.initialize(session);
  while (!stop.signal.aborted) {
    await deliverPending(client, (event) =>
      codex
        ? deliverCodex(codex, session, event)
        : deliverOpenCode(
            process.env.OPENCODE_BASE_URL || "http://127.0.0.1:4096",
            session,
            event,
            fetch,
            process.env.OPENCODE_AUTHORIZATION,
          ),
    );
    await sleep(2000, undefined, { signal: stop.signal }).catch(() => {});
  }
} catch (error) {
  console.error(
    error instanceof Error
      ? error.message
      : "Bridge failed; messages remain unacknowledged",
  );
  process.exitCode = 1;
} finally {
  codex?.close();
}
