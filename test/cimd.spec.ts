import { env } from 'cloudflare:workers';
import { createExecutionContext, reset } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import worker from '../src/worker.ts';
import { hash, type WorkerEnv } from '../src/types.ts';

const origin = 'https://lead.test';
const clientId = 'https://claude.ai/oauth/claude-code-client-metadata';
const redirect = 'http://localhost:43127/callback';
const verifier = 'a'.repeat(64);
function settings(): WorkerEnv {
  const project = { agentId: 'client_' + 'a'.repeat(40), tenantId: 'test', clients: {
    alice: { name: 'Alice', github: { userId: '123', oauthClientId: clientId } },
  } };
  return { ...env, CAMEL_LEAD_URL: origin, GITHUB_CLIENT_ID: 'test-client', GITHUB_CLIENT_SECRET: 'test-secret', PROJECTS_JSON: JSON.stringify({ demo: project, other: project }) };
}
function document(overrides: Record<string, unknown> = {}) {
  return { client_id: clientId, client_name: '<Claude>', redirect_uris: ['http://localhost/callback'], token_endpoint_auth_methods_supported: ['none'], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], ...overrides };
}
function call(path: string, e = settings(), init?: RequestInit) {
  return worker.fetch(new Request(origin + path, init), e, createExecutionContext());
}
function cookies(r: Response) { return r.headers.getSetCookie().map(s => s.split(';')[0]).join('; '); }
function form(body: Record<string, string>, cookie = ''): RequestInit {
  return { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie }, body: new URLSearchParams(body) };
}
async function params(overrides: Record<string, string> = {}) {
  const digest = await hash(verifier);
  const challenge = btoa(String.fromCharCode(...digest.match(/../g)!.map(x => parseInt(x, 16)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return new URLSearchParams({ client_id: clientId, redirect_uri: redirect, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', resource: origin + '/projects/demo/mcp', scope: 'lead:messages', state: 'client-state', ...overrides });
}
function metadata(response = () => Response.json(document())) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    expect(String(input)).toBe(clientId);
    expect(init?.redirect).toBe('manual');
    expect(init?.credentials).toBe('omit');
    const headers = new Headers(init?.headers);
    expect(headers.get('accept')).toBe('application/json');
    expect(headers.has('authorization')).toBe(false);
    expect(headers.has('cookie')).toBe(false);
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    return response();
  });
}
async function login(e = settings()) {
  const page = await call('/authorize?' + await params(), e);
  expect(page.status).toBe(200);
  const html = await page.text();
  expect(html).toContain('&#60;Claude&#62;');
  expect(html).toContain('Client metadata published by <strong>claude.ai</strong>');
  expect(html).toContain('app on your computer');
  const handle = /name="handle" value="([^"]+)"/.exec(html)![1];
  const approval = await call('/authorize', e, form({ handle, decision: 'approve' }, cookies(page)));
  expect(approval.status).toBe(302);
  const upstream = new URL(approval.headers.get('location')!);
  expect(upstream.searchParams.get('code_challenge_method')).toBe('S256');
  const callback = await call('/oauth/callback?code=test-code&state=' + upstream.searchParams.get('state'), e, { headers: { Cookie: cookies(approval) } });
  return { page, approval, callback };
}
function upstreamMocks() {
  let active = true;
  const mock = metadata();
  const metadataOnly = mock.getMockImplementation()!;
  mock.mockImplementation(async (input, init) => {
    const url = String(input);
    if (url === 'https://github.com/login/oauth/access_token') return Response.json({ access_token: 'github-test-only', scope: 'read:org' });
    if (url === 'https://api.github.com/user') return Response.json({ id: 123 });
    if (url.endsWith('/memberships/orgs/qaml-ai')) return Response.json({ state: active ? 'active' : 'pending' });
    return metadataOnly(input, init);
  });
  return { revoke: () => { active = false; } };
}
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await reset(); });

it('advertises CIMD with public-client auth, issuer binding, S256 and DCR fallback', async () => {
  const response = await call('/.well-known/oauth-authorization-server');
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    client_id_metadata_document_supported: true,
    issuer: origin,
    authorization_response_iss_parameter_supported: true,
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: expect.arrayContaining(['none']),
    registration_endpoint: origin + '/oauth/register',
  });
});

it('authorizes a CIMD client without DCR, supports ephemeral loopback ports and preserves project isolation, refresh and revocation', async () => {
  const e = settings(), upstream = upstreamMocks();
  const { callback } = await login(e);
  expect(callback.status).toBe(302);
  const target = new URL(callback.headers.get('location')!);
  expect(target.origin + target.pathname).toBe(redirect);
  expect(target.searchParams.get('state')).toBe('client-state');
  expect(target.searchParams.get('iss')).toBe(origin);
  const tokenResponse = await call('/oauth/token', e, form({ grant_type: 'authorization_code', client_id: clientId, redirect_uri: redirect, code: target.searchParams.get('code')!, code_verifier: verifier }));
  expect(tokenResponse.status).toBe(200);
  const token = await tokenResponse.json<any>();
  expect(token.refresh_token).toBeTruthy();
  const headers = { Authorization: `Bearer ${token.access_token}` };
  expect((await call('/projects/demo/messages', e, { headers })).status).toBe(200);
  expect((await call('/projects/other/messages', e, { headers })).status).toBe(401);
  const refreshed = await call('/oauth/token', e, form({ grant_type: 'refresh_token', refresh_token: token.refresh_token, client_id: clientId }));
  expect(refreshed.status).toBe(200);
  upstream.revoke();
  expect((await call('/projects/demo/messages', e, { headers })).status).toBe(403);
  expect(await e.OAUTH_KV!.get('client:' + clientId)).toBeNull();
});

it('does not turn a valid metadata document into a project mailbox grant', async () => {
  const e = settings();
  const projects = JSON.parse(e.PROJECTS_JSON);
  projects.demo.clients.alice.github.oauthClientId = 'a-different-client';
  e.PROJECTS_JSON = JSON.stringify(projects);
  upstreamMocks();
  const { callback } = await login(e);
  expect(callback.status).toBe(403);
  expect(callback.headers.has('location')).toBe(false);
});

it.each([
  { redirect_uri: 'https://attacker.example/callback' },
  { redirect_uri: 'http://localhost:43127/other' },
  { redirect_uri: 'http://127.0.0.1:43127/callback' },
  { code_challenge_method: 'plain' },
  { code_challenge: '' },
  { resource: 'https://attacker.example/mcp' },
])('rejects invalid authorization parameters %j', async overrides => {
  metadata();
  const response = await call('/authorize?' + await params(overrides));
  expect(response.status).toBe(400);
  expect(response.headers.has('location')).toBe(false);
});

it.each([
  'http://example.com/client.json',
  'https://example.com/',
  'https://example.com/client.json#',
  'https://user@example.com/client.json',
  'https://@example.com/client.json',
  'https://example.com/a/../client.json',
  'https://example.com/a/%2e%2e/client.json',
])('rejects invalid client ID without fetching: %s', async id => {
  const mock = vi.spyOn(globalThis, 'fetch');
  expect((await call('/authorize?' + await params({ client_id: id }))).status).toBe(400);
  expect(mock).not.toHaveBeenCalled();
});

it.each([
  { client_id: clientId + '/wrong' },
  { client_name: '' },
  { redirect_uris: [] },
  { redirect_uris: ['https://example.com/callback#'] },
  { redirect_uris: ['javascript:alert(1)'] },
  { token_endpoint_auth_methods_supported: ['none', 'client_secret_basic'] },
  { token_endpoint_auth_method: 'client_secret_post' },
  { token_endpoint_auth_methods_supported: ['unsupported-only'] },
  { grant_types: ['client_credentials'] },
  { client_secret: 'must-not-be-published' },
  { jwks: { keys: [{ kty: 'RSA', d: 'private-material' }] } },
  { jwks: { keys: [] }, jwks_uri: 'https://example.com/jwks' },
])('rejects invalid client metadata %j with safe local errors', async overrides => {
  metadata(() => Response.json(document(overrides)));
  const response = await call('/authorize?' + await params());
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: 'invalid_client' });
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.has('location')).toBe(false);
});

it.each([201, 204, 302, 307, 404, 500])('rejects non-200 metadata status %i without following redirects', async status => {
  const mock = metadata(() => new Response(status === 204 ? null : JSON.stringify(document()), { status, headers: { Location: 'http://127.0.0.1/internal' } }));
  const response = await call('/authorize?' + await params());
  expect(response.status).toBe(400);
  expect(mock).toHaveBeenCalledTimes(1);
});

it.each([
  () => new Response('{invalid json'),
  () => new Response('x'.repeat(5121)),
  () => new Response('{}', { headers: { 'Content-Length': '5121' } }),
])('rejects invalid or oversized metadata responses', async response => {
  metadata(response);
  expect((await call('/authorize?' + await params())).status).toBe(400);
});

it('returns invalid_client instead of a generic 500 when metadata cannot be reached', async () => {
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('network detail should stay private'));
  const response = await call('/authorize?' + await params());
  expect(response.status).toBe(400);
  expect(await response.text()).not.toContain('network detail');
});

it('does not exchange a code without its PKCE verifier', async () => {
  upstreamMocks();
  const { callback } = await login();
  const code = new URL(callback.headers.get('location')!).searchParams.get('code')!;
  const response = await call('/oauth/token', settings(), form({ grant_type: 'authorization_code', client_id: clientId, redirect_uri: redirect, code }));
  expect(response.status).toBe(400);
  expect(await response.json()).not.toHaveProperty('access_token');
});


it('does not advertise CIMD when the public-only runtime flag is absent', async () => {
  vi.stubGlobal('Cloudflare', { compatibilityFlags: { global_fetch_strictly_public: false } });
  const response = await call('/.well-known/oauth-authorization-server');
  expect(await response.json()).toMatchObject({ client_id_metadata_document_supported: false });
});

it('redacts metadata fetch logs including untrusted URL query values', async () => {
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('private upstream error'));
  const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const response = await call('/authorize?' + await params({ client_id: clientId + '?untrusted=secret-query' }));
  expect(response.status).toBe(400);
  expect(log).toHaveBeenCalledWith(JSON.stringify({ event: 'cimd_metadata_resolution_failed' }));
  const text = JSON.stringify(log.mock.calls);
  expect(text).not.toContain('secret-query');
  expect(text).not.toContain('private upstream error');
});

const jwksUrl = 'https://claude.ai/oauth/test-jwks';
async function assertionFixture() {
  const key = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
  const jwk = { ...await crypto.subtle.exportKey('jwk', key.publicKey), alg: 'ES256', kid: 'test-key', use: 'sig' };
  const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const json = (value: unknown) => encode(new TextEncoder().encode(JSON.stringify(value)));
  const jwt = async (aud = origin) => {
    const now = Math.floor(Date.now() / 1000);
    const input = json({ typ: 'client-authentication+jwt', alg: 'ES256', kid: 'test-key' }) + '.' + json({ iss: clientId, sub: clientId, aud, iat: now, exp: now + 60, jti: crypto.randomUUID() });
    const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key.privateKey, new TextEncoder().encode(input));
    return input + '.' + encode(new Uint8Array(signature));
  };
  upstreamMocks();
  const mock = vi.mocked(fetch), original = mock.getMockImplementation()!;
  let jwksStatus = 200;
  mock.mockImplementation(async (input, init) => {
    if (String(input) === clientId) return Response.json(document({ token_endpoint_auth_methods_supported: ['private_key_jwt'], jwks_uri: jwksUrl }));
    if (String(input) === jwksUrl) {
      expect(init?.redirect).toBe('manual'); expect(init?.credentials).toBe('omit');
      return Response.json({ keys: [jwk] }, { status: jwksStatus, headers: { Location: 'http://attacker.example/keys' } });
    }
    return original(input, init);
  });
  const { callback } = await login();
  expect(callback.status).toBe(302);
  const body = { grant_type: 'authorization_code', client_id: clientId, redirect_uri: redirect, code: new URL(callback.headers.get('location')!).searchParams.get('code')!, code_verifier: verifier };
  const authenticated = async (aud = origin) => ({ ...body, client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer', client_assertion: await jwt(aud) });
  return { body, authenticated, status: (value: number) => { jwksStatus = value; } };
}
it('supports issuer-bound asymmetric CIMD clients without allowing a downgrade to none', async () => {
  const f = await assertionFixture();
  const missing = await call('/oauth/token', settings(), form(f.body));
  expect(await missing.json()).toMatchObject({ error: 'invalid_client' });
  const wrongAudience = await call('/oauth/token', settings(), form(await f.authenticated('https://attacker.example')));
  expect(await wrongAudience.json()).toMatchObject({ error: 'invalid_client' });
  const correct = await call('/oauth/token', settings(), form(await f.authenticated()));
  expect(correct.status).toBe(200);
  expect(await correct.json()).toHaveProperty('access_token');
});
it.each([201, 302, 307])('rejects JWKS status %i without following key redirects', async status => {
  const f = await assertionFixture();
  f.status(status);
  const response = await call('/oauth/token', settings(), form(await f.authenticated()));
  expect(await response.json()).toMatchObject({ error: 'invalid_client' });
  expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).startsWith('http://attacker.example'))).toBe(false);
});
