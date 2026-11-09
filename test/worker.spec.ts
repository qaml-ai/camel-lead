import { env, exports } from "cloudflare:workers";
import {
  reset,
  runDurableObjectAlarm,
  runInDurableObject,
  evictDurableObject,
} from "cloudflare:test";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { testRuntime } from "@camelai/run/testing";
import type { WorkerEnv } from "../src/types.ts";
import type { ProjectRoom } from "../src/room.ts";
declare module "cloudflare:workers" {
  interface ProvidedEnv extends WorkerEnv {}
}
const AGENT = "client_" + "a".repeat(40),
  AUDIENCE = "https://lead.test/agent/demo/mcp";
let rt: Awaited<ReturnType<typeof testRuntime>>, leadToken: string;
const identity = { tenant: "test", agent: AGENT, context: { project: "demo" } };
const req = (path: string, token = "alice-test-only", body?: unknown) =>
  exports.default.fetch("https://lead.test" + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const room = () => env.PROJECTS.getByName("demo");
const signed = (name: string, args: unknown, token = leadToken) =>
  req("/agent/demo/mcp", token, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  });
async function tool(name: string, args: unknown) {
  const response = await signed(name, args);
  expect(response.status).toBe(200);
  return (await response.json<any>()).result;
}
function runtimeFetch(handler: (request: Request) => Promise<Response>) {
  vi.mocked(globalThis.fetch).mockImplementation(
    async (input: any, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === rt.url + "/.well-known/jwks.json")
        return Response.json({ keys: [rt.jwk] });
      return handler(
        input instanceof Request ? input : new Request(input, init),
      );
    },
  );
}
beforeEach(async () => {
  rt = await testRuntime({ url: env.CAMELRUN_URL });
  leadToken = await rt.token(identity, AUDIENCE);
  vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
    Response.json({ keys: [rt.jwk] }),
  );
});
afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});
describe("project delivery", () => {
  it("rejects unauthenticated clients, static lead bearers and legacy OpenAPI routes", async () => {
    expect((await req("/projects/demo/messages", "bad")).status).toBe(401);
    expect((await signed("participants", {}, "alice-test-only")).status).toBe(
      401,
    );
    expect((await signed("participants", {}, "lead-test-only")).status).toBe(
      401,
    );
    expect(
      (
        await req("/agent/demo/send", "lead-test-only", {
          target: "bob",
          text: "x",
          messageId: "x",
        })
      ).status,
    ).toBe(404);
    expect((await req("/projects/demo/messages", leadToken)).status).toBe(401);
  });
  it("admits concurrent clients with trusted identities and retries idempotently", async () => {
    const [a, b] = await Promise.all([
      req("/projects/demo/messages", "alice-test-only", {
        text: "alpha",
        requestId: "same",
      }),
      req("/projects/demo/messages", "bob-test-only", {
        text: "beta",
        requestId: "same",
      }),
    ]);
    const one: any = await a.json(),
      two: any = await b.json();
    expect(a.status).toBe(202);
    expect(b.status).toBe(202);
    expect(one.requestId).not.toBe(two.requestId);
    expect(
      await (
        await req("/projects/demo/messages", "alice-test-only", {
          text: "alpha",
          requestId: "same",
        })
      ).json(),
    ).toEqual(one);
    expect(
      (
        await req("/projects/demo/messages", "alice-test-only", {
          text: "changed",
          requestId: "same",
        })
      ).status,
    ).toBe(409);
    const rows = await runInDurableObject(room(), (_o: ProjectRoom, s) =>
      s.storage.sql
        .exec("SELECT client,text FROM jobs ORDER BY client")
        .toArray(),
    );
    expect(rows).toEqual([
      { client: "alice", text: "alpha" },
      { client: "bob", text: "beta" },
    ]);
  });
  it("routes signed MCP messages privately, broadcasts once and retains mailboxes across eviction", async () => {
    expect(
      (
        await tool("send_message", {
          target: "bob",
          text: "Please review",
          messageId: "m1",
          project: "other",
        })
      ).isError,
    ).toBeUndefined();
    expect(
      (await (await req("/projects/demo/messages")).json<any>()).events,
    ).toHaveLength(0);
    await tool("send_message", {
      target: "all",
      text: "Standup",
      messageId: "m2",
    });
    await tool("send_message", {
      target: "all",
      text: "Standup",
      messageId: "m2",
    });
    expect(
      (
        await tool("send_message", {
          target: "all",
          text: "Changed",
          messageId: "m2",
        })
      ).isError,
    ).toBe(true);
    await evictDurableObject(room());
    const bob: any = await (
      await req("/projects/demo/messages", "bob-test-only")
    ).json();
    expect(bob.events.map((m: any) => m.text)).toEqual([
      "Please review",
      "Standup",
    ]);
    expect(
      (
        await (
          await req("/projects/other/messages", "bob-test-only")
        ).json<any>()
      ).events,
    ).toHaveLength(0);
    expect(
      (await req("/projects/demo/ack", "bob-test-only", { seq: 999 })).status,
    ).toBe(400);
    await req("/projects/demo/ack", "bob-test-only", {
      seq: bob.events.at(-1).seq,
    });
    expect(
      (
        await (
          await req("/projects/demo/messages", "bob-test-only")
        ).json<any>()
      ).events,
    ).toHaveLength(0);
  });
  it("runs the outbox with trusted sender attribution and routes each reply to its caller", async () => {
    const bodies: any[] = [];
    runtimeFetch(async (request) => {
      expect(request.headers.get("authorization")).toBe(
        "Bearer runtime-test-only",
      );
      if (request.method === "POST") {
        const body: any = await request.json();
        bodies.push(body);
        return Response.json({ id: body.requestId, state: "pending" });
      }
      return Response.json({
        state: "completed",
        outcome: {
          result: { reply: "Done for " + request.url.split("/").at(-1) },
        },
      });
    });
    await req("/projects/demo/messages", "alice-test-only", {
      text: "hello",
      requestId: "a",
    });
    await req("/projects/demo/messages", "bob-test-only", {
      text: "hi",
      requestId: "b",
    });
    expect(await runDurableObjectAlarm(room())).toBe(true);
    expect(bodies.map((b) => b.from.id).sort()).toEqual(["alice", "bob"]);
    expect(bodies.every((b) => b.metadata.project === "demo")).toBe(true);
    await runDurableObjectAlarm(room());
    const a: any = await (await req("/projects/demo/messages")).json(),
      b: any = await (
        await req("/projects/demo/messages", "bob-test-only")
      ).json();
    expect(a.events).toHaveLength(1);
    expect(b.events).toHaveLength(1);
    expect(a.events[0].requestId).not.toBe(b.events[0].requestId);
    await runDurableObjectAlarm(room());
    expect(await runDurableObjectAlarm(room())).toBe(false);
  });
  it("retries an ambiguous upstream send using exactly the same request id", async () => {
    const ids: string[] = [];
    let first = true;
    runtimeFetch(async (request) => {
      const body: any = await request.json();
      ids.push(body.requestId);
      if (first) {
        first = false;
        throw new Error("connection lost after admission");
      }
      return Response.json({ state: "pending" });
    });
    await req("/projects/demo/messages", "alice-test-only", {
      text: "hello",
      requestId: "retry",
    });
    await runDurableObjectAlarm(room());
    await runDurableObjectAlarm(room());
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
  });
  it("serves client and agent MCP tool discovery with separate authorization", async () => {
    const client: any = await (
      await req("/projects/demo/mcp", "alice-test-only", {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      })
    ).json();
    expect(client.result.tools.map((t: any) => t.name)).toEqual([
      "message",
      "get_messages",
      "wait_token",
      "acknowledge",
      "participants",
    ]);
    const agent: any = await (
      await req("/agent/demo/mcp", leadToken, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      })
    ).json();
    expect(agent.result.tools.map((t: any) => t.name)).toEqual([
      "send_message",
      "participants",
    ]);
  });
  it("rejects oversized bodies and unknown recipients", async () => {
    expect(
      (
        await req("/projects/demo/messages", "alice-test-only", {
          text: "x".repeat(65_000),
          requestId: "x",
        })
      ).status,
    ).toBe(413);
    expect(
      (
        await tool("send_message", {
          target: "stranger",
          text: "hello",
          messageId: "x",
        })
      ).isError,
    ).toBe(true);
  });
});
for (const [name, who, audience, overrides] of [
  ["other tenant", { ...identity, tenant: "other" }, AUDIENCE, {}],
  [
    "other agent",
    { ...identity, agent: "client_" + "b".repeat(40) },
    AUDIENCE,
    {},
  ],
  [
    "other project",
    { ...identity, context: { project: "other" } },
    AUDIENCE,
    {},
  ],
  ["other audience", identity, "https://elsewhere.test/mcp", {}],
  ["expired token", identity, AUDIENCE, { expiresIn: -90 }],
  [
    "other issuer",
    identity,
    AUDIENCE,
    { claims: { iss: "https://evil.test" } },
  ],
  [
    "future issued token",
    identity,
    AUDIENCE,
    { claims: { iat: Math.floor(Date.now() / 1000) + 3600 } },
  ],
] as const)
  it(`rejects ${name} despite a valid runtime signature`, async () => {
    const token = await rt.token(who, audience, overrides);
    expect((await signed("participants", {}, token)).status).toBe(401);
  });
it("rejects tokens signed by an unrelated private key", async () => {
  const rogue = await testRuntime({ url: env.CAMELRUN_URL });
  const token = await rogue.token(identity, AUDIENCE);
  expect((await signed("participants", {}, token)).status).toBe(401);
});
