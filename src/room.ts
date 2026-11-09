import { DurableObject } from "cloudflare:workers";
import {
  config,
  Failure,
  hash,
  type Job,
  type Message,
  type WorkerEnv,
} from "./types.ts";

/** One durable mailbox/outbox per project. camelRun, not this object, owns the model loop and memory. */
export class ProjectRoom extends DurableObject<WorkerEnv> {
  constructor(ctx: DurableObjectState, env: WorkerEnv) {
    super(ctx, env);
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
        submit: this.submit,
        read: this.read,
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
  async join(project: string, client: string) {
    const p = config(this.env, project);
    if (!Object.hasOwn(p.clients, client))
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
  async read(project: string, client: string) {
    await this.join(project, client);
    const ack = this.ctx.storage.sql
      .exec<{ ack: number }>("SELECT ack FROM receipts WHERE client=?", client)
      .one().ack;
    const events = this.ctx.storage.sql
      .exec<Message>(
        "SELECT * FROM messages WHERE target=? AND seq>? ORDER BY seq LIMIT 50",
        client,
        ack,
      )
      .toArray();
    return { events };
  }
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
    return Object.entries(p.clients).map(([id, c]) => ({
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
    const targets = target === "all" ? Object.keys(p.clients) : [target];
    if (targets.some((t) => !Object.hasOwn(p.clients, t)))
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
        let result: any;
        if (job.state === "queued") {
          result = await this.runtime(
            `/v1/agents/${p.agentId}/prompt`,
            "POST",
            {
              text: job.text,
              requestId: job.id,
              from: { id: job.client, name: p.clients[job.client].name },
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
