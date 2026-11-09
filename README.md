# camel-lead

A shared project-lead agent for Claude Code, Codex, OpenCode and other MCP clients.
The agent runs in [camelRun](https://run.camelai.com); this separate Cloudflare
Worker delivers messages between the lead and its connected collaborators.

The lead's interface is deliberately small:

```text
participants()                         # authorized clients and last adapter contact
send_message(target, text, messageId)   # one client, or target="all"
```

Clients use `message`, `get_messages`, `acknowledge`, and `participants`. Multiple
clients can submit simultaneously to **one shared agent and conversation**.
camelRun serializes their turns. A normal final reply goes back to its caller;
the lead can also proactively message any authorized client. Durable SQLite
mailboxes preserve messages when a client disconnects. No VM or permanent socket
is needed for the adapter.

## Status

Implemented and locally tested in real workerd, with synthetic camelRun responses.
**Not deployed; no real hosted model/client end-to-end execution verified.**
This is an operator-configured, trusted project/team adapter, not a public signup
service. A public source repository does not mean anonymous access to projects.

| Client                   | Conversation                                 | Incoming push                                                      |
| ------------------------ | -------------------------------------------- | ------------------------------------------------------------------ |
| Claude Code              | Remote MCP or included stdio adapter         | Claude channel extension, explicitly opted in                      |
| Codex                    | Remote MCP or generic stdio                  | Included app-server bridge; **not** a native MCP notification      |
| OpenCode                 | Remote MCP or generic stdio                  | Included HTTP bridge against the inspected current development API |
| Cursor/other MCP clients | Remote MCP tools                             | Poll `get_messages`; no unsolicited turns promised                 |
| ChatGPT                  | MCP client capable of configured bearer auth | No automatic hosted connector registration or wake-up support      |

A local helper must be running for native-client delivery. The shared lead itself
remains hosted. Ordinary MCP tool access alone does not wake a coding client.

## Setup (operator)

Node 22.21+, a Cloudflare account, and a camelRun tenant API key are required.

```sh
npm ci
npm run check
npm run build                      # dry-run only, no deployment
```

Choose a new adapter hostname; do not point it at the existing camelRun Worker.
The prepared configuration defaults to `https://run-pilot.camelai.dev`, the
existing Cloudflare deployment discovered on November 9, 2026. Override
`CAMELRUN_URL` for another deployment. No account IDs, credentials or existing
production routes are included. `workers_dev` is disabled by default.

Create one lead/definition and its dedicated Dreaming volume (this command makes
real API changes; it does not deploy anything):

```sh
# Set CAMELAI_API_KEY privately in your shell, never in chat/source.
export CAMELAI_BASE_URL=https://run-pilot.camelai.dev
export DREAM_BUDGET_USD=1           # per nightly consolidation attempt, not a hard spending cap
node --experimental-strip-types scripts/provision.ts demo https://lead.example.com alice bob
```

The script writes private mode-0600 files under `.secrets/demo/`, including a
journal of created resource IDs, per-client credentials, a separate lead-tool
credential, and `projects.json`. It never prints credentials. If interrupted,
inspect the journal; do not delete the directory and blindly repeat. Existing
setup directories are refused. Resources are not automatically deleted on error.

Configure `CAMELRUN_API_KEY` and `PROJECTS_JSON` as Worker **secrets**, using the
private files/secure input, not literals in source. `PROJECTS_JSON` is a registry:

```json
{
  "demo": {
    "agentId": "client_<40 hex characters>",
    "leadTokenHash": "<sha256 hex>",
    "clients": {
      "alice": { "name": "Alice", "tokenHash": "<sha256 hex>" },
      "bob": { "name": "Bob", "tokenHash": "<sha256 hex>" }
    }
  }
}
```

Merge project entries when adding a project; do not overwrite another project's
registry. Each project should have its **own** agent and memory volume. Rotate or
remove a client by updating its registry entry. Keep the camelRun API key only in
the adapter. The lead's separate bearer credential permits only delivery and
participant listing for that project, not incoming client messages.

After review, configure a route and deploy this Worker separately. No deployment
was performed during development. An optional `RUNTIME` service binding can point
to `camelrun-pilot` in the same Cloudflare account; requests retain their normal
URL and API authorization. Without it, the adapter uses authenticated HTTPS.

## Memory

Provisioning uses the actual camelRun **Dreaming** API:
`PUT /v1/agents/:id/dreaming`, with a dedicated memory volume, explicit budget,
nightly schedule and `acrossUsers: true`. Provisioning mounts the dedicated volume at `/memory` read-only before enabling
Dreaming, as required by camelRun. Conversation history handles immediate continuity; Dreaming consolidates
longer-term project facts. It is **shared project memory**, not private memory per
participant. Never put separate customers in one project. The memory volume is
replaced by consolidation; do not store unrelated files in it. Keep the upstream
Workers minute cron enabled for scheduled Dreaming. Review generated memories.

See [camelRun's Dreaming guide](https://github.com/qaml-ai/run/blob/5843358775cc9e8dcda45edb6920873a8c3489b2/docs/guides/dreaming.md).

## Connect a client

Set `CAMEL_LEAD_URL` to your adapter URL and `CAMEL_LEAD_TOKEN` privately to that
client's credential. These credentials are different from your camelRun API key.

Remote MCP: `https://lead.example.com/projects/demo/mcp`, with bearer auth.
The server is stateless HTTP; use the client tools to poll messages. OAuth/DCR
and an app-store connector are not implemented.

Generic local MCP (Codex, OpenCode, Cursor, etc.):

```sh
node --experimental-strip-types clients/stdio.ts demo generic
```

Register that command using the client's normal MCP configuration. Do not commit
credential values; pass them through its supported environment mechanism.

Claude Code channel:

```sh
claude mcp add project-lead -- node --experimental-strip-types /absolute/path/camel-lead/clients/stdio.ts demo claude
claude --dangerously-load-development-channels server:project-lead
```

Claude's development-channel preview needs explicit opt-in and may be blocked by
organization policy. The adapter emits `notifications/claude/channel`. A successful
transport write is **not** confirmation that Claude processed the message. Its
mailbox acknowledgement is transport-level; select generic polling if you need
the user/model to explicitly acknowledge processing.

Codex incoming-event bridge (run alongside its generic MCP tools):

```sh
node --experimental-strip-types clients/bridge.ts demo codex LOCAL_THREAD_ID
```

This starts an app-server, resumes a local thread, submits events with `turn/start`,
and acknowledges only completed turns. It does not add native Codex MCP-channel
support, create cloud sessions or bypass thread ownership. Keep its credentials,
permissions and normal app-server configuration intact. It stops on unsupported
approval requests; it **never auto-approves**. A cloud test accepted protocol calls
but inference failed with HTTP CONNECT 403, so a real Codex model response remains
unverified.

OpenCode incoming-event bridge:

```sh
# Optional: OPENCODE_BASE_URL, OPENCODE_AUTHORIZATION (private server auth header)
node --experimental-strip-types clients/bridge.ts demo opencode SESSION_ID
```

Targets `POST /api/session/:sessionID/prompt` from development revision
[`7a2e04b`](https://github.com/anomalyco/opencode/blob/7a2e04b37d6aa178af207ce52a6111c747f2855f/packages/protocol/src/groups/session.ts).
It acknowledges after durable API admission, **not** model completion. Older
versions use different APIs; it fails rather than silently guessing routes.
Actual OpenCode execution is unverified.

## Delivery and safety

- Server-assigned client identity comes from bearer authentication, never a model
  argument. Clients can read/ack only their own mailbox. All collaborators still
  share the lead's conversation and memory by design.
- Runtime prompts use stable request IDs. Ambiguous retries reuse the same ID.
  Alarm-driven outbox delivery and reply persistence survive DO eviction.
- Mailbox messages remain until explicitly acknowledged. Acknowledgement hides
  them from subsequent reads; it does not delete stored records.
- Delivery is at-least-once: a client crash after processing but before ack can
  repeat an event. Codex/OpenCode consumers must make side effects idempotent.
- Normal lead replies and proactive tool messages are separate. The lead is
  instructed not to send duplicate final replies or endless agent-to-agent loops.
- External messages are not trusted instructions or approvals. Do not automatically
  execute dangerous actions just because another agent requested them.
- There is a 100-pending-request project queue, bounded message bodies, 16k-character
  messages, and no arbitrary webhook target URLs. Polling is authenticated.
- Twelve delivery errors, invalid upstream authorization or missing upstream
  resources mark the local request failed and notify its caller. The upstream
  request may still have executed; inspect its ID before manually replaying.
- Messages/idempotency records currently have **no automatic retention purge**.
  Before broad production use, define retention, deletion, backup and incident
  procedures. This is a trusted-team first version, not a security audit.

No runtime key, raw client credential, source transcript or message text is logged.
The `healthz` route is public; all project/lead operations require credentials.

## Tests and compatibility evidence

`npm test` runs actual Workers/Durable Objects tests: authorization, concurrent
clients, idempotency, private routing, broadcast, eviction persistence, outbox
retries, live MCP wire contracts, and bounds. `npm run test:node` checks adapters
and provisioning contracts with fixtures. These are not claims of live provider
interoperability.

Claude reference: https://code.claude.com/docs/en/channels-reference
Codex restriction: https://github.com/openai/codex/blob/6222faa3c463442b3788b2690108568786f6ffc7/codex-rs/app-server/src/request_processors/mcp_event_stream.rs

CI checks every push/PR. There is deliberately **no automatic deployment workflow**.
