import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { LeadClient } from "./api.ts";
import { CLIENT_INSTRUCTIONS, TOOL_TEXT } from "../src/text.ts";
const session = z.string().min(1).max(80).optional().describe(TOOL_TEXT.session);
// "generic" was the old mode argument; it is still accepted so existing registrations keep working.
const [project, mode = "generic"] = process.argv.slice(2);
if (!project || mode !== "generic")
  throw new Error(
    "Usage: stdio.ts PROJECT. Push modes were removed; use the wait_token tool.",
  );
const client = new LeadClient(
  process.env.CAMEL_LEAD_URL || "http://127.0.0.1:8787",
  project,
  process.env.CAMEL_LEAD_TOKEN || "",
);
const server = new McpServer(
  { name: "camel-lead", version: "0.2.0" },
  {
    instructions: CLIENT_INSTRUCTIONS,
  },
);
const result = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data) }],
});
server.registerTool(
  "join",
  { description: TOOL_TEXT.join, inputSchema: { name: z.string() } },
  // The adapter relays which coding client it serves, so the lead sees "Claude Code" rather than "agent".
  async (args) => {
    const info = server.server.getClientVersion();
    return result(
      await client.call("join", {
        name: args.name,
        ...(info?.name ? { clientInfo: { name: info.name.slice(0, 200), version: String(info.version ?? "").slice(0, 200) } } : {}),
      }),
    );
  },
);
server.registerTool(
  "message",
  {
    description: "Queue a message to the shared project lead.",
    inputSchema: {
      text: z.string().min(1).max(16_000),
      requestId: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
      session,
    },
  },
  async (args) => result(await client.call("messages", args)),
);
server.registerTool(
  "get_messages",
  {
    description: TOOL_TEXT.get_messages,
    inputSchema: { session },
  },
  async (args) =>
    result(await client.call("messages" + (args.session ? `?session=${encodeURIComponent(args.session)}` : ""))),
);
server.registerTool(
  "wait_token",
  {
    description: TOOL_TEXT.wait_token,
    inputSchema: {
      ttlMinutes: z.number().int().min(5).max(1440).optional(),
      timeoutSeconds: z.number().int().min(60).max(86400).optional(),
      follow: z.boolean().optional(),
      session,
    },
  },
  async (args) => result(await client.call("wait-token", args)),
);
server.registerTool(
  "acknowledge",
  {
    description: TOOL_TEXT.acknowledge,
    inputSchema: { seq: z.number().int().nonnegative(), session },
  },
  async (args) => result(await client.call("ack", args)),
);
server.registerTool(
  "participants",
  {
    description: TOOL_TEXT.participants,
    inputSchema: {},
  },
  async () => result(await client.call("participants")),
);
let finish!: () => void;
const closed = new Promise<void>((resolve) => {
  finish = resolve;
});
process.stdin.once("end", finish);
process.once("SIGTERM", finish);
process.once("SIGINT", finish);
server.server.onclose = finish;
try {
  await server.connect(new StdioServerTransport());
  await closed;
} finally {
  await server.close();
}
