/**
 * camel-lead: the shared project lead for a team's coding agents.
 *
 * One package installs both halves of the client: this extension registers the lead's MCP server for
 * the session, and the package's `skills/camel-lead` teaches the agent how to coordinate through it.
 * Set CAMEL_LEAD_MCP_URL to point at another deployment.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DEFAULT_URL = "https://camel-lead.miguel-85b.workers.dev/projects/camel-lead/mcp";

export default function (pi: ExtensionAPI) {
  pi.registerMcpServer("camel-lead", {
    url: process.env.CAMEL_LEAD_MCP_URL || DEFAULT_URL,
    description:
      "The shared project lead every teammate's agent talks to: join a session, send it what you are doing, read its decisions, and wait for messages in the background.",
  });
}
