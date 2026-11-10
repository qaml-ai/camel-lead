import { timingSafeEqual } from "node:crypto";
import { verifyRuntimeToken } from "@camelai/run/server";
export interface ClientConfig {
  name: string;
  tokenHash?: string;
  github?: { userId: string; oauthClientId: string };
}
export interface ProjectConfig {
  agentId: string;
  tenantId: string;
  clients: Record<string, ClientConfig>;
  /** Opt-in only. Active qaml-ai membership is still required on every request. */
  githubAutoEnroll?: {
    enabled: boolean;
    maxClientsPerUser?: number;
    blockedClientIds?: string[];
  };
}
export type Message = {
  seq: number;
  id: string;
  target: string;
  text: string;
  kind: string;
  requestId: string | null;
  created: number;
  /** Only on a session's read: whether the message is in the session's own mailbox or its client's shared one. */
  mailbox?: "session" | "shared";
};
export type Job = {
  id: string;
  client: string;
  text: string;
  state: string;
  attempts: number;
  created: number;
  /** The session that asked, when the message was sent with one. Null for the client mailbox. */
  session: string | null;
  event: "session_joined" | "session_returned" | null;
};
export interface Secrets {
  CAMELRUN_API_KEY: string;
  PROJECTS_JSON: string;
  OAUTH_KV?: KVNamespace;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  RUNTIME?: Fetcher;
  CAMELRUN_ISSUER?: string;
}
export type WorkerEnv = Env & Secrets;
export class Failure extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export async function boundedJson(
  request: Request,
  max = 64_000,
): Promise<any> {
  if (Number(request.headers.get("content-length") || 0) > max)
    throw new Failure(413, "Request too large");
  const reader = request.body?.getReader();
  if (!reader) throw new Failure(400, "JSON body required");
  let size = 0,
    text = "";
  const decoder = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      throw new Failure(413, "Request too large");
    }
    text += decoder.decode(value, { stream: true });
  }
  try {
    return JSON.parse(text + decoder.decode());
  } catch {
    throw new Failure(400, "Invalid JSON");
  }
}
export function config(env: WorkerEnv, project: string): ProjectConfig {
  const all = JSON.parse(env.PROJECTS_JSON || "{}") as Record<
    string,
    ProjectConfig
  >;
  const p = Object.hasOwn(all, project) ? all[project] : undefined;
  if (!p || !/^client_[a-f0-9]{40}$/.test(p.agentId))
    throw new Failure(404, "Unknown project");
  return p;
}
export async function hash(value: string) {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}
export async function matches(value: string, expected: string) {
  const digest = await hash(value);
  const a = new TextEncoder().encode(digest),
    b = new TextEncoder().encode(expected.padEnd(64, "0").slice(0, 64));
  return timingSafeEqual(a, b) && /^[a-f0-9]{64}$/.test(expected);
}
export async function clientAuth(request: Request, p: ProjectConfig) {
  const token =
    request.headers.get("authorization")?.replace(/^Bearer /, "") || "";
  if (!token) throw new Failure(401, "Bearer credential required");
  for (const [id, client] of Object.entries(p.clients))
    if (client.tokenHash && await matches(token, client.tokenHash)) return id;
  throw new Failure(401, "Invalid client credential");
}
/** camelRun signs each request; the adapter stores no lead private/shared key. */
export async function leadAuth(
  request: Request,
  p: ProjectConfig,
  env: WorkerEnv,
  project: string,
) {
  const token = /^Bearer\s+(\S+)$/i.exec(
    request.headers.get("authorization") || "",
  )?.[1];
  if (!token || !p.tenantId)
    throw new Failure(401, "Runtime identity required");
  try {
    const audience = `${env.CAMEL_LEAD_URL.replace(/\/+$/, "")}/agent/${project}/mcp`;
    const identity = await verifyRuntimeToken(token, {
      runtime: env.CAMELRUN_URL,
      tenant: p.tenantId,
      audience,
      ...(env.CAMELRUN_ISSUER ? { issuer: env.CAMELRUN_ISSUER } : {}),
      ...(env.RUNTIME
        ? {
            fetch: (input: RequestInfo | URL, init?: RequestInit) =>
              env.RUNTIME!.fetch(new Request(input, init)),
          }
        : {}),
    });
    if (identity.agent !== p.agentId || identity.context.project !== project)
      throw new Error("Not this project's lead");
    return identity;
  } catch {
    throw new Failure(401, "Invalid runtime identity");
  }
}

export async function rpc(
  room: { invoke(operation: string, args: unknown[]): Promise<any> },
  operation: string,
  ...args: unknown[]
) {
  const reply = await room.invoke(operation, args);
  if (!reply.ok) throw new Failure(reply.status, reply.error);
  return reply.value;
}
export type Mail = { events: Message[]; next: number };
type Room = {
  invoke(operation: string, args: unknown[]): Promise<any>;
  fetch(input: string, init: RequestInit): Promise<Response>;
};
/**
 * Blocking read of one client's mailbox. This stateless Worker holds the caller's request; the room only keeps a
 * hibernatable socket and can sleep. Mail is always read through the normal authorized read, before and after.
 */
export async function waitRead(
  room: Room,
  project: string,
  client: string,
  seconds: number,
  after: number,
  read: () => Promise<Mail> = () => rpc(room, "read", project, client, after, session),
  session?: string,
): Promise<Mail> {
  const first = await read();
  if (first.events.length || !(seconds > 0)) return first;
  let ws: WebSocket | null = null;
  try {
    const response = await room.fetch("https://room/wait", {
      headers: {
        Upgrade: "websocket",
        "X-Lead-Socket": JSON.stringify({ project, client, session, after }),
      },
    });
    if (response.status === 429) throw new Failure(429, "Too many waiting requests; retry later");
    ws = response.webSocket;
  } catch (error) {
    if (error instanceof Failure) throw error;
  }
  // No socket (the room restarted): answer from the durable mailbox; the caller asks again.
  if (!ws) return read();
  const socket = ws;
  socket.accept();
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, Math.min(seconds, 50) * 1000);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    socket.addEventListener("message", done);
    socket.addEventListener("close", done);
    socket.addEventListener("error", done);
  });
  try {
    socket.close(1000, "Done");
  } catch {}
  return read();
}
