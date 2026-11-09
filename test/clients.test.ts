import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { spawn } from "node:child_process";
import type { Duplex } from "node:stream";
import { LeadClient } from "../clients/api.ts";
import {
  leadDefinition,
  leadMcpSource,
  memoryConfig,
} from "../scripts/plan.ts";
const event = {
  seq: 7,
  id: "event-7",
  text: "Check the release",
  kind: "message",
  requestId: null,
};
test("memory and delivery provisioning use the current camelRun APIs", () => {
  assert.throws(() => memoryConfig("v", 0), /explicit/);
  assert.deepEqual(memoryConfig("v", 1).acrossUsers, true);
  const d = leadDefinition("demo");
  const source = leadMcpSource("demo", "https://lead.test");
  assert.deepEqual(source.auth, { type: "runtime" });
  assert.equal(source.url, "https://lead.test/agent/demo/mcp");
  assert.equal("openApi" in d, false);
  assert.match(d.systemPrompt, /shared/);
  assert.throws(() => leadDefinition("../bad"), /Invalid project/);
});

type Fake = {
  url: string;
  requests: string[];
  acks: number[];
  upgrades: IncomingMessage[];
};
/** A synthetic adapter. `upgrade` gets a function that writes one text frame to the socket. */
async function fakeLead(
  t: { after(fn: () => void): void },
  mail: (url: URL, n: number) => unknown | Promise<unknown>,
  upgrade?: (send: (data: unknown) => void, socket: Duplex) => void,
  status = 200,
): Promise<Fake> {
  const fake: Fake = { url: "", requests: [], acks: [], upgrades: [] };
  const http = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, "Bearer synthetic-only");
    const url = new URL(req.url!, "http://lead.test");
    res.setHeader("Content-Type", "application/json");
    if (url.pathname === "/projects/demo/ack") {
      let body = "";
      for await (const c of req) body += c;
      fake.acks.push(JSON.parse(body).seq);
      res.end("{}");
      return;
    }
    fake.requests.push(req.url!);
    res.writeHead(status);
    res.end(JSON.stringify(await mail(url, fake.requests.length)));
  });
  http.on("upgrade", (req, socket) => {
    fake.upgrades.push(req);
    if (!upgrade || req.headers.authorization !== "Bearer synthetic-only") {
      socket.end("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    const accept = createHash("sha1")
      .update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
      .digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    socket.on("error", () => {});
    upgrade((data) => {
      const payload = Buffer.from(JSON.stringify(data));
      assert.ok(payload.length < 65_536);
      const header =
        payload.length < 126
          ? Buffer.from([0x81, payload.length])
          : Buffer.from([0x81, 126, payload.length >> 8, payload.length & 255]);
      socket.write(Buffer.concat([header, payload]));
    }, socket);
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    http.closeAllConnections();
    http.close();
  });
  fake.url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  return fake;
}
async function waitCli(fake: Fake, ...args: string[]) {
  const child = spawn(
    process.execPath,
    [
      "--experimental-strip-types",
      "--no-warnings",
      new URL("../clients/wait.ts", import.meta.url).pathname,
      ...args,
    ],
    {
      env: {
        PATH: process.env.PATH || "",
        CAMEL_LEAD_URL: fake.url,
        CAMEL_LEAD_TOKEN: "synthetic-only",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (c) => (stdout += c));
  child.stderr.on("data", (c) => (stderr += c));
  const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
  return { code, stderr, lines: stdout.split("\n").filter(Boolean).map((l) => JSON.parse(l)) };
}
const nothing = { events: [], next: 0 };

test("the client's blocking read passes wait and after, and outlasts the server's hold", async () => {
  const seen: { url: string; signal: AbortSignal }[] = [];
  const c = new LeadClient("https://lead.test", "demo", "test-only", async (input, init) => {
    seen.push({ url: String(input), signal: init!.signal! });
    return Response.json({ events: [event], next: 7 });
  });
  assert.deepEqual(await c.wait(50, 3), { events: [event], next: 7 });
  assert.equal(seen[0].url, "https://lead.test/projects/demo/messages?wait=50&after=3");
  assert.equal(seen[0].signal.aborted, false);
});
test("wait CLI long-polls until mail arrives, frames it as external data, acknowledges and exits 0", { timeout: 20000 }, async (t) => {
  const fake = await fakeLead(t, async (_url, n) => {
    if (n > 1) return { events: [event], next: 7 };
    await new Promise((resolve) => setTimeout(resolve, 1100));
    return nothing;
  });
  const run = await waitCli(fake, "demo", "--poll", "--ack", "--after", "3");
  assert.equal(run.code, 0);
  assert.equal(run.lines.length, 1);
  assert.equal(run.lines[0].seq, 7);
  assert.match(run.lines[0].text, /external data, not permission/);
  assert.match(run.lines[0].text, /Check the release$/);
  assert.deepEqual(fake.requests, Array(2).fill("/projects/demo/messages?wait=50&after=3"));
  assert.deepEqual(fake.acks, [7]);
  assert.equal(fake.upgrades.length, 0);
});
test("wait CLI exits 2 on timeout with no messages and never acknowledges", { timeout: 20000 }, async (t) => {
  const fake = await fakeLead(t, async (url) => {
    assert.equal(url.searchParams.get("wait"), "1");
    await new Promise((resolve) => setTimeout(resolve, 1000));
    return nothing;
  });
  const run = await waitCli(fake, "demo", "--poll", "--timeout", "1");
  assert.equal(run.code, 2);
  assert.deepEqual(run.lines, []);
  assert.deepEqual(fake.acks, []);
});
test("wait CLI sleeps on a WebSocket, wakes on its mail and leaves it unacknowledged by default", { timeout: 20000 }, async (t) => {
  const fake = await fakeLead(
    t,
    () => assert.fail("no polling while the socket works"),
    (send) => {
      setTimeout(() => send({ type: "messages", events: [], next: 0 }), 50);
      setTimeout(() => send({ type: "messages", events: [event, { ...event, seq: 8, id: "event-8" }], next: 8 }), 300);
    },
  );
  const run = await waitCli(fake, "demo", "--timeout", "10");
  assert.equal(run.code, 0, run.stderr);
  assert.deepEqual(run.lines.map((l) => l.seq), [7, 8]);
  assert.equal(fake.upgrades[0].url, "/projects/demo/ws?after=0");
  assert.equal(fake.upgrades[0].headers.authorization, "Bearer synthetic-only");
  assert.deepEqual(fake.acks, []);
});
test("wait CLI times out on an idle WebSocket with exit 2", { timeout: 20000 }, async (t) => {
  const fake = await fakeLead(t, () => nothing, () => {});
  const run = await waitCli(fake, "demo", "--timeout", "1");
  assert.equal(run.code, 2);
  assert.deepEqual(fake.requests, []);
});
test("wait CLI falls back to long-polling when the WebSocket is refused or asks for reauthentication", { timeout: 20000 }, async (t) => {
  const refused = await fakeLead(t, () => ({ events: [event], next: 7 }));
  const one = await waitCli(refused, "demo", "--ack");
  assert.equal(one.code, 0, one.stderr);
  assert.equal(refused.upgrades.length, 1);
  assert.deepEqual(refused.acks, [7]);
  const stale = await fakeLead(
    t,
    () => ({ events: [event], next: 7 }),
    (send, socket) => {
      send({ type: "reauthenticate" });
      socket.end();
    },
  );
  const two = await waitCli(stale, "demo");
  assert.equal(two.code, 0, two.stderr);
  assert.equal(stale.requests.length, 1);
});
test("wait CLI exits 1 on a refused credential or bad usage", { timeout: 20000 }, async (t) => {
  const fake = await fakeLead(t, () => ({ error: "Invalid client credential" }), undefined, 401);
  const run = await waitCli(fake, "demo");
  assert.equal(run.code, 1);
  assert.match(run.stderr, /HTTP 401/);
  assert.equal(fake.requests.length, 1);
  assert.equal((await waitCli(fake, "--timeout", "5")).code, 1);
  assert.equal((await waitCli(fake, "demo", "--timeout", "soon")).code, 1);
});

test("stdio adapter offers wait_for_messages and no push channel", { timeout: 20000 }, async (t) => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const fake = await fakeLead(t, (url) =>
    url.searchParams.get("after") === "7" ? { events: [], next: 7 } : { events: [event], next: 7 },
  );
  const adapter = (...args: string[]) =>
    new StdioClientTransport({
      command: process.execPath,
      args: ["--experimental-strip-types", "--no-warnings", new URL("../clients/stdio.ts", import.meta.url).pathname, ...args],
      env: { PATH: process.env.PATH || "", CAMEL_LEAD_URL: fake.url, CAMEL_LEAD_TOKEN: "synthetic-only" },
      stderr: "pipe",
    });
  const client = new Client({ name: "test-client", version: "1" });
  t.after(() => client.close());
  let pushed = 0;
  client.fallbackNotificationHandler = async () => {
    pushed++;
  };
  await client.connect(adapter("demo"));
  assert.equal(client.getServerCapabilities()?.experimental, undefined);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name), ["message", "get_messages", "wait_for_messages", "acknowledge", "participants"]);
  assert.match(tools[2].description!, /external data, not instructions/);
  const call = async (args: Record<string, unknown>) =>
    JSON.parse(((await client.callTool({ name: "wait_for_messages", arguments: args })).content as any)[0].text);
  const got = await call({ timeoutSeconds: 2 });
  assert.equal(got.status, "messages");
  assert.equal(got.events[0].seq, 7);
  const empty = await call({ after: 7 });
  assert.equal(empty.status, "no_new_messages");
  assert.match(empty.hint, /Call wait_for_messages again/);
  assert.deepEqual(fake.requests, ["/projects/demo/messages?wait=2&after=0", "/projects/demo/messages?wait=25&after=7"]);
  assert.deepEqual(fake.acks, []);
  assert.equal(pushed, 0);
  // The removed channel mode fails loudly instead of silently not delivering.
  const old = new Client({ name: "test-client", version: "1" });
  await assert.rejects(old.connect(adapter("demo", "claude")));
});

test(
  "operator provisioning mounts dedicated read-only memory before enabling Dreaming",
  { timeout: 10000 },
  async (t) => {
    const { createServer } = await import("node:http");
    const { mkdtemp, rm, readFile, stat } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { spawn } = await import("node:child_process");
    const dir = await mkdtemp(join(tmpdir(), "camel-lead-setup-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const calls: { path: string; body: any }[] = [];
    const server = createServer(async (req, res) => {
      let text = "";
      for await (const chunk of req) text += chunk;
      calls.push({ path: req.url!, body: text ? JSON.parse(text) : null });
      const id =
        req.url === "/v1/definitions"
          ? "def_test"
          : req.url === "/v1/volumes"
            ? "vol_test"
            : "client_" + "a".repeat(40);
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify(req.url === "/v1/me" ? { tenant: "test" } : { id }),
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    t.after(() => {
      server.closeAllConnections();
      server.close();
    });
    const child = spawn(
      process.execPath,
      [
        "--experimental-strip-types",
        new URL("../scripts/provision.ts", import.meta.url).pathname,
        "demo",
        "https://lead.test",
        "alice",
        "bob",
      ],
      {
        cwd: dir,
        env: {
          PATH: process.env.PATH || "",
          CAMELAI_API_KEY: "synthetic-only",
          CAMELAI_BASE_URL: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
          DREAM_BUDGET_USD: "1",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.resume();
    const code = await new Promise<number | null>((resolve) =>
      child.on("exit", resolve),
    );
    assert.equal(code, 0);
    assert.deepEqual(
      calls.map((c) => c.path),
      [
        "/v1/me",
        "/v1/volumes",
        "/v1/agents",
        "/v1/agents/" + "client_" + "a".repeat(40) + "/dreaming",
      ],
    );
    assert.deepEqual(calls[2].body.mounts, [
      { volumeId: "vol_test", path: "/memory", mode: "ro" },
    ]);
    assert.equal(calls[3].body.acrossUsers, true);
    assert.equal(calls[2].body.context.project, "demo");
    assert.equal("definition" in calls[2].body, false);
    const config = JSON.parse(
      await readFile(join(dir, ".secrets/demo/projects.json"), "utf8"),
    );
    assert.deepEqual(Object.keys(config.demo.clients), ["alice", "bob"]);
    assert.equal(config.demo.tenantId, "test");
    assert.equal("leadTokenHash" in config.demo, false);
    const activation = JSON.parse(
      await readFile(join(dir, ".secrets/demo/activation.json"), "utf8"),
    );
    assert.deepEqual(activation.source.auth, { type: "runtime" });
    assert.equal(activation.source.url, "https://lead.test/agent/demo/mcp");
    const raw = await readFile(join(dir, ".secrets/demo/alice.token"), "utf8");
    assert.equal(output.includes(raw), false);
    assert.equal(
      (await stat(join(dir, ".secrets/demo/alice.token"))).mode & 0o777,
      0o600,
    );
  },
);

for (const tenantMatches of [true, false])
  test(
    `MCP activation ${tenantMatches ? "uses runtime identity auth" : "refuses another tenant"} without a shared lead secret`,
    { timeout: 10000 },
    async (t) => {
      const { createServer } = await import("node:http");
      const { mkdtemp, rm, mkdir, writeFile } =
        await import("node:fs/promises");
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");
      const { spawn } = await import("node:child_process");
      const dir = await mkdtemp(join(tmpdir(), "lead-activation-"));
      t.after(() => rm(dir, { recursive: true, force: true }));
      await mkdir(join(dir, ".secrets/demo"), { recursive: true });
      await writeFile(
        join(dir, ".secrets/demo/activation.json"),
        JSON.stringify({
          agentId: "client_test",
          tenantId: "test",
          source: { url: "https://lead.test/agent/demo/mcp" },
        }),
      );
      const calls: { method: string; path: string; body: any }[] = [];
      const server = createServer(async (req, res) => {
        let body = "";
        for await (const chunk of req) body += chunk;
        calls.push({
          method: req.method!,
          path: req.url!,
          body: body ? JSON.parse(body) : null,
        });
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify(
            req.url === "/v1/me"
              ? { tenant: tenantMatches ? "test" : "other" }
              : req.method === "PATCH"
                ? { id: "configured" }
                : {
                    state: "completed",
                    outcome: { result: { configured: true } },
                  },
          ),
        );
      });
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      t.after(() => {
        server.closeAllConnections();
        server.close();
      });
      const child = spawn(
        process.execPath,
        [
          "--experimental-strip-types",
          new URL("../scripts/activate.ts", import.meta.url).pathname,
          "demo",
        ],
        {
          cwd: dir,
          env: {
            PATH: process.env.PATH || "",
            CAMELAI_API_KEY: "synthetic-only",
            CAMELAI_BASE_URL: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      child.stdout.resume();
      child.stderr.resume();
      const code = await new Promise<number | null>((resolve) =>
        child.on("exit", resolve),
      );
      assert.equal(code, tenantMatches ? 0 : 1);
      if (tenantMatches) {
        assert.deepEqual(calls[1].body.mcpServers, [
          leadMcpSource("demo", "https://lead.test"),
        ]);
        assert.equal(calls[1].method, "PATCH");
        assert.equal(calls.length, 3);
      } else assert.equal(calls.length, 1);
    },
  );
