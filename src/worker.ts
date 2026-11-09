import { oauthRoute, oauthClient, oauthEnabled } from "./oauth.ts";
import { z } from "zod";
import {
  rpc,
  boundedJson,
  clientAuth,
  config,
  Failure,
  leadAuth,
  type WorkerEnv,
} from "./types.ts";
import { mcp, leadMcp } from "./mcp.ts";
export { ProjectRoom } from "./room.ts";
const message = z.object({
  text: z.string().min(1).max(16_000),
  requestId: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
});
export default {
  async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
    try {
      const url = new URL(request.url);
      const authResponse = await oauthRoute(request, env, ctx);
      if (authResponse) return authResponse;
      if (url.pathname === "/healthz") return Response.json({ ok: true });
      const match =
        /^\/(projects|agent)\/([A-Za-z0-9_-]{1,80})\/(mcp|messages|ack|participants|send)$/.exec(
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
        );
      }
      if (action === "messages" && request.method === "GET")
        return Response.json(await rpc(room, "read", project, client));
      if (action === "messages" && request.method === "POST") {
        const body = message.parse(await boundedJson(request));
        return Response.json(
          await rpc(room, "submit", project, client, body.requestId, body.text),
          { status: 202 },
        );
      }
      if (action === "ack" && request.method === "POST") {
        const { seq } = z
          .object({ seq: z.number().int().nonnegative() })
          .parse(await boundedJson(request));
        return Response.json(await rpc(room, "ack", project, client, seq));
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
          ...(status === 401 && oauthEnabled(env) && new URL(request.url).pathname.startsWith('/projects/') ? {
            'WWW-Authenticate': `Bearer resource_metadata="${env.CAMEL_LEAD_URL}/.well-known/oauth-protected-resource${new URL(request.url).pathname.replace(/\/(messages|ack|participants)$/, '/mcp')}", scope="lead:messages"`
          } : {}),
        } },
      );
    }
  },
} satisfies ExportedHandler<WorkerEnv>;
