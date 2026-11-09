# GitHub sign-in for shared MCP projects

The default human/client authentication is direct GitHub OAuth, using the Cloudflare OAuth provider library for the MCP authorization server. Cloudflare Access is optional infrastructure, not a prerequisite. The lead's `/agent/:project/mcp` endpoint still uses camelRun runtime Ed25519 identities.

## Security model

Sign-in requires active `qaml-ai` membership **and** an explicit mailbox grant for a stable GitHub numeric user ID and MCP OAuth client ID. No project-wide or organization-wide automatic admission occurs. Each MCP client gets a separate configured mailbox, even when the same human uses several clients. A mailbox grant cannot be ambiguous. Removing the mapping takes effect on the next request.

GitHub is queried on every OAuth-authenticated request to revalidate the numeric identity and organization membership. Revoked GitHub access, removed membership and unavailable membership checks fail closed. This costs two GitHub API requests per client request; GitHub limits can temporarily block access. Upstream token expiration requires signing in again; this version does not refresh GitHub tokens.

The MCP server asks for `lead:messages` only; GitHub asks for `read:org` only (no repository access, email permission, write scopes, or device flow). Consent shows the requesting client's self-asserted name, return hostname and localhost warning. Browser-bound single-use consent and upstream state use Secure HttpOnly cookies, with PKCE on both OAuth hops. MCP tokens are audience-bound to the exact project MCP endpoint. Access tokens last one hour; refresh grants last one day. DCR is supported; client metadata URL fetching is disabled.

GitHub tokens are retained only in the OAuth provider's encrypted grant props in KV. MCP clients receive adapter tokens, never GitHub tokens. This is not encryption against an operator controlling the running Worker. No tokens or authorization codes should be logged.

Existing per-client token hashes remain supported for existing CLI bridges; omit `tokenHash` to make a mailbox OAuth-only. Do not leave bearer credentials enabled if your policy requires GitHub membership on every request.

## Deployment prerequisites

Coordinate these with the deployment operator; do not create a second runtime agent or memory volume.

1. Choose the final HTTPS camel-lead origin, matching `CAMEL_LEAD_URL` exactly without a trailing slash.
2. Register a **dedicated GitHub OAuth App**, preferably owned by `qaml-ai`: homepage = that origin; callback = `<origin>/oauth/callback`. Request no repository permissions. Do not change an existing app's callbacks. Organization OAuth restrictions/SSO may require the organization's approval of this app.
3. Put `GITHUB_CLIENT_SECRET` in the Worker's encrypted secret binding using a secure input path that does not echo it. Put `GITHUB_CLIENT_ID` in a binding (it is public, but can also be a secret). Never commit the secret, place it in plaintext Wrangler vars, or send it in chat. Keep the upstream app secret in the operator's normal secure credential store.
4. Create one dedicated KV namespace and bind it as `OAUTH_KV` in this deployment. This namespace stores the OAuth provider's clients, encrypted grants, hashes, and short-lived browser transactions. No Access policy, DNS or firewall changes are needed for direct OAuth.
5. Both credentials and the KV binding are required to enable OAuth. Without all three, sign-in endpoints return 503 and existing bearer clients still work.

This code does not create the OAuth App, its real credentials, or the KV namespace automatically.

## Connect a client

Configure the remote MCP endpoint as `<origin>/projects/demo/mcp` in an OAuth-capable client. It discovers the protected-resource metadata and authorization server, registers through `/oauth/register`, and opens `/authorize`.

The consent page shows the MCP **client ID**. The operator adds an explicit mailbox entry in the private `PROJECTS_JSON` registry, alongside the existing agent/tenant IDs:

```json
{
  "demo": {
    "agentId": "client_<existing-agent-id>",
    "tenantId": "<existing-tenant>",
    "clients": {
      "miguel-codex": {
        "name": "Miguel / Codex",
        "github": { "userId": "<numeric-github-id>", "oauthClientId": "<registered-mcp-client-id>" }
      },
      "miguel-claude": {
        "name": "Miguel / Claude",
        "github": { "userId": "<same-numeric-github-id>", "oauthClientId": "<different-mcp-client-id>" }
      }
    }
  }
}
```

Publish the registry through the existing secure configuration process, then continue or restart sign-in. Authorization fails until the mapping exists. A re-registered client needs its new client ID granted. These operator grants are intentionally explicit in this version; a self-service project invitation/admin UI is not implemented.

## Compatibility and validation

Remote clients must implement MCP OAuth with PKCE, resource indicators and DCR. OAuth does not add push support to a client. Existing local stdio/app-server bridges still use configured bearer credentials; they do not yet perform the new OAuth flow or refresh automatically.

Workers tests exercise DCR, HTML escaping, consent cookie binding, upstream PKCE, callback, token exchange, project audience isolation, mailbox grants, membership removal and rate-limit failures with mocked GitHub. They do not prove a real GitHub login or native client integration. Test both with the real OAuth App before announcing sign-in as live.

References: [GitHub OAuth web flow](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps), [Cloudflare OAuth provider](https://github.com/cloudflare/workers-oauth-provider).
