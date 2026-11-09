import { DurableObject } from "cloudflare:workers";
import {
  config,
  Failure,
  hash,
  type ClientConfig,
  type Job,
  type Message,
  type WorkerEnv,
} from "./types.ts";
import { automaticEnrollmentLimit, automaticMailboxId, explicitMailbox } from "./enrollment.ts";
type OAuthMailbox = { id: string; userId: string; oauthClientId: string; suspended: number };
type Waiter = { after: number; release: () => void };
/** Survives hibernation with the socket. `sent` is the highest sequence already written to it. */
type Socket = {
  project: string;
  client: string;
  sent: number;
  auth: "bearer" | "oauth";
  /** The bearer hash matched at connect. A rotated credential closes the socket. */
  key: string | null;
  opened: number;
};
/** OAuth is revalidated with GitHub per request. A socket cannot do that, so it carries mail only briefly. */
const OAUTH_SOCKET_FRESH_MS = 60_000;
export const MAX_WAIT_SECONDS = 50;

/** One durable mailbox/outbox per project. camelRun, not this object, owns the model loop and memory. */
export class ProjectRoom extends DurableObject<WorkerEnv> {
  /** Memory only. A waiter lost to eviction fails its request; the client asks again and the durable mailbox answers. */
  private waiters = new Map<string, Set<Waiter>>();
  private dirty = new Set<string>();
  limits = { clientWaiters: 4, projectWaiters: 256, clientSockets: 4, projectSockets: 1024 };
  constructor(ctx: DurableObjectState, env: WorkerEnv) {
    super(ctx, env);
    // Answered by the runtime without waking a hibernating object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS oauth_mailboxes(id TEXT PRIMARY KEY,userId TEXT NOT NULL,oauthClientId TEXT NOT NULL,suspended INTEGER NOT NULL DEFAULT 0,UNIQUE(userId,oauthClientId))`,
    );
    ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS deliveries(id TEXT PRIMARY KEY,target TEXT NOT NULL,text TEXT NOT NULL,recipients TEXT NOT NULL)`,
    );
    ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,client TEXT NOT NULL,text TEXT NOT NULL,state TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,created INTEGER NOT NULL)`,
    );
    ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS messages(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL,target TEXT NOT NULL,text TEXT NOT NULL,kind TEXT NOT NULL,requestId TEXT,created INTEGER NOT NULL,UNIQUE(id,target))`,
    );
    ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS receipts(client TEXT PRIMARY KEY,ack INTEGER NOT NULL DEFAULT 0,seen INTEGER NOT NULL)`,
    );
  }
  async invoke(operation: string, args: unknown[]) {
    try {
      const methods = {
        resolveOAuthClient: this.resolveOAuthClient,
        suspendOAuthUser: this.suspendOAuthUser,
        submit: this.submit,
        read: this.read,
        wait: this.wait,
        ack: this.ack,
        participants: this.participants,
        send: this.send,
      };
      if (!Object.hasOwn(methods, operation))
        throw new Failure(404, "Unknown operation");
      const value = await (methods as Record<string, Function>)[
        operation
      ].apply(this, args);
      return { ok: true as const, value };
    } catch (error) {
      return {
        ok: false as const,
        status: error instanceof Failure ? error.status : 500,
        error:
          error instanceof Failure ? error.message : "Project operation failed",
      };
    }
  }
  /** Internal RPC only: called after browser consent and verified GitHub identity. */
  async resolveOAuthClient(project: string, userId: string, oauthClientId: string, create = false) {
    const p = config(this.env, project);
    const explicit = explicitMailbox(p, userId, oauthClientId);
    if (explicit) return explicit;
    const limit = automaticEnrollmentLimit(p, userId, oauthClientId);
    if (!limit) throw new Failure(403, "No explicit project mailbox grant or automatic enrollment permission for this GitHub user and MCP client");
    const id = await automaticMailboxId(project, userId, oauthClientId);
    if (Object.hasOwn(p.clients, id)) throw new Failure(403, "Automatic mailbox conflicts with a configured client");
    this.ctx.storage.transactionSync(() => {
      const existing = this.ctx.storage.sql.exec<OAuthMailbox>("SELECT * FROM oauth_mailboxes WHERE id=?", id).toArray()[0];
      if (existing && (existing.userId !== userId || existing.oauthClientId !== oauthClientId))
        throw new Failure(403, "Automatic mailbox identity mismatch");
      if (!existing) {
        if (!create) throw new Failure(403, "Mailbox not enrolled; restart sign-in from your MCP client");
        // Count suspended/blocked entries too: rotating DCR IDs cannot evade the cap.
        const count = this.ctx.storage.sql.exec<{ n: number }>("SELECT count(*) AS n FROM oauth_mailboxes WHERE userId=?", userId).one().n;
        if (count >= limit) throw new Failure(403, "Automatic client limit reached; reuse a stable client ID or contact the operator");
        this.ctx.storage.sql.exec("INSERT INTO oauth_mailboxes(id,userId,oauthClientId) VALUES(?,?,?)", id, userId, oauthClientId);
      } else {
        // Only a newly verified, live identity can reactivate its own mailbox.
        this.ctx.storage.sql.exec("UPDATE oauth_mailboxes SET suspended=0 WHERE id=?", id);
      }
    });
    return id;
  }
  suspendOAuthUser(project: string, userId: string) {
    config(this.env, project);
    this.ctx.storage.sql.exec("UPDATE oauth_mailboxes SET suspended=1 WHERE userId=?", userId);
  }
  private clients(project: string): Record<string, ClientConfig> {
    const p = config(this.env, project), clients = { ...p.clients };
    for (const row of this.ctx.storage.sql.exec<OAuthMailbox>("SELECT * FROM oauth_mailboxes WHERE suspended=0")) {
      if (!automaticEnrollmentLimit(p, row.userId, row.oauthClientId) || Object.hasOwn(clients, row.id)) continue;
      // A newly configured manual mapping replaces, never aliases, the automatic mailbox.
      try { if (explicitMailbox(p, row.userId, row.oauthClientId)) continue; }
      catch { continue; }
      // Client names are self-asserted. Use server-derived attribution instead.
      clients[row.id] = { name: `GitHub ${row.userId} / MCP ${row.id.slice(3, 15)}` };
    }
    return clients;
  }
  async join(project: string, client: string) {
    const p = config(this.env, project);
    if (!Object.hasOwn(this.clients(project), client))
      throw new Failure(403, "Unknown client");
    await this.ctx.storage.put("project", project);
    this.ctx.storage.sql.exec(
      "INSERT INTO receipts(client,seen) VALUES(?,?) ON CONFLICT(client) DO UPDATE SET seen=excluded.seen",
      client,
      Date.now(),
    );
    return p;
  }
  async submit(
    project: string,
    client: string,
    requestId: string,
    text: string,
  ) {
    await this.join(project, client);
    const id =
      "lead_" + (await hash(`${project}:${client}:${requestId}`)).slice(0, 48);
    if ((await this.ctx.storage.getAlarm()) === null)
      await this.ctx.storage.setAlarm(Date.now() + 1000);
    const old = this.ctx.storage.sql
      .exec<Job>("SELECT * FROM jobs WHERE id=?", id)
      .toArray()[0];
    if (old) {
      if (old.text !== text)
        throw new Failure(409, "requestId already used for different text");
      return { requestId: id, state: old.state };
    }
    if (
      this.ctx.storage.sql
        .exec<{ n: number }>(
          "SELECT count(*) AS n FROM jobs WHERE state IN ('queued','running')",
        )
        .one().n >= 100
    )
      throw new Failure(429, "Project queue full; retry later");
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO jobs(id,client,text,state,created) VALUES(?,?,?,?,?)",
      id,
      client,
      text,
      "queued",
      Date.now(),
    );
    return { requestId: id, state: "queued" };
  }
  /** Unacknowledged events after the caller's cursor. `next` is the cursor for its following call. */
  private pending(client: string, after: number, limit = 50) {
    const ack =
      this.ctx.storage.sql
        .exec<{ ack: number }>("SELECT ack FROM receipts WHERE client=?", client)
        .toArray()[0]?.ack ?? 0;
    const from = Math.max(ack, after);
    const events = this.ctx.storage.sql
      .exec<Message>(
        "SELECT * FROM messages WHERE target=? AND seq>? ORDER BY seq LIMIT ?",
        client,
        from,
        limit,
      )
      .toArray();
    return { events, next: events.at(-1)?.seq ?? from };
  }
  async read(project: string, client: string, after = 0) {
    await this.join(project, client);
    return this.pending(client, after);
  }
  /** Blocking read: answers at once when mail exists, otherwise when mail arrives or the wait ends. */
  async wait(project: string, client: string, seconds: number, after = 0) {
    const first = await this.read(project, client, after);
    if (first.events.length || !(seconds > 0)) return first;
    let total = 0;
    for (const set of this.waiters.values()) total += set.size;
    if (total >= this.limits.projectWaiters)
      throw new Failure(429, "Too many waiting requests for this project; retry later");
    let set = this.waiters.get(client);
    if (!set) this.waiters.set(client, (set = new Set()));
    // An abandoned request cannot be seen from here. The newest wait wins; the oldest returns empty.
    while (set.size >= this.limits.clientWaiters) set.values().next().value!.release();
    const mine = set;
    await new Promise<void>((resolve) => {
      const waiter: Waiter = {
        after,
        release: () => {
          clearTimeout(timer);
          mine.delete(waiter);
          resolve();
        },
      };
      const timer = setTimeout(
        waiter.release,
        Math.min(seconds, MAX_WAIT_SECONDS) * 1000,
      );
      mine.add(waiter);
    });
    // Authorization and the mailbox are both checked again after the wait.
    return this.read(project, client, after);
  }
  /** Wake this client's waiting requests and sockets. Runs after the write that queued it has committed. */
  private flush() {
    const targets = [...this.dirty];
    this.dirty.clear();
    for (const client of targets) {
      try {
        for (const waiter of [...(this.waiters.get(client) ?? [])])
          if (this.pending(client, waiter.after, 1).events.length) waiter.release();
        for (const ws of this.ctx.getWebSockets(client)) this.deliver(ws);
      } catch {
        // The mailbox is durable; the next read, wait or connect delivers.
      }
    }
  }
  /** Internal only: the Worker authenticates, then forwards the upgrade with the server-assigned identity. */
  async fetch(request: Request) {
    const url = new URL(request.url);
    if (
      url.pathname !== "/ws" ||
      request.headers.get("Upgrade")?.toLowerCase() !== "websocket"
    )
      return Response.json({ error: "Not found" }, { status: 404 });
    let wanted: Partial<Socket & { after: number }> = {};
    try {
      wanted = JSON.parse(request.headers.get("X-Lead-Socket") || "{}");
    } catch {}
    const project = String(wanted.project || ""),
      client = String(wanted.client || "");
    try {
      await this.join(project, client);
      const open = (tag?: string) =>
        this.ctx
          .getWebSockets(tag)
          .filter((ws) => ws.readyState === WebSocket.OPEN);
      if (open().length >= this.limits.projectSockets)
        throw new Failure(429, "Too many open sockets for this project; retry later");
      const mine = open(client).sort(
        (a, b) =>
          ((a.deserializeAttachment() as Socket | null)?.opened ?? 0) -
          ((b.deserializeAttachment() as Socket | null)?.opened ?? 0),
      );
      while (mine.length >= this.limits.clientSockets)
        mine.shift()!.close(4008, "Replaced by a newer connection");
    } catch (error) {
      return Response.json(
        { error: error instanceof Failure ? error.message : "Project operation failed" },
        { status: error instanceof Failure ? error.status : 500 },
      );
    }
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], [client]);
    const attachment: Socket = {
      project,
      client,
      sent: Number(wanted.after) || 0,
      auth: wanted.auth === "oauth" ? "oauth" : "bearer",
      key: typeof wanted.key === "string" ? wanted.key : null,
      opened: Date.now(),
    };
    pair[1].serializeAttachment(attachment);
    this.deliver(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }
  /** False closes the socket: the client reconnects or polls, and is authenticated again. */
  private allowed(ws: WebSocket, a: Socket, carriesMail: boolean) {
    let ok = false;
    try {
      const c = this.clients(a.project)[a.client];
      ok = !!c && (a.auth === "oauth" || (!!a.key && c.tokenHash === a.key));
    } catch {}
    const stale =
      ok && a.auth === "oauth" && carriesMail && Date.now() - a.opened > OAUTH_SOCKET_FRESH_MS;
    if (ok && !stale) return true;
    try {
      // Mail is waiting, but only a request authenticated now may read it.
      if (stale) ws.send(JSON.stringify({ type: "reauthenticate" }));
      ws.close(4401, "Reauthenticate");
    } catch {}
    return false;
  }
  /** Write this socket's own undelivered mail. Receipt is not acknowledgement. */
  private deliver(ws: WebSocket) {
    const a = ws.deserializeAttachment() as Socket | null;
    if (!a || ws.readyState !== WebSocket.OPEN) return;
    try {
      for (;;) {
        const { events, next } = this.pending(a.client, a.sent);
        if (!events.length || !this.allowed(ws, a, true)) return;
        ws.send(JSON.stringify({ type: "messages", events, next }));
        a.sent = next;
        ws.serializeAttachment(a);
      }
    } catch {
      try {
        ws.close(1011, "Delivery failed");
      } catch {}
    }
  }
  async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer) {
    const a = ws.deserializeAttachment() as Socket | null;
    if (!a) return ws.close(1008, "Unknown socket");
    if (typeof data !== "string" || data.length > 1024)
      return ws.close(1009, "Unsupported frame");
    if (!this.allowed(ws, a, true)) return;
    let frame: any;
    try {
      frame = JSON.parse(data);
    } catch {}
    try {
      if (frame?.type !== "ack" || !Number.isSafeInteger(frame.seq) || frame.seq < 0)
        throw new Failure(400, 'Expected {"type":"ack","seq":<number>}');
      ws.send(
        JSON.stringify({ type: "ack", ...(await this.ack(a.project, a.client, frame.seq)) }),
      );
    } catch (error) {
      ws.send(
        JSON.stringify({
          type: "error",
          error: error instanceof Failure ? error.message : "Project operation failed",
        }),
      );
    }
  }
  webSocketClose(ws: WebSocket, code: number) {
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, "Closed");
    } catch {}
  }
  webSocketError() {}
  async ack(project: string, client: string, seq: number) {
    await this.join(project, client);
    const max =
      this.ctx.storage.sql
        .exec<{ n: number | null }>(
          "SELECT max(seq) AS n FROM messages WHERE target=?",
          client,
        )
        .one().n || 0;
    if (seq > max) throw new Failure(400, "Cannot acknowledge unseen sequence");
    this.ctx.storage.sql.exec(
      "UPDATE receipts SET ack=max(ack,?) WHERE client=?",
      seq,
      client,
    );
    return { ack: seq };
  }
  participants(project: string) {
    const p = config(this.env, project);
    return Object.entries(this.clients(project)).map(([id, c]) => ({
      id,
      name: c.name,
      lastSeen:
        this.ctx.storage.sql
          .exec<{ seen: number }>(
            "SELECT seen FROM receipts WHERE client=?",
            id,
          )
          .toArray()[0]?.seen ?? null,
    }));
  }
  async send(project: string, target: string, text: string, id: string) {
    const p = config(this.env, project);
    const previous = this.ctx.storage.sql.exec<{ target: string; text: string; recipients: string }>("SELECT * FROM deliveries WHERE id=?", id).toArray()[0];
    if (previous) {
      if (previous.target !== target || previous.text !== text) throw new Failure(409, "messageId already used for another message");
      // Freeze the original recipient set. A retry must not fan out to newly enrolled clients.
      return { deliveredToMailboxes: JSON.parse(previous.recipients) as string[] };
    }
    const clients = this.clients(project);
    const targets = target === "all" ? Object.keys(clients) : [target];
    if (targets.some((t) => !Object.hasOwn(clients, t)))
      throw new Failure(404, "Unknown target");
    const existing = this.ctx.storage.sql
      .exec<{ target: string; text: string }>(
        "SELECT target,text FROM messages WHERE id=?",
        `proactive:${id}`,
      )
      .toArray();
    if (
      existing.length &&
      (existing.some((r) => r.text !== text) ||
        existing
          .map((r) => r.target)
          .sort()
          .join() !== targets.toSorted().join())
    )
      throw new Failure(409, "messageId already used for another message");
    this.ctx.storage.transactionSync(() => {
      for (const t of targets)
        this.insert(`proactive:${id}`, t, text, "message", null);
      this.ctx.storage.sql.exec("INSERT INTO deliveries(id,target,text,recipients) VALUES(?,?,?,?)", id, target, text, JSON.stringify(targets));
    });
    return { deliveredToMailboxes: targets };
  }
  private insert(
    id: string,
    target: string,
    text: string,
    kind: string,
    requestId: string | null,
  ) {
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO messages(id,target,text,kind,requestId,created) VALUES(?,?,?,?,?,?)",
      id,
      target,
      text.slice(0, 16_000),
      kind,
      requestId,
      Date.now(),
    );
    // A microtask runs after the enclosing synchronous transaction commits.
    if (!this.dirty.size) queueMicrotask(() => this.flush());
    this.dirty.add(target);
  }
  private async runtime(path: string, method = "GET", body?: unknown) {
    const request = new Request(
      this.env.CAMELRUN_URL.replace(/\/$/, "") + path,
      {
        method,
        headers: {
          Authorization: `Bearer ${this.env.CAMELRUN_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      },
    );
    const response = this.env.RUNTIME
      ? await this.env.RUNTIME.fetch(request)
      : await fetch(request);
    if (!response.ok)
      throw new Failure(response.status, "camelRun request failed");
    return response.json<any>();
  }
  async alarm() {
    const project = await this.ctx.storage.get<string>("project");
    if (!project) return;
    const p = config(this.env, project);
    const jobs = this.ctx.storage.sql
      .exec<Job>(
        "SELECT * FROM jobs WHERE state IN ('queued','running') ORDER BY created LIMIT 10",
      )
      .toArray();
    if (!jobs.length) return;
    // Schedule before network I/O. Leave one final harmless alarm rather than race a new admission by deleting it.
    await this.ctx.storage.setAlarm(Date.now() + 5000);
    for (const job of jobs) {
      try {
        const client = this.clients(project)[job.client];
        if (!client) throw new Failure(403, "Client access revoked");
        let result: any;
        if (job.state === "queued") {
          result = await this.runtime(
            `/v1/agents/${p.agentId}/prompt`,
            "POST",
            {
              text: job.text,
              requestId: job.id,
              from: { id: job.client, name: client.name },
              metadata: { source: "camel-lead", client: job.client, project },
            },
          );
          this.ctx.storage.sql.exec(
            "UPDATE jobs SET state='running' WHERE id=?",
            job.id,
          );
        } else
          result = await this.runtime(
            `/v1/agents/${p.agentId}/requests/${job.id}`,
          );
        if (result.state === "completed") {
          const outcome = result.outcome || {},
            r = outcome.result || {};
          const text =
            typeof r.reply === "string" && r.reply
              ? r.reply
              : outcome.error ||
                r.error ||
                (r.stopped === "input_required"
                  ? "The lead is waiting for human input; review it in camelRun."
                  : "The lead completed without a text reply.");
          // Policy may have changed or a revocation may have been observed during network I/O.
          if (!Object.hasOwn(this.clients(project), job.client)) throw new Failure(403, "Client access revoked");
          this.ctx.storage.transactionSync(() => {
            this.insert(
              `reply:${job.id}`,
              job.client,
              text,
              outcome.error || r.error ? "error" : "reply",
              job.id,
            );
            this.ctx.storage.sql.exec(
              "UPDATE jobs SET state='done' WHERE id=?",
              job.id,
            );
          });
        }
      } catch (error) {
        const attempts = job.attempts + 1;
        this.ctx.storage.sql.exec(
          "UPDATE jobs SET attempts=? WHERE id=?",
          attempts,
          job.id,
        );
        // After ambiguous delivery, never invent another id. Failure leaves the original runtime request inspectable.
        if (
          attempts >= 12 ||
          (error instanceof Failure && [401, 403, 404].includes(error.status))
        ) {
          this.ctx.storage.transactionSync(() => {
            this.insert(
              `reply:${job.id}`,
              job.client,
              "Unable to complete this request. Ask the project administrator to inspect its camelRun request ID.",
              "error",
              job.id,
            );
            this.ctx.storage.sql.exec(
              "UPDATE jobs SET state='failed' WHERE id=?",
              job.id,
            );
          });
        }
      }
    }
  }
}
