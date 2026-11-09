import { oauthRoute, oauthClient, oauthEnabled } from "./oauth.ts";
import { z } from "zod";
import {
  rpc,
  waitRead,
  boundedJson,
  clientAuth,
  config,
  Failure,
  leadAuth,
  type WorkerEnv,
} from "./types.ts";
import { mcp, leadMcp, mintWait } from "./mcp.ts";
import { MAX_WAIT_SECONDS } from "./room.ts";
export { ProjectRoom } from "./room.ts";
const optional = (v: string | null) => v ?? undefined;
/** Longer waits are clamped, not refused. 50 s stays under the 60 s limits common in HTTP clients and proxies. */
const tokenWaitQuery = z.object({
  timeout: z.coerce.number().int().min(0).default(25).transform((n) => Math.min(n, MAX_WAIT_SECONDS)),
  after: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
});
const session = z.string().min(1).max(80).optional();
const ackBody = z.object({ seq: z.number().int().nonnegative(), session, mailbox: z.enum(["session", "shared"]).optional() });
const joinBody = z.object({
  name: z.string(),
  clientInfo: z.object({ name: z.string().max(200), version: z.string().max(200).optional() }).optional(),
});
const origin = (env: WorkerEnv) => env.CAMEL_LEAD_URL.replace(/\/+$/, "");
const message = z.object({
  text: z.string().min(1).max(16_000),
  requestId: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
  session,
});
export default {
  async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
    try {
      const url = new URL(request.url);
      const authResponse = await oauthRoute(request, env, ctx);
      if (authResponse) return authResponse;
      if (url.pathname === "/healthz") return Response.json({ ok: true });
      const match =
        /^\/(projects|agent)\/([A-Za-z0-9_-]{1,80})\/(mcp|messages|ack|participants|send|wait|wait-token|join)$/.exec(
          url.pathname,
        );
      if (!match) throw new Failure(404, "Not found");
      const [, kind, project, action] = match,
        p = config(env, project),
        room = env.PROJECTS.getByName(project);
      if (kind === "agent") {
        if (action !== "mcp") throw new Failure(404, "Not found");
        await leadAuth(request, p, env, project);
        if (request.method !== "POST")
          throw new Failure(405, "Stateless MCP: POST each request");
        return await leadMcp(
          request,
          await boundedJson(request),
          room,
          project,
        );
      }
      if (action === "wait") {
        // The only blocking read. A wait token is accepted here and nowhere else, and can only read.
        if (request.method !== "GET") throw new Failure(405, "Method not allowed");
        const token = /^Bearer (\S+)$/.exec(request.headers.get("authorization") || "")?.[1] || "";
        const owner: { client: string; session?: string } = await rpc(room, "waitTokenOwner", project, token);
        const q = tokenWaitQuery.parse({
          timeout: optional(url.searchParams.get("timeout")),
          after: optional(url.searchParams.get("after")),
        });
        const mail = await waitRead(
          room,
          project,
          owner.client,
          q.timeout,
          q.after,
          () => rpc(room, "waitTokenRead", project, token, q.after),
          owner.session,
        );
        // 200 with mail, 204 with nothing yet: a shell loop needs only the status.
        return mail.events.length
          ? Response.json(mail, { headers: { "Cache-Control": "no-store" } })
          : new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
      }
      let client: string;
      try { client = await clientAuth(request, p); }
      catch (error) {
        if (!oauthEnabled(env)) throw error;
        client = await oauthClient(request, env, project, p);
      }
      if (action === "mcp") {
        if (request.method !== "POST")
          return Response.json(
            { error: "Stateless MCP: POST each request" },
            { status: 405, headers: { Allow: "POST" } },
          );
        return await mcp(
          request,
          await boundedJson(request),
          room,
          project,
          client,
          origin(env),
        );
      }
      if (action === "wait-token" && request.method === "POST")
        return Response.json(
          await mintWait(room, origin(env), project, client, await boundedJson(request)),
          { headers: { "Cache-Control": "no-store" } },
        );
      if (action === "join" && request.method === "POST") {
        const body = joinBody.parse(await boundedJson(request));
        return Response.json(await rpc(room, "joinSession", project, client, body.name, body.clientInfo));
      }
      if (action === "messages" && request.method === "GET")
        return Response.json(
          await rpc(room, "read", project, client, 0, session.parse(optional(url.searchParams.get("session")))),
          { headers: { "Cache-Control": "no-store" } },
        );
      if (action === "messages" && request.method === "POST") {
        const body = message.parse(await boundedJson(request));
        return Response.json(
          await rpc(room, "submit", project, client, body.requestId, body.text, body.session),
          { status: 202 },
        );
      }
      if (action === "ack" && request.method === "POST") {
        const body = ackBody.parse(await boundedJson(request));
        return Response.json(await rpc(room, "ack", project, client, body.seq, body.session, body.mailbox));
      }
      if (action === "participants" && request.method === "GET")
        return Response.json(await rpc(room, "participants", project));
      throw new Failure(405, "Method not allowed");
    } catch (error) {
      const status =
        error instanceof Failure
          ? error.status
          : error instanceof z.ZodError
            ? 400
            : 500;
      if (status === 500)
        console.error(
          JSON.stringify({
            event: "request_failed",
            path: new URL(request.url).pathname,
          }),
        );
      return Response.json(
        {
          error:
            status === 500
              ? "Internal error"
              : error instanceof Failure
                ? error.message
                : "Invalid input",
        },
        { status, headers: {
          "Cache-Control": "no-store",
          ...(status === 401 && oauthEnabled(env) && /^\/projects\/[^/]+\/(mcp|messages|ack|participants|wait-token|join)$/.test(new URL(request.url).pathname) ? {
            'WWW-Authenticate': `Bearer resource_metadata="${env.CAMEL_LEAD_URL}/.well-known/oauth-protected-resource${new URL(request.url).pathname.replace(/\/(messages|ack|participants|wait-token|join)$/, '/mcp')}", scope="lead:messages"`
          } : {}),
        } },
      );
    }
  },
} satisfies ExportedHandler<WorkerEnv>;
