import { env, exports } from "cloudflare:workers";
import {
  reset,
  runDurableObjectAlarm,
  runInDurableObject,
  evictDurableObject,
} from "cloudflare:test";
import { afterEach, describe, it, expect, vi } from "vitest";
import type { WorkerEnv } from "../src/types.ts";
import type { ProjectRoom } from "../src/room.ts";
declare module "cloudflare:workers" {
  interface ProvidedEnv extends WorkerEnv {}
}
const req = (path: string, token = "alice-test-only", body?: unknown) =>
  exports.default.fetch("https://lead.test" + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const room = () => env.PROJECTS.getByName("demo");
afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});
describe("project delivery", () => {
  it("rejects unauthenticated requests and separates lead permissions", async () => {
    expect((await req("/projects/demo/messages", "bad")).status).toBe(401);
    expect(
      (
        await req("/agent/demo/send", "alice-test-only", {
          target: "bob",
          text: "x",
          messageId: "x",
        })
      ).status,
    ).toBe(401);
    expect(
      (await req("/projects/demo/messages", "lead-test-only")).status,
    ).toBe(401);
  });
  it("admits concurrent clients with different source identities and retries idempotently", async () => {
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
  it("routes proactive messages privately, broadcasts once and retains mailboxes across eviction", async () => {
    await req("/agent/demo/send", "lead-test-only", {
      target: "bob",
      text: "Please review",
      messageId: "m1",
    });
    expect(
      (await (await req("/projects/demo/messages")).json<any>()).events,
    ).toHaveLength(0);
    await req("/agent/demo/send", "lead-test-only", {
      target: "all",
      text: "Standup",
      messageId: "m2",
    });
    await req("/agent/demo/send", "lead-test-only", {
      target: "all",
      text: "Standup",
      messageId: "m2",
    });
    expect(
      (
        await req("/agent/demo/send", "lead-test-only", {
          target: "all",
          text: "Changed",
          messageId: "m2",
        })
      ).status,
    ).toBe(409);
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
  it("runs the camelRun outbox with trusted sender attribution and routes each reply to its caller", async () => {
    const bodies: any[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any) => {
      const request = input as Request;
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
    // One final alarm does no work and leaves no endless idle poll loop.
    await runDurableObjectAlarm(room());
    expect(await runDurableObjectAlarm(room())).toBe(false);
  });
  it("retries an ambiguous upstream send using the exact same request id", async () => {
    const ids: string[] = [];
    let first = true;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any) => {
      const body: any = await (input as Request).json();
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
  it("serves real MCP initialization and scoped tools without exposing another mailbox", async () => {
    const rpc = async (id: number, method: string, params: any) =>
      req("/projects/demo/mcp", "alice-test-only", {
        jsonrpc: "2.0",
        id,
        method,
        params,
      });
    // MCP requires both accepted response media types.
    const request = new Request("https://lead.test/projects/demo/mcp", {
      method: "POST",
      headers: {
        Authorization: "Bearer alice-test-only",
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "test", version: "1" },
        },
      }),
    });
    const initialized: any = await (
      await exports.default.fetch(request)
    ).json();
    expect(initialized.result.serverInfo.name).toBe("camel-lead");
    const toolRequest = new Request("https://lead.test/projects/demo/mcp", {
      method: "POST",
      headers: {
        Authorization: "Bearer alice-test-only",
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      }),
    });
    const tools: any = await (await exports.default.fetch(toolRequest)).json();
    expect(tools.result.tools.map((t: any) => t.name)).toEqual([
      "message",
      "get_messages",
      "acknowledge",
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
        await req("/agent/demo/send", "lead-test-only", {
          target: "stranger",
          text: "hello",
          messageId: "x",
        })
      ).status,
    ).toBe(404);
  });
});
