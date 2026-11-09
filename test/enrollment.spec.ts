import { env } from 'cloudflare:workers';
import { createExecutionContext, reset, runInDurableObject, runDurableObjectAlarm, evictDurableObject } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import worker from '../src/worker.ts';
import { hash, rpc, type WorkerEnv, type ProjectConfig } from '../src/types.ts';
import { automaticMailboxId, automaticEnrollmentLimit } from '../src/enrollment.ts';
import type { ProjectRoom } from '../src/room.ts';
const origin = 'https://lead.test';
const user = '1033072';
const room = (project = 'auto') => env.PROJECTS.getByName(project);
const settings = (): WorkerEnv => ({ ...env, GITHUB_CLIENT_ID: 'test-github-client', GITHUB_CLIENT_SECRET: 'test-github-secret' });
const call = (path: string, e: WorkerEnv, init?: RequestInit) => worker.fetch(new Request(origin + path, init), e, createExecutionContext());
const cookies = (r: Response) => r.headers.getSetCookie().map(s => s.split(';')[0]).join('; ');
async function login(e = settings(), clientId?: string) {
  if (!clientId) {
    const response = await call('/oauth/register', e, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: 'Unverified App', redirect_uris: ['http://localhost:9000/callback'], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }) });
    expect(response.status).toBe(201);
    clientId = (await response.json<any>()).client_id;
  }
  const verifier = 'a'.repeat(64), digest = await hash(verifier);
  const challenge = btoa(String.fromCharCode(...digest.match(/../g)!.map(x => parseInt(x, 16)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const params = new URLSearchParams({ client_id: clientId!, redirect_uri: 'http://localhost:9000/callback', response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', resource: origin + '/projects/auto/mcp', scope: 'lead:messages', state: 'client-state' });
  const page = await call('/authorize?' + params, e), html = await page.text();
  expect(html).toContain('private delivery mailbox');
  expect(html).toContain('self');
  const handle = /name="handle" value="([^"]+)"/.exec(html)![1];
  const approval = await call('/authorize', e, { method: 'POST', headers: { Cookie: cookies(page), 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ handle, decision: 'approve' }) });
  const state = new URL(approval.headers.get('location')!).searchParams.get('state');
  const callback = await call('/oauth/callback?code=test-code&state=' + state, e, { headers: { Cookie: cookies(approval) } });
  if (callback.status !== 302) return { e, clientId: clientId!, callback, token: undefined as string | undefined };
  const code = new URL(callback.headers.get('location')!).searchParams.get('code')!;
  const exchange = await call('/oauth/token', e, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId!, redirect_uri: 'http://localhost:9000/callback', code, code_verifier: verifier }) });
  expect(exchange.status).toBe(200);
  return { e, clientId: clientId!, callback, token: (await exchange.json<any>()).access_token as string };
}
function github(identity = Number(user)) {
  let state = 'active', outage = false;
  const mock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init?: RequestInit) => {
    const request = new Request(input, init);
    if (outage) return new Response('', { status: 503 });
    if (request.url === 'https://github.com/login/oauth/access_token') return Response.json({ access_token: 'github-test-only', scope: 'read:org' });
    if (request.url === 'https://api.github.com/user') return Response.json({ id: identity });
    if (request.url.endsWith('/memberships/orgs/qaml-ai')) return Response.json({ state });
    throw new Error('Unexpected request');
  });
  return { mock, revoke: () => { state = 'pending'; }, restore: () => { state = 'active'; outage = false; }, outage: () => { outage = true; } };
}
const read = (e: WorkerEnv, token?: string) => call('/projects/auto/messages', e, { headers: { Authorization: 'Bearer ' + token } });
async function rows() {
  return runInDurableObject(room(), (_o: ProjectRoom, s) => s.storage.sql.exec('SELECT * FROM oauth_mailboxes').toArray());
}
afterEach(async () => { vi.restoreAllMocks(); await reset(); });
it('defaults closed and requires opt-in, a bounded cap and a nonblocked client', () => {
  const p: ProjectConfig = { agentId: '', tenantId: '', clients: {} };
  expect(automaticEnrollmentLimit(p, user, 'client')).toBe(0);
  p.githubAutoEnroll = { enabled: true };
  expect(automaticEnrollmentLimit(p, user, 'client')).toBe(16);
  expect(automaticEnrollmentLimit(p, '999', 'client')).toBe(16);
  for (const max of [0, 33, 1.5]) { p.githubAutoEnroll.maxClientsPerUser = max; expect(automaticEnrollmentLimit(p, user, 'client')).toBe(0); }
  p.githubAutoEnroll.maxClientsPerUser = 3; p.githubAutoEnroll.blockedClientIds = ['client'];
  expect(automaticEnrollmentLimit(p, user, 'client')).toBe(0);
});
it('enrolls after consent and live identity, isolates clients/projects, and reuses exact identities', async () => {
  github();
  const a = await login(), b = await login(a.e);
  expect(a.callback.status).toBe(302); expect(b.callback.status).toBe(302);
  const aId = await automaticMailboxId('auto', user, a.clientId), bId = await automaticMailboxId('auto', user, b.clientId);
  expect(aId).not.toBe(bId);
  expect(await automaticMailboxId('auto-other', user, a.clientId)).not.toBe(aId);
  await rpc(room(), 'send', 'auto', aId, 'Private reply', 'private');
  expect((await (await read(a.e, a.token)).json<any>()).events).toHaveLength(1);
  expect((await (await read(b.e, b.token)).json<any>()).events).toHaveLength(0);
  expect((await call('/projects/auto-other/messages', a.e, { headers: { Authorization: 'Bearer ' + a.token } })).status).toBe(401);
  const reconnect = await login(a.e, a.clientId);
  expect(reconnect.callback.status).toBe(302); expect(await rows()).toHaveLength(2);
  await evictDurableObject(room());
  expect((await (await read(a.e, reconnect.token)).json<any>()).events[0].text).toBe('Private reply');
  const stored = JSON.stringify(await rows()); expect(stored).not.toContain('github-test-only');
  expect((await call('/projects/auto/enroll', a.e, { method: 'POST' })).status).toBe(404);
});
it('admits other active org members but does not enroll nonmembers', async () => {
  const gh = github(999);
  expect((await login()).callback.status).toBe(302); expect(await rows()).toHaveLength(1);
  gh.mock.mockRestore(); const allowed = github(); allowed.revoke();
  expect((await login()).callback.status).toBe(403); expect(await rows()).toHaveLength(1);
});
it('atomically caps new DCR identities while permitting idempotent existing enrollments', async () => {
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => room().invoke('resolveOAuthClient', ['auto', user, 'client-' + i, true])));
  expect(results.filter(r => r.ok)).toHaveLength(3); expect(await rows()).toHaveLength(3);
  const id = (await rows())[0].oauthClientId as string;
  await expect(rpc(room(), 'resolveOAuthClient', 'auto', user, id, true)).resolves.toBe(await automaticMailboxId('auto', user, id));
  await rpc(room(), 'suspendOAuthUser', 'auto', user);
  await expect(rpc(room(), 'resolveOAuthClient', 'auto', user, 'new-id', true)).rejects.toMatchObject({ status: 403 });
});
it('keeps exact CIMD URLs stable, never aliases by display name or domain', async () => {
  const a = 'https://client.test/oauth/code', b = 'https://client.test/oauth/web';
  const ids = await Promise.all([a, a, b].map(c => rpc(room(), 'resolveOAuthClient', 'auto', user, c, true)));
  expect(ids[0]).toBe(ids[1]); expect(ids[0]).not.toBe(ids[2]); expect(await rows()).toHaveLength(2);
});
it('freezes broadcast recipients on retries across enrollment and empty recipient sets', async () => {
  const empty = await rpc(room(), 'send', 'auto', 'all', 'Before enrollment', 'empty');
  expect(empty.deliveredToMailboxes).toEqual([]);
  const a = await rpc(room(), 'resolveOAuthClient', 'auto', user, 'a', true);
  const first = await rpc(room(), 'send', 'auto', 'all', 'Hello', 'all');
  const b = await rpc(room(), 'resolveOAuthClient', 'auto', user, 'b', true);
  expect(await rpc(room(), 'send', 'auto', 'all', 'Hello', 'all')).toEqual(first);
  expect(await rpc(room(), 'send', 'auto', 'all', 'Before enrollment', 'empty')).toEqual(empty);
  expect((await rpc(room(), 'read', 'auto', a)).events).toHaveLength(1);
  expect((await rpc(room(), 'read', 'auto', b)).events).toHaveLength(0);
  await expect(rpc(room(), 'send', 'auto', a, 'Hello', 'all')).rejects.toMatchObject({ status: 409 });
});
it('suspends automatic routing and queued work on observed revocation; live revalidation restores only that client', async () => {
  const gh = github(), a = await login(), b = await login(a.e);
  const aId = await automaticMailboxId('auto', user, a.clientId);
  await rpc(room(), 'submit', 'auto', aId, 'queued', 'Do not run after revocation');
  gh.revoke(); expect((await read(a.e, a.token)).status).toBe(403);
  expect(await rpc(room(), 'participants', 'auto')).toEqual([]);
  await expect(rpc(room(), 'send', 'auto', aId, 'Blocked', 'blocked')).rejects.toMatchObject({ status: 404 });
  const before = gh.mock.mock.calls.length;
  await runDurableObjectAlarm(room()); expect(gh.mock).toHaveBeenCalledTimes(before);
  const jobs = await runInDurableObject(room(), (_o: ProjectRoom, s) => s.storage.sql.exec('SELECT state FROM jobs').toArray());
  expect(jobs).toEqual([{ state: 'failed' }]);
  gh.restore(); expect((await read(b.e, b.token)).status).toBe(200);
  expect(await rpc(room(), 'participants', 'auto')).toHaveLength(1);
});
it('fails closed on upstream outage without mistaking it for a revocation', async () => {
  const gh = github(), a = await login(); gh.outage();
  expect((await read(a.e, a.token)).status).toBe(503);
  expect((await rows())[0].suspended).toBe(0);
});
it('removing policy or blocking a client stops existing routing and enrollment', async () => {
  const id = await rpc(room(), 'resolveOAuthClient', 'auto', user, 'a', true);
  await runInDurableObject(room(), async (o: ProjectRoom) => {
    const original = (o as any).env;
    const projects = JSON.parse(original.PROJECTS_JSON); projects.auto.githubAutoEnroll.blockedClientIds = ['a'];
    (o as any).env = { ...original, PROJECTS_JSON: JSON.stringify(projects) };
    try {
      expect(await o.participants('auto')).toEqual([]);
      await expect(o.read('auto', id)).rejects.toMatchObject({ status: 403 });
      await expect(o.resolveOAuthClient('auto', user, 'a', false)).rejects.toMatchObject({ status: 403 });
      projects.auto.githubAutoEnroll.enabled = false;
      (o as any).env.PROJECTS_JSON = JSON.stringify(projects);
      await expect(o.resolveOAuthClient('auto', user, 'b', true)).rejects.toMatchObject({ status: 403 });
    } finally { (o as any).env = original; }
  });
});
it('runs auto-enrolled jobs with derived sender identity and returns replies only to that mailbox', async () => {
  const a = await rpc(room(), 'resolveOAuthClient', 'auto', user, 'a', true);
  const b = await rpc(room(), 'resolveOAuthClient', 'auto', user, 'b', true);
  await rpc(room(), 'submit', 'auto', a, 'request', 'Please help');
  const outbound = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any) => {
    const request = input as Request, body = await request.json<any>();
    expect(body.from.id).toBe(a); expect(body.from.name).toContain('GitHub ' + user);
    expect(body.metadata).toMatchObject({ client: a, project: 'auto' });
    return Response.json({ state: 'completed', outcome: { result: { reply: 'Done' } } });
  });
  await runDurableObjectAlarm(room()); expect(outbound).toHaveBeenCalledTimes(1);
  expect((await rpc(room(), 'read', 'auto', a)).events.map((r: any) => r.text)).toEqual(['Done']);
  expect((await rpc(room(), 'read', 'auto', b)).events).toHaveLength(0);
});
