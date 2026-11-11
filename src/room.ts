import { createHash } from "node:crypto";
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
import { clean, clientLabel, displayName, plain, sessionName } from "./names.ts";
import { directInput, uploadInput, type MessageDetails, type SharedFile, type MultipartStatus } from "./sharing.ts";
type OAuthMailbox = { id: string; userId: string; oauthClientId: string; suspended: number };
/** Survives hibernation with the socket: which mailbox it watches (a client id or a session id), and from where. */
type Socket = { client: string; after: number; shared?: string };
/** A verified GitHub profile. Only the Worker, after checking the identity with GitHub, passes one in. */
export type Profile = { login: string; name: string };
/** A named mailbox under one client. Its id is also its mailbox id in messages, receipts and wait tokens. */
type Session = { id: string; client: string; name: string; created: number; seen: number; notified: number };
type StoredMessage = Omit<Message, keyof MessageDetails> & { details: string | null };
/**
 * An authorized client: the verified person behind it (as shown, with "(@login)" when two people share a name),
 * a grouping key for that person, their plain name and GitHub login, and the client label.
 */
type Known = { person: string; key: string; label: string; name: string; login?: string };
export const MAX_WAIT_SECONDS = 50;
/** A client's messages are copied to its sessions seen within this time, or waiting right now. */
export const SESSION_LIVE_MS = 3600_000;
/** At the session cap, a session unseen for this long gives way to a new one. */
export const SESSION_IDLE_MS = 24 * 3600_000;
/** A session unseen for this long ends; its unacknowledged messages move to the client mailbox. */
export const SESSION_EXPIRY_MS = 7 * 24 * 3600_000;
export const MAX_SESSIONS = 20;

/** One durable mailbox/outbox per project. camelRun, not this object, owns the model loop and memory. */
export class ProjectRoom extends DurableObject<WorkerEnv> {
  limits = { clientSockets: 4, projectSockets: 256, clientTokens: 5 };
  private dirty = new Set<string>();
  constructor(ctx: DurableObjectState, env: WorkerEnv) {
    super(ctx, env);
    ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS wait_tokens(n INTEGER PRIMARY KEY AUTOINCREMENT,hash TEXT NOT NULL UNIQUE,client TEXT NOT NULL,expires INTEGER NOT NULL)`,
    );
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
    // Names and sessions are additive: new tables and one nullable column. Rooms created before them keep working.
    ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS people(userId TEXT PRIMARY KEY,login TEXT NOT NULL DEFAULT '',name TEXT NOT NULL DEFAULT '')`,
    );
    ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS client_info(client TEXT PRIMARY KEY,name TEXT NOT NULL,version TEXT NOT NULL DEFAULT '')`,
    );
    ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,client TEXT NOT NULL,name TEXT NOT NULL,created INTEGER NOT NULL,seen INTEGER NOT NULL,UNIQUE(client,name))`,
    );
    if (!ctx.storage.sql.exec("PRAGMA table_info(jobs)").toArray().some((c) => c.name === "session"))
      ctx.storage.sql.exec("ALTER TABLE jobs ADD COLUMN session TEXT");
    if (!ctx.storage.sql.exec("PRAGMA table_info(jobs)").toArray().some((c) => c.name === "event"))
      ctx.storage.sql.exec("ALTER TABLE jobs ADD COLUMN event TEXT");
    if (!ctx.storage.sql.exec("PRAGMA table_info(sessions)").toArray().some((c) => c.name === "notified"))
      ctx.storage.sql.exec("ALTER TABLE sessions ADD COLUMN notified INTEGER NOT NULL DEFAULT 0");
    if (!ctx.storage.sql.exec("PRAGMA table_info(messages)").toArray().some((c) => c.name === "details"))
      ctx.storage.sql.exec("ALTER TABLE messages ADD COLUMN details TEXT");
    if (!ctx.storage.sql.exec("PRAGMA table_info(deliveries)").toArray().some((c) => c.name === "details"))
      ctx.storage.sql.exec("ALTER TABLE deliveries ADD COLUMN details TEXT");
    if (!ctx.storage.sql.exec("PRAGMA table_info(deliveries)").toArray().some((c) => c.name === "owner"))
      ctx.storage.sql.exec("ALTER TABLE deliveries ADD COLUMN owner TEXT");
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS delivery_receipts(
      id TEXT NOT NULL,target TEXT NOT NULL,mailbox TEXT NOT NULL,queued INTEGER NOT NULL,
      fetched INTEGER,acknowledged INTEGER,replied INTEGER,replyId TEXT,PRIMARY KEY(id,target))`);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS files(
      id TEXT PRIMARY KEY,owner TEXT NOT NULL,name TEXT NOT NULL,size INTEGER NOT NULL,sha256 TEXT NOT NULL,
      contentType TEXT NOT NULL,created INTEGER NOT NULL,expires INTEGER NOT NULL,state TEXT NOT NULL,cleaned INTEGER NOT NULL DEFAULT 0)`);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS file_grants(file TEXT NOT NULL,mailbox TEXT NOT NULL,PRIMARY KEY(file,mailbox))");
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS file_multipart(
      file TEXT PRIMARY KEY,uploadId TEXT,partSize INTEGER NOT NULL)`);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS file_parts(
      file TEXT NOT NULL,partNumber INTEGER NOT NULL,etag TEXT NOT NULL,PRIMARY KEY(file,partNumber))`);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS file_tokens(
      hash TEXT PRIMARY KEY,file TEXT NOT NULL,client TEXT NOT NULL,mailbox TEXT NOT NULL,mode TEXT NOT NULL,expires INTEGER NOT NULL)`);
  }
  async invoke(operation: string, args: unknown[]) {
    try {
      const methods = {
        resolveOAuthClient: this.resolveOAuthClient,
        recordIdentity: this.recordIdentity,
        suspendOAuthUser: this.suspendOAuthUser,
        submit: this.submit,
        read: this.read,
        joinSession: this.joinSession,
        recordClientInfo: this.recordClientInfo,
        mintWaitToken: this.mintWaitToken,
        waitTokenOwner: this.waitTokenOwner,
        waitTokenRead: this.waitTokenRead,
        ack: this.ack,
        participants: this.participants,
        send: this.send,
        sendDirect: this.sendDirect,
        deliveryStatus: this.deliveryStatus,
        prepareUpload: this.prepareUpload,
        getFile: this.getFile,
        listFiles: this.listFiles,
        deleteFile: this.deleteFile,
        fileToken: this.fileToken,
        completeUpload: this.completeUpload,
        resumeUpload: this.resumeUpload,
        multipartStatus: this.multipartStatus,
        recordPart: this.recordPart,
        completeMultipart: this.completeMultipart,
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
  async resolveOAuthClient(project: string, userId: string, oauthClientId: string, create = false, profile?: Profile) {
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
    this.recordProfile(userId, profile);
    return id;
  }
  /**
   * The person's GitHub login and display name, kept for readable names. Enrollments made before names were
   * stored get theirs here on their next verified request; until then they show as "GitHub <id>".
   */
  /** Internal RPC only, for explicitly granted mailboxes: the Worker has just verified this identity with GitHub. */
  recordIdentity(project: string, userId: string, profile: Profile) {
    config(this.env, project);
    if (/^[1-9][0-9]*$/.test(userId)) this.recordProfile(userId, profile);
  }
  private recordProfile(userId: string, profile?: Profile) {
    const login = clean(profile?.login, 60),
      name = clean(profile?.name, 60) || login;
    if (!login && !name) return;
    const sql = this.ctx.storage.sql;
    const old = sql.exec<Profile>("SELECT login,name FROM people WHERE userId=?", userId).toArray()[0];
    // Every request revalidates the identity; write only when it changed.
    if (old?.login === login && old.name === name) return;
    sql.exec(
      "INSERT INTO people(userId,login,name) VALUES(?,?,?) ON CONFLICT(userId) DO UPDATE SET login=excluded.login,name=excluded.name",
      userId,
      login,
      name,
    );
  }
  /** `clientInfo` from an MCP `initialize` request. Self-asserted: it only labels the client, never the person. */
  recordClientInfo(project: string, client: string, name: unknown, version?: unknown) {
    if (!Object.hasOwn(this.clients(project), client)) throw new Failure(403, "Unknown client");
    const n = clean(name, 100);
    if (!n) return;
    this.ctx.storage.sql.exec(
      "INSERT INTO client_info(client,name,version) VALUES(?,?,?) ON CONFLICT(client) DO UPDATE SET name=excluded.name,version=excluded.version",
      client,
      n,
      clean(version, 40),
    );
  }
  suspendOAuthUser(project: string, userId: string) {
    config(this.env, project);
    this.ctx.storage.sql.exec("UPDATE oauth_mailboxes SET suspended=1 WHERE userId=?", userId);
    // End this user's parked waits now; their next read is refused.
    const sql = this.ctx.storage.sql;
    for (const row of sql.exec<{ id: string }>("SELECT id FROM oauth_mailboxes WHERE userId=?", userId))
      for (const box of [row.id, ...sql.exec<{ id: string }>("SELECT id FROM sessions WHERE client=?", row.id).toArray().map((s) => s.id)])
        this.closeSockets(box);
  }
  private closeSockets(mailbox: string) {
    for (const ws of this.ctx.getWebSockets(mailbox))
      try {
        ws.close(4401, "Access ended");
      } catch {}
  }
  /** Every authorized client, with the verified person behind it and its client label. */
  private clients(project: string): Record<string, Known> {
    const p = config(this.env, project),
      sql = this.ctx.storage.sql,
      clients: Record<string, Known> = {};
    const people = new Map(sql.exec<Profile & { userId: string }>("SELECT * FROM people").toArray().map((r) => [r.userId, r]));
    const labels = new Map(sql.exec<{ client: string; name: string }>("SELECT client,name FROM client_info").toArray().map((r) => [r.client, r.name]));
    // The person is never taken from a tool argument or a self-asserted app name: GitHub's verified profile, or the operator's registry.
    const github = (id: string, userId: string, fallback: string): Known => {
      const profile = people.get(userId),
        login = plain(profile?.login ?? ""),
        name = plain(profile?.name ?? "") || login || fallback;
      return { person: name, name, key: `github:${userId}`, label: clientLabel(labels.get(id)), ...(login ? { login } : {}) };
    };
    for (const [id, c] of Object.entries(p.clients as Record<string, ClientConfig>)) {
      const name = clean(c.name, 60) || id;
      clients[id] = c.github
        ? github(id, c.github.userId, name)
        : { person: name, name, key: `name:${name}`, label: clientLabel(labels.get(id)) };
    }
    for (const row of sql.exec<OAuthMailbox>("SELECT * FROM oauth_mailboxes WHERE suspended=0")) {
      if (!automaticEnrollmentLimit(p, row.userId, row.oauthClientId) || Object.hasOwn(clients, row.id)) continue;
      // A newly configured manual mapping replaces, never aliases, the automatic mailbox.
      try { if (explicitMailbox(p, row.userId, row.oauthClientId)) continue; }
      catch { continue; }
      clients[row.id] = github(row.id, row.userId, `GitHub ${row.userId}`);
    }
    // Two people with the same name are told apart by their GitHub login.
    const sharing = new Map<string, Set<string>>();
    for (const c of Object.values(clients)) {
      const who = sharing.get(c.name.toLowerCase()) ?? new Set();
      sharing.set(c.name.toLowerCase(), who.add(c.key));
    }
    for (const c of Object.values(clients))
      if (c.login && sharing.get(c.name.toLowerCase())!.size > 1) c.person = `${c.name} (@${c.login})`;
    return clients;
  }
  private touch(mailbox: string, now: number) {
    this.ctx.storage.sql.exec(
      "INSERT INTO receipts(client,seen) VALUES(?,?) ON CONFLICT(client) DO UPDATE SET seen=excluded.seen",
      mailbox,
      now,
    );
  }
  /**
   * Admit an authorized client and return the mailbox it may use: its own, or one of its own sessions.
   * Another client's session is as unknown as a missing one.
   */
  private async enter(project: string, client: string, session?: string | null) {
    config(this.env, project);
    if (!Object.hasOwn(this.clients(project), client))
      throw new Failure(403, "Unknown client");
    await this.ctx.storage.put("project", project);
    const now = Date.now();
    this.touch(client, now);
    if (session === undefined || session === null) return client;
    this.expireSessions(now);
    const sql = this.ctx.storage.sql;
    if (typeof session !== "string" || !sql.exec("SELECT 1 FROM sessions WHERE id=? AND client=?", session, client).toArray().length)
      throw new Failure(404, "Unknown session; call join to get a session id");
    sql.exec("UPDATE sessions SET seen=? WHERE id=?", now, session);
    this.touch(session, now);
    return session;
  }
  /** End sessions unseen for seven days. */
  private expireSessions(now = Date.now()) {
    for (const s of this.ctx.storage.sql.exec<Session>("SELECT * FROM sessions WHERE seen<=?", now - SESSION_EXPIRY_MS).toArray())
      this.retire(s);
  }
  /** End a session: what it never acknowledged moves to its client's mailbox, so nothing is lost. The rest is deleted. */
  private retire(s: Session) {
    const sql = this.ctx.storage.sql;
    this.ctx.storage.transactionSync(() => {
      const ack = sql.exec<{ ack: number }>("SELECT ack FROM receipts WHERE client=?", s.id).toArray()[0]?.ack ?? 0;
      // Re-inserted, not retargeted: a new sequence number puts them after the client's own acknowledgement cursor.
      const moved = sql.exec(
        "INSERT OR IGNORE INTO messages(id,target,text,kind,requestId,created,details) SELECT id,?,text,kind,requestId,created,details FROM messages WHERE target=? AND seq>? ORDER BY seq",
        s.client,
        s.id,
        ack,
      ).rowsWritten;
      sql.exec("UPDATE delivery_receipts SET mailbox=? WHERE mailbox=? AND acknowledged IS NULL", s.client, s.id);
      sql.exec("INSERT OR IGNORE INTO file_grants(file,mailbox) SELECT file,? FROM file_grants WHERE mailbox=?", s.client, s.id);
      sql.exec("DELETE FROM file_grants WHERE mailbox=?", s.id);
      // Ownership follows the client when a named session retires.
      sql.exec("UPDATE files SET owner=? WHERE owner=?", s.client, s.id);
      sql.exec("UPDATE deliveries SET owner=? WHERE owner=?", s.client, s.id);
      sql.exec("DELETE FROM messages WHERE target=?", s.id);
      sql.exec("DELETE FROM receipts WHERE client=?", s.id);
      sql.exec("DELETE FROM wait_tokens WHERE client=?", s.id);
      sql.exec("DELETE FROM sessions WHERE id=?", s.id);
      if (moved) this.notify(s.client);
    });
    this.closeSockets(s.id);
  }
  private sessionsOf(client: string) {
    return this.ctx.storage.sql
      .exec<Session>("SELECT * FROM sessions WHERE client=? ORDER BY created,id", client)
      .toArray();
  }
  private open(tag?: string) {
    return this.ctx.getWebSockets(tag).filter((ws) => ws.readyState === WebSocket.OPEN);
  }
  /** Sessions that will read a message soon: one with a wait parked right now, or seen within the last hour. */
  private liveSessions(client: string, now: number) {
    return this.sessionsOf(client).filter((s) => s.seen > now - SESSION_LIVE_MS || this.open(s.id).length > 0);
  }
  /** New lead work must preempt the hourly file-cleanup alarm without delaying an earlier wake-up. */
  private async wakeLead() {
    const due = Date.now() + 1000;
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm === null || alarm > due) await this.ctx.storage.setAlarm(due);
  }
  /**
   * Create or resume a named session under the calling client. The same name is always the same session id,
   * so an agent that lost its context gets its mailbox back by joining again.
   */
  async joinSession(project: string, client: string, rawName: unknown, clientInfo?: { name?: unknown; version?: unknown }) {
    await this.enter(project, client);
    const name = sessionName(rawName);
    if (clientInfo) this.recordClientInfo(project, client, clientInfo.name, clientInfo.version);
    const id = "ses_" + (await hash(JSON.stringify([project, client, name]))).slice(0, 40);
    const known = this.clients(project);
    if (Object.hasOwn(known, id)) throw new Failure(409, "Session name conflicts with a configured client");
    // Arm delivery before atomically writing the session and its event.
    await this.wakeLead();
    const now = Date.now(),
      sql = this.ctx.storage.sql;
    this.expireSessions(now);
    const display = displayName(known[client].person, known[client].label, name);
    this.ctx.storage.transactionSync(() => {
      const previous = sql.exec<Session>("SELECT * FROM sessions WHERE id=?", id).toArray()[0];
      const event = !previous ? "session_joined"
        : previous.seen <= now - SESSION_LIVE_MS && previous.notified <= now - SESSION_LIVE_MS
          ? "session_returned" : null;
      if (event && sql.exec<{ n: number }>("SELECT count(*) AS n FROM jobs WHERE state IN ('queued','running')").one().n >= 100)
        throw new Failure(429, "Project queue full; retry later");
      if (previous)
        sql.exec("UPDATE sessions SET seen=? WHERE id=?", now, id);
      else {
        const all = sql.exec<Session>("SELECT * FROM sessions WHERE client=? ORDER BY seen", client).toArray();
        if (all.length >= MAX_SESSIONS) {
          // Never retire a session seen in the last day or waiting right now.
          const idle = all.find((s) => s.seen <= now - SESSION_IDLE_MS && !this.open(s.id).length);
          if (!idle)
            throw new Failure(429, `This client already has ${MAX_SESSIONS} live sessions; join one of them by name`);
          this.retire(idle);
        }
        sql.exec("INSERT INTO sessions(id,client,name,created,seen) VALUES(?,?,?,?,?)", id, client, name, now, now);
      }
      if (event) {
        const text = JSON.stringify({ event, person: known[client].person, client: known[client].label,
          session: name, displayName: display, replyTarget: id });
        sql.exec("INSERT INTO jobs(id,client,text,state,created,session,event) VALUES(?,?,?,?,?,?,?)",
          `presence_${crypto.randomUUID()}`, client, text, "queued", now, id, event);
        sql.exec("UPDATE sessions SET notified=? WHERE id=?", now, id);
      }
      this.touch(id, now);
    });
    return { session: id, displayName: display };
  }
  async submit(
    project: string,
    client: string,
    requestId: string,
    text: string,
    session?: string | null,
  ) {
    const mailbox = await this.enter(project, client, session);
    // Two sessions of one client may reuse a requestId; without a session the id is what it always was.
    const scope = mailbox === client ? `${project}:${client}` : `${project}:${client}:${mailbox}`;
    const id = "lead_" + (await hash(`${scope}:${requestId}`)).slice(0, 48);
    await this.wakeLead();
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
      "INSERT OR IGNORE INTO jobs(id,client,text,state,created,session) VALUES(?,?,?,?,?,?)",
      id,
      client,
      text,
      "queued",
      Date.now(),
      mailbox === client ? null : mailbox,
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
      .exec<StoredMessage>(
        "SELECT * FROM messages WHERE target=? AND seq>? ORDER BY seq LIMIT ?",
        client,
        from,
        limit,
      )
      .toArray();
    return { events, next: events.at(-1)?.seq ?? from };
  }
  /**
   * A session's view: its own mailbox and its client's shared mailbox, each message marked with which one it is in.
   * Mail sent to the client while no session was live is therefore never stranded. Each mailbox keeps its own
   * acknowledgement, and several sessions may see the same shared message (delivery is at-least-once).
   * Sequence numbers are unique across mailboxes, so one cursor orders both.
   */
  private pendingBoth(session: string, client: string, after: number, limit = 50) {
    const sql = this.ctx.storage.sql;
    const ack = (id: string) => sql.exec<{ ack: number }>("SELECT ack FROM receipts WHERE client=?", id).toArray()[0]?.ack ?? 0;
    const own = ack(session),
      shared = ack(client);
    const events = sql
      .exec<StoredMessage>(
        "SELECT * FROM messages WHERE ((target=? AND seq>?) OR (target=? AND seq>?)) AND seq>? ORDER BY seq LIMIT ?",
        session,
        own,
        client,
        shared,
        after,
        limit,
      )
      .toArray()
      .map((e) => ({ ...e, mailbox: e.target === session ? ("session" as const) : ("shared" as const) }));
    return { events, next: events.at(-1)?.seq ?? Math.max(after, own, shared) };
  }
  async read(project: string, client: string, after = 0, session?: string | null) {
    const mailbox = await this.enter(project, client, session);
    return this.fetched(mailbox === client ? this.pending(client, after) : this.pendingBoth(mailbox, client, after));
  }
  private fetched(mail: { events: StoredMessage[]; next: number }) {
    const now = Date.now();
    const events = mail.events.map((event) => {
      this.ctx.storage.sql.exec("UPDATE delivery_receipts SET fetched=coalesce(fetched,?) WHERE id=? AND mailbox=?", now, event.id, event.target);
      const { details, ...value } = event;
      return details ? { ...value, ...JSON.parse(details) as MessageDetails } : value;
    });
    return { ...mail, events };
  }
  /**
   * A narrow credential for a shell command: it can only read what its minter can, this client's shared mailbox
   * or, when minted with a session, that session's view (its own mailbox and the shared one), never another
   * session's. Only its hash is stored. The raw value is returned once.
   */
  async mintWaitToken(project: string, client: string, ttlMinutes: number, session?: string | null) {
    // The token row's `client` column holds the mailbox id: a client id, or a session id.
    client = await this.enter(project, client, session);
    const token =
      "clw_" + Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
    const now = Date.now(),
      expires = now + ttlMinutes * 60_000;
    const digest = await hash(token);
    this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      sql.exec("DELETE FROM wait_tokens WHERE expires<=?", now);
      sql.exec("INSERT INTO wait_tokens(hash,client,expires) VALUES(?,?,?)", digest, client, expires);
      // Minting past the cap drops the oldest: this is also how a client rotates.
      sql.exec(
        "DELETE FROM wait_tokens WHERE client=? AND n NOT IN (SELECT n FROM wait_tokens WHERE client=? ORDER BY n DESC LIMIT ?)",
        client,
        client,
        this.limits.clientTokens,
      );
    });
    return { token, expiresAt: new Date(expires).toISOString() };
  }
  /** The mailbox a wait token stands for. This object is one project, so another project's token is unknown here. */
  async waitTokenOwner(project: string, token: string): Promise<{ client: string; session?: string }> {
    const refused = new Failure(401, "Invalid or expired wait token; mint a new one with the wait_token tool");
    if (!/^clw_[A-Za-z0-9_-]{43}$/.test(token)) throw refused;
    const digest = await hash(token);
    this.expireSessions();
    const sql = this.ctx.storage.sql;
    const row = sql
      .exec<{ client: string }>("SELECT client FROM wait_tokens WHERE hash=? AND expires>?", digest, Date.now())
      .toArray()[0];
    if (!row) throw refused;
    // A removed or suspended client's tokens stop working with it, and an ended session's with the session.
    const clients = this.clients(project);
    if (Object.hasOwn(clients, row.client)) return { client: row.client };
    const session = sql.exec<Session>("SELECT * FROM sessions WHERE id=?", row.client).toArray()[0];
    if (!session || !Object.hasOwn(clients, session.client)) throw refused;
    return { client: session.client, session: session.id };
  }
  /** A token's read checks the token every time, so a wait that outlives its token ends with 401. */
  async waitTokenRead(project: string, token: string, after = 0) {
    const owner = await this.waitTokenOwner(project, token);
    return this.read(project, owner.client, after, owner.session);
  }
  /** Signal this client's waiting requests. Runs after the write that queued it has committed. */
  private flush() {
    const targets = [...this.dirty];
    this.dirty.clear();
    // A session's parked wait also watches its client's shared mailbox.
    for (const client of targets)
      for (const ws of [...this.ctx.getWebSockets(client), ...this.ctx.getWebSockets(`shared:${client}`)]) this.signal(ws);
  }
  /**
   * Internal only. The Worker authenticates the caller, holds its HTTP request and parks this socket here,
   * so this object can hibernate while requests wait. The socket carries a wake-up, never mail.
   */
  async fetch(request: Request) {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket")
      return Response.json({ error: "Not found" }, { status: 404 });
    let wanted: Partial<Socket & { project: string; session: string }> = {};
    try {
      wanted = JSON.parse(request.headers.get("X-Lead-Socket") || "{}");
    } catch {}
    const owner = String(wanted.client || "");
    let client = owner;
    try {
      // From here `client` is the mailbox being watched: the client's own, or one of its sessions.
      client = await this.enter(String(wanted.project || ""), owner, wanted.session);
      const open = (tag?: string) => this.open(tag);
      if (open().length >= this.limits.projectSockets)
        throw new Failure(429, "Too many waiting requests for this project; retry later");
      // Refused, not replaced: waiting commands loop, and replacing one another would never settle.
      // An abandoned wait frees its place when its request ends, at most 50 seconds later.
      if (open(client).length >= this.limits.clientSockets)
        throw new Failure(429, "Too many waiting requests for this client; retry later");
    } catch (error) {
      return Response.json(
        { error: error instanceof Failure ? error.message : "Project operation failed" },
        { status: error instanceof Failure ? error.status : 500 },
      );
    }
    const pair = new WebSocketPair();
    const shared = client === owner ? undefined : owner;
    this.ctx.acceptWebSocket(pair[1], shared ? [client, `shared:${shared}`] : [client]);
    pair[1].serializeAttachment({ client, after: Number(wanted.after) || 0, ...(shared ? { shared } : {}) } satisfies Socket);
    // Mail that arrived between the caller's read and this connect is not missed.
    this.signal(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }
  private signal(ws: WebSocket) {
    try {
      const a = ws.deserializeAttachment() as Socket | null;
      if (
        a &&
        ws.readyState === WebSocket.OPEN &&
        (a.shared ? this.pendingBoth(a.client, a.shared, a.after, 1) : this.pending(a.client, a.after, 1)).events.length
      )
        ws.send("mail");
    } catch {
      // The mailbox is durable; the waiting request reads it when its time is up.
    }
  }
  webSocketMessage() {}
  webSocketClose(ws: WebSocket, code: number) {
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, "Closed");
    } catch {}
  }
  webSocketError() {}
  /**
   * Acknowledge one mailbox through `seq`. A session acknowledges its own mailbox unless it says "shared",
   * which acknowledges its client's shared mailbox for every session of that client.
   */
  async ack(project: string, client: string, seq: number, session?: string | null, box?: "session" | "shared" | null) {
    const mailbox = await this.enter(project, client, session);
    if (box != null && box !== "session" && box !== "shared") throw new Failure(400, 'mailbox must be "session" or "shared"');
    if (box === "session" && mailbox === client)
      throw new Failure(400, "A session id is required to acknowledge a session mailbox");
    // What the caller has seen: its own mailbox and, for a session, the shared one too.
    const max =
      this.ctx.storage.sql
        .exec<{ n: number | null }>(
          "SELECT max(seq) AS n FROM messages WHERE target IN (?,?)",
          mailbox,
          client,
        )
        .one().n || 0;
    if (seq > max) throw new Failure(400, "Cannot acknowledge unseen sequence");
    const acked = box === "shared" ? "shared" : mailbox === client ? undefined : "session";
    client = box === "shared" ? client : mailbox;
    this.ctx.storage.sql.exec(
      "UPDATE receipts SET ack=max(ack,?) WHERE client=?",
      seq,
      client,
    );
    this.ctx.storage.sql.exec(`UPDATE delivery_receipts SET acknowledged=coalesce(acknowledged,?)
      WHERE mailbox=? AND id IN (SELECT id FROM messages WHERE target=? AND seq<=?)`, Date.now(), client, client, seq);
    return { ack: seq, ...(acked ? { mailbox: acked } : {}) };
  }
  /** People, their clients, and each client's named sessions. Ids are what the lead's send_message accepts. */
  participants(project: string) {
    this.expireSessions();
    const iso = (ms?: number) => (ms ? new Date(ms).toISOString() : null);
    const people = new Map<string, { name: string; login?: string; status: "online" | "offline"; clients: unknown[] }>();
    for (const [id, c] of Object.entries(this.clients(project))) {
      const seen = this.ctx.storage.sql
        .exec<{ seen: number }>("SELECT seen FROM receipts WHERE client=?", id)
        .toArray()[0]?.seen;
      const person = people.get(c.key) ?? { name: c.name, ...(c.login ? { login: c.login } : {}), status: "offline", clients: [] };
      people.set(c.key, person);
      const online = this.open(id).length > 0 || this.open(`shared:${id}`).length > 0;
      if (online) person.status = "online";
      person.clients.push({
        status: online ? "online" : "offline",
        id,
        displayName: displayName(c.person, c.label),
        lastSeen: iso(seen),
        sessions: this.sessionsOf(id).map((s) => ({
          id: s.id,
          name: s.name,
          status: this.open(s.id).length > 0 ? "online" : "offline",
          displayName: displayName(c.person, c.label, s.name),
          lastSeen: iso(s.seen),
        })),
      });
    }
    return [...people.values()];
  }
  async sendDirect(project: string, client: string, input: unknown) {
    const args = directInput.parse(input);
    const mailbox = await this.enter(project, client, args.session);
    const id = "direct_" + (await hash(JSON.stringify([project, mailbox, args.messageId]))).slice(0, 48);
    const old = this.ctx.storage.sql.exec<{ details: string }>("SELECT details FROM deliveries WHERE id=?", id).toArray()[0];
    const info = this.clients(project)[client];
    const name = args.session ? this.sessionsOf(client).find((s) => s.id === args.session)?.name : undefined;
    const details: MessageDetails = {
      sender: old ? JSON.parse(old.details).sender : { id: mailbox, client, name: displayName(info.person, info.label, name) },
      attachments: [...new Set(args.attachments)].sort(),
      ...(args.replyTo ? { replyTo: args.replyTo } : {}),
    };
    // Identical retries still succeed after an attachment expires or is deleted.
    if (!old) {
      for (const file of details.attachments) this.accessFile(file, mailbox, client);
      if (args.replyTo) {
        const original = this.ctx.storage.sql.exec<{ details: string | null }>(
          "SELECT details FROM messages WHERE id=? AND target IN (?,?)", args.replyTo, mailbox, client,
        ).toArray()[0];
        if (!original?.details) throw new Failure(404, "Unknown reply message");
        const sender = (JSON.parse(original.details) as MessageDetails).sender;
        if (args.target !== sender.id && args.target !== sender.client)
          throw new Failure(400, "A reply must target the original sender");
      }
    }
    const delivered = await this.send(project, args.target, args.text, id, details, mailbox);
    return { messageId: id, ...delivered };
  }
  async deliveryStatus(project: string, client: string | null, id: string, session?: string) {
    const owner = client === null ? null : await this.enter(project, client, session);
    const row = this.ctx.storage.sql.exec<{ owner: string | null; target: string; recipients: string }>(
      "SELECT owner,target,recipients FROM deliveries WHERE id=?", id,
    ).toArray()[0];
    if (!row || row.owner !== owner) throw new Failure(404, "Unknown message");
    const receipts = this.ctx.storage.sql.exec<{
      target: string; mailbox: string; queued: number; fetched: number | null;
      acknowledged: number | null; replied: number | null; replyId: string | null;
    }>("SELECT target,mailbox,queued,fetched,acknowledged,replied,replyId FROM delivery_receipts WHERE id=? ORDER BY target", `proactive:${id}`).toArray();
    return { messageId: id, target: row.target, trackingAvailable: receipts.length > 0, receipts };
  }
  private accessFile(id: string, mailbox: string, client: string, ownerOnly = false) {
    const file = this.ctx.storage.sql.exec<SharedFile>(
      "SELECT id,owner,name,size,sha256,contentType,created,expires,state FROM files WHERE id=?", id,
    ).toArray()[0];
    const owns = file && (file.owner === mailbox || file.owner === client);
    const granted = !ownerOnly && this.ctx.storage.sql.exec(
      "SELECT 1 FROM file_grants WHERE file=? AND mailbox IN (?,?)", id, mailbox, client,
    ).toArray().length;
    if (!file || (!owns && !granted) || (!ownerOnly && (file.state !== "ready" || file.expires <= Date.now())))
      throw new Failure(404, "Unknown or unavailable file");
    return file;
  }
  private async transferToken(project: string, client: string, mailbox: string, file: SharedFile, mode: "upload" | "download") {
    const token = "clf_" + Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
    const digest = await hash(token);
    // Recheck after hashing, which yields to concurrent deletion or revocation.
    await this.enter(project, client, mailbox === client ? undefined : mailbox);
    const current = this.accessFile(file.id, mailbox, client, mode === "upload");
    if (current.state === "deleted" || current.expires <= Date.now()) throw new Failure(404, "File unavailable");
    this.ctx.storage.sql.exec("DELETE FROM file_tokens WHERE expires<=?", Date.now());
    const expires = Math.min(current.expires, Date.now() + 24 * 3600_000);
    this.ctx.storage.sql.exec("INSERT INTO file_tokens(hash,file,client,mailbox,mode,expires) VALUES(?,?,?,?,?,?)",
      digest, file.id, client, mailbox, mode, expires);
    return { file: current, token, expiresAt: new Date(expires).toISOString() };
  }
  async prepareUpload(project: string, client: string, input: unknown) {
    if (!this.env.FILES) throw new Failure(503, "File storage is not configured");
    const args = uploadInput.parse(input);
    const partSize = args.partSize ?? Math.max(8 * 1024 ** 2, Math.ceil(args.size / 10_000));
    if (args.multipart && (args.size === 0 || partSize > 5 * 1024 ** 3 || Math.ceil(args.size / partSize) > 10_000))
      throw new Failure(400, "Multipart uploads require 1 to 10000 parts of at most 5 GiB");
    const mailbox = await this.enter(project, client, args.session);
    if (await this.ctx.storage.getAlarm() === null) await this.ctx.storage.setAlarm(Date.now() + 60_000);
    const id = "file_" + crypto.randomUUID().replaceAll("-", "");
    const now = Date.now();
    this.ctx.storage.sql.exec("INSERT INTO files(id,owner,name,size,sha256,contentType,created,expires,state) VALUES(?,?,?,?,?,?,?,?,?)",
      id, mailbox, args.name, args.size, args.sha256, args.contentType, now, now + args.ttlDays * 86400_000, "pending");
    const file = this.accessFile(id, mailbox, client, true);
    if (args.multipart) {
      this.ctx.storage.sql.exec("INSERT INTO file_multipart(file,partSize) VALUES(?,?)", id, partSize);
      return this.resumeUpload(project, client, id, args.session);
    }
    return this.transferToken(project, client, mailbox, file, "upload");
  }
  async resumeUpload(project: string, client: string, id: string, session?: string) {
    const mailbox = await this.enter(project, client, session);
    const file = this.accessFile(id, mailbox, client, true);
    if (file.state !== "pending" || file.expires <= Date.now()) throw new Failure(409, "Upload is no longer pending");
    const record = this.ctx.storage.sql.exec<{ uploadId: string | null; partSize: number }>("SELECT * FROM file_multipart WHERE file=?", id).toArray()[0];
    if (!record) throw new Failure(400, "Not a multipart upload");
    if (!record.uploadId) {
      const created = await this.env.FILES.createMultipartUpload(`${project}/${id}`, {
        httpMetadata: { contentType: file.contentType }, customMetadata: { uploadFile: id },
      });
      try {
        const current = this.accessFile(id, mailbox, client, true);
        if (current.state !== "pending" || current.expires <= Date.now())
          throw new Failure(409, "Upload is no longer pending");
        const changed = this.ctx.storage.sql.exec("UPDATE file_multipart SET uploadId=? WHERE file=? AND uploadId IS NULL", created.uploadId, id).rowsWritten;
        if (!changed) await created.abort();
      } catch (error) {
        await created.abort();
        throw error;
      }
    }
    const credentials = await this.transferToken(project, client, mailbox, file, "upload");
    return { ...credentials, multipart: this.multipartStatus(id) };
  }
  multipartStatus(id: string): MultipartStatus | null {
    const record = this.ctx.storage.sql.exec<{ uploadId: string; partSize: number; size: number }>(
      "SELECT m.uploadId,m.partSize,f.size FROM file_multipart m JOIN files f ON f.id=m.file WHERE file=?", id,
    ).toArray()[0];
    if (!record) return null;
    return { uploadId: record.uploadId, partSize: record.partSize, partCount: Math.ceil(record.size / record.partSize),
      parts: this.ctx.storage.sql.exec<{ partNumber: number; etag: string }>("SELECT partNumber,etag FROM file_parts WHERE file=? ORDER BY partNumber", id).toArray() };
  }
  async recordPart(project: string, id: string, token: string, part: R2UploadedPart) {
    const file = await this.fileToken(project, id, token, "upload");
    if (file.state !== "pending") throw new Failure(409, "Upload is no longer pending");
    this.ctx.storage.sql.exec("INSERT INTO file_parts(file,partNumber,etag) VALUES(?,?,?) ON CONFLICT(file,partNumber) DO UPDATE SET etag=excluded.etag", id, part.partNumber, part.etag);
    return part;
  }
  async completeMultipart(project: string, client: string, id: string, session?: string) {
    const mailbox = await this.enter(project, client, session);
    let file = this.accessFile(id, mailbox, client, true);
    if (file.state === "deleted" || file.expires <= Date.now()) throw new Failure(409, "Upload is no longer available");
    if (file.state === "ready") return file;
    const multipart = this.multipartStatus(id);
    if (!multipart?.uploadId) throw new Failure(400, "Not a multipart upload");
    if (multipart.parts.length !== multipart.partCount) throw new Failure(409, "Upload has missing parts");
    const key = `${project}/${id}`;
    // A completed R2 object survives a lost response or room restart. Retry verification safely.
    let object = await this.env.FILES.get(key);
    if (!object) {
      try { await this.env.FILES.resumeMultipartUpload(key, multipart.uploadId).complete(multipart.parts); }
      catch (error) {
        if (!await this.env.FILES.head(key)) throw error;
      }
      object = await this.env.FILES.get(key);
    }
    if (!object || object.customMetadata?.uploadFile !== id) throw new Failure(409, "Upload object unavailable");
    const digest = createHash("sha256");
    let bytes = 0;
    for await (const chunk of object.body) { digest.update(chunk); bytes += chunk.byteLength; }
    if (bytes !== file.size || digest.digest("hex") !== file.sha256) {
      await this.deleteFile(project, client, id, session);
      throw new Failure(400, "Assembled file size or checksum does not match; prepare a new upload");
    }
    await this.enter(project, client, session);
    file = this.accessFile(id, mailbox, client, true);
    if (file.state === "deleted" || file.expires <= Date.now()) throw new Failure(409, "Upload is no longer available");
    this.ctx.storage.sql.exec("UPDATE files SET state='ready' WHERE id=?", id);
    return { ...file, state: "ready" };
  }
  async getFile(project: string, client: string, id: string, session?: string) {
    const mailbox = await this.enter(project, client, session);
    return this.transferToken(project, client, mailbox, this.accessFile(id, mailbox, client), "download");
  }
  async listFiles(project: string, client: string, session?: string, after = "", limit = 100) {
    const mailbox = await this.enter(project, client, session);
    const files = this.ctx.storage.sql.exec<SharedFile>(`SELECT id,owner,name,size,sha256,contentType,created,expires,state FROM files
      WHERE id>? AND state='ready' AND expires>? AND (owner IN (?,?) OR id IN
      (SELECT file FROM file_grants WHERE mailbox IN (?,?))) ORDER BY id LIMIT ?`,
      after, Date.now(), mailbox, client, mailbox, client, limit + 1).toArray();
    return { files: files.slice(0, limit), next: files.length > limit ? files[limit - 1].id : null };
  }
  async deleteFile(project: string, client: string, id: string, session?: string) {
    const mailbox = await this.enter(project, client, session);
    const file = this.accessFile(id, mailbox, client, true);
    if (await this.ctx.storage.getAlarm() === null) await this.ctx.storage.setAlarm(Date.now() + 60_000);
    this.ctx.storage.sql.exec("UPDATE files SET state='deleted',expires=min(expires,?) WHERE id=?", Date.now(), id);
    this.ctx.storage.sql.exec("DELETE FROM file_tokens WHERE file=?", id);
    const multipart = this.multipartStatus(id);
    if (multipart?.uploadId) await this.env.FILES.resumeMultipartUpload(`${project}/${id}`, multipart.uploadId).abort();
    await this.env.FILES.delete(`${project}/${file.id}`);
    return { deleted: id };
  }
  async fileToken(project: string, id: string, token: string, mode: "upload" | "download") {
    if (!/^clf_[A-Za-z0-9_-]{43}$/.test(token)) throw new Failure(401, "Invalid file token");
    const digest = await hash(token);
    const row = this.ctx.storage.sql.exec<{ client: string; mailbox: string }>(
      "SELECT client,mailbox FROM file_tokens WHERE hash=? AND file=? AND mode=? AND expires>?", digest, id, mode, Date.now(),
    ).toArray()[0];
    if (!row) throw new Failure(401, "Invalid or expired file token");
    await this.enter(project, row.client, row.mailbox === row.client ? undefined : row.mailbox);
    const file = this.accessFile(id, row.mailbox, row.client, mode === "upload");
    if (file.state === "deleted" || file.expires <= Date.now()) throw new Failure(404, "File unavailable");
    return file;
  }
  async completeUpload(project: string, id: string, token: string) {
    const file = await this.fileToken(project, id, token, "upload");
    const updated = this.ctx.storage.sql.exec(
      "UPDATE files SET state='ready' WHERE id=? AND state!='deleted' AND expires>?", id, Date.now(),
    ).rowsWritten;
    if (!updated) throw new Failure(404, "File unavailable");
    return { ...file, state: "ready" };
  }
  private async cleanupFiles(project: string) {
    const now = Date.now();
    this.ctx.storage.sql.exec("DELETE FROM file_tokens WHERE expires<=?", now);
    const files = this.ctx.storage.sql.exec<SharedFile>(
      "SELECT * FROM files WHERE cleaned<=? AND (state='deleted' OR expires<=?) ORDER BY cleaned,id LIMIT 25",
      now - 3600_000, now,
    ).toArray();
    for (const file of files) {
      this.ctx.storage.sql.exec("UPDATE files SET state='deleted',expires=min(expires,?) WHERE id=?", now, file.id);
      const multipart = this.multipartStatus(file.id);
      if (multipart?.uploadId) await this.env.FILES.resumeMultipartUpload(`${project}/${file.id}`, multipart.uploadId).abort();
      await this.env.FILES.delete(`${project}/${file.id}`);
      this.ctx.storage.sql.exec("DELETE FROM file_parts WHERE file=?", file.id);
      this.ctx.storage.sql.exec("DELETE FROM file_multipart WHERE file=?", file.id);
      this.ctx.storage.sql.exec("UPDATE files SET cleaned=? WHERE id=?", now, file.id);
      this.ctx.storage.sql.exec("DELETE FROM file_tokens WHERE file=?", file.id);
      this.ctx.storage.sql.exec("DELETE FROM file_grants WHERE file=?", file.id);
      // Keep a tombstone for late uploads, and retry removal throughout that window.
      if (file.expires < now - 86400_000) this.ctx.storage.sql.exec("DELETE FROM files WHERE id=?", file.id);
    }
    return files.length === 25;
  }
  async send(project: string, target: string, text: string, id: string, details: MessageDetails | null = null, owner: string | null = null) {
    const p = config(this.env, project);
    const encoded = details ? JSON.stringify(details) : null;
    const previous = this.ctx.storage.sql.exec<{ target: string; text: string; recipients: string; details: string | null; owner: string | null }>("SELECT * FROM deliveries WHERE id=?", id).toArray()[0];
    if (previous) {
      if (previous.target !== target || previous.text !== text || previous.details !== encoded || previous.owner !== owner) throw new Failure(409, "messageId already used for another message");
      // Freeze the original recipient set. A retry must not fan out to newly enrolled clients.
      return { deliveredToMailboxes: JSON.parse(previous.recipients) as string[] };
    }
    const now = Date.now();
    this.expireSessions(now);
    const clients = this.clients(project);
    // A client's message is copied to each of its live sessions, or kept in the shared client mailbox
    // (which every one of its sessions reads) when it has none.
    const boxes = (client: string) => {
      const live = this.liveSessions(client, now).map((s) => s.id);
      return live.length ? live : [client];
    };
    let targets: string[];
    if (target === "all") targets = Object.keys(clients).flatMap(boxes);
    else if (Object.hasOwn(clients, target)) targets = boxes(target);
    else {
      const session = this.ctx.storage.sql.exec<Session>("SELECT * FROM sessions WHERE id=?", target).toArray()[0];
      if (!session || !Object.hasOwn(clients, session.client)) throw new Failure(404, "Unknown target");
      targets = [session.id];
    }
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
      for (const t of targets) {
        this.insert(`proactive:${id}`, t, text, "message", null, details);
        this.ctx.storage.sql.exec("INSERT INTO delivery_receipts(id,target,mailbox,queued) VALUES(?,?,?,?)", `proactive:${id}`, t, t, now);
        for (const file of details?.attachments ?? [])
          this.ctx.storage.sql.exec("INSERT OR IGNORE INTO file_grants(file,mailbox) VALUES(?,?)", file, t);
      }
      this.ctx.storage.sql.exec("INSERT INTO deliveries(id,target,text,recipients,details,owner) VALUES(?,?,?,?,?,?)", id, target, text, JSON.stringify(targets), encoded, owner);
      if (details?.replyTo) this.ctx.storage.sql.exec(
        "UPDATE delivery_receipts SET replied=coalesce(replied,?),replyId=coalesce(replyId,?) WHERE id=? AND mailbox IN (?,?)",
        now, `proactive:${id}`, details.replyTo, owner, details.sender.client);
    });
    return { deliveredToMailboxes: targets };
  }
  private insert(
    id: string,
    target: string,
    text: string,
    kind: string,
    requestId: string | null,
    details: MessageDetails | null = null,
  ) {
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO messages(id,target,text,kind,requestId,created,details) VALUES(?,?,?,?,?,?,?)",
      id,
      target,
      text.slice(0, 16_000),
      kind,
      requestId,
      Date.now(),
      details ? JSON.stringify(details) : null,
    );
    this.notify(target);
  }
  private notify(mailbox: string) {
    // A microtask runs after the enclosing synchronous transaction commits.
    if (!this.dirty.size) queueMicrotask(() => this.flush());
    this.dirty.add(mailbox);
  }
  /** Where a job's reply goes: the session that asked while it still exists, otherwise its client's mailbox. */
  private replyBox(job: Job) {
    return job.session &&
      this.ctx.storage.sql.exec("SELECT 1 FROM sessions WHERE id=? AND client=?", job.session, job.client).toArray().length
      ? job.session
      : job.client;
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
    // Arm recovery before R2 I/O. File expiry and job delivery share this room's alarm.
    const hasFiles = this.ctx.storage.sql.exec("SELECT 1 FROM files LIMIT 1").toArray().length > 0;
    if (hasFiles) {
      await this.ctx.storage.setAlarm(Date.now() + 3600_000);
      try {
        if (await this.cleanupFiles(project)) await this.ctx.storage.setAlarm(Date.now() + 5000);
      } catch {
        console.error(JSON.stringify({ event: "file_cleanup_failed", project }));
        await this.ctx.storage.setAlarm(Date.now() + 60_000);
      }
    }
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
        const session = job.session
          ? this.ctx.storage.sql.exec<Session>("SELECT * FROM sessions WHERE id=? AND client=?", job.session, job.client).toArray()[0]
          : undefined;
        let result: any;
        if (job.state === "queued") {
          result = await this.runtime(
            `/v1/agents/${p.agentId}/prompt`,
            "POST",
            {
              text: job.text,
              requestId: job.id,
              // The lead sees who is speaking, and from.id is a valid send_message target.
              from: { id: session?.id ?? job.client, name: displayName(client.person, client.label, session?.name) },
              metadata: { source: "camel-lead", client: job.client, project, ...(session ? { session: session.id } : {}), ...(job.event ? { event: job.event } : {}) },
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
            if (!job.event || r.reply || outcome.error || r.error || r.stopped === "input_required") this.insert(
              `reply:${job.id}`,
              this.replyBox(job),
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
              this.replyBox(job),
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
