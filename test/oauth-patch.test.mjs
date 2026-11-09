import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { patches, patchedSource } from '../scripts/patch-oauth-provider.mjs';

test('CIMD provider patch is installed, exact, idempotent and fails on drift', () => {
  const source = readFileSync(new URL('../node_modules/@cloudflare/workers-oauth-provider/dist/oauth-provider.js', import.meta.url), 'utf8');
  assert.ok(patchedSource(source) === source, 'Run npm ci / the postinstall patch before building');
  assert.throws(() => patchedSource('unexpected provider code'));
  for (const [before, after] of patches) {
    assert.equal(source.split(after).length, 2, 'Patched block must occur exactly once');
    assert.ok(patchedSource(source.replace(after, before)) === source);
    assert.throws(() => patchedSource(source.replace(after, before + before)));
  }
});
