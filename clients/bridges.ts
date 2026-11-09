import type { Event } from "./api.ts";
import { externalText } from "./api.ts";
export type Rpc = {
  call(method: string, params: unknown): Promise<any>;
  waitTurn(id: string): Promise<{ status: string }>;
};
export async function deliverCodex(rpc: Rpc, threadId: string, event: Event) {
  const result = await rpc.call("turn/start", {
    threadId,
    input: [{ type: "text", text: externalText(event) }],
  });
  const turn = await rpc.waitTurn(result.turn.id);
  if (turn.status !== "completed")
    throw new Error(
      `Codex turn ${turn.status}; message remains unacknowledged`,
    );
}
/** Current OpenCode development API. Older releases use different routes/payloads; fail closed, no guessing. */
export async function deliverOpenCode(
  base: string,
  session: string,
  event: Event,
  fetcher: typeof fetch = fetch,
  authorization?: string,
) {
  const url = new URL(base);
  if (
    url.protocol !== "https:" &&
    !["localhost", "127.0.0.1"].includes(url.hostname)
  )
    throw new Error("OpenCode requires HTTPS or loopback");
  const result = await fetcher(
    `${base.replace(/\/$/, "")}/api/session/${encodeURIComponent(session)}/prompt`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(authorization ? { Authorization: authorization } : {}),
      },
      body: JSON.stringify({
        text: externalText(event),
        metadata: { source: "camel-lead", eventId: event.id },
      }),
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!result.ok)
    throw new Error(
      `OpenCode admission HTTP ${result.status}; message remains unacknowledged`,
    );
}
