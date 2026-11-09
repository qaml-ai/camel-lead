import { env, exports } from "cloudflare:workers";
import { reset, runInDurableObject, evictDurableObject } from "cloudflare:test";
import { afterEach, describe, it, expect } from "vitest";
import type { WorkerEnv } from "../src/types.ts";
import type { ProjectRoom } from "../src/room.ts";
declare module "cloudflare:workers" {
  interface ProvidedEnv extends WorkerEnv {}
}
const ALICE = "alice-test-only",
  BOB = "bob-test-only";
const req = (path: string, token = ALICE, body?: unknown) =>
  exports.default.fetch("https://lead.test/projects/demo/" + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const json = async (path: string, token = ALICE, body?: unknown) =>
  (await req(path, token, body)).json<any>();
const room = () => env.PROJECTS.getByName("demo");
let sent = 0;
/** The lead's send, without its signed MCP envelope (covered in worker.spec.ts). */
async function send(target: string, text: string) {
  const reply = await room().invoke("send", ["demo", target, text, `m${++sent}`]);
  expect(reply.ok).toBe(true);
}
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const settled = async (p: Promise<unknown>, ms = 150) =>
  Promise.race([p.then(() => true), pause(ms).then(() => false)]);
const mcpTool = async (name: string, args: unknown, token = ALICE) => {
  const body = await json("mcp", token, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  });
  return body.result;
};
const open: WebSocket[] = [];
function attach(response: Response) {
  expect(response.status).toBe(101);
  const ws = response.webSocket!;
  const frames: any[] = [],
    wanted: ((frame: any) => void)[] = [];
  let close!: (event: CloseEvent) => void;
  const closed = new Promise<CloseEvent>((resolve) => (close = resolve));
  ws.addEventListener("message", (event) => {
    const frame = event.data === "pong" ? "pong" : JSON.parse(String(event.data));
    const next = wanted.shift();
    next ? next(frame) : frames.push(frame);
  });
  ws.addEventListener("close", close);
  ws.accept();
  open.push(ws);
  return {
    ws,
    closed,
    frames,
    next: () =>
      frames.length
        ? Promise.resolve(frames.shift())
        : new Promise<any>((resolve) => wanted.push(resolve)),
  };
}
const socket = async (token = ALICE, query = "") =>
  attach(
    await exports.default.fetch("https://lead.test/projects/demo/ws" + query, {
      headers: { Upgrade: "websocket", Authorization: `Bearer ${token}` },
    }),
  );
/** Straight to the room, as the Worker would after authenticating. */
const roomFetch = (socket: Record<string, unknown>) =>
  room().fetch("https://room/ws", {
    headers: {
      Upgrade: "websocket",
      "X-Lead-Socket": JSON.stringify({ project: "demo", ...socket }),
    },
  });
const roomSocket = async (socket: Record<string, unknown>) => attach(await roomFetch(socket));
afterEach(async () => {
  for (const ws of open.splice(0))
    try {
      ws.close(1000, "done");
    } catch {}
  await reset();
});

describe("blocking mailbox read", () => {
  it("answers at once when mail exists, and keeps the non-waiting read unchanged", async () => {
    expect(await json("messages")).toEqual({ events: [], next: 0 });
    await send("alice", "ready");
    const started = Date.now();
    const mail = await json("messages?wait=50");
    expect(Date.now() - started).toBeLessThan(2000);
    expect(mail.events.map((e: any) => e.text)).toEqual(["ready"]);
    expect(mail.next).toBe(mail.events[0].seq);
    // Nothing was acknowledged by waiting.
    expect((await json("messages")).events).toHaveLength(1);
  });
  it("holds the request, then answers when a message arrives", async () => {
    const waiting = json("messages?wait=30");
    expect(await settled(waiting)).toBe(false);
    await send("alice", "wake up");
    const mail = await waiting;
    expect(mail.events.map((e: any) => e.text)).toEqual(["wake up"]);
  });
  it("returns a clear empty result when the wait ends", async () => {
    const started = Date.now();
    expect(await json("messages?wait=1")).toEqual({ events: [], next: 0 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  });
  it("filters by the after cursor without acknowledging", async () => {
    await send("alice", "one");
    await send("alice", "two");
    const all = await json("messages");
    const [first, second] = all.events.map((e: any) => e.seq);
    expect(all.next).toBe(second);
    const later = await json(`messages?wait=5&after=${first}`);
    expect(later.events.map((e: any) => e.text)).toEqual(["two"]);
    expect(await json(`messages?wait=1&after=${second}`)).toEqual({
      events: [],
      next: second,
    });
    const waiting = json(`messages?wait=30&after=${second}`);
    expect(await settled(waiting)).toBe(false);
    await send("alice", "three");
    expect((await waiting).events.map((e: any) => e.text)).toEqual(["three"]);
    expect((await json("messages")).events).toHaveLength(3);
    // An acknowledged message stays hidden even from an older cursor.
    await json("ack", ALICE, { seq: second });
    expect(
      (await json("messages?after=0")).events.map((e: any) => e.text),
    ).toEqual(["three"]);
  });
  it("never answers one client's wait with another client's mail", async () => {
    const alice = json("messages?wait=2");
    await pause(50);
    await send("bob", "for bob only");
    expect(await settled(alice, 300)).toBe(false);
    expect(
      (await json("messages?wait=30", BOB)).events.map((e: any) => e.text),
    ).toEqual(["for bob only"]);
    expect(await alice).toEqual({ events: [], next: 0 });
  });
  it("clamps long waits and rejects invalid parameters and credentials", async () => {
    await send("alice", "x");
    expect((await json("messages?wait=9999")).events).toHaveLength(1);
    expect((await req("messages?wait=-1")).status).toBe(400);
    expect((await req("messages?wait=abc")).status).toBe(400);
    expect((await req("messages?after=-3")).status).toBe(400);
    expect((await req("messages?wait=30", "bad")).status).toBe(401);
  });
  it("bounds waiting requests per client and per project", async () => {
    const waits = [];
    for (let i = 0; i < 5; i++) {
      waits.push(json("messages?wait=30"));
      await pause(20);
    }
    // The fifth replaced the oldest, which returns empty; four keep waiting.
    expect(await waits[0]).toEqual({ events: [], next: 0 });
    for (const w of waits.slice(1)) expect(await settled(w, 30)).toBe(false);
    await runInDurableObject(room(), (o: ProjectRoom) => {
      o.limits.projectWaiters = 4;
    });
    expect((await req("messages?wait=30", BOB)).status).toBe(429);
    // A refused wait does not block ordinary reads.
    expect((await req("messages", BOB)).status).toBe(200);
    await send("alice", "release");
    for (const w of waits.slice(1)) expect((await w).events).toHaveLength(1);
    expect(
      await runInDurableObject(room(), (o: ProjectRoom) =>
        [...(o as any).waiters.values()].reduce((n: number, s: Set<unknown>) => n + s.size, 0),
      ),
    ).toBe(0);
  });
  it("answers a wait from the durable mailbox after the room was evicted", async () => {
    await send("alice", "kept");
    await evictDurableObject(room());
    expect((await json("messages?wait=30")).events.map((e: any) => e.text)).toEqual(["kept"]);
  });
});

describe("wait_for_messages tool", () => {
  it("returns mail, or says plainly that nothing arrived yet", async () => {
    const empty = JSON.parse(
      (await mcpTool("wait_for_messages", { timeoutSeconds: 1 })).content[0].text,
    );
    expect(empty).toMatchObject({ status: "no_new_messages", events: [], next: 0 });
    expect(empty.hint).toMatch(/call wait_for_messages again/i);
    const waiting = mcpTool("wait_for_messages", {});
    expect(await settled(waiting)).toBe(false);
    await send("alice", "hello");
    await send("bob", "not yours");
    const got = JSON.parse((await waiting).content[0].text);
    expect(got.status).toBe("messages");
    expect(got.events.map((e: any) => e.text)).toEqual(["hello"]);
    const after = JSON.parse(
      (await mcpTool("wait_for_messages", { timeoutSeconds: 1, after: got.next }))
        .content[0].text,
    );
    expect(after.status).toBe("no_new_messages");
    expect((await mcpTool("wait_for_messages", { timeoutSeconds: 51 })).isError).toBe(true);
  });
});

describe("mailbox WebSocket", () => {
  it("requires the client credential and an upgrade", async () => {
    const upgrade = (token: string) =>
      exports.default.fetch("https://lead.test/projects/demo/ws", {
        headers: { Upgrade: "websocket", Authorization: `Bearer ${token}` },
      });
    expect((await upgrade("bad")).status).toBe(401);
    expect((await req("ws")).status).toBe(426);
  });
  it("delivers pending mail on connect and new mail on arrival, only to its owner, and acknowledges", async () => {
    await send("alice", "pending");
    const alice = await socket(),
      bob = await socket(BOB);
    const first = await alice.next();
    expect(first.type).toBe("messages");
    expect(first.events.map((e: any) => e.text)).toEqual(["pending"]);
    await send("alice", "live");
    const second = await alice.next();
    // Only what this socket has not carried yet.
    expect(second.events.map((e: any) => e.text)).toEqual(["live"]);
    expect(second.next).toBe(second.events[0].seq);
    await pause(100);
    expect(bob.frames).toEqual([]);
    await send("all", "everyone");
    expect((await bob.next()).events.map((e: any) => e.text)).toEqual(["everyone"]);
    const third = await alice.next();
    alice.ws.send(JSON.stringify({ type: "ack", seq: second.next }));
    expect(await alice.next()).toEqual({ type: "ack", ack: second.next });
    expect((await json("messages")).events.map((e: any) => e.text)).toEqual(["everyone"]);
    alice.ws.send(JSON.stringify({ type: "ack", seq: 99_999 }));
    expect((await alice.next()).type).toBe("error");
    alice.ws.send("not json");
    expect((await alice.next()).type).toBe("error");
    // Bob's acknowledgement cannot reach Alice's mailbox.
    bob.ws.send(JSON.stringify({ type: "ack", seq: third.next }));
    expect((await bob.next()).type).toBe("ack");
    expect((await json("messages")).events).toHaveLength(1);
  });
  it("starts after the caller's cursor", async () => {
    await send("alice", "old");
    const { next } = await json("messages");
    const alice = await socket(ALICE, `?after=${next}`);
    await send("alice", "new");
    expect((await alice.next()).events.map((e: any) => e.text)).toEqual(["new"]);
  });
  it("keeps delivering after the room hibernates, and answers pings without it", async () => {
    const alice = await socket();
    await send("alice", "before");
    const before = await alice.next();
    await evictDurableObject(room());
    alice.ws.send("ping");
    expect(await alice.next()).toBe("pong");
    await send("alice", "after");
    const after = await alice.next();
    // The cursor survived with the socket: no repeat of what it already carried.
    expect(after.events.map((e: any) => e.text)).toEqual(["after"]);
    alice.ws.send(JSON.stringify({ type: "ack", seq: after.next }));
    expect(await alice.next()).toEqual({ type: "ack", ack: after.next });
    expect(before.next).toBeLessThan(after.next);
  });
  it("bounds sockets per client and per project", async () => {
    const sockets = [];
    for (let i = 0; i < 5; i++) {
      sockets.push(await socket());
      await pause(5);
    }
    expect((await sockets[0].closed).code).toBe(4008);
    await send("alice", "fan out");
    for (const s of sockets.slice(1))
      expect((await s.next()).events.map((e: any) => e.text)).toEqual(["fan out"]);
    await runInDurableObject(room(), (o: ProjectRoom) => {
      o.limits.projectSockets = 4;
    });
    const refused = await exports.default.fetch("https://lead.test/projects/demo/ws", {
      headers: { Upgrade: "websocket", Authorization: `Bearer ${BOB}` },
    });
    expect(refused.status).toBe(429);
  });
  it("closes instead of delivering when the credential changed or cannot be rechecked", async () => {
    // A bearer socket whose credential no longer matches the registry.
    const rotated = await roomSocket({ client: "alice", auth: "bearer", key: "0".repeat(64) });
    // OAuth is revalidated with GitHub per request; an old socket only signals.
    const oauth = await roomSocket({ client: "bob", auth: "oauth" });
    await runInDurableObject(room(), (_o: ProjectRoom, state) => {
      for (const ws of state.getWebSockets("bob"))
        ws.serializeAttachment({ ...ws.deserializeAttachment(), opened: 0 });
    });
    await send("all", "secret");
    expect((await rotated.closed).code).toBe(4401);
    expect(rotated.frames).toEqual([]);
    expect(await oauth.next()).toEqual({ type: "reauthenticate" });
    expect((await oauth.closed).code).toBe(4401);
    // Nothing was lost: an authenticated read still has it.
    expect((await json("messages", BOB)).events.map((e: any) => e.text)).toEqual(["secret"]);
    expect((await roomFetch({ client: "mallory" })).status).toBe(403);
  });
});
