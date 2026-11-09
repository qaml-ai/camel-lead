/**
 * Block until the project lead has mail for this client, print it, and exit.
 * Exit 0: messages printed, one JSON object per line. Exit 2: timeout, nothing arrived. Exit 1: error.
 * Run it as a background shell command: the agent sleeps, spending nothing, and its exit is the wake-up.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { HttpError, LeadClient, externalText, type Event } from "./api.ts";

const USAGE =
  "Usage: wait.ts PROJECT [--timeout SECONDS] [--after SEQ] [--ack] [--poll]";
const args = process.argv.slice(2);
let project = "",
  timeout = 0,
  after = 0,
  ack = false,
  poll = false;
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  const number = () => {
    const n = Number(args[++i]);
    if (!Number.isSafeInteger(n) || n < 0) fail(USAGE);
    return n;
  };
  if (arg === "--timeout") timeout = number();
  else if (arg === "--after") after = number();
  else if (arg === "--ack") ack = true;
  else if (arg === "--poll") poll = true;
  else if (!arg.startsWith("-") && !project) project = arg;
  else fail(USAGE);
}
if (!project) fail(USAGE);
function fail(message: string): never {
  process.stderr.write(message + "\n");
  process.exit(1);
}

const base = (process.env.CAMEL_LEAD_URL || "http://127.0.0.1:8787").replace(/\/$/, "");
const token = process.env.CAMEL_LEAD_TOKEN || "";
const client = new LeadClient(base, project, token);
const deadline = timeout ? Date.now() + timeout * 1000 : Infinity;
const remaining = () => deadline - Date.now();
type Outcome = Event[] | "timeout" | "dropped" | "unavailable";

/** Idle sockets let the server hibernate. "dropped" = it worked for a while; "unavailable" = it never did. */
function viaSocket(): Promise<Outcome> {
  return new Promise((resolve) => {
    const started = Date.now();
    let opened = false,
      pong = Date.now(),
      ws: WebSocket;
    const done = (outcome: Outcome) => {
      clearInterval(ping);
      clearTimeout(timer);
      clearTimeout(connecting);
      try {
        ws.close();
      } catch {}
      resolve(outcome);
    };
    const lost = () =>
      done(opened && Date.now() - started > 5000 ? "dropped" : "unavailable");
    const timer = Number.isFinite(deadline)
      ? setTimeout(() => done("timeout"), Math.min(Math.max(0, remaining()), 2 ** 31 - 1))
      : undefined;
    // The server answers "ping" without waking. Silence means a dead connection.
    const ping = setInterval(() => {
      if (Date.now() - pong > 75_000) return lost();
      try {
        ws.send("ping");
      } catch {
        lost();
      }
    }, 30_000);
    try {
      // Node's WebSocket accepts request headers; a browser's would not.
      ws = new (WebSocket as any)(
        `${base.replace(/^http/, "ws")}/projects/${encodeURIComponent(project)}/ws?after=${after}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
    } catch {
      return done("unavailable");
    }
    const connecting = setTimeout(() => opened || lost(), 15_000);
    ws.onopen = () => {
      opened = true;
      clearTimeout(connecting);
    };
    ws.onmessage = (message) => {
      if (message.data === "pong") {
        pong = Date.now();
        return;
      }
      try {
        const frame = JSON.parse(String(message.data));
        if (frame.type === "messages" && frame.events?.length) done(frame.events);
        // Mail is waiting but must be fetched by a freshly authenticated request.
        else if (frame.type === "reauthenticate") done("unavailable");
      } catch {}
    };
    ws.onerror = lost;
    ws.onclose = lost;
  });
}

/** Chained blocking reads. Works anywhere HTTPS does. */
async function viaPolling(): Promise<Outcome> {
  let failures = 0;
  for (;;) {
    const left = remaining();
    if (left <= 0) return "timeout";
    const started = Date.now();
    let pause = 0;
    try {
      const seconds = Math.max(1, Math.min(50, Math.ceil(left / 1000)));
      const mail = await client.wait(seconds, after);
      if (mail.events.length) return mail.events;
      failures = 0;
      // An early empty answer (replaced wait, restarted server) must not become a busy loop.
      if (Date.now() - started < 1000) pause = 2000;
    } catch (error) {
      if (error instanceof HttpError && error.status < 500 && error.status !== 429)
        throw error;
      pause = Math.min(30_000, 1000 * 2 ** ++failures);
    }
    if (pause) await sleep(Math.min(pause, Math.max(0, remaining())));
  }
}

try {
  let outcome: Outcome = poll ? "unavailable" : await viaSocket();
  while (outcome === "dropped") {
    await sleep(Math.min(2000, Math.max(0, remaining())));
    outcome = await viaSocket();
  }
  if (outcome === "unavailable") outcome = await viaPolling();
  if (typeof outcome === "string") {
    process.stderr.write("No messages before the timeout.\n");
    process.exitCode = 2;
  } else {
    const lines = outcome
      .map((event) =>
        JSON.stringify({
          seq: event.seq,
          id: event.id,
          kind: event.kind,
          requestId: event.requestId,
          text: externalText(event),
        }),
      )
      .join("\n");
    await new Promise<void>((resolve, reject) =>
      process.stdout.write(lines + "\n", (error) => (error ? reject(error) : resolve())),
    );
    // Only after the output is written. A crash in between repeats a message, never loses one.
    if (ack)
      await client.ack(outcome.at(-1)!.seq).catch(() => {
        process.stderr.write("Acknowledgement failed; these messages will be delivered again.\n");
      });
    process.exitCode = 0;
  }
} catch (error) {
  process.stderr.write(
    (error instanceof Error ? error.message : "Waiting failed") + "\n",
  );
  process.exitCode = 1;
}
// Do not linger on a socket's closing handshake: the exit is the wake-up signal. Output is already flushed.
process.exit();
