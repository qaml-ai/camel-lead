import { timingSafeEqual } from "node:crypto";
export interface ClientConfig {
  name: string;
  tokenHash: string;
}
export interface ProjectConfig {
  agentId: string;
  leadTokenHash: string;
  clients: Record<string, ClientConfig>;
}
export type Message = {
  seq: number;
  id: string;
  target: string;
  text: string;
  kind: string;
  requestId: string | null;
  created: number;
};
export type Job = {
  id: string;
  client: string;
  text: string;
  state: string;
  attempts: number;
  created: number;
};
export interface Secrets {
  CAMELRUN_API_KEY: string;
  PROJECTS_JSON: string;
  RUNTIME?: Fetcher;
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
    if (await matches(token, client.tokenHash)) return id;
  throw new Failure(401, "Invalid client credential");
}
export async function leadAuth(request: Request, p: ProjectConfig) {
  const token =
    request.headers.get("authorization")?.replace(/^Bearer /, "") || "";
  if (!token || !(await matches(token, p.leadTokenHash)))
    throw new Failure(401, "Invalid lead credential");
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
