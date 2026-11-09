import { OAuthAuthorizationServer, AuthorizationError, CimdFetchError } from '@cloudflare/workers-oauth-provider';
import { config, Failure, rpc, type ProjectConfig, type WorkerEnv } from './types.ts';
import { explicitMailbox } from './enrollment.ts';

const SCOPE = 'lead:messages';
type Props = { githubToken: string; githubUserId: string; project: string; client: string };
const escape = (s: string) => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
export function oauthEnabled(env: WorkerEnv) {
  return !!(env.OAUTH_KV && env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET);
}
export function resource(env: WorkerEnv, project: string) {
  return `${env.CAMEL_LEAD_URL.replace(/\/$/, '')}/projects/${project}/mcp`;
}
export function server(env: WorkerEnv) {
  const projects = Object.keys(JSON.parse(env.PROJECTS_JSON || '{}'));
  return new OAuthAuthorizationServer<WorkerEnv>({
    issuer: env.CAMEL_LEAD_URL.replace(/\/$/, ''),
    resources: projects.map(p => resource(env, p)),
    scopesSupported: [SCOPE],
    clientRegistrationEndpoint: '/oauth/register',
    accessTokenTTL: 3600,
    refreshTokenTTL: 86400,
    // Requires global_fetch_strictly_public. Keep the pinned provider hardening
    // in scripts/patch-oauth-provider.mjs until the upstream fixes are released.
    clientIdMetadataDocumentEnabled: true,
  });
}
export function mappedClient(p: ProjectConfig, userId: string, oauthClientId: string) {
  const client = explicitMailbox(p, userId, oauthClientId);
  if (!client) throw new Failure(403, 'No explicit project mailbox grant for this GitHub user and MCP client');
  return client;
}
type GitHubStage = 'github_token' | 'github_user' | 'github_membership';
function failureKind(error: unknown) {
  if (error instanceof Error && error.name === 'TimeoutError') return 'timeout';
  if (error instanceof Error && error.name === 'AbortError') return 'aborted';
  if (error instanceof TypeError) return 'type_error';
  if (error instanceof SyntaxError) return 'invalid_json';
  return 'unexpected';
}
function logOAuthFailure(stage: string, kind: string, status?: number) {
  // Never log URLs, bodies, tokens, codes, state, error messages or stacks.
  console.error(JSON.stringify({ event: 'oauth_operation_failed', stage, kind, ...(status === undefined ? {} : { status }) }));
}
// Workers does not implement redirect: 'error'. Use manual and reject non-2xx
// responses below, so credentials are never forwarded to a redirect destination.
async function githubFetch(stage: GitHubStage, url: string, init: RequestInit) {
  try { return await fetch(url, init); }
  catch (error) {
    logOAuthFailure(stage, failureKind(error));
    throw new Failure(503, 'GitHub authorization temporarily unavailable. Restart sign-in from your MCP client.');
  }
}
async function githubJson(stage: GitHubStage, response: Response): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await response.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new TypeError('Invalid response shape');
    return body as Record<string, unknown>;
  } catch (error) {
    logOAuthFailure(stage, failureKind(error), response.status);
    throw new Failure(503, 'GitHub authorization returned an invalid response. Restart sign-in from your MCP client.');
  }
}
async function github(path: string, token: string) {
  const stage: GitHubStage = path === '/user' ? 'github_user' : 'github_membership';
  const response = await githubFetch(stage, `https://api.github.com${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'camel-lead' },
    signal: AbortSignal.timeout(10000), redirect: 'manual',
  });
  if (response.status === 429 || response.status >= 500 || (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0'))
    throw new Failure(503, 'GitHub authorization temporarily unavailable');
  if (!response.ok) throw new Failure(403, 'GitHub authorization no longer valid');
  return githubJson(stage, response);
}
export async function githubIdentity(token: string) {
  const user = await github('/user', token);
  if (typeof user.id !== 'number' || !Number.isSafeInteger(user.id) || user.id <= 0) throw new Failure(403, 'Invalid GitHub identity');
  const membership = await github('/user/memberships/orgs/qaml-ai', token);
  if (membership.state !== 'active') throw new Failure(403, 'Active qaml-ai membership required');
  return String(user.id);
}
export async function oauthClient(request: Request, env: WorkerEnv, project: string, p: ProjectConfig) {
  const token = /^Bearer\s+(\S+)$/i.exec(request.headers.get('authorization') || '')?.[1];
  if (!token) throw new Failure(401, 'OAuth credential required');
  const grant = await server(env).validateToken<Props>(resource(env, project), token, env);
  if (!grant) throw new Failure(401, 'Invalid OAuth credential');
  if (!grant.scope.includes(SCOPE) || grant.props.project !== project) throw new Failure(403, 'Wrong project or scope');
  // Revalidate on every request: removed memberships and revoked GitHub tokens fail closed.
  let id: string;
  try { id = await githubIdentity(grant.props.githubToken); }
  catch (error) {
    // A definitive upstream revocation disables the user's automatic mailboxes.
    // Outages/rate limits fail this request closed, but are not revocations.
    if (error instanceof Failure && error.status === 403)
      await rpc(env.PROJECTS.getByName(project), 'suspendOAuthUser', project, grant.userId);
    throw error;
  }
  if (id !== grant.props.githubUserId || id !== grant.userId) throw new Failure(403, 'GitHub identity changed');
  const client = explicitMailbox(p, id, grant.clientId) ?? await rpc(env.PROJECTS.getByName(project), 'resolveOAuthClient', project, id, grant.clientId, false);
  if (client !== grant.props.client) throw new Failure(403, 'Mailbox grant changed');
  return client;
}
export async function oauthRoute(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response | undefined> {
  const url = new URL(request.url), path = url.pathname;
  const metadata = /^\/\.well-known\/oauth-protected-resource\/projects\/([A-Za-z0-9_-]{1,80})\/mcp$/.exec(path);
  if (!metadata && !['/authorize', '/oauth/callback', '/oauth/register', '/oauth/token', '/oauth/revoke', '/.well-known/oauth-authorization-server'].includes(path)) return;
  if (!oauthEnabled(env)) throw new Failure(503, 'GitHub MCP sign-in is not configured');
  const as = server(env), oauth = as.getOAuthApi(env);
  if (metadata) {
    config(env, metadata[1]);
    return Response.json({ resource: resource(env, metadata[1]), authorization_servers: [env.CAMEL_LEAD_URL.replace(/\/$/, '')], scopes_supported: [SCOPE] });
  }
  let callbackStage: string | undefined;
  try {
    if (path === '/authorize' && request.method === 'GET') {
      const auth = await oauth.parseAuthRequest(request);
      if (!auth.resource || !auth.scope.includes(SCOPE) || auth.scope.some(s => s !== SCOPE)) throw new Failure(400, 'Select a project resource and lead:messages scope');
      const details = await oauth.describeConsent(auth), consent = await oauth.beginConsent(auth);
      consent.headers.set('Content-Type', 'text/html; charset=utf-8');
      return new Response(`<!doctype html><meta charset="utf-8"><title>Connect camel-lead</title><h1>Connect ${escape(details.clientName)}?</h1>${details.clientDomain ? `<p>Client metadata published by <strong>${escape(details.clientDomain)}</strong>. The app name is self-asserted.</p>` : '<p>This app registered itself; its name is not verified.</p>'}<p>Allow reading and sending project messages. Tokens return to <strong>${escape(details.redirectHost)}</strong>.</p>${details.redirectIsLoopback ? '<p>This connects an app on your computer. Continue only if you started this sign-in.</p>' : ''}<p>Requires active qaml-ai membership and project access. If your GitHub account is allowed to connect automatically, this creates or reuses a private delivery mailbox for this exact MCP client ID: <code>${escape(auth.clientId)}</code>. Otherwise, ask the operator for access. All project participants share the lead conversation and memory; model usage is billed to the project.</p><form method="post"><input type="hidden" name="handle" value="${escape(consent.handle)}"><button name="decision" value="approve">Continue with GitHub</button><button name="decision" value="deny">Cancel</button></form>`, { headers: consent.headers });
    }
    if (path === '/authorize' && request.method === 'POST') {
      const form = await request.formData(), handle = String(form.get('handle'));
      if (form.get('decision') !== 'approve') return new Response(null, { status: 302, headers: (await oauth.denyConsent(request, handle)).headers });
      const approved = await oauth.approveConsent(request, handle, { scope: [SCOPE] });
      const verifier = crypto.randomUUID() + crypto.randomUUID();
      const { state, headers } = await oauth.beginUpstream(approved.request, { data: { verifier }, headers: approved.headers });
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
      const challenge = btoa(String.fromCharCode(...digest)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      const target = new URL('https://github.com/login/oauth/authorize');
      for (const [key, value] of Object.entries({ client_id: env.GITHUB_CLIENT_ID!, redirect_uri: `${env.CAMEL_LEAD_URL}/oauth/callback`, scope: 'read:org', state, code_challenge: challenge, code_challenge_method: 'S256', allow_signup: 'false' })) target.searchParams.set(key, value);
      headers.set('Location', target.href);
      return new Response(null, { status: 302, headers });
    }
    if (path === '/oauth/callback' && request.method === 'GET') {
      callbackStage = 'upstream_state';
      const { request: original, data, headers } = await oauth.finishUpstream<{ verifier: string }>(request);
      const code = url.searchParams.get('code');
      if (!code || url.searchParams.has('error')) throw new Failure(403, 'GitHub sign-in declined');
      if (!data || typeof data.verifier !== 'string') throw new Failure(400, 'Authorization failed or expired. Restart from your MCP client.');
      callbackStage = 'github_token';
      const response = await githubFetch('github_token', 'https://github.com/login/oauth/access_token', {
        method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'camel-lead' }, redirect: 'manual', signal: AbortSignal.timeout(10000),
        body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code, code_verifier: data.verifier, redirect_uri: `${env.CAMEL_LEAD_URL}/oauth/callback` }),
      });
      if (!response.ok) throw new Failure(503, 'GitHub token exchange failed');
      const upstream = await githubJson('github_token', response);
      if (typeof upstream.access_token !== 'string' || typeof upstream.scope !== 'string' || !upstream.scope.split(/[ ,]+/).includes('read:org')) throw new Failure(403, 'GitHub read:org permission required');
      callbackStage = 'github_identity';
      const userId = await githubIdentity(upstream.access_token);
      callbackStage = 'project_grant';
      const project = Object.keys(JSON.parse(env.PROJECTS_JSON)).find(p => resource(env, p) === original.resource);
      if (!project) throw new Failure(403, 'Unknown project resource');
      const client = explicitMailbox(config(env, project), userId, original.clientId) ?? await rpc(env.PROJECTS.getByName(project), 'resolveOAuthClient', project, userId, original.clientId, true);
      callbackStage = 'issue_authorization';
      const { redirectTo } = await oauth.completeAuthorization({ request: original, userId, metadata: { project, client }, scope: [SCOPE], props: { githubToken: upstream.access_token, githubUserId: userId, project, client }, revokeExistingGrants: false });
      headers.set('Location', redirectTo);
      return new Response(null, { status: 302, headers });
    }
    return await as.fetch(request, env, ctx);
  } catch (e) {
    if (e instanceof CimdFetchError) return Response.json({ error: 'invalid_client', error_description: 'Client metadata could not be verified. Retry from your MCP client or contact its operator.' }, { status: 400, headers: { 'Cache-Control': 'no-store' } });
    if (e instanceof AuthorizationError) return new Response('Authorization failed or expired. Restart from your MCP client.', { status: 400, headers: { 'Cache-Control': 'no-store' } });
    if (callbackStage && !(e instanceof Failure)) logOAuthFailure(callbackStage, failureKind(e));
    throw e;
  }
}
