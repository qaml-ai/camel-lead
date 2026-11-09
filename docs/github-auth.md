# GitHub sign-in for shared MCP projects

The default human/client authentication is direct GitHub OAuth, using the Cloudflare OAuth provider library for the MCP authorization server. Cloudflare Access is optional infrastructure, not a prerequisite. The lead's `/agent/:project/mcp` endpoint still uses camelRun runtime Ed25519 identities.

## Security model

Sign-in always requires active `qaml-ai` membership. Projects can opt into automatic membership-based enrollment with `githubAutoEnroll: { "enabled": true }` in their private `PROJECTS_JSON` entry. Every active member can then connect through normal browser consent without an operator granting each new MCP client. Automatic enrollment is disabled unless explicitly enabled for that project. Existing explicit mailbox mappings remain supported and take precedence.

Automatic mailboxes are derived from the exact project, stable GitHub numeric ID and exact OAuth client ID. Their names and attribution are server-derived, never taken from a self-asserted app name: the person shown is the verified GitHub profile name (else the login), stored at sign-in and refreshed on later requests. The MCP client's self-reported `clientInfo` only supplies the client label next to it. Two different clients or users never share one delivery mailbox. The project lead's conversation and memory are still shared by all project participants.
GitHub is queried on every OAuth-authenticated request to revalidate the numeric identity and organization membership. Revoked GitHub access, removed membership and unavailable membership checks fail closed. This costs two GitHub API requests per client request; GitHub limits can temporarily block access. Upstream token expiration requires signing in again; this version does not refresh GitHub tokens.

The MCP server asks for `lead:messages` only; GitHub asks for `read:org` only (no repository access, email permission, write scopes, or device flow). Consent shows the requesting client's self-asserted name, return hostname and localhost warning. Browser-bound single-use consent and upstream state use Secure HttpOnly cookies, with PKCE on both OAuth hops. MCP tokens are audience-bound to the exact project MCP endpoint. Access tokens last one hour; refresh grants last one day. CIMD (Client ID Metadata Documents) and DCR are both supported. CIMD uses the client's stable HTTPS metadata URL as its exact client ID. This identifies the client application; it does not replace GitHub sign-in, consent, or project access policy.

GitHub tokens are retained only in the OAuth provider's encrypted grant props in KV. MCP clients receive adapter tokens, never GitHub tokens. This is not encryption against an operator controlling the running Worker. No tokens or authorization codes should be logged.

Existing per-client token hashes remain supported for the stdio adapter; omit `tokenHash` to make a mailbox OAuth-only. Do not leave bearer credentials enabled if your policy requires GitHub membership on every request.

## Deployment prerequisites

Coordinate these with the deployment operator; do not create a second runtime agent or memory volume.

1. Choose the final HTTPS camel-lead origin, matching `CAMEL_LEAD_URL` exactly without a trailing slash.
2. Register a **dedicated GitHub OAuth App**, preferably owned by `qaml-ai`: homepage = that origin; callback = `<origin>/oauth/callback`. Request no repository permissions. Do not change an existing app's callbacks. Organization OAuth restrictions/SSO may require the organization's approval of this app.
3. Put `GITHUB_CLIENT_SECRET` in the Worker's encrypted secret binding using a secure input path that does not echo it. Put `GITHUB_CLIENT_ID` in a binding (it is public, but can also be a secret). Never commit the secret, place it in plaintext Wrangler vars, or send it in chat. Keep the upstream app secret in the operator's normal secure credential store.
4. Create one dedicated KV namespace and bind it as `OAUTH_KV` in this deployment. This namespace stores the OAuth provider's clients, encrypted grants, hashes, and short-lived browser transactions. No Access policy, DNS or firewall changes are needed for direct OAuth.
5. Both credentials and the KV binding are required to enable OAuth. Without all three, sign-in endpoints return 503 and existing bearer clients still work.

This code does not create the OAuth App, its real credentials, or the KV namespace automatically.

## Connect a client

Configure the remote MCP endpoint as `<origin>/projects/demo/mcp` in an OAuth-capable client. It discovers the protected-resource metadata and authorization server, then uses its published CIMD URL as `client_id` or registers through `/oauth/register` (DCR), and opens `/authorize`.

For the existing camel-lead project, preserve its agent, tenant and clients and add:

```json
"githubAutoEnroll": { "enabled": true }
```

Publish that private registry through the existing secure configuration process. Members then restart sign-in from their MCP client and approve the displayed app/redirect host. The callback creates a durable mailbox automatically after checking GitHub identity and membership. No runtime credential, upstream GitHub token or new static client token is copied into that mailbox registry. GitHub tokens remain only in the OAuth provider's encrypted grant props.

The exact client ID is the identity: prefer the vendor's stable CIMD URL. Claude Code and Claude web/Desktop may use different URLs, so they receive different mailboxes. Two installations using the same CIMD ID and GitHub account intentionally share a mailbox. DCR works too, but a newly registered client ID creates a new mailbox; names/domains are never used to merge them. Repeating consent for the same identity is idempotent and preserves messages/acknowledgements.

Automatic enrollment is capped at 16 distinct client IDs per user per project. `maxClientsPerUser` can explicitly set 1–32. Suspended/blocked entries still count, so rotating DCR registrations cannot evade the cap. DCR itself is public and still consumes OAuth KV storage; use platform rate limits if this becomes a problem. Public client registration alone never grants project access.

To disable automatic access for the project, remove `githubAutoEnroll` or set `enabled: false`. To block an exact automatic client ID for all members, set `blockedClientIds` to an array of those IDs. These checks apply to requests, participant lists, new deliveries and queued jobs. Existing manual grants are independent and must be removed separately if also being revoked. Mailboxes and message history are retained, not deleted. Removing and later restoring the policy re-enables eligible identities.

Every client request rechecks live GitHub identity/membership. On a definitive GitHub revocation, all automatic mailboxes for that user are suspended; verified later requests reactivate only their own mailbox. Background delivery does not store GitHub credentials or poll membership: before revocation is observed, previously authorized queued work can still execute and messages can still be queued. The removed member cannot read/submit/ack with OAuth because the next request fails closed. An in-flight runtime request cannot be cancelled by this adapter; inspect its stable request ID before replaying. GitHub outages deny client requests but do not masquerade as permanent revocation.

New broadcast delivery records freeze the original recipients, including an empty set. Retrying the same message ID after another client enrolls never sends that old broadcast to the new client. Pre-upgrade broadcast records retain their conservative conflict behavior if the recipient set changed.

For projects that keep automatic enrollment disabled, operators can continue using explicit entries such as `"miguel-claude": { "name": "Miguel / Claude", "github": { "userId": "<numeric-id>", "oauthClientId": "<exact-client-id>" } }` inside `clients`. Ambiguous mappings fail closed; adding a manual mapping does not silently expose an old automatic mailbox under a different identity.

## CIMD fetch safety and deployment

The provider advertises `client_id_metadata_document_supported: true` only when `global_fetch_strictly_public` is active. Keep this compatibility flag alongside `nodejs_compat` in **every deployment configuration**, including private deployment overrides. It blocks non-public fetch destinations at the runtime layer, including DNS-based private addresses; string checks alone are not an SSRF defense. No DNS, firewall or project permissions are relaxed by CIMD.

`@cloudflare/workers-oauth-provider` is pinned at 1.2.4. `npm ci` runs the checked-in `postinstall` hardening patch, which fails on an unexpected version or bundle. It requires non-root HTTPS client IDs without userinfo, dot path components or fragments, rejects redirects/non-200 responses for both client metadata and JWKS, and tightens metadata validation. Do not deploy with lifecycle scripts disabled: run `node scripts/patch-oauth-provider.mjs` and `npm run test:oauth-patch` explicitly in that case. Keep these tests when upgrading and remove the patch only after verifying equivalent upstream protections.

The provider bounds each metadata body to 5 KiB and fetches to 10 seconds, verifies exact document `client_id`, registered redirect URIs, allowed grants and authentication methods, and uses only public key material. Fetches do not forward browser cookies or credentials. Application metadata-failure logs omit URLs and raw errors; keep `observability.redact_query_string: true` in deployment overrides so platform logs/traces omit OAuth callback query strings too. Metadata is cached only after validation according to the provider's HTTP-cache policy. Provider metadata fetch failures return a safe `invalid_client` error, not a redirect to an unverified URI. CIMD itself grants no access. The project policy, verified GitHub identity, active organization membership and explicit browser consent determine admission. No existing explicit registry entries are changed by automatic enrollment.

## Compatibility and validation

Remote clients must implement MCP OAuth with PKCE, resource indicators and either CIMD or DCR. Claude Code may choose an ephemeral loopback port; the provider allows only that port to vary, keeping the registered scheme, host, path and query matched. A stable vendor CIMD URL is shared across installations: one GitHub user using two installations with the same client ID maps to the same mailbox. Use distinct client IDs if separate mailboxes are required. Nothing is pushed to a client; it checks with `get_messages` or waits with the `wait_token` command. A wait token is minted by an authenticated MCP call and is not rechecked against GitHub while it lives: it is read-only, expires (8 hours by default, 24 at most) and stops working when an automatically enrolled mailbox is suspended by a failed membership check. The local stdio adapter still uses configured bearer credentials; it does not yet perform the OAuth flow or refresh automatically.

Workers tests exercise CIMD without DCR, discovery, metadata/URL validation, no-redirect fetching, size limits, PKCE, refresh, exact mailbox grants and DCR, HTML escaping, consent cookie binding, upstream PKCE, callback, token exchange, project audience isolation, mailbox grants, membership removal and rate-limit failures with mocked GitHub. They do not prove a real GitHub login or native client integration. Test both with the real OAuth App before announcing sign-in as live.

References: [Anthropic connector authentication](https://claude.com/docs/connectors/building/authentication), [GitHub OAuth web flow](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps), [Cloudflare OAuth provider](https://github.com/cloudflare/workers-oauth-provider), [CIMD draft-03](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-client-id-metadata-document-03), [MCP client registration](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/client-registration).
