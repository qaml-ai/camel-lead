// Narrow, fail-closed compatibility/security fixes for CIMD draft-03. Remove
// after upgrading to an upstream release with these fixes and keeping the tests.
// Do not silently apply to a different dependency version or a changed bundle.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const patches = [
  ['const response = await fetch(issuer.jwksUri, {\n\t\t\t\theaders: {',
   'const response = await fetch(issuer.jwksUri, {\n\t\t\t\tredirect: "manual",\n\t\t\t\tcredentials: "omit",\n\t\t\t\theaders: {'],
  ['if (!response.ok) return err({\n\t\t\t\treason: "jwks_fetch_failed",',
   'if (response.status !== 200) return err({\n\t\t\t\treason: "jwks_fetch_failed",'],
  ['console.warn(`CIMD fetch failed for ${clientId}:`, error instanceof Error ? error.message : error);',
   'console.warn(JSON.stringify({ event: "cimd_metadata_resolution_failed" }));'],
  ['if (!path) throw new Error("Client Identifier URL must contain a path component");',
   'if (!path || path === "/") throw new Error("Client Identifier URL must contain a non-root path component");'],
  ['if (parsed.hash) throw new Error("Client Identifier URL must not contain a fragment");',
   'if (clientId.includes("#")) throw new Error("Client Identifier URL must not contain a fragment");'],
  ['if (parsed.username || parsed.password) throw new Error("Client Identifier URL must not contain userinfo");',
   'if (parsed.username || parsed.password || /^https:\\/\\/[^/?#]*@/i.test(clientId)) throw new Error("Client Identifier URL must not contain userinfo");'],
  ['const redirectUris = requireValidRedirectUris(metadata.redirectUris, validateRedirectUriSafety);',
   'const redirectUris = requireValidRedirectUris(metadata.redirectUris, validateListedRedirectUri);'],
  ['const jwks = parsePublicJwks(raw.jwks);',
   'if (raw.jwks !== undefined && raw.jwks_uri !== undefined) throw new Error("jwks and jwks_uri must not both be present");\n\tconst jwks = parsePublicJwks(raw.jwks);'],
  ['if (preferredMethod !== void 0 && SHARED_SECRET_TOKEN_ENDPOINT_AUTH_METHODS.has(preferredMethod)) throw new Error(`CIMD clients cannot use symmetric token endpoint authentication method: ${preferredMethod}`);',
   'if ([...(supportedMethods ?? []), preferredMethod].some((method) => SHARED_SECRET_TOKEN_ENDPOINT_AUTH_METHODS.has(method))) throw new Error("CIMD clients cannot advertise symmetric token endpoint authentication methods");'],
  ['return fetch(metadataUrl, {\n\t\theaders: {',
   'return fetch(metadataUrl, {\n\t\tredirect: "manual",\n\t\tcredentials: "omit",\n\t\theaders: {'],
  ['if (!response.ok) throw new Error(`Failed to fetch client metadata: HTTP ${response.status}`);',
   'if (response.status !== 200) throw new Error(`Failed to fetch client metadata: HTTP ${response.status}`);'],
];

export function patchedSource(source) {
  for (const [before, after] of patches) {
    if (source.split(after).length === 2 && !source.replace(after, "").includes(before)) continue;
    if (source.split(before).length !== 2) throw new Error('OAuth provider patch did not match exactly once. Review dependency before enabling CIMD.');
    source = source.replace(before, after);
  }
  return source;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = new URL('../node_modules/@cloudflare/workers-oauth-provider/', import.meta.url);
  const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
  if (pkg.version !== '1.2.4') throw new Error('Review CIMD hardening before upgrading workers-oauth-provider');
  const file = new URL('dist/oauth-provider.js', root);
  const original = readFileSync(file, 'utf8');
  const updated = patchedSource(original);
  if (updated !== original) writeFileSync(file, updated);
  console.log('Verified workers-oauth-provider 1.2.4 CIMD hardening');
}
