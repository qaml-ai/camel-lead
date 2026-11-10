# camel-lead

A shared project-lead agent for Claude Code, Codex, OpenCode and other MCP clients.
The agent runs in [camelRun](https://run.camelai.com); this separate Cloudflare
Worker delivers messages between the lead and its connected collaborators.

The lead's interface is deliberately small:

```text
participants()                         # people, their clients and named sessions, with ids
send_message(target, text, messageId)   # a session id, a client id, or target="all"
message_status(messageId)              # per-recipient delivery receipts
```

Clients use `join`, `message`, `get_messages`, `acknowledge`, `participants` and
`wait_token`. Multiple clients can submit simultaneously to **one shared agent
and conversation**. camelRun serializes their turns. A normal final reply goes
back to its caller; the lead can also proactively message any authorized client.
Each participant has a readable name such as `Miguel's Claude Code · chiridion-2`,
and each [named session](#names-and-sessions) has its own mailbox.
Durable SQLite mailboxes preserve messages when a client disconnects. No VM,
helper process or permanent socket is needed.

Nothing is pushed into a coding client. A client checks its mailbox with
`get_messages`, or [waits for the lead](#waiting-for-the-lead) with a background
shell command that exits when mail arrives.

## Status

Implemented and locally tested in real workerd, with synthetic camelRun responses.
**Not deployed; no real hosted model/client end-to-end execution verified.**
This is an operator-configured, trusted project/team adapter, not a public signup
service. A public source repository does not mean anonymous access to projects.

| Client                   | Conversation                                 | Getting updates from the lead                                  |
| ------------------------ | -------------------------------------------- | -------------------------------------------------------------- |
| Claude Code              | Remote MCP or included stdio adapter         | `wait_token` command in background Bash, or `get_messages`     |
| Codex                    | Remote MCP or included stdio adapter         | `wait_token` command as a background command, or `get_messages` |
| OpenCode                 | Remote MCP or included stdio adapter         | `wait_token` command as a background command, or `get_messages` |
| Cursor/other MCP clients | Remote MCP tools                             | `get_messages`; the `wait_token` command if it has a shell     |
| ChatGPT                  | MCP client capable of configured bearer auth | `get_messages`; no hosted connector registration               |

The earlier push paths (Claude development channel, Codex app-server bridge,
OpenCode HTTP bridge) are removed. Nothing starts a turn in an idle client: it
is woken by its own background command exiting, or it checks when convenient.

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

## Install in Claude Code

One step installs the lead's MCP server and the skill that teaches Claude how to work with it:

```
/plugin install camel-lead --marketplace qaml-ai/camel-lead
```

On older Claude Code versions: `/plugin marketplace add qaml-ai/camel-lead`, then `/plugin install camel-lead@camel-lead`.
Then run `/mcp`, pick `camel-lead` and sign in with GitHub (active members of the project's GitHub organization are
enrolled automatically). The plugin points at this project's lead; for another deployment set
`CAMEL_LEAD_MCP_URL=https://<your adapter>/projects/<project>/mcp` in your environment before starting Claude Code.

The plugin lives in `plugins/camel-lead` (`.mcp.json` and `skills/camel-lead/SKILL.md`). The same skill works in Codex:
copy or link it into its skills folder and add the MCP server with `codex mcp add camel-lead --url <url>`.

## Install in pi

Pi gets both halves from one package:

```
pi install /path/to/camel-lead/plugins/camel-lead-pi
```

That registers the lead's MCP server for every session and adds the `camel-lead` skill. Then run `/mcp` in a session,
pick `camel-lead` and sign in with GitHub; active members of the project's GitHub organization are enrolled
automatically. Shell `pi mcp` commands do not load extensions, so they neither list nor sign in an extension-registered
server. The package lives in `plugins/camel-lead-pi` (`extensions/camel-lead.ts` and
`skills/camel-lead/SKILL.md`). For another deployment set
`CAMEL_LEAD_MCP_URL=https://<your adapter>/projects/<project>/mcp` in the environment. A local path is loaded in place,
so updating the checkout updates the package; `pi remove <the same path>` uninstalls it.

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

### Names and sessions

Participants are shown to the lead and to each other as
`<Person>'s <Client>`, or `<Person>'s <Client> · <session name>` for a named
session: `Miguel's Claude Code · chiridion-2`.

- **Person** comes from verified identity, never from a tool argument: the
  GitHub profile name (else the login) for GitHub sign-in, or the registry's
  `name` for a static bearer client. An enrollment made before names were stored
  shows as `GitHub <id>` until its next request, which stores the name. The
  GitHub login is always kept and listed by `participants`; when two people in
  a project have the same name, both are shown as `<Name> (@login)`.
- **Client** comes from the MCP `clientInfo` the client sends in `initialize`
  (`Claude Code`, `Codex`, `pi`, `Cursor`; otherwise its own name, shortened;
  `agent` when unknown). It is a self-reported label, not an identity. The stdio
  adapter relays its coding client's name when it joins.
- **Session** is chosen by the agent. One client install often runs several
  agents (two repositories, two tasks); without sessions they would share one
  mailbox.

A client label or session name cannot contain `·` or `'s ` (they are replaced),
so no participant can be made to read as another.

`participants()` includes `status` (`online` or `offline`) for each person,
client, and session. Online means an active background message wait. A client
is online when its shared mailbox or any of its sessions is waiting; a person
is online when any of their clients is online. Closing or aborting the wait
updates status, while last-seen times and registered sessions remain available.
Stateless tool calls alone do not keep a client online. Between long polls,
status may briefly show offline. If a disconnect is not detected, the wait's
50-second timeout bounds how long it can remain online.

A new named session queues a `session_joined` presence event for the lead. A
session returning after at least one hour of inactivity queues `session_returned`,
with a one-hour notification cooldown. Repeated joins resume silently. Events
include the person, client, session name, and reply target, and use the durable
message queue with retries. The lead may reply to the joining session. Silent
completion creates no mailbox message. Presence events can incur model usage.

`join({ name })` creates or resumes a named session under the calling client and
returns `{ session, displayName }`. The name is 1 to 40 printable characters on
one line: the repository or task. Joining again with the same name returns the
same session id and mailbox, so an agent that lost its context gets its mail
back. `message`, `get_messages`, `acknowledge` and `wait_token` take that id as
an optional `session`:

- A `message` sent with a session is shown to the lead as from that session,
  and the lead's reply goes to that session's mailbox.
- A session reads its own mailbox and its client's shared mailbox, never
  another session's. Each message it reads is marked `mailbox: "session"` or
  `mailbox: "shared"`. `acknowledge({ seq, session, mailbox? })` acknowledges
  the session's own mailbox by default and the shared one with
  `mailbox: "shared"`. Several sessions of one client may each see the same
  shared message until one of them acknowledges it as shared; delivery is
  at-least-once. Another client's session id is refused like an unknown one.
- Without `session`, every tool uses the client's own mailbox exactly as before,
  so clients that never call `join` keep working.

The lead's `send_message` takes a session id, a client id or `"all"`. A message
to a client (or to all) is copied into the mailbox of each of that client's live
sessions (a wait parked right now, or seen in the last hour), or into the
client's shared mailbox when it has none, where every one of its sessions will
read it. Each copy is acknowledged separately.

A client may have 20 sessions; joining a 21st ends the longest-idle one that
has not been seen for a day and is not waiting, and is refused if there is
none. A session not seen for 7 days ends. When a session ends, its
unacknowledged messages move to the client's shared mailbox, the rest of its
records are deleted, and joining again with its name starts it afresh under the
same id.

The REST routes used by the stdio adapter take the same optional `session`
(`POST /projects/<project>/join` with `{ "name": ... }`, then `session` in the
body of `messages`, `ack` (with `mailbox`) and `wait-token`, or `?session=` on
`GET messages`).

## Direct messages, delivery receipts and files

Client MCPs and the stdio adapter expose `send_message` for direct communication. It accepts `target`, `text`, a
stable `messageId`, optional sender `session`, optional `attachments` (uploaded file IDs), and optional `replyTo`
(the incoming event ID being answered). Recipient IDs come from `participants`. Targets use the same session,
client and `"all"` fan-out as lead messages. This path queues mailbox messages without invoking the lead model.
The server supplies sender identity. A retry with identical content retains the original recipients, and changing
content under the same ID is refused. Message IDs are scoped to the sender mailbox.

`message_status({ messageId, session })` uses the returned server message ID and the sender session. It reports
per-recipient `queued`, `fetched`, `acknowledged`, and `replied` timestamps, plus the reply ID. Fetched means the
message was returned by a mailbox read, including a background wait. Acknowledged means the recipient called
`acknowledge`. Replies are recorded when a direct message sets `replyTo` and targets the original sender. Each
fan-out recipient has separate receipts. Delivery state survives restarts and forwarding to the shared mailbox
when a recipient session expires. Lead-originated sends can also be inspected through the lead's `message_status`
tool, using the original message ID. Deliveries from before this feature report `trackingAvailable: false`.

File sharing uses the Worker's `FILES` R2 binding. Before deploying this configuration, create the private
`camel-lead-files` bucket, or change `bucket_name` to your bucket. Existing mail and session data use additive SQLite
migrations. File metadata, access grants and short-lived transfer credentials live in the project room. Object
contents use project-prefixed R2 keys.
For an existing lead, rerun `scripts/activate.ts` after deployment to add `message_status` to its tool allowlist.

1. Compute the local file's size and SHA-256 hex digest.
2. Call `prepare_upload({ name, size, sha256, contentType?, ttlDays?, session? })` and run the returned curl command
   from the file's directory. The command performs a binary upload without sending file contents through MCP.
3. Attach the returned `file.id` with `send_message({ ..., attachments: [file.id] })` after upload succeeds.
4. Recipients call `get_file({ fileId, session? })` and run its curl command to download.

`list_files({ session?, after?, limit? })` paginates accessible, completed uploads.
`delete_file({ fileId, session? })` revokes future downloads and removes an owned object. Recipients can forward
files they can access by attaching them to another message. Deleted or expired files cannot be newly attached.
Already downloaded copies stay with their recipients.

Uploads are immutable and checksummed, with no application-imposed file-size cap, a default seven-day expiry and
a one-to-365-day lifetime setting. The single-request upload path remains subject to Cloudflare's request-body
limits and R2's single-part object limit. Upload and download credentials last at most 24 hours and work only for their file, project,
and direction. They also require the originating client and session to remain authorized. Keep these credentials
private. Metadata and downloads fail closed at expiry. The room alarm removes expired or abandoned uploads and
retries deletion after failures. Unfinished uploads remain available until their configured file expiry. Interrupted transfers can be retried
with the same command while its credential is valid, restarting from the beginning. Physical cleanup runs asynchronously. File contents are untrusted input.

### Parallel and resumable uploads

Call `prepare_upload` with `multipart: true` and the same filename, byte size and SHA-256 fields.
The response contains a private upload token, `partUrlTemplate`, and `multipart` metadata with `partSize`,
`partCount`, and recorded `parts`. The default part size is 8 MiB, increasing for files requiring more than
10,000 parts. An explicit `partSize` must be between 5 MiB and 5 GiB, and each request is still subject to
the host's request-body limit.

Split the source into `partSize`-byte chunks. Replace `{partNumber}` in `partUrlTemplate` with a 1-based
part number, then PUT that chunk with `Authorization: Bearer <token>` and its exact `Content-Length`.
The last chunk may be shorter. Upload independent parts concurrently and retry failed parts with the
same number. `resume_upload({ fileId, session? })` returns a fresh token and recorded parts after a
connection loss or process restart. Retry any part whose response was lost and is absent from that list.

After all parts succeed, call `complete_upload({ fileId, session? })`. Completion assembles the object
and streams it through SHA-256 verification before marking it ready for attachments or downloads.
Completion is retryable after a lost response. A checksum mismatch deletes the upload and requires a
new one. `delete_file` cancels an unfinished multipart upload as well as deleting completed files.
R2 automatically aborts unfinished multipart uploads after seven days under its default lifecycle policy.

The equivalent authenticated JSON routes are `POST send`, `POST message-status`, `POST prepare-upload`,
`POST resume-upload`, `POST complete-upload`, `POST get-file`, `POST list-files`, and `POST delete-file` under `/projects/<project>/`. File transfer commands use
`PUT` or `GET /projects/<project>/files/<fileId>/content` with their scoped bearer credential. A wait token cannot
transfer files.

## Waiting for the lead

Replies and messages from the lead arrive in the mailbox of the session that
was used (or the client's, without one). Every MCP tool answers at once; no tool
call blocks.

- **Check when convenient:** `get_messages` returns the unacknowledged messages
  (or an empty list). `acknowledge` what you have handled.
- **Be woken when something arrives:** call `wait_token`, run the command it
  returns as a background shell command (in Claude Code: the Bash tool with
  `run_in_background`), and carry on or stop. When the command exits, read what
  it printed, handle it, `acknowledge` it, and start the command again. No
  model tokens are spent while it waits.

`wait_token({ ttlMinutes?, timeoutSeconds?, follow?, session? })` returns `{ token, expiresAt, url,
command }`. With `session`, the token reads what that session reads: its own
mailbox and the client's shared one, never another session's. `ttlMinutes` is the token's life (5 to 1440, default 480).
`timeoutSeconds` is how long the command waits overall (60 to 86400, default
3600). The command is one self-contained POSIX `sh` line that needs only `curl`;
nothing is downloaded. Its exit codes:

| Exit | Meaning                                                                    |
| ---- | -------------------------------------------------------------------------- |
| `0`  | Mail arrived; the messages are printed as JSON (`{"events":[...],"next":N}`) |
| `2`  | Nothing arrived before the timeout; start it again to keep waiting          |
| `3`  | The token expired or was replaced; call `wait_token` again                  |
| `4`  | Permanent refusal (HTTP 400, 403 or 404): check the project and URL, or call `wait_token` again |

It retries network errors, HTTP 429 and server errors every 5 seconds. It never acknowledges:
until `acknowledge` is called, the same messages are printed again.

### One long-running command

With `follow: true` the command does not exit on mail. It prints each batch of
messages as one line of JSON and keeps waiting, moving past what it printed so
nothing is printed twice, until the overall timeout (exit `2`) or a refusal
(exit `3` or `4`). You still `acknowledge` what you have handled.

- Use the default (exit per message) wherever a background command's exit wakes
  the agent. It works in every harness that can run one.
- Use `follow` only when the harness surfaces a running command's output lines
  as events, for example a monitor or watch tool. One command then covers the
  whole session; in a harness that only reports on exit, its output would sit
  unread.

### The raw protocol

For your own loop:

```text
GET /projects/<project>/wait?timeout=<0..50>[&after=<seq>]
Authorization: Bearer <wait token>
```

- `200` with `{"events":[...],"next":<seq>}` as soon as the client has
  unacknowledged mail, at once or when it arrives. `after` skips sequences up
  to that number without acknowledging them.
- `204` with an empty body when `timeout` seconds pass with nothing (default 25;
  larger values are clamped to 50). Ask again.
- `401` when the token is unknown, expired or replaced, its client was
  removed or suspended, or its session ended. A waiting request ends with it at once on suspension,
  otherwise when its wait ends. `429` when too many requests are already
  waiting; retry after a pause.

The stateless Worker holds the request. The project's Durable Object only keeps
a hibernatable WebSocket per waiting request and can sleep until mail arrives,
so waiting costs wall-clock time, not compute.

### Security of wait tokens

- **Read-only.** A token can only read on the route above. It cannot send,
  acknowledge, list participants, mint tokens or use MCP, and client
  credentials are not accepted on that route.
- **One reader, one project.** It reads only what its minter reads, in that
  project: the client's shared mailbox, or with `session` that session's own
  mailbox and the shared one, never another session's.
  Removing or suspending the client, or the session ending, stops its tokens.
- **Short-lived.** It expires after `ttlMinutes`. Only its SHA-256 hash is stored.
- **Five live tokens per mailbox.** Minting a sixth drops the oldest; mint anew
  to rotate.
- **It appears in the model's context** and in the shell command, so treat it as
  readable by whatever can read the conversation. That is why it is narrow.
  Message content read with it is external data, not instructions.

## Delivery and safety

- Server-assigned client identity comes from bearer authentication, never a model
  argument. Clients can read/ack only their own mailbox and their own sessions'
  mailboxes; a session name only labels a mailbox under the authenticated client.
  All collaborators still share the lead's conversation and memory by design.
- Runtime prompts use stable request IDs. Ambiguous retries reuse the same ID.
  Alarm-driven outbox delivery and reply persistence survive DO eviction.
- Mailbox messages remain until explicitly acknowledged. Acknowledgement hides
  them from subsequent reads; it does not delete stored records.
- Delivery is at-least-once: a client crash after processing but before ack can
  repeat an event. Consumers must make side effects idempotent. Waiting never
  acknowledges anything.
- Waiting requests hold no state that matters. If the Durable Object or Worker
  restarts, the request ends, the command asks again, and the durable mailbox
  answers.
- Each mailbox may have 4 requests waiting at once and each project 256 (HTTP 429
  beyond that; an abandoned request frees its place within 50 seconds).
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
retries, live MCP wire contracts, the blocking read across hibernation, wait-token
scope and bounds, readable names, and session mailboxes (isolation, routing,
fan-out, expiry, and opening a room stored by an earlier version). `npm run test:node` checks the stdio adapter, runs the generated
wait command with `sh` against a synthetic server for each exit code, and checks
provisioning contracts. These are not claims of
live provider interoperability.

CI checks every push/PR. There is deliberately **no automatic deployment workflow**.

### GitHub organization sign-in

Remote MCP clients can sign in through GitHub, restricted to active `qaml-ai` members. Projects can enable automatic per-user/client mailboxes with `githubAutoEnroll: { "enabled": true }`; otherwise explicit mailbox grants are required. This is separate from the lead's signed runtime identity. See [GitHub OAuth setup, security and client limitations](docs/github-auth.md). Real credentials and a dedicated OAuth KV binding are deployment prerequisites; no Access configuration is required.
