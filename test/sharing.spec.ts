import { env, exports } from "cloudflare:workers";
import { reset, runInDurableObject, runDurableObjectAlarm, evictDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { hash, rpc } from "../src/types.ts";
import type { ProjectRoom } from "../src/room.ts";

const alice = "alice-test-only", bob = "bob-test-only";
const room = () => env.PROJECTS.getByName("demo");
const request = (path: string, token = alice, body?: unknown, project = "demo") =>
  exports.default.fetch(`https://lead.test/projects/${project}/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
async function tool(name: string, args: unknown, token = alice) {
  const response = await request("mcp", token, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  const result = (await response.json<any>()).result;
  if (result.isError) throw new Error(result.content[0].text);
  return JSON.parse(result.content[0].text);
}
const join = async (name: string, token = alice) => (await tool("join", { name }, token)).session as string;
const read = (session?: string, token = bob) => tool("get_messages", { session }, token);
const status = (messageId: string, session?: string) => tool("message_status", { messageId, session });
async function upload(content = "hello", session?: string) {
  const prepared = await tool("prepare_upload", { name: "report.txt", size: new TextEncoder().encode(content).length, sha256: await hash(content), session });
  const response = await transfer(prepared, "PUT", content);
  expect(response.status).toBe(200);
  return prepared;
}
function transfer(prepared: { url: string; token: string }, method = "GET", content?: string) {
  return exports.default.fetch(prepared.url, {
    method,
    headers: { Authorization: `Bearer ${prepared.token}`, ...(content === undefined ? {} : { "Content-Length": String(new TextEncoder().encode(content).length) }) },
    body: content,
  });
}
afterEach(async () => { await reset(); });

describe("direct messaging and receipts", () => {
  it("routes directly with verified sender identity, stable retries and independent delivery receipts", async () => {
    const a = await join("sender"), b = await join("receiver", bob);
    const args = { target: b, text: "hello", messageId: "hello", session: a };
    const sent = await tool("send_message", args);
    expect(sent.deliveredToMailboxes).toEqual([b]);
    expect(await tool("send_message", args)).toEqual(sent);
    await expect(tool("send_message", { ...args, text: "changed" })).rejects.toThrow();
    let receipts = (await status(sent.messageId, a)).receipts;
    expect(receipts).toEqual([{ target: b, mailbox: b, queued: expect.any(Number), fetched: null, acknowledged: null, replied: null, replyId: null }]);
    const mail = await read(b);
    expect(mail.events).toHaveLength(1);
    expect(mail.events[0]).toMatchObject({ text: "hello", sender: { id: a, client: "alice", name: "Alice's agent · sender" }, attachments: [] });
    expect((await status(sent.messageId, a)).receipts[0].fetched).toBeTypeOf("number");
    expect((await status(sent.messageId, a)).receipts[0].acknowledged).toBeNull();
    await tool("acknowledge", { seq: mail.next, session: b }, bob);
    expect((await status(sent.messageId, a)).receipts[0].acknowledged).toBeTypeOf("number");
    const reply = await tool("send_message", { target: a, text: "received", messageId: "reply", session: b, replyTo: mail.events[0].id }, bob);
    receipts = (await status(sent.messageId, a)).receipts;
    expect(receipts[0]).toMatchObject({ replied: expect.any(Number), replyId: `proactive:${reply.messageId}` });
    expect((await read(a, alice)).events[0].replyTo).toBe(mail.events[0].id);
    await expect(tool("message_status", { messageId: sent.messageId }, bob)).rejects.toThrow();
    await expect(tool("message_status", { messageId: sent.messageId })).rejects.toThrow();
  });
  it("freezes fan-out on retry and scopes ids by sender session", async () => {
    const a = await join("a"), a2 = await join("a2");
    const sent = await tool("send_message", { target: "bob", text: "shared", messageId: "same", session: a });
    expect(sent.deliveredToMailboxes).toEqual(["bob"]);
    const b = await join("later", bob);
    expect(await tool("send_message", { target: "bob", text: "shared", messageId: "same", session: a })).toEqual(sent);
    const mail = await read(b);
    expect(mail.events[0].mailbox).toBe("shared");
    const sent2 = await tool("send_message", { target: "bob", text: "session", messageId: "same", session: a2 });
    expect(sent2.messageId).not.toBe(sent.messageId);
    expect(sent2.deliveredToMailboxes).toEqual([b]);
    await tool("acknowledge", { seq: mail.next, session: b, mailbox: "shared" }, bob);
    expect((await status(sent.messageId, a)).receipts[0].acknowledged).toBeTypeOf("number");
    expect((await status(sent2.messageId, a2)).receipts[0].acknowledged).toBeNull();
  });
  it("marks fetched through a wait token and retains receipts when a recipient session retires", async () => {
    const b = await join("receiver", bob);
    const sent = await tool("send_message", { target: b, text: "survives", messageId: "retire" });
    const wait = await tool("wait_token", { session: b }, bob);
    expect((await request("wait?timeout=0", wait.token)).status).toBe(200);
    expect((await status(sent.messageId)).receipts[0].fetched).toBeTypeOf("number");
    await runInDurableObject(room(), (_o: ProjectRoom, state) => {
      state.storage.sql.exec("UPDATE sessions SET seen=? WHERE id=?", Date.now() - 8 * 86400_000, b);
    });
    await tool("participants", {});
    const mail = await read();
    expect(mail.events[0].text).toBe("survives");
    await tool("acknowledge", { seq: mail.next }, bob);
    expect((await status(sent.messageId)).receipts[0]).toMatchObject({ target: b, mailbox: "bob", acknowledged: expect.any(Number) });
    await evictDurableObject(room());
    expect((await status(sent.messageId)).receipts[0].acknowledged).toBeTypeOf("number");
  });
  it("rejects other sessions, unknown recipients, unrelated replies and cross-project ids", async () => {
    const b = await join("receiver", bob);
    await expect(tool("send_message", { target: "missing", text: "x", messageId: "x" })).rejects.toThrow();
    await expect(tool("send_message", { target: "bob", text: "x", messageId: "x", session: b })).rejects.toThrow();
    const sent = await tool("send_message", { target: b, text: "hello", messageId: "x" });
    const incoming = (await read(b)).events[0];
    await expect(tool("send_message", { target: "bob", text: "x", messageId: "wrong", session: b, replyTo: incoming.id }, bob)).rejects.toThrow();
    const response = await request("message-status", alice, { messageId: sent.messageId }, "other");
    expect(response.status).toBe(404);
    const jobs = await runInDurableObject(room(), (_o: ProjectRoom, state) => state.storage.sql.exec("SELECT * FROM jobs WHERE event IS NULL").toArray());
    expect(jobs).toEqual([]);
  });
});

describe("file sharing", () => {
  it("issues day-long credentials and preserves unfinished uploads until file expiry", async () => {
    const before = Date.now();
    const prepared = await tool("prepare_upload", { name: "slow.txt", size: 5, sha256: await hash("hello") });
    expect(Date.parse(prepared.expiresAt)).toBeGreaterThanOrEqual(before + 24 * 3600_000);
    expect(Date.parse(prepared.expiresAt)).toBeLessThanOrEqual(Date.now() + 24 * 3600_000);
    await runInDurableObject(room(), (_o: ProjectRoom, state) => {
      state.storage.sql.exec("UPDATE files SET created=? WHERE id=?", Date.now() - 2 * 3600_000, prepared.file.id);
    });
    await runDurableObjectAlarm(room());
    expect((await transfer(prepared, "PUT", "hello")).status).toBe(200);
    const download = await tool("get_file", { fileId: prepared.file.id });
    expect(Date.parse(download.expiresAt)).toBeGreaterThanOrEqual(before + 24 * 3600_000);
    expect(await (await transfer(download)).text()).toBe("hello");

    const expiring = await tool("prepare_upload", { name: "expired.txt", size: 0, sha256: await hash(""), ttlDays: 1 });
    expect(Date.parse(expiring.expiresAt)).toBe(expiring.file.expires);
    await runInDurableObject(room(), (_o: ProjectRoom, state) => {
      state.storage.sql.exec("UPDATE files SET expires=? WHERE id=?", Date.now() - 1, expiring.file.id);
    });
    await runDurableObjectAlarm(room());
    expect((await transfer(expiring, "PUT", "")).ok).toBe(false);
  });
  it("transfers binary content with concurrent, idempotent uploads", async () => {
    const content = new Uint8Array([0, 255, 128, 1, 13, 10]);
    const digest = Buffer.from(await crypto.subtle.digest("SHA-256", content)).toString("hex");
    const prepared = await tool("prepare_upload", { name: "binary.dat", size: content.length, sha256: digest });
    const put = () => exports.default.fetch(prepared.url, {
      method: "PUT", headers: { Authorization: `Bearer ${prepared.token}`, "Content-Length": String(content.length) }, body: content,
    });
    expect((await Promise.all([put(), put()])).map((response) => response.status)).toEqual([200, 200]);
    const download = await tool("get_file", { fileId: prepared.file.id });
    expect(new Uint8Array(await (await transfer(download)).arrayBuffer())).toEqual(content);
    await runInDurableObject(room(), (_o: ProjectRoom, state) => {
      state.storage.sql.exec("UPDATE file_tokens SET expires=0");
    });
    expect((await transfer(download)).status).toBe(401);
    const refreshed = await transfer(await tool("get_file", { fileId: prepared.file.id }));
    expect(refreshed.status).toBe(200);
    expect(new Uint8Array(await refreshed.arrayBuffer())).toEqual(content);
  });
  it("uploads immutable bytes, grants attached files to recipients and downloads using narrow tokens", async () => {
    const a = await join("sender"), b = await join("receiver", bob), other = await join("other", bob);
    const prepared = await upload("hello", a);
    expect(await transfer(prepared, "PUT", "hello").then((r) => r.status)).toBe(200);
    expect((await tool("list_files", { session: a })).files).toHaveLength(1);
    await expect(tool("get_file", { fileId: prepared.file.id, session: b }, bob)).rejects.toThrow();
    const sent = await tool("send_message", { target: b, text: "review", messageId: "file", attachments: [prepared.file.id], session: a });
    expect((await read(b)).events[0].attachments).toEqual([prepared.file.id]);
    const download = await tool("get_file", { fileId: prepared.file.id, session: b }, bob);
    const response = await transfer(download);
    expect(response.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(new TextDecoder().decode(await response.arrayBuffer())).toBe("hello");
    expect((await transfer(download, "PUT", "hello")).status).toBe(401);
    expect((await transfer(prepared)).status).toBe(401);
    await expect(tool("get_file", { fileId: prepared.file.id, session: other }, bob)).rejects.toThrow();
    await expect(tool("delete_file", { fileId: prepared.file.id, session: b }, bob)).rejects.toThrow();
    await expect(tool("send_message", { target: a, text: "invalid", messageId: "invalid", attachments: [prepared.file.id], session: other }, bob)).rejects.toThrow();
    expect((await status(sent.messageId, a)).receipts[0].fetched).toBeTypeOf("number");
  });
  it("validates size and checksum, excludes pending files, and rejects cross-file or cross-project transfer tokens", async () => {
    const missingBody = await tool("prepare_upload", { name: "missing", size: 1, sha256: await hash("") });
    const absent = await exports.default.fetch(missingBody.url, {
      method: "PUT", headers: { Authorization: `Bearer ${missingBody.token}`, "Content-Length": "1" },
    });
    expect(absent.status).toBe(400);
    expect(await env.FILES.head(`demo/${missingBody.file.id}`)).toBeNull();
    const prepared = await tool("prepare_upload", { name: "x", size: 5, sha256: await hash("hello") });
    expect((await tool("list_files", {})).files).toEqual([]);
    await expect(tool("send_message", { target: "bob", text: "x", messageId: "pending", attachments: [prepared.file.id] })).rejects.toThrow();
    expect((await transfer(prepared, "PUT", "shorter")).status).toBe(400);
    expect((await transfer(prepared, "PUT", "wrong")).ok).toBe(false);
    expect(await env.FILES.head(`demo/${prepared.file.id}`)).toBeNull();
    expect((await transfer({ ...prepared, url: prepared.url.replace("/demo/", "/other/") }, "PUT", "hello")).status).toBe(401);
    const second = await tool("prepare_upload", { name: "y", size: 5, sha256: await hash("hello") });
    expect((await transfer({ ...prepared, url: second.url }, "PUT", "hello")).status).toBe(401);
    expect((await transfer(prepared, "PUT", "hello")).status).toBe(200);
    expect((await transfer(prepared, "PUT", "other")).ok).toBe(false);
    const download = await tool("get_file", { fileId: prepared.file.id });
    expect(new TextDecoder().decode(await (await transfer(download)).arrayBuffer())).toBe("hello");
  });
  it("supports shared-client grants, forwarded attachments, pagination, expiry and deletion", async () => {
    const first = await upload("one"), second = await upload("two");
    const page = await tool("list_files", { limit: 1 });
    expect(page.files).toHaveLength(1);
    expect((await tool("list_files", { limit: 1, after: page.next })).files).toHaveLength(1);
    await tool("send_message", { target: "bob", text: "shared", messageId: "share", attachments: [first.file.id] });
    const b = await join("later", bob);
    const download = await tool("get_file", { fileId: first.file.id, session: b }, bob);
    expect(new TextDecoder().decode(await (await transfer(download)).arrayBuffer())).toBe("one");
    await tool("send_message", { target: "alice", text: "forward", messageId: "forward", session: b, attachments: [first.file.id] }, bob);
    await tool("delete_file", { fileId: first.file.id });
    expect((await transfer(download)).ok).toBe(false);
    expect(await env.FILES.head(`demo/${first.file.id}`)).toBeNull();
    await tool("delete_file", { fileId: first.file.id });
    // Retries never re-grant deleted files or create another message.
    await tool("send_message", { target: "bob", text: "shared", messageId: "share", attachments: [first.file.id] });
    await runInDurableObject(room(), (_o: ProjectRoom, state) => {
      state.storage.sql.exec("UPDATE files SET expires=? WHERE id=?", Date.now() - 1, second.file.id);
      state.storage.sql.exec("DELETE FROM jobs");
    });
    await expect(tool("get_file", { fileId: second.file.id })).rejects.toThrow();
    await runDurableObjectAlarm(room());
    expect(await env.FILES.head(`demo/${second.file.id}`)).toBeNull();
    expect((await tool("list_files", {})).files).toEqual([]);
  });
  it("uses the same REST entry points, admits large files and rejects malformed input", async () => {
    const preparedResponse = await request("prepare-upload", alice, { name: "safe.txt", size: 0, sha256: await hash("") });
    expect(preparedResponse.status).toBe(200);
    const prepared = await preparedResponse.json<any>();
    expect((await transfer(prepared, "PUT", "")).status).toBe(200);
    const sent = await request("send", alice, { target: "bob", messageId: "rest", text: "file", attachments: [prepared.file.id] });
    expect(sent.status).toBe(202);
    expect((await request("get-file", bob, { fileId: prepared.file.id })).status).toBe(200);
    expect((await request("list-files", bob, {})).status).toBe(200);
    expect((await request("prepare-upload", alice, { name: "../x", size: 0, sha256: await hash("") })).status).toBe(400);
    expect((await request("prepare-upload", alice, { name: "x", size: 10 * 1024 * 1024 * 1024, sha256: await hash("") })).status).toBe(200);
    expect((await request("delete-file", alice, { fileId: prepared.file.id })).status).toBe(200);
    expect((await request("send", "bad", { target: "bob", text: "x", messageId: "x" })).status).toBe(401);
  });
  it("continues delivering lead jobs when file cleanup fails", async () => {
    await upload();
    const submitted = await tool("message", { text: "still deliver", requestId: "cleanup-failure" });
    await runInDurableObject(room(), async (object: ProjectRoom) => {
      const internal = object as any;
      const cleanup = internal.cleanupFiles, runtime = internal.runtime;
      internal.cleanupFiles = async () => { throw new Error("Temporary storage failure"); };
      internal.runtime = async () => ({ state: "completed", outcome: { result: { reply: "delivered" } } });
      try { await object.alarm(); }
      finally { internal.cleanupFiles = cleanup; internal.runtime = runtime; }
    });
    expect((await read(undefined, alice)).events).toContainEqual(expect.objectContaining({ text: "delivered", requestId: submitted.requestId }));
  });
});

it("migrates existing messages and deliveries without rewriting their data", async () => {
  await rpc(room(), "send", "demo", "bob", "before upgrade", "old");
  await runInDurableObject(room(), (_o: ProjectRoom, state) => {
    state.storage.sql.exec("ALTER TABLE messages DROP COLUMN details");
    state.storage.sql.exec("ALTER TABLE deliveries DROP COLUMN details");
    state.storage.sql.exec("ALTER TABLE deliveries DROP COLUMN owner");
    state.storage.sql.exec("DROP TABLE delivery_receipts");
  });
  await evictDurableObject(room());
  expect((await read()).events[0]).toMatchObject({ id: "proactive:old", text: "before upgrade" });
  expect(await rpc(room(), "deliveryStatus", "demo", null, "old")).toMatchObject({ trackingAvailable: false, receipts: [] });
  const sent = await tool("send_message", { target: "bob", text: "after upgrade", messageId: "new" });
  expect((await status(sent.messageId)).receipts).toHaveLength(1);
});
