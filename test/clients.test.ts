import { test } from "node:test";
import assert from "node:assert/strict";
import { LeadClient, deliverPending } from "../clients/api.ts";
import { deliverCodex, deliverOpenCode } from "../clients/bridges.ts";
import { leadDefinition, memoryConfig } from "../scripts/plan.ts";
const event = {
  seq: 7,
  id: "event-7",
  text: "Check the release",
  kind: "message",
  requestId: null,
};
test("failed client delivery never acknowledges the mailbox", async () => {
  const paths: string[] = [];
  const c = new LeadClient(
    "https://lead.test",
    "demo",
    "test-only",
    async (input) => {
      paths.push(String(input));
      return Response.json({ events: [event] });
    },
  );
  await assert.rejects(
    deliverPending(c, async () => {
      throw new Error("offline");
    }),
    /offline/,
  );
  assert.equal(paths.length, 1);
});
test("successful client delivery acknowledges only after admission", async () => {
  const order: string[] = [];
  const c = new LeadClient(
    "https://lead.test",
    "demo",
    "test-only",
    async (input, init) => {
      order.push(String(input).endsWith("/ack") ? "ack" : "read");
      if (String(input).endsWith("/ack"))
        assert.deepEqual(JSON.parse(String(init?.body)), { seq: 7 });
      return Response.json({ events: [event] });
    },
  );
  await deliverPending(c, async () => {
    order.push("delivered");
  });
  assert.deepEqual(order, ["read", "delivered", "ack"]);
});
test("Codex bridge starts a turn and waits for completion before delivery succeeds", async () => {
  const calls: any[] = [];
  await deliverCodex(
    {
      call: async (m, p) => {
        calls.push([m, p]);
        return { turn: { id: "turn-1" } };
      },
      waitTurn: async (id) => {
        assert.equal(id, "turn-1");
        return { status: "completed" };
      },
    },
    "thread-1",
    event,
  );
  assert.equal(calls[0][0], "turn/start");
  assert.equal(calls[0][1].threadId, "thread-1");
  assert.match(calls[0][1].input[0].text, /not permission/);
});
test("Codex failure preserves the delivery for retry", async () => {
  await assert.rejects(
    deliverCodex(
      {
        call: async () => ({ turn: { id: "t" } }),
        waitTurn: async () => ({ status: "failed" }),
      },
      "thread",
      event,
    ),
    /unacknowledged/,
  );
});
test("OpenCode bridge uses the inspected API, carries source identity and refuses failed admissions", async () => {
  await deliverOpenCode(
    "http://127.0.0.1:4096",
    "session",
    event,
    async (input, init) => {
      assert.equal(
        String(input),
        "http://127.0.0.1:4096/api/session/session/prompt",
      );
      assert.equal(JSON.parse(String(init?.body)).metadata.eventId, "event-7");
      return new Response(null, { status: 202 });
    },
  );
  await assert.rejects(
    deliverOpenCode(
      "https://opencode.test",
      "s",
      event,
      async () => new Response(null, { status: 401 }),
    ),
    /unacknowledged/,
  );
});
test("memory and delivery provisioning use the current camelRun APIs", () => {
  assert.throws(() => memoryConfig("v", 0), /explicit/);
  assert.deepEqual(memoryConfig("v", 1).acrossUsers, true);
  const d = leadDefinition("demo", "https://lead.test", "synthetic-only");
  assert.equal(d.openApi[0].auth.token, "synthetic-only");
  assert.equal(
    d.openApi[0].spec.paths["/agent/demo/send"]?.post.operationId,
    "send_message",
  );
  assert.match(d.systemPrompt, /shared/);
  assert.throws(
    () => leadDefinition("../bad", "https://lead.test", "x"),
    /Invalid project/,
  );
});

test(
  "Claude stdio adapter emits the native notification and acknowledges after transport delivery",
  { timeout: 15000 },
  async (t) => {
    const { createServer } = await import("node:http");
    const { Client } =
      await import("@modelcontextprotocol/sdk/client/index.js");
    const { StdioClientTransport } =
      await import("@modelcontextprotocol/sdk/client/stdio.js");
    const { z } = await import("zod");
    let acknowledged = false;
    const http = createServer(async (req, res) => {
      assert.equal(req.headers.authorization, "Bearer synthetic-only");
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/projects/demo/messages") {
        res.end(JSON.stringify({ events: acknowledged ? [] : [event] }));
        return;
      }
      if (req.url === "/projects/demo/ack") {
        let body = "";
        for await (const c of req) body += c;
        assert.equal(JSON.parse(body).seq, event.seq);
        acknowledged = true;
        res.end("{}");
        return;
      }
      res.writeHead(404);
      res.end("{}");
    });
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    t.after(() => {
      http.closeAllConnections();
      http.close();
    });
    const { port } = http.address() as { port: number };
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        "--experimental-strip-types",
        new URL("../clients/stdio.ts", import.meta.url).pathname,
        "demo",
        "claude",
      ],
      env: {
        PATH: process.env.PATH || "",
        CAMEL_LEAD_URL: `http://127.0.0.1:${port}`,
        CAMEL_LEAD_TOKEN: "synthetic-only",
      },
      stderr: "pipe",
    });
    const client = new Client({ name: "test-client", version: "1" });
    t.after(async () => {
      await client.close();
      await transport.close();
    });
    let done!: (value: any) => void;
    const received = new Promise<any>((resolve) => {
      done = resolve;
    });
    client.setNotificationHandler(
      z.object({
        method: z.literal("notifications/claude/channel"),
        params: z.object({
          content: z.string(),
          meta: z.record(z.string(), z.string()),
        }),
      }),
      (n) => {
        done(n.params);
      },
    );
    await client.connect(transport);
    assert.deepEqual(client.getServerCapabilities()?.experimental, {
      "claude/channel": {},
    });
    assert.equal((await received).content, event.text);
    for (let i = 0; i < 100 && !acknowledged; i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(acknowledged, true);
  },
);

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
      calls.push({ path: req.url!, body: JSON.parse(text) });
      const id =
        req.url === "/v1/definitions"
          ? "def_test"
          : req.url === "/v1/volumes"
            ? "vol_test"
            : "client_" + "a".repeat(40);
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ id }));
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
        "/v1/definitions",
        "/v1/volumes",
        "/v1/agents",
        "/v1/agents/" + "client_" + "a".repeat(40) + "/dreaming",
      ],
    );
    assert.deepEqual(calls[2].body.mounts, [
      { volumeId: "vol_test", path: "/memory", mode: "ro" },
    ]);
    assert.equal(calls[3].body.acrossUsers, true);
    const config = JSON.parse(
      await readFile(join(dir, ".secrets/demo/projects.json"), "utf8"),
    );
    assert.deepEqual(Object.keys(config.demo.clients), ["alice", "bob"]);
    const raw = await readFile(join(dir, ".secrets/demo/alice.token"), "utf8");
    assert.equal(output.includes(raw), false);
    assert.equal(
      (await stat(join(dir, ".secrets/demo/alice.token"))).mode & 0o777,
      0o600,
    );
  },
);
