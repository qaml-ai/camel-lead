import { env } from 'cloudflare:workers';
import { createExecutionContext, reset } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import worker from '../src/worker.ts';
import { hash } from '../src/types.ts';
import type { WorkerEnv } from '../src/types.ts';
import { githubIdentity, mappedClient } from '../src/oauth.ts';
const origin = 'https://lead.test';
const p = { agentId: 'client_' + 'a'.repeat(40), tenantId: 'test', clients: {
  alice: { name: 'Alice', github: { userId: '123', oauthClientId: 'placeholder' } },
  bob: { name: 'Bob', github: { userId: '123', oauthClientId: 'other-client' } },
} };
function settings(): WorkerEnv {
  return { ...env, CAMEL_LEAD_URL: origin, GITHUB_CLIENT_ID: 'test-github-client', GITHUB_CLIENT_SECRET: 'test-github-secret', PROJECTS_JSON: JSON.stringify({ demo: p, other: p }) };
}
function call(path: string, e: WorkerEnv, init?: RequestInit) {
  return worker.fetch(new Request(origin + path, init), e, createExecutionContext());
}
function cookies(r: Response) { return r.headers.getSetCookie().map(s => s.split(';')[0]).join('; '); }
async function fixture() {
  const e = settings();
  const registration = await call('/oauth/register', e, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: '<Client>', redirect_uris: ['http://localhost:9000/callback'], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }) });
  expect(registration.status).toBe(201);
  const registered = await registration.json<any>();
  const project = structuredClone(p); project.clients.alice.github.oauthClientId = registered.client_id;
  e.PROJECTS_JSON = JSON.stringify({ demo: project, other: project });
  const verifier = 'a'.repeat(64), digest = await hash(verifier);
  const challenge = btoa(String.fromCharCode(...digest.match(/../g)!.map(x => parseInt(x, 16)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const params = new URLSearchParams({ client_id: registered.client_id, redirect_uri: 'http://localhost:9000/callback', response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', resource: origin + '/projects/demo/mcp', scope: 'lead:messages', state: 'client-state' });
  return { e, registered, verifier, params };
}
afterEach(async () => { vi.restoreAllMocks(); await reset(); });
it('requires exact user and client grants, rejecting ambiguous mappings', () => {
  expect(mappedClient(p, '123', 'other-client')).toBe('bob');
  expect(() => mappedClient(p, '999', 'other-client')).toThrow();
  expect(() => mappedClient(p, '123', 'unregistered')).toThrow();
  expect(() => mappedClient({ ...p, clients: { ...p.clients, duplicate: p.clients.bob } }, '123', 'other-client')).toThrow();
});
it('performs browser consent, GitHub PKCE, MCP OAuth issuance, audience isolation and live revocation', async () => {
  const { e, registered, verifier, params } = await fixture();
  const page = await call('/authorize?' + params, e);
  expect(page.status).toBe(200);
  const html = await page.text();
  expect(html).toContain('&#60;Client&#62;'); expect(html).toContain('localhost');
  expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
  const handle = /name="handle" value="([^"]+)"/.exec(html)![1];
  const approval = await call('/authorize', e, { method: 'POST', headers: { Cookie: cookies(page), 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ handle, decision: 'approve' }) });
  expect(approval.status).toBe(302);
  const upstream = new URL(approval.headers.get('location')!);
  expect(upstream.origin).toBe('https://github.com'); expect(upstream.searchParams.get('scope')).toBe('read:org');
  expect(upstream.searchParams.get('code_challenge_method')).toBe('S256');
  let revoked = false;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === 'https://github.com/login/oauth/access_token') {
      expect(JSON.parse(String(init!.body)).code_verifier).toBeTruthy();
      return Response.json({ access_token: 'github-test-only', scope: 'read:org' });
    }
    if (url === 'https://api.github.com/user') return Response.json({ id: 123 });
    if (url.endsWith('/memberships/orgs/qaml-ai')) return Response.json({ state: revoked ? 'pending' : 'active' });
    throw new Error('Unexpected fetch ' + url);
  });
  const callback = await call('/oauth/callback?code=test-code&state=' + upstream.searchParams.get('state'), e, { headers: { Cookie: cookies(approval) } });
  expect(callback.status).toBe(302);
  const target = new URL(callback.headers.get('location')!); expect(target.searchParams.get('state')).toBe('client-state');
  const tokenReply = await call('/oauth/token', e, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', client_id: registered.client_id, redirect_uri: 'http://localhost:9000/callback', code: target.searchParams.get('code')!, code_verifier: verifier }) });
  expect(tokenReply.status).toBe(200);
  const token = await tokenReply.json<any>();
  const headers = { Authorization: `Bearer ${token.access_token}` };
  const own = await call('/projects/demo/messages', e, { headers }); expect(own.status).toBe(200);
  expect((await call('/projects/other/messages', e, { headers })).status).toBe(401);
  revoked = true;
  expect((await call('/projects/demo/messages', e, { headers })).status).toBe(403);
});
it('rejects consent without its browser cookie and publishes MCP discovery', async () => {
  const { e, params } = await fixture();
  const page = await call('/authorize?' + params, e), html = await page.text();
  const handle = /name="handle" value="([^"]+)"/.exec(html)![1];
  expect((await call('/authorize', e, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ handle, decision: 'approve' }) })).status).toBe(400);
  const denied = await call('/projects/demo/mcp', e);
  expect(denied.status).toBe(401); expect(denied.headers.get('www-authenticate')).toContain('resource_metadata=');
  const metadata = await call('/.well-known/oauth-protected-resource/projects/demo/mcp', e);
  expect((await metadata.json<any>()).resource).toBe(origin + '/projects/demo/mcp');
});
it('fails closed on GitHub rate limits and nonmembers', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 403, headers: { 'x-ratelimit-remaining': '0' } }));
  await expect(githubIdentity('test')).rejects.toMatchObject({ status: 503 });
});

async function beginCallback() {
  const { e, params } = await fixture();
  const page = await call('/authorize?' + params, e);
  const handle = /name="handle" value="([^"]+)"/.exec(await page.text())![1];
  const approval = await call('/authorize', e, { method: 'POST', headers: { Cookie: cookies(page), 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ handle, decision: 'approve' }) });
  expect(approval.status).toBe(302);
  const state = new URL(approval.headers.get('location')!).searchParams.get('state');
  return { e, callback: () => call('/oauth/callback?code=private-code&state=' + state, e, { headers: { Cookie: cookies(approval) } }) };
}
it('reports GitHub exchange network failures without logging credentials', async () => {
  const { callback } = await beginCallback();
  const logs = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('private-token private-code private-state'));
  const response = await callback();
  expect(response.status).toBe(503);
  expect(await response.text()).toContain('Restart sign-in');
  expect(logs.mock.calls).toEqual([[JSON.stringify({ event: 'oauth_operation_failed', stage: 'github_token', kind: 'type_error' })]]);
});
it('reports non-JSON GitHub exchange responses without logging the body', async () => {
  const { callback } = await beginCallback();
  const logs = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('<html>private-token</html>', { headers: { 'Content-Type': 'text/html' } }));
  const response = await callback();
  expect(response.status).toBe(503);
  expect(await response.text()).toContain('invalid response');
  expect(logs.mock.calls).toEqual([[JSON.stringify({ event: 'oauth_operation_failed', stage: 'github_token', kind: 'invalid_json', status: 200 })]]);
});
it('keeps missing mailbox grants forbidden after a successful GitHub exchange', async () => {
  const { e, callback } = await beginCallback();
  const projects = JSON.parse(e.PROJECTS_JSON); projects.demo.clients = {};
  e.PROJECTS_JSON = JSON.stringify(projects);
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any) => {
    const url = String(input);
    if (url === 'https://github.com/login/oauth/access_token') return Response.json({ access_token: 'github-test-only', scope: 'read:org' });
    if (url === 'https://api.github.com/user') return Response.json({ id: 123 });
    if (url.endsWith('/memberships/orgs/qaml-ai')) return Response.json({ state: 'active' });
    throw new Error('Unexpected fetch');
  });
  const response = await callback();
  expect(response.status).toBe(403);
  expect(await response.text()).toContain('No explicit project mailbox grant');
});
it('safely handles invalid GitHub identity response shapes', async () => {
  const logs = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(null));
  await expect(githubIdentity('private-token')).rejects.toMatchObject({ status: 503 });
  expect(logs.mock.calls).toEqual([[JSON.stringify({ event: 'oauth_operation_failed', stage: 'github_user', kind: 'type_error', status: 200 })]]);
});
