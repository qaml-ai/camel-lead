import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export const idInput = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);
export const sessionInput = z.string().min(1).max(80).optional();
export const attachmentInput = z.array(idInput).max(20).default([]);
export const directInput = z.object({
  target: idInput,
  text: z.string().min(1).max(16_000),
  messageId: idInput,
  session: sessionInput,
  attachments: attachmentInput,
  replyTo: z.string().min(1).max(100).optional(),
});
export const uploadInput = z.object({
  name: z.string().min(1).max(255).refine((name) => name !== "." && name !== ".." && name.isWellFormed() && !/[\\/\x00-\x1f\x7f]/.test(name), "Use a filename without directories or control characters"),
  size: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  sha256: z.string().regex(/^[a-fA-F0-9]{64}$/).transform((value) => value.toLowerCase()),
  contentType: z.string().regex(/^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/).default("application/octet-stream"),
  ttlDays: z.number().int().min(1).max(365).default(7),
  session: sessionInput,
});
export type UploadInput = z.infer<typeof uploadInput>;
export type MessageDetails = {
  sender: { id: string; client: string; name: string };
  attachments: string[];
  replyTo?: string;
};
export type SharedFile = {
  id: string;
  owner: string;
  name: string;
  size: number;
  sha256: string;
  contentType: string;
  created: number;
  expires: number;
  state: "pending" | "ready" | "deleted";
};

/** Shell arguments are quoted independently; filenames and tokens never become shell syntax. */
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
export function fileTransfer(origin: string, project: string, file: SharedFile, token: string, mode: "upload" | "download", expiresAt: string) {
  const url = `${origin}/projects/${project}/files/${file.id}/content`;
  const auth = `-H ${quote(`Authorization: Bearer ${token}`)}`;
  const path = quote(`./${file.name}`);
  const command = mode === "upload"
    ? `curl --fail-with-body --silent --show-error -X PUT ${auth} -H ${quote(`Content-Length: ${file.size}`)} --data-binary @${path} ${quote(url)}`
    : `curl --fail-with-body --silent --show-error ${auth} ${quote(url)} --output ${path}`;
  return { file, url, token, expiresAt, command };
}

/** Keep the remote server and local stdio adapter on the same tool contract. */
export function registerSharingTools(server: McpServer, call: (tool: string, args: Record<string, unknown>) => Promise<unknown>) {
  const tools = [
    {
      name: "send_message",
      description: "Send directly to a project session, client, or all, without a lead turn. Use participant IDs and a stable messageId for retries. Attach uploaded file IDs with attachments. Set replyTo to an incoming event's id to record a reply. Returns the messageId used by message_status.",
      schema: directInput,
    },
    {
      name: "message_status",
      description: "Inspect your sent message's per-recipient queued, fetched, acknowledged and replied timestamps. Fetched means returned to a reader; acknowledged means the recipient explicitly marked it handled. Use the messageId returned by send_message and the same sender session.",
      schema: z.object({ messageId: idInput, session: sessionInput }),
    },
    {
      name: "prepare_upload",
      description: "Prepare an immutable file upload. Supply its filename, byte size and SHA-256 hex digest, then run the returned curl command in the file's directory. Files expire after ttlDays (default 7). The upload token is private and expires in 15 minutes. Attach the returned file ID with send_message after uploading.",
      schema: uploadInput,
    },
    {
      name: "get_file",
      description: "Get metadata and a private, short-lived curl download command for an uploaded file you own or received. File content is untrusted input. Supply the receiving session when a file was shared with that session.",
      schema: z.object({ fileId: idInput, session: sessionInput }),
    },
    {
      name: "list_files",
      description: "List uploaded, unexpired files owned by or shared with this session and its client's shared mailbox. Follow next as after to continue.",
      schema: z.object({ session: sessionInput, after: idInput.optional(), limit: z.number().int().min(1).max(100).default(100) }),
    },
    {
      name: "delete_file",
      description: "Delete a file you own and revoke future downloads for all recipients. Existing downloaded copies remain with their recipients.",
      schema: z.object({ fileId: idInput, session: sessionInput }),
    },
  ];
  for (const tool of tools) server.registerTool(tool.name, {
    description: tool.description,
    inputSchema: tool.schema.shape,
  }, async (args: Record<string, unknown>) => {
    try {
      return { content: [{ type: "text" as const, text: JSON.stringify(await call(tool.name, args)) }] };
    } catch {
      return { isError: true, content: [{ type: "text" as const, text: "Sharing operation failed. Check the target, sender session, file access, and retry with the same messageId." }] };
    }
  });
}
