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
import { directInput, idInput, fileTransfer, uploadInput } from "./sharing.ts";
import { transferFile } from "./files.ts";
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
      const transfer = /^\/projects\/([A-Za-z0-9_-]{1,80})\/files\/(file_[a-f0-9]{32})\/content$/.exec(url.pathname);
      if (transfer) {
        const [, project, id] = transfer;
        config(env, project);
        return await transferFile(request, env, env.PROJECTS.getByName(project), project, id);
      }
      const match =
        /^\/(projects|agent)\/([A-Za-z0-9_-]{1,80})\/(mcp|messages|ack|participants|send|wait|wait-token|join|message-status|prepare-upload|resume-upload|complete-upload|get-file|list-files|delete-file)$/.exec(
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
          request.signal,
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
      if (action === "send" && request.method === "POST")
        return Response.json(await rpc(room, "sendDirect", project, client, directInput.parse(await boundedJson(request))), { status: 202 });
      if (action === "message-status" && request.method === "POST") {
        const body = z.object({ messageId: idInput, session }).parse(await boundedJson(request));
        return Response.json(await rpc(room, "deliveryStatus", project, client, body.messageId, body.session));
      }
      if (action === "prepare-upload" && request.method === "POST") {
        const prepared = await rpc(room, "prepareUpload", project, client, uploadInput.parse(await boundedJson(request)));
        return Response.json(fileTransfer(origin(env), project, prepared.file, prepared.token, "upload", prepared.expiresAt, prepared.multipart), { headers: { "Cache-Control": "no-store" } });
      }
      if (action === "resume-upload" && request.method === "POST") {
        const body = z.object({ fileId: idInput, session }).parse(await boundedJson(request));
        const prepared = await rpc(room, "resumeUpload", project, client, body.fileId, body.session);
        return Response.json(fileTransfer(origin(env), project, prepared.file, prepared.token, "upload", prepared.expiresAt, prepared.multipart), { headers: { "Cache-Control": "no-store" } });
      }
      if (action === "complete-upload" && request.method === "POST") {
        const body = z.object({ fileId: idInput, session }).parse(await boundedJson(request));
        return Response.json(await rpc(room, "completeMultipart", project, client, body.fileId, body.session));
      }
      if (action === "get-file" && request.method === "POST") {
        const body = z.object({ fileId: idInput, session }).parse(await boundedJson(request));
        const prepared = await rpc(room, "getFile", project, client, body.fileId, body.session);
        return Response.json(fileTransfer(origin(env), project, prepared.file, prepared.token, "download", prepared.expiresAt), { headers: { "Cache-Control": "no-store" } });
      }
      if (action === "list-files" && request.method === "POST") {
        const body = z.object({ session, after: idInput.optional(), limit: z.number().int().min(1).max(100).default(100) }).parse(await boundedJson(request));
        return Response.json(await rpc(room, "listFiles", project, client, body.session, body.after, body.limit));
      }
      if (action === "delete-file" && request.method === "POST") {
        const body = z.object({ fileId: idInput, session }).parse(await boundedJson(request));
        return Response.json(await rpc(room, "deleteFile", project, client, body.fileId, body.session));
      }
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
          ...(status === 401 && oauthEnabled(env) && /^\/projects\/[^/]+\/(mcp|messages|ack|participants|wait-token|join|send|message-status|prepare-upload|resume-upload|complete-upload|get-file|list-files|delete-file)$/.test(new URL(request.url).pathname) ? {
            'WWW-Authenticate': `Bearer resource_metadata="${env.CAMEL_LEAD_URL}/.well-known/oauth-protected-resource${new URL(request.url).pathname.replace(/\/(messages|ack|participants|wait-token|join|send|message-status|prepare-upload|resume-upload|complete-upload|get-file|list-files|delete-file)$/, '/mcp')}", scope="lead:messages"`
          } : {}),
        } },
      );
    }
  },
} satisfies ExportedHandler<WorkerEnv>;
