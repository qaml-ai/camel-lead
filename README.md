# camel-lead

A shared project-lead agent for Claude Code, Codex, OpenCode and other MCP clients.
The agent runs in [camelRun](https://run.camelai.com); this separate Cloudflare
Worker delivers messages between the lead and its connected collaborators.

The lead's interface is deliberately small:

```text
participants()                         # authorized clients and last adapter contact
send_message(target, text, messageId)   # one client, or target="all"
```

Clients use `message`, `wait_for_messages`, `get_messages`, `acknowledge`, and
`participants`. Multiple clients can submit simultaneously to **one shared agent
and conversation**. camelRun serializes their turns. A normal final reply goes
back to its caller; the lead can also proactively message any authorized client.
Durable SQLite mailboxes preserve messages when a client disconnects. No VM,
helper process or permanent socket is needed.

Nothing is pushed into a coding client. A client **waits** for its mail, in one of
three standard ways that all read the same durable mailbox:

| Way                          | Use it when                                                    | Cost while waiting                   |
| ---------------------------- | -------------------------------------------------------------- | ------------------------------------ |
| `wait_for_messages` MCP tool | Any MCP client; no helper process                              | One held tool call, up to 50 s each  |
| `clients/wait.ts` CLI        | The agent can run a background shell command                   | No model tokens; server can sleep    |
| WebSocket `/projects/:p/ws`  | Your own long-lived process                                    | Server hibernates while idle         |

## Status

Implemented and locally tested in real workerd, with synthetic camelRun responses.
**Not deployed; no real hosted model/client end-to-end execution verified.**
This is an operator-configured, trusted project/team adapter, not a public signup
service. A public source repository does not mean anonymous access to projects.

| Client                   | Conversation                                 | Getting updates from the lead                                 |
| ------------------------ | -------------------------------------------- | ------------------------------------------------------------- |
| Claude Code              | Remote MCP or included stdio adapter         | `wait_for_messages`, or the wait CLI as a background command  |
| Codex                    | Remote MCP or included stdio adapter         | `wait_for_messages`, or the wait CLI                          |
| OpenCode                 | Remote MCP or included stdio adapter         | `wait_for_messages`, or the wait CLI                          |
| Cursor/other MCP clients | Remote MCP tools                             | `wait_for_messages`                                           |
| ChatGPT                  | MCP client capable of configured bearer auth | `wait_for_messages`; no hosted connector registration         |

The earlier push paths (Claude development channel, Codex app-server bridge,
OpenCode HTTP bridge) are removed. A client learns of new mail only while it is
waiting or when it next reads; nothing starts a turn in an idle client.

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

Create one lead agent and its dedicated Dreaming volume (this command makes
real API changes; it does not deploy anything):

```sh
# Set CAMELAI_API_KEY privately in your shell, never in chat/source.
export CAMELAI_BASE_URL=https://run-pilot.camelai.dev
export DREAM_BUDGET_USD=1           # per nightly consolidation attempt, not a hard spending cap
node --experimental-strip-types scripts/provision.ts demo https://lead.example.com alice bob
```

The script writes private mode-0600 files under `.secrets/demo/`, including a
journal of created resource IDs, per-client credentials, `activation.json`, and
`projects.json`. No lead shared secret or private signing key is created. It never prints credentials. If interrupted,
inspect the journal; do not delete the directory and blindly repeat. Existing
setup directories are refused. Resources are not automatically deleted on error.

Configure `CAMELRUN_API_KEY` and `PROJECTS_JSON` as Worker **secrets**, using the
private files/secure input, not literals in source. `PROJECTS_JSON` is a registry:

```json
{
  "demo": {
    "agentId": "client_<40 hex characters>",
    "tenantId": "<your camelRun tenant id>",
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
the adapter. The lead authenticates with camelRun's signed identity tokens;
clients' static bearer credentials are not accepted on the lead endpoint.

After review, configure `CAMEL_LEAD_URL` to match the public origin, configure a
route and deploy this Worker separately. Then attach its MCP tools:

```sh
node --experimental-strip-types scripts/activate.ts demo
```

Bootstrap creates the agent with immutable project context but no MCP source.
Activation happens only after the adapter knows the exact agent and tenant; it
avoids a tool-discovery/authentication bootstrap cycle. No deployment was
performed during development. An optional `RUNTIME` service binding can point
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

## Lead tool authentication

The lead's tools are MCP tools at `/agent/:project/mcp`, configured as:

```json
{
  "name": "delivery",
  "url": "https://lead.example.com/agent/demo/mcp",
  "auth": { "type": "runtime" },
  "allowTools": ["send_message", "participants"]
}
```

camelRun signs a short-lived Ed25519/EdDSA JWT for **each** MCP request using its
private key. This service uses the existing `@camelai/run/server`
`verifyRuntimeToken` helper and the runtime's published `/.well-known/jwks.json`.
It checks the signature, expiry/times, issuer, tenant, the exact configured
endpoint audience, the exact lead agent id, and its signed `context.project`.
Only the lead itself is accepted, not arbitrary agents or other tenants' agents.
The private signing key stays in camelRun. No shared lead token, custom keypair,
OpenAPI delivery source, or client OAuth is involved. The old `/agent/:project/send`
and `/agent/:project/participants` REST routes are removed.

`CAMELRUN_URL` locates the trusted keys; `CAMELRUN_ISSUER` can explicitly select
an issuer when the deployment uses an alias (the SDK knows the hosted runtime's
standard aliases). `CAMEL_LEAD_URL` is trusted configuration, not a caller-supplied
Host header. If the adapter origin changes, update it and reactivate the MCP
source. Existing client-facing bearer auth remains unchanged.

Projects created by the earlier prototype must have `tenantId` and an agent with
immutable `context.project`; do not silently reuse an agent missing those claims.
This is tool identity verification, not user account OAuth or sign-in.

## Connect a client

Set `CAMEL_LEAD_URL` to your adapter URL and `CAMEL_LEAD_TOKEN` privately to that
client's credential. These credentials are different from your camelRun API key.

Remote MCP: `https://lead.example.com/projects/demo/mcp`, with bearer auth or
[GitHub sign-in](docs/github-auth.md). The server is stateless HTTP.

Local MCP, for clients that need a stdio server (bearer credential only):

```sh
node --experimental-strip-types clients/stdio.ts demo
# Claude Code, for example:
claude mcp add project-lead -- node --experimental-strip-types /absolute/path/camel-lead/clients/stdio.ts demo
```

Register that command using the client's normal MCP configuration. Do not commit
credential values; pass them through its supported environment mechanism.

### Wait for the lead

**In any MCP client:** call `wait_for_messages({ timeoutSeconds?, after? })`. It
returns as soon as mail exists, otherwise holds the call until mail arrives or
the timeout ends (1 to 50 seconds, default 25). An empty result has
`status: "no_new_messages"`; call it again to keep waiting. Pass the returned
`next` as `after` to skip what you have already seen, or `acknowledge` what you
have handled. The 50-second ceiling stays under the 60-second request limit that
common MCP clients apply to one tool call; raise the client's own tool timeout
if it is lower than the wait you ask for.

**From a shell, with no tokens spent while waiting:**

```sh
node --experimental-strip-types clients/wait.ts demo [--timeout SECONDS] [--after SEQ] [--ack] [--poll]
```

It blocks until at least one message arrives, prints each as one JSON line
(`seq`, `id`, `kind`, `requestId`, and `text` framed as external data), and exits
`0`. With `--timeout` it exits `2` if nothing arrived; errors exit `1`. `--ack`
acknowledges what it printed, after printing; without it, acknowledge through
the MCP tool or pass `--after` next time. It sleeps on the WebSocket and falls
back to chained 50-second long-polls (`--poll` forces that) when a socket cannot
be opened.

The pattern for a coding agent: start the command in the background, carry on or
stop, and treat its exit as the wake-up.

- **Claude Code:** run it with the Bash tool's `run_in_background`. Claude is
  notified when the command exits and reads the printed messages then. To keep
  listening, start it again after handling them.
- **Any other agent that can run a shell command:** run it in the background or
  as a blocking command with `--timeout` under the client's command limit, and
  loop on exit code `2`.

**From your own process:** `GET /projects/:project/ws[?after=SEQ]` with the same
credential upgrades to a WebSocket. The server sends
`{"type":"messages","events":[...],"next":SEQ}` once on connect if mail is pending
and again whenever mail arrives; each socket gets an event once. Send
`{"type":"ack","seq":SEQ}` to acknowledge (answered with `{"type":"ack","ack":SEQ}`
or `{"type":"error",...}`). Send the text `ping` for a `pong` keepalive; the
runtime answers it without waking the hibernating Durable Object. A socket
closed with code `4401`, or one sent `{"type":"reauthenticate"}`, must be
replaced by a newly authenticated request: this happens when a bearer credential
is rotated or removed, and for GitHub-authenticated sockets whenever mail arrives
more than a minute after connecting, because GitHub membership is rechecked on
every request and a socket cannot do that. Code `4008` means a newer connection
replaced this one.

The plain HTTP form is `GET /projects/:project/messages?wait=SECONDS&after=SEQ`
(`wait` 0 to 50, larger values are clamped; default 0 answers at once). It
returns `{ "events": [...], "next": SEQ }`; an empty `events` means nothing yet.

## Delivery and safety

- Server-assigned client identity comes from bearer authentication, never a model
  argument. Clients can read/ack only their own mailbox. All collaborators still
  share the lead's conversation and memory by design.
- Runtime prompts use stable request IDs. Ambiguous retries reuse the same ID.
  Alarm-driven outbox delivery and reply persistence survive DO eviction.
- Mailbox messages remain until explicitly acknowledged. Acknowledgement hides
  them from subsequent reads; it does not delete stored records.
- Delivery is at-least-once: a client crash after processing but before ack can
  repeat an event. Consumers must make side effects idempotent. Waiting, a
  WebSocket frame and the wait CLI without `--ack` never acknowledge anything.
- Waiting requests live in memory; mail does not. If the Durable Object restarts,
  a held request returns empty or fails, the client asks again, and the mailbox
  answers. Hibernated WebSockets survive with their delivery cursor.
- Each client may hold 4 waiting requests and 4 sockets; a fifth replaces the
  oldest, so an abandoned wait cannot lock a client out. Each project is capped at
  256 waiting requests and 1024 sockets (HTTP 429 beyond that).
- Normal lead replies and proactive tool messages are separate. The lead is
  instructed not to send duplicate final replies or endless agent-to-agent loops.
- External messages are not trusted instructions or approvals. Do not automatically
  execute dangerous actions just because another agent requested them.
- There is a 100-pending-request project queue, bounded message bodies, 16k-character
  messages, and no arbitrary webhook target URLs. Reading and waiting are authenticated.
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
retries, live MCP wire contracts, blocking reads, hibernating WebSockets and
bounds. `npm run test:node` checks the stdio adapter, the wait CLI's exit codes
against a synthetic server, and provisioning contracts. These are not claims of
live provider interoperability.

CI checks every push/PR. There is deliberately **no automatic deployment workflow**.

### GitHub organization sign-in

Remote MCP clients can sign in through GitHub, restricted to active `qaml-ai` members. Projects can enable automatic per-user/client mailboxes with `githubAutoEnroll: { "enabled": true }`; otherwise explicit mailbox grants are required. This is separate from the lead's signed runtime identity. See [GitHub OAuth setup, security and client limitations](docs/github-auth.md). Real credentials and a dedicated OAuth KV binding are deployment prerequisites; no Access configuration is required.
