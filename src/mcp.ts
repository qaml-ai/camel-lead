import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { Failure, rpc } from "./types.ts";
import { CLIENT_INSTRUCTIONS, TOOL_TEXT } from "./text.ts";
import { waitCommand } from "./wait-command.ts";
import type { ProjectRoom } from "./room.ts";
import { fileTransfer, registerSharingTools } from "./sharing.ts";

export { CLIENT_INSTRUCTIONS, TOOL_TEXT };
const session = z.string().min(1).max(80).optional().describe(TOOL_TEXT.session);
const mailbox = z.enum(["session", "shared"]).optional().describe(TOOL_TEXT.mailbox);
export const waitTokenInput = z.object({
  ttlMinutes: z.number().int().min(5).max(1440).default(480),
  timeoutSeconds: z.number().int().min(60).max(86400).default(3600),
  follow: z.boolean().default(false),
  session,
});
/** Mint a read-only wait token and the command that uses it. The URL comes from trusted configuration. */
export async function mintWait(
  room: { invoke(operation: string, args: unknown[]): Promise<any> },
  origin: string,
  project: string,
  client: string,
  input: unknown,
) {
  const { ttlMinutes, timeoutSeconds, follow, session } = waitTokenInput.parse(input ?? {});
  const minted = await rpc(room, "mintWaitToken", project, client, ttlMinutes, session);
  const url = `${origin}/projects/${project}/wait`;
  return { ...minted, url, command: waitCommand(url, minted.token, timeoutSeconds, follow) };
}
export async function mcp(
  request: Request,
  body: any,
  room: DurableObjectStub<ProjectRoom>,
  project: string,
  client: string,
  origin: string,
) {
  // The server is stateless, so the client's self-reported name is kept when its initialize request arrives.
  const info = [body].flat().find((m) => m?.method === "initialize")?.params?.clientInfo;
  if (info && typeof info.name === "string")
    await rpc(room, "recordClientInfo", project, client, info.name, info.version).catch(() => {});
  const server = new McpServer(
    { name: "camel-lead", version: "0.1.0" },
    {
      instructions: CLIENT_INSTRUCTIONS,
    },
  );
  const result = (data: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
  });
  const safe =
    (
      fn: (args: any) => Promise<unknown>,
      failed = "Project operation failed; retry the same requestId or inspect server diagnostics.",
    ) =>
    async (args: any) => {
      try {
        return result(await fn(args));
      } catch (error) {
        // Session mistakes are the caller's to fix, so say what they are.
        const text = error instanceof Failure && /session/i.test(error.message) ? error.message : failed;
        return { isError: true, content: [{ type: "text" as const, text }] };
      }
    };
  server.registerTool(
    "join",
    {
      description: TOOL_TEXT.join,
      inputSchema: { name: z.string() },
    },
    safe((args) => rpc(room, "joinSession", project, client, args.name), "Could not join; try again."),
  );
  server.registerTool(
    "message",
    {
      description:
        "Queue a message to the shared project lead. Model usage is billed to the configured camelRun account.",
      inputSchema: {
        text: z.string().min(1).max(16_000),
        requestId: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
        session,
      },
    },
    safe((args) =>
      rpc(room, "submit", project, client, args.requestId, args.text, args.session),
    ),
  );
  server.registerTool(
    "get_messages",
    {
      description: TOOL_TEXT.get_messages,
      inputSchema: { session },
    },
    safe((args) => rpc(room, "read", project, client, 0, args.session)),
  );
  server.registerTool(
    "wait_token",
    {
      description: TOOL_TEXT.wait_token,
      inputSchema: waitTokenInput.partial().shape,
    },
    safe(
      (args) => mintWait(room, origin, project, client, args),
      "Could not mint a wait token; try again.",
    ),
  );
  server.registerTool(
    "acknowledge",
    {
      description: TOOL_TEXT.acknowledge,
      inputSchema: { seq: z.number().int().nonnegative(), session, mailbox },
    },
    safe((args) => rpc(room, "ack", project, client, args.seq, args.session, args.mailbox)),
  );
  server.registerTool(
    "participants",
    {
      description: TOOL_TEXT.participants,
      inputSchema: {},
    },
    safe(async () => rpc(room, "participants", project)),
  );
  registerSharingTools(server, async (tool, args) => {
    switch (tool) {
      case "send_message": return rpc(room, "sendDirect", project, client, args);
      case "message_status": return rpc(room, "deliveryStatus", project, client, args.messageId, args.session);
      case "prepare_upload": {
        const prepared = await rpc(room, "prepareUpload", project, client, args);
        return fileTransfer(origin, project, prepared.file, prepared.token, "upload", prepared.expiresAt);
      }
      case "get_file": {
        const prepared = await rpc(room, "getFile", project, client, args.fileId, args.session);
        return fileTransfer(origin, project, prepared.file, prepared.token, "download", prepared.expiresAt);
      }
      case "list_files": return rpc(room, "listFiles", project, client, args.session, args.after, args.limit);
      case "delete_file": return rpc(room, "deleteFile", project, client, args.fileId, args.session);
      default: throw new Error("Unknown sharing tool");
    }
  });
  return transportResponse(request, body, server);
}

/** Only runtime-verified lead requests reach this endpoint, and its project is not a model argument. */
export async function leadMcp(
  request: Request,
  body: any,
  room: DurableObjectStub<ProjectRoom>,
  project: string,
) {
  const server = new McpServer(
    { name: "camel-lead-delivery", version: "0.2.0" },
    {
      instructions:
        "Send messages only to authorized project collaborators. Queued delivery does not confirm client processing.",
    },
  );
  server.registerTool(
    "send_message",
    {
      description:
        "Queue a message to one authorized project client, or target all. Use a stable messageId for retries.",
      inputSchema: {
        target: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/).describe(TOOL_TEXT.leadTarget),
        text: z.string().min(1).max(16_000),
        messageId: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
      },
    },
    async (args) => {
      try {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                await rpc(
                  room,
                  "send",
                  project,
                  args.target,
                  args.text,
                  args.messageId,
                ),
              ),
            },
          ],
        };
      } catch {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: "Message refused; check recipient and messageId. Retry identical content with the same messageId.",
            },
          ],
        };
      }
    },
  );
  server.registerTool(
    "participants",
    {
      description: TOOL_TEXT.leadParticipants,
      inputSchema: {},
    },
    async () => ({
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(await rpc(room, "participants", project)),
        },
      ],
    }),
  );
  server.registerTool("message_status", {
    description: "Inspect per-recipient delivery timestamps for a message sent by this lead. Use the original send_message messageId.",
    inputSchema: { messageId: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/) },
  }, async ({ messageId }) => {
    try {
      return { content: [{ type: "text" as const, text: JSON.stringify(await rpc(room, "deliveryStatus", project, null, messageId)) }] };
    } catch {
      return { isError: true, content: [{ type: "text" as const, text: "Unknown message." }] };
    }
  });
  return transportResponse(request, body, server);
}

async function transportResponse(
  request: Request,
  body: any,
  server: McpServer,
) {
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    const response = await transport.handleRequest(request, {
      parsedBody: body,
    });
    return new Response(response.body ? await response.arrayBuffer() : null, {
      status: response.status,
      headers: response.headers,
    });
  } finally {
    await server.close();
  }
}
